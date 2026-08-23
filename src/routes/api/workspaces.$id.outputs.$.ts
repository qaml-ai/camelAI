import type { Route } from './+types/workspaces.$id.outputs.$';
import { getEnv } from '@/lib/cloudflare.server';
import { getR2ObjectWithRetry } from '@/lib/r2-read-retry';
import { buildWorkspaceScopedR2Key } from '@/lib/workspace-r2-paths';
import { requireWorkspaceAuth } from './workspaces.utils';
import { resolveObjectStore } from '../../../workers/main/src/binding-facades/object-store';

// Common MIME types for file serving
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.ipynb': 'application/x-ipynb+json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
};

// MIME types that should display inline (not trigger download)
const INLINE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
  'image/bmp',
  'text/plain',
  'text/csv',
  'text/html',
  'text/tab-separated-values',
  'text/css',
  'application/json',
  'application/x-ndjson',
  'application/x-ipynb+json',
  'application/javascript',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);

function getMimeType(filename: string): string {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()?.toLowerCase()}` : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function shouldDisplayInline(mimeType: string): boolean {
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  return INLINE_MIME_TYPES.has(normalized);
}

/**
 * Normalize and validate the file path, preventing directory traversal.
 * Returns null if the path is invalid.
 */
function validateFilePath(rawPath: string): string | null {
  if (!rawPath || rawPath === '/') return null;

  // Decode URI component to handle %20, etc.
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  // Ensure path starts with /
  if (!path.startsWith('/')) path = `/${path}`;

  // Prevent directory traversal
  if (path.includes('..')) return null;

  // Normalize path segments
  const segments = path.split('/').filter(s => s && s !== '.');
  if (segments.length === 0) return null;

  return segments.join('/');
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    const rawFilePath = params['*'];

    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    if (!rawFilePath) {
      return Response.json({ error: 'File path required' }, { status: 400 });
    }

    // Validate and normalize the file path
    const filePath = validateFilePath(rawFilePath);
    if (!filePath) {
      return Response.json({ error: 'Invalid file path' }, { status: 400 });
    }

    const { orgId } = await requireWorkspaceAuth(request, context, workspaceId);

    const env = getEnv(context);
    const filename = filePath.split('/').pop() || 'file';
    const fallbackContentType = getMimeType(filename);

    const r2Key = buildWorkspaceScopedR2Key(
      orgId,
      workspaceId,
      `user-outputs/${filePath}`
    );
    // Retry briefly: a preview can reference an output the moment before its
    // R2 write lands, which would otherwise 404 for a few seconds.
    const object = await getR2ObjectWithRetry(resolveObjectStore(env), r2Key);

    if (!object) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    const contentType = object.httpMetadata?.contentType || fallbackContentType;
    const displayInline = shouldDisplayInline(contentType);

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `${displayInline ? 'inline' : 'attachment'}; filename="${filename}"`,
    };

    // Only set Content-Length when R2 reports a non-zero size.
    // Objects uploaded via S3 API can report size=0 even though the body
    // stream contains the full content, causing browsers to discard the
    // response body.
    if (object.size > 0) {
      headers['Content-Length'] = object.size.toString();
    }

    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error serving output file:', error);
    return Response.json({ error: 'Failed to serve file' }, { status: 500 });
  }
}
