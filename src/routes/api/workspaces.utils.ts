import type { AppLoadContext } from 'react-router';
import { getSession } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import { getWorkspaceAccessContext } from '@/lib/auth-do';
import type { WorkspaceAccessLevel } from '../../../workers/main/src/workspace';
import { ENTERPRISE_OIDC_AUTH_SOURCE } from '../../../workers/main/src/signed-session';
import type {
  WorkspaceFilesystemClient,
  WorkspaceListResponse as DoWorkspaceListResponse,
  WorkspaceReadFileResponse,
} from '../../../workers/main/src/workspace-filesystem-do';

interface WorkspaceFileAdapterListResponse extends DoWorkspaceListResponse {
  success: boolean;
}

class WorkspaceFileAdapter {
  private fsPromise?: Promise<WorkspaceFilesystemClient>;

  constructor(
    private readonly env: CloudflareEnv,
    private readonly workspaceId: string,
  ) {}

  private async getFs(): Promise<WorkspaceFilesystemClient> {
    this.fsPromise ??= import('../../../workers/main/src/workspace-filesystem-do')
      .then(({ WorkspaceFilesystemClient }) => new WorkspaceFilesystemClient(
        this.env as never,
        this.workspaceId,
      ));
    return this.fsPromise;
  }

  async readFile(path: string): Promise<WorkspaceReadFileResponse> {
    return (await this.getFs()).readFile(toWorkspacePath(path));
  }

  async readFileStream(path: string): Promise<Response | null> {
    const result = await this.readFile(path);
    if (!result.success) return null;

    const bytes = result.isBinary || result.encoding === 'base64'
      ? base64ToBytes(result.content ?? '')
      : new TextEncoder().encode(result.content ?? '');
    return new Response(bytes as BodyInit, {
      headers: {
        'Content-Length': String(bytes.byteLength),
      },
    });
  }

  async listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean; limit?: number },
  ): Promise<WorkspaceFileAdapterListResponse> {
    return (await this.getFs()).listFiles(toWorkspacePath(path), options) as Promise<WorkspaceFileAdapterListResponse>;
  }
}

export interface WorkspaceAuth {
  userId: string;
  orgId: string;
  workspaceId: string;
  access: WorkspaceAccessLevel;
  container: WorkspaceFileAdapter;
}

export interface WorkspaceAccessAuth {
  userId: string;
  orgId: string;
  workspaceId: string;
  access: WorkspaceAccessLevel;
}

/**
 * Require workspace session with optional write access check.
 * Performs auth + access validation only (no container startup).
 */
