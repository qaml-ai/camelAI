import type { Route } from './+types/workspaces.$id.upload';
import { requireWorkspaceAccess } from './workspaces.utils';
import { getEnv } from '@/lib/cloudflare.server';
import { isSelfhostRuntime } from '@/lib/selfhost-runtime';
import { buildWorkspaceScopedR2Key } from '@/lib/workspace-r2-paths';
import { resolveObjectStore } from '../../../workers/main/src/binding-facades/object-store';

function generateUniqueFilename(originalName: string): string {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 8);
  const ext = originalName.includes('.')
    ? originalName
      .slice(originalName.lastIndexOf('.'))
      .replace(/[^a-zA-Z0-9.]/g, '_')
      .substring(0, 20)
    : '';
  const baseName = originalName.includes('.')
    ? originalName.slice(0, originalName.lastIndexOf('.'))
    : originalName;
  // Sanitize base name (remove special chars, limit length)
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 50);
  return `${sanitized}-${timestamp}-${randomPart}${ext}`;
}

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const MAX_FILENAME_LENGTH = 255;
const VALID_STORED_FILENAME = /^[a-zA-Z0-9._-]+$/;

function toMountPath(filename: string): string {
  return `uploads/${filename}`;
}

function buildUploadKey(orgId: string, workspaceId: string, filename: string): string {
  return buildWorkspaceScopedR2Key(orgId, workspaceId, `user-uploads/${filename}`);
}

function parseStoredFilename(value: string | null): string | null {
  if (!value) return null;
  if (value.length > MAX_FILENAME_LENGTH) return null;
  if (!VALID_STORED_FILENAME.test(value)) return null;
  return value;
}

function parsePartNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    return null;
  }
  return parsed;
}

function parseUploadedParts(value: unknown): Array<{ partNumber: number; etag: string }> | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const partNumber = record.partNumber;
    const etag = record.etag;

    if (
      !Number.isInteger(partNumber)
      || (partNumber as number) < 1
      || (partNumber as number) > 10_000
      || typeof etag !== 'string'
      || etag.length === 0
    ) {
      return null;
    }

    parts.push({ partNumber: partNumber as number, etag });
  }

  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleMultipartCreate(
  request: Request,
  env: ReturnType<typeof getEnv>,
  orgId: string,
  workspaceId: string
) {
  const body = await readJsonBody(request) as
    | { originalName?: unknown; contentType?: unknown }
    | null;

  if (!body || typeof body.originalName !== 'string' || body.originalName.trim().length === 0) {
    return Response.json({ error: 'originalName is required' }, { status: 400 });
  }

  const originalName = body.originalName;
  const contentType = typeof body.contentType === 'string' && body.contentType.trim().length > 0
    ? body.contentType
    : DEFAULT_CONTENT_TYPE;

  const filename = generateUniqueFilename(originalName);
  const r2Key = buildUploadKey(orgId, workspaceId, filename);

  if (isSelfhostRuntime(env)) {
    return Response.json({
      uploadMode: 'direct',
      filename,
      path: toMountPath(filename),
    });
  }

  const multipartUpload = await resolveObjectStore(env).createMultipartUpload(r2Key, {
    httpMetadata: { contentType },
    customMetadata: {
      originalName,
      uploadedAt: new Date().toISOString(),
    },
  });

  return Response.json({
    uploadId: multipartUpload.uploadId,
    filename,
    path: toMountPath(filename),
  });
}

async function handleDirectUpload(
  request: Request,
  env: ReturnType<typeof getEnv>,
  orgId: string,
  workspaceId: string,
  url: URL
) {
  if (!isSelfhostRuntime(env)) {
    return Response.json({ error: 'Direct upload is only available in self-hosted installs' }, { status: 400 });
  }

  const filename = parseStoredFilename(url.searchParams.get('filename'));
  if (!filename) {
    return Response.json({ error: 'filename is required' }, { status: 400 });
  }
  if (!request.body) {
    return Response.json({ error: 'Missing request body' }, { status: 400 });
  }

  const originalName = url.searchParams.get('originalName')?.slice(0, MAX_FILENAME_LENGTH)
    || filename;
  const contentType = request.headers.get('Content-Type')?.trim() || DEFAULT_CONTENT_TYPE;
  const r2Key = buildUploadKey(orgId, workspaceId, filename);
  const object = await resolveObjectStore(env).put(r2Key, request.body, {
    httpMetadata: { contentType },
    customMetadata: {
      originalName,
      uploadedAt: new Date().toISOString(),
    },
  });

  return Response.json({
    path: toMountPath(filename),
    filename,
    size: object.size,
    etag: object.httpEtag,
  });
}

