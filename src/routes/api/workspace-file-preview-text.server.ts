import type { AppLoadContext } from 'react-router';
import { getEnv } from '@/lib/cloudflare.server';
import { FULL_TEXT_PREVIEW_BYTE_LIMIT } from '@/lib/file-preview-limits';
import { getR2ObjectWithRetry } from '@/lib/r2-read-retry';
import { buildWorkspaceScopedR2Key } from '@/lib/workspace-r2-paths';
import { ProjectFilesystemClient, WorkspaceFilesystemClient } from '../../../workers/main/src/workspace-filesystem-do';
import { resolveObjectStore } from '../../../workers/main/src/binding-facades/object-store';
import {
  hasNormalizableWhitespace,
  normalizeWorkspacePath,
  normalizeWhitespace,
  requireWorkspaceAccess,
} from './workspaces.utils';
import {
  FullTextPreviewTooLargeError,
  normalizeTextPreviewMaxLines,
  readTextPreviewFromStream,
  type TextPreviewMode,
  type TextPreviewResponse,
} from './text-preview-stream';

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'application/typescript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
};

type TextPreviewSource = 'workspace' | 'project' | 'upload' | 'output';

function getMimeType(filename: string): string {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()?.toLowerCase()}` : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function parseMode(raw: string | null): TextPreviewMode {
  if (!raw || raw === 'initial') return 'initial';
  if (raw === 'full') return 'full';
  throw Response.json({ error: 'Invalid mode' }, { status: 400 });
}

function validateR2Path(rawPath: string): string | null {
  if (!rawPath || rawPath === '/') return null;

  let path = rawPath;
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.includes('..')) return null;

  const segments = path.split('/').filter((segment) => segment && segment !== '.');
  if (segments.length === 0) return null;
  return segments.join('/');
}

function normalizePreviewWorkspacePath(rawPath: string): string {
  try {
    return normalizeWorkspacePath(rawPath);
  } catch {
    throw Response.json({ error: 'Invalid file path' }, { status: 400 });
  }
}

async function resolveWorkspacePreviewPath(
  fs: WorkspaceFilesystemClient,
  workspacePath: string
): Promise<string | null> {
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  if (normalizedPath === '/') return '/';
  if (!hasNormalizableWhitespace(normalizedPath)) return null;

  const segments = normalizedPath.slice(1).split('/');
  let currentPath = '/';

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const normalizedSegment = normalizeWhitespace(segment);

    let listing: Awaited<ReturnType<WorkspaceFilesystemClient['listFiles']>>;
    try {
      listing = await fs.listFiles(currentPath, {
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

    if (index < segments.length - 1 && match.type !== 'directory') {
      return null;
    }

    currentPath = match.absolutePath || `${currentPath.replace(/\/$/, '')}/${match.name}`;
  }

  return currentPath;
}

async function resolvePreviewStream({
  request,
  context,
  workspaceId,
  source,
  path,
  project,
}: {
  request: Request;
  context: AppLoadContext;
  workspaceId: string;
  source: TextPreviewSource;
  path: string;
  project: string | null;
}): Promise<{
  stream: ReadableStream<Uint8Array>;
  contentType?: string;
  path?: string;
  size?: number;
}> {
  const access = await requireWorkspaceAccess(request, context, workspaceId);
  const env = getEnv(context);

  if (source === 'workspace') {
    const workspacePath = normalizePreviewWorkspacePath(path);
    const fs = new WorkspaceFilesystemClient(env as never, workspaceId);
    let resolvedPath = workspacePath;
    let result = await fs.readFileStream(resolvedPath);
    if (!result.success) {
      const fallbackPath = await resolveWorkspacePreviewPath(fs, workspacePath);
      if (fallbackPath && fallbackPath !== workspacePath) {
        resolvedPath = fallbackPath;
        result = await fs.readFileStream(resolvedPath);
      }
    }
    if (!result.success || !result.stream) {
      throw Response.json({ error: 'File not found' }, { status: 404 });
    }
    return {
      stream: result.stream,
      contentType: result.mimeType || getMimeType(resolvedPath),
      path: resolvedPath,
      size: result.size,
    };
  }

  if (source === 'project') {
    if (!project) {
      throw Response.json({ error: 'Project required' }, { status: 400 });
    }
    const projectPath = normalizePreviewWorkspacePath(path);
    const workspaceFs = new WorkspaceFilesystemClient(env as never, workspaceId);
    const projectRecord = await workspaceFs.getProjectByName(project);
    if (!projectRecord) {
      throw Response.json({ error: 'Project not found' }, { status: 404 });
    }
    const projectFs = new ProjectFilesystemClient(env as never, projectRecord.id);
    const result = await projectFs.readFileStream(projectPath);
    if (!result.success || !result.stream) {
      throw Response.json({ error: 'File not found' }, { status: 404 });
    }
    return {
      stream: result.stream,
      contentType: result.mimeType || getMimeType(projectPath),
      path: projectPath,
      size: result.size,
    };
  }

  const filePath = validateR2Path(path);
  if (!filePath) {
    throw Response.json({ error: 'Invalid file path' }, { status: 400 });
  }
  const bucketDir = source === 'upload' ? 'user-uploads' : 'user-outputs';
  // Retry briefly: a preview can reference the file the moment before its R2
  // write lands, which would otherwise 404 for a few seconds.
  const object = await getR2ObjectWithRetry(
    resolveObjectStore(env),
    buildWorkspaceScopedR2Key(access.orgId, workspaceId, `${bucketDir}/${filePath}`)
  );
  if (!object?.body) {
    throw Response.json({ error: 'File not found' }, { status: 404 });
  }
  return {
    stream: object.body,
    contentType: object.httpMetadata?.contentType || getMimeType(filePath),
    path: filePath,
    size: object.size > 0 ? object.size : undefined,
  };
}

export async function loadTextPreviewResponse({
  request,
  context,
  workspaceId,
}: {
  request: Request;
  context: AppLoadContext;
  workspaceId: string;
}): Promise<TextPreviewResponse> {
  const url = new URL(request.url);
  const source = url.searchParams.get('source') as TextPreviewSource | null;
  const path = url.searchParams.get('path');
  if (!source || !['workspace', 'project', 'upload', 'output'].includes(source)) {
    throw Response.json({ error: 'Invalid source' }, { status: 400 });
  }
  if (!path) {
    throw Response.json({ error: 'File path required' }, { status: 400 });
  }

  const mode = parseMode(url.searchParams.get('mode'));
  const maxLines = normalizeTextPreviewMaxLines(url.searchParams.get('maxLines'));
  const stream = await resolvePreviewStream({
    request,
    context,
    workspaceId,
    source,
    path,
    project: url.searchParams.get('project'),
  });

  if (
    mode === 'full' &&
    typeof stream.size === 'number' &&
    stream.size > FULL_TEXT_PREVIEW_BYTE_LIMIT
  ) {
    await stream.stream.cancel().catch(() => {});
    throw new FullTextPreviewTooLargeError();
  }

  return readTextPreviewFromStream(stream.stream, {
    mode,
    maxLines,
    contentType: stream.contentType,
    path: stream.path,
    size: stream.size,
  });
}