export async function requireWorkspaceAccess(
  request: Request,
  context: AppLoadContext,
  workspaceId: string,
  options: { requireWrite?: boolean } = {}
): Promise<WorkspaceAccessAuth> {
  const sessionContext = await getSession(request, context);
  if (!sessionContext) {
    throw Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const env = getEnv(context);

  // Cast to AuthEnv for auth-do functions
  const authEnv = env as unknown as AuthEnv;

  const { workspace, access } = await getWorkspaceAccessContext(
    authEnv,
    workspaceId,
    sessionContext.session.user_id,
  );
  if (!workspace) {
    throw Response.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let superuser: boolean | null = null;
  const isSuperuser = async (): Promise<boolean> => {
    if (sessionContext.session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE) return false;
    if (superuser !== null) return superuser;
    const userProfile = await authEnv.USER
      .get(authEnv.USER.idFromName(sessionContext.session.user_id))
      .getProfile();
    superuser = Boolean(
      userProfile?.is_superuser && userProfile.email_verified_at != null,
    );
    return superuser;
  };

  const isCrossOrgWorkspace = workspace.org_id !== sessionContext.session.org_id;
  if (isCrossOrgWorkspace) {
    if (!(await isSuperuser())) {
      throw Response.json({ error: 'Workspace not found' }, { status: 404 });
    }
    if (options.requireWrite) {
      throw Response.json({ error: 'Read-only workspace access' }, { status: 403 });
    }

    return {
      userId: sessionContext.session.user_id,
      orgId: workspace.org_id,
      workspaceId,
      access: 'full',
    };
  }

  if (access === 'none') {
    if (!(await isSuperuser())) {
      throw Response.json({ error: 'Workspace not found' }, { status: 404 });
    }
    if (options.requireWrite) {
      throw Response.json({ error: 'Read-only workspace access' }, { status: 403 });
    }

    return {
      userId: sessionContext.session.user_id,
      orgId: workspace.org_id,
      workspaceId,
      access: 'full',
    };
  }
  if (options.requireWrite && access !== 'full') {
    throw Response.json({ error: 'Read-only workspace access' }, { status: 403 });
  }

  return {
    userId: sessionContext.session.user_id,
    orgId: workspace.org_id,
    workspaceId,
    access,
  };
}

/**
 * Require workspace session with optional write access check.
 * Returns workspace auth info and container stub, or throws Response on error.
 */
export async function requireWorkspaceAuth(
  request: Request,
  context: AppLoadContext,
  workspaceId: string,
  options: { requireWrite?: boolean } = {}
): Promise<WorkspaceAuth> {
  const accessAuth = await requireWorkspaceAccess(request, context, workspaceId, options);
  const env = getEnv(context);
  const container = new WorkspaceFileAdapter(env, accessAuth.workspaceId);

  return {
    ...accessAuth,
    container,
  };
}

/** Workspace root directory inside sandbox */
const WORKSPACE_ROOT = '/workspace';

const NORMALIZABLE_WHITESPACE = /[ \u00A0\u2007\u202F]/;

/**
 * Replace non-breaking spaces (U+00A0) and other Unicode whitespace with
 * regular ASCII spaces. macOS uses non-breaking spaces in screenshot filenames
 * (e.g. "Screenshot 2026-01-23 at 12.39.52\u00a0PM.png") which causes
 * mismatches when tools report these paths with regular spaces.
 */
export function normalizeWhitespace(input: string): string {
  return input.replace(/[\u00A0\u2007\u202F]/g, ' ');
}

export function hasNormalizableWhitespace(input: string): boolean {
  return NORMALIZABLE_WHITESPACE.test(input);
}

/**
 * Normalize a workspace path, preventing directory traversal attacks.
 */
export function normalizeWorkspacePath(input?: string | null): string {
  if (!input) return '/';
  let raw = input.trim();
  if (!raw.startsWith('/')) raw = `/${raw}`;

  const segments: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) {
        throw new Error('Path escapes workspace root');
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `/${segments.join('/')}`;
}

/**
 * Convert a workspace-relative path to an absolute container path.
 * Workspace path '/' maps to '/workspace', '/foo' maps to '/workspace/foo'.
 */
export function toContainerPath(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (normalized === '/') return WORKSPACE_ROOT;
  return `${WORKSPACE_ROOT}${normalized}`;
}

function toWorkspacePath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (
    normalized === WORKSPACE_ROOT ||
    normalized.startsWith(`${WORKSPACE_ROOT}/`)
  ) {
    if (normalized === WORKSPACE_ROOT) return '/';
    return normalizeWorkspacePath(normalized.slice(WORKSPACE_ROOT.length));
  }
  return normalized;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function joinContainerPath(dir: string, base: string): string {
  if (!base) return dir;
  if (dir.endsWith('/')) return `${dir}${base}`;
  return `${dir}/${base}`;
}

/**
 * Resolve an existing workspace path to the actual container path, matching
 * entries whose names normalize to the same whitespace (e.g. NBSP vs space).
 * Returns null if no match is found or the path has no normalizable whitespace.
 */
export async function resolveContainerPath(
  container: WorkspaceFileAdapter,
  workspacePath: string
): Promise<string | null> {
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  if (normalizedPath === '/') return toContainerPath('/');
  if (!hasNormalizableWhitespace(normalizedPath)) return null;

  const segments = normalizedPath.slice(1).split('/');
  let currentPath = toContainerPath('/');

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const normalizedSegment = normalizeWhitespace(segment);

    let listing: Awaited<ReturnType<WorkspaceFileAdapter['listFiles']>>;
    try {
      listing = await container.listFiles(currentPath, {
        recursive: false,
        includeHidden: true,
      });
    } catch {
      return null;
    }
    const entries = listing.files ?? [];

    let match = entries.find((entry) => entry.name === segment);
    if (!match) {
      const matches = entries.filter(
        (entry) => normalizeWhitespace(entry.name) === normalizedSegment
      );
      if (matches.length !== 1) {
        return null;
      }
      match = matches[0];
    }

    if (i < segments.length - 1 && match.type !== 'directory') {
      return null;
    }

    currentPath = match.absolutePath || joinContainerPath(currentPath, match.name);
  }

  return currentPath;
}