async function handleMultipartUploadPart(
  request: Request,
  env: ReturnType<typeof getEnv>,
  orgId: string,
  workspaceId: string,
  url: URL
) {
  const uploadId = url.searchParams.get('uploadId');
  const filename = parseStoredFilename(url.searchParams.get('filename'));
  const partNumber = parsePartNumber(url.searchParams.get('partNumber'));

  if (!uploadId || !filename || !partNumber) {
    return Response.json(
      { error: 'uploadId, filename, and partNumber are required' },
      { status: 400 }
    );
  }
  if (!request.body) {
    return Response.json({ error: 'Missing request body' }, { status: 400 });
  }

  const r2Key = buildUploadKey(orgId, workspaceId, filename);
  const multipartUpload = resolveObjectStore(env).resumeMultipartUpload(r2Key, uploadId);

  try {
    const uploadedPart = await multipartUpload.uploadPart(partNumber, request.body);
    return Response.json({
      partNumber: uploadedPart.partNumber,
      etag: uploadedPart.etag,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to upload part';
    return Response.json({ error: message }, { status: 400 });
  }
}

async function handleMultipartComplete(
  request: Request,
  env: ReturnType<typeof getEnv>,
  orgId: string,
  workspaceId: string,
  url: URL
) {
  const uploadId = url.searchParams.get('uploadId');
  const filename = parseStoredFilename(url.searchParams.get('filename'));

  if (!uploadId || !filename) {
    return Response.json({ error: 'uploadId and filename are required' }, { status: 400 });
  }

  const body = await readJsonBody(request) as { parts?: unknown } | null;
  const parts = parseUploadedParts(body?.parts);
  if (!parts) {
    return Response.json({ error: 'parts are required' }, { status: 400 });
  }

  const r2Key = buildUploadKey(orgId, workspaceId, filename);
  const multipartUpload = resolveObjectStore(env).resumeMultipartUpload(r2Key, uploadId);

  try {
    const object = await multipartUpload.complete(parts);
    return Response.json({
      path: toMountPath(filename),
      filename,
      size: object.size,
      etag: object.httpEtag,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to complete multipart upload';
    return Response.json({ error: message }, { status: 400 });
  }
}

async function handleMultipartAbort(
  env: ReturnType<typeof getEnv>,
  orgId: string,
  workspaceId: string,
  url: URL
) {
  const uploadId = url.searchParams.get('uploadId');
  const filename = parseStoredFilename(url.searchParams.get('filename'));

  if (!uploadId || !filename) {
    return Response.json({ error: 'uploadId and filename are required' }, { status: 400 });
  }

  const r2Key = buildUploadKey(orgId, workspaceId, filename);
  const multipartUpload = resolveObjectStore(env).resumeMultipartUpload(r2Key, uploadId);

  try {
    await multipartUpload.abort();
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to abort multipart upload';
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { orgId } = await requireWorkspaceAccess(request, context, workspaceId, {
      requireWrite: true,
    });

    const env = getEnv(context);
    const url = new URL(request.url);
    const actionType = url.searchParams.get('action');

    if (request.method === 'POST') {
      if (actionType === 'mpu-create') {
        return await handleMultipartCreate(request, env, orgId, workspaceId);
      }
      if (actionType === 'mpu-complete') {
        return await handleMultipartComplete(request, env, orgId, workspaceId, url);
      }
      return Response.json({ error: `Unknown action ${actionType} for POST` }, { status: 400 });
    }

    if (request.method === 'PUT') {
      if (actionType === 'direct') {
        return await handleDirectUpload(request, env, orgId, workspaceId, url);
      }
      if (actionType === 'mpu-uploadpart') {
        return await handleMultipartUploadPart(request, env, orgId, workspaceId, url);
      }
      return Response.json({ error: `Unknown action ${actionType} for PUT` }, { status: 400 });
    }

    if (request.method === 'DELETE') {
      if (actionType === 'mpu-abort') {
        return await handleMultipartAbort(env, orgId, workspaceId, url);
      }
      return Response.json({ error: `Unknown action ${actionType} for DELETE` }, { status: 400 });
    }

    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST, PUT, DELETE' },
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error uploading file:', error);
    return Response.json({ error: 'Failed to upload file' }, { status: 500 });
  }
}
