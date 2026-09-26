'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Attachment } from '@/components/attachment-list';

const DRAFT_PREFIX = 'draft:';
const DELIVERY_DRAFT_PREFIX = 'delivery-draft:';
const MAX_DRAFTS = 50;

export interface SerializedAttachment {
  id: string;
  name: string;
  path: string;
  size?: number;
  contentType?: string;
  originalName?: string;
  kind?: 'transcript';
  sourceThreadId?: string;
  sourceTitle?: string;
  snippet?: string;
  status: 'complete';
}

export interface DraftData {
  text: string;
  attachments: SerializedAttachment[];
  savedAt: number;
}

export interface DeliveryDraftData extends DraftData {
  clientMessageId: string;
  acceptedAt: number | null;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function draftKey(workspaceId: string, threadId: string | null): string {
  return `${DRAFT_PREFIX}${workspaceId}:${threadId ?? 'new'}`;
}

export function deliveryDraftKey(workspaceId: string, threadId: string | null): string {
  return `${DELIVERY_DRAFT_PREFIX}${workspaceId}:${threadId ?? 'new'}`;
}

export function serializeAttachments(attachments: Attachment[]): SerializedAttachment[] {
  return attachments
    .filter((attachment) => attachment.status === 'complete')
    .map(({
      id,
      name,
      path,
      size,
      contentType,
      originalName,
      kind,
      sourceThreadId,
      sourceTitle,
      snippet,
    }) => ({
      id,
      name,
      path,
      size,
      contentType,
      originalName,
      kind,
      sourceThreadId,
      sourceTitle,
      snippet,
      status: 'complete',
    }));
}

function parseSerializedAttachment(value: unknown): SerializedAttachment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.path !== 'string' ||
    (record.size !== undefined &&
      (typeof record.size !== 'number' || !Number.isFinite(record.size)))
  ) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    path: record.path,
    size: typeof record.size === 'number' ? record.size : undefined,
    contentType: typeof record.contentType === 'string' ? record.contentType : undefined,
    originalName: typeof record.originalName === 'string' ? record.originalName : undefined,
    kind: record.kind === 'transcript' ? 'transcript' : undefined,
    sourceThreadId:
      typeof record.sourceThreadId === 'string' ? record.sourceThreadId : undefined,
    sourceTitle:
      typeof record.sourceTitle === 'string' ? record.sourceTitle : undefined,
    snippet: typeof record.snippet === 'string' ? record.snippet : undefined,
    status: 'complete',
  };
}

function parseDraft(raw: string): DraftData | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const attachments = Array.isArray(parsed.attachments)
    ? parsed.attachments
        .map(parseSerializedAttachment)
        .filter((attachment): attachment is SerializedAttachment => attachment !== null)
    : [];
  const savedAt = typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt)
    ? parsed.savedAt
    : 0;

  if (!text.trim() && attachments.length === 0) {
    return null;
  }

  return { text, attachments, savedAt };
}

function parseDeliveryDraft(raw: string): DeliveryDraftData | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const draft = parseDraft(raw);
  if (!draft) {
    return null;
  }

  const clientMessageId =
    typeof parsed.clientMessageId === 'string' ? parsed.clientMessageId : '';
  if (!clientMessageId) {
    return null;
  }

  const acceptedAt =
    typeof parsed.acceptedAt === 'number' && Number.isFinite(parsed.acceptedAt)
      ? parsed.acceptedAt
      : null;

  return { ...draft, clientMessageId, acceptedAt };
}

function evictOldDrafts(storage: Storage, maxDrafts: number) {
  const drafts: Array<{ key: string; savedAt: number }> = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(DRAFT_PREFIX)) {
      continue;
    }

    const raw = storage.getItem(key);
    if (!raw) {
      continue;
    }

    try {
      const draft = parseDraft(raw);
      if (!draft) {
        storage.removeItem(key);
        continue;
      }
      drafts.push({ key, savedAt: draft.savedAt });
    } catch {
      storage.removeItem(key);
    }
  }

  if (drafts.length <= maxDrafts) {
    return;
  }

  drafts.sort((left, right) => left.savedAt - right.savedAt);
  for (const draft of drafts.slice(0, drafts.length - maxDrafts)) {
    storage.removeItem(draft.key);
  }
}

export function loadDraft(
  workspaceId: string | null | undefined,
  threadId: string | null
): DraftData | null {
  const storage = getStorage();
  if (!storage || !workspaceId) {
    return null;
  }

  const key = draftKey(workspaceId, threadId);

  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }

    const draft = parseDraft(raw);
    if (!draft) {
      storage.removeItem(key);
      return null;
    }

    return draft;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeDraft(
  workspaceId: string | null | undefined,
  threadId: string | null,
  text: string,
  attachments: Attachment[]
): DraftData | null {
  const storage = getStorage();
  if (!storage || !workspaceId) {
    return null;
  }

  const key = draftKey(workspaceId, threadId);
  const serializedAttachments = serializeAttachments(attachments);
  if (!text.trim() && serializedAttachments.length === 0) {
    storage.removeItem(key);
    return null;
  }

  const draft: DraftData = {
    text,
    attachments: serializedAttachments,
    savedAt: Date.now(),
  };

  try {
    storage.setItem(key, JSON.stringify(draft));
    evictOldDrafts(storage, MAX_DRAFTS);
    return draft;
  } catch (error) {
    console.warn('Failed to persist draft', error);
    return null;
  }
}

export function removeDraft(workspaceId: string | null | undefined, threadId: string | null) {
  const storage = getStorage();
  if (!storage || !workspaceId) {
    return;
  }

  storage.removeItem(draftKey(workspaceId, threadId));
}

export function loadDeliveryDraft(
  workspaceId: string | null | undefined,
  threadId: string | null
): DeliveryDraftData | null {
  const storage = getStorage();
  if (!storage || !workspaceId) {
    return null;
  }

  const key = deliveryDraftKey(workspaceId, threadId);

  try {
    const raw = storage.getItem(key);
    if (!raw) {
      return null;
    }

    const draft = parseDeliveryDraft(raw);
    if (!draft) {
      storage.removeItem(key);
      return null;
    }

    return draft;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeDeliveryDraft(
  workspaceId: string | null | undefined,
  threadId: string | null,
  clientMessageId: string,
  text: string,
  attachments: Attachment[],
  acceptedAt: number | null = null
): DeliveryDraftData | null {
  const storage = getStorage();
  if (!storage || !workspaceId || !clientMessageId) {
    return null;
  }

  const key = deliveryDraftKey(workspaceId, threadId);
  const serializedAttachments = serializeAttachments(attachments);
  if (!text.trim() && serializedAttachments.length === 0) {
    storage.removeItem(key);
    return null;
  }

  const draft: DeliveryDraftData = {
    text,
    attachments: serializedAttachments,
    savedAt: Date.now(),
    clientMessageId,
    acceptedAt,
  };

  try {
    storage.setItem(key, JSON.stringify(draft));
    return draft;
  } catch (error) {
    console.warn('Failed to persist delivery draft', error);
    return null;
  }
}

export function markDeliveryDraftAccepted(
  workspaceId: string | null | undefined,
  threadId: string | null,
  clientMessageId: string
): DeliveryDraftData | null {
  const draft = loadDeliveryDraft(workspaceId, threadId);
  if (!draft || draft.clientMessageId !== clientMessageId) {
    return null;
  }

  return writeDeliveryDraft(
    workspaceId,
    threadId,
    clientMessageId,
    draft.text,
    draft.attachments,
    Date.now()
  );
}

export function removeDeliveryDraft(
  workspaceId: string | null | undefined,
  threadId: string | null
) {
  const storage = getStorage();
  if (!storage || !workspaceId) {
    return;
  }

  storage.removeItem(deliveryDraftKey(workspaceId, threadId));
}

export function useDraftPersistence(workspaceId: string | undefined, threadId: string | null) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef<{ text: string; attachments: Attachment[] } | null>(null);

  const saveDraft = useCallback((text: string, attachments: Attachment[]) => {
    if (!workspaceId) {
      return;
    }

    latestRef.current = { text, attachments };

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      writeDraft(workspaceId, threadId, text, attachments);
      timerRef.current = null;
    }, 500);
  }, [threadId, workspaceId]);

  const flushDraft = useCallback((text: string, attachments: Attachment[]) => {
    if (!workspaceId) {
      return null;
    }

    latestRef.current = { text, attachments };

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    return writeDraft(workspaceId, threadId, text, attachments);
  }, [threadId, workspaceId]);

  const clearDraft = useCallback(() => {
    if (!workspaceId) {
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    latestRef.current = null;
    removeDraft(workspaceId, threadId);
  }, [threadId, workspaceId]);

  useEffect(() => {
    return () => {
      if (!workspaceId || !latestRef.current) {
        return;
      }

      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        writeDraft(
          workspaceId,
          threadId,
          latestRef.current.text,
          latestRef.current.attachments
        );
      }
    };
  }, [threadId, workspaceId]);

  return { saveDraft, flushDraft, clearDraft };
}
