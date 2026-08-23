/**
 * Cloudflare Email Sending proxy for sandbox containers.
 *
 * - Trusted only when forwarded through sandbox-host (x-sandbox-secret auth)
 * - Rate-limited per workspace (hourly + daily sliding windows via WorkspaceDO)
 * - Recipients must be workspace members (email whitelist)
 */

import type { RouteContext } from '../types.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import { getWorkspaceStub, getUserStub, getOrgStub } from '../helpers/stubs.js';
import { buildWorkspaceEmailSenderAddress, getWorkspaceEmailDomain } from '../../../../src/lib/workspace-email.js';
import { getBillingPlanLimits } from '../../../../src/lib/billing-plans.js';
import {
  appendEmailThreadReferenceIds,
  buildEmailReplyHeaders,
  EMAIL_REPLY_REFERENCE_TTL_SECONDS,
  getEmailReplyReferenceKey,
  getEmailThreadReferencesKey,
} from '../channels.js';
import type { OrgThread } from '../identity/org-do.js';
import { isSelfhostRuntime } from '../../../../src/lib/selfhost-runtime.js';
import { SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE } from '../../../../src/lib/selfhost-capabilities.js';
import { resolveEmailBinding } from '../binding-facades/managed.js';

// ---------------------------------------------------------------------------
// Rate limit constants
// ---------------------------------------------------------------------------

const RATE_LIMIT_HOURLY = 50;
const RATE_LIMIT_DAILY = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

interface EmailSendProxyRequest {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
}

type EmailSendBody = {
  from: string;
  to: string[];
  subject: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  headers?: Record<string, string>;
  text?: string;
  html?: string;
};

/**
 * Extract a bare email address from a potentially formatted recipient string
 * like `"Name <email@example.com>"` or just `"email@example.com"`.
 *
 * Returns null if the string contains commas or multiple angle-bracket groups,
 * which could be an attempt to smuggle extra addresses past whitelist validation.
 */
function extractEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes(',')) return null;

  const angleBrackets = trimmed.match(/<[^>]+>/g);
  if (angleBrackets && angleBrackets.length > 1) return null;

  const match = trimmed.match(/<([^>]+)>/);
  return (match ? match[1] : trimmed).trim().toLowerCase();
}

function normalizeRecipients(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const email = extractEmail(value);
    return email ? [email] : null;
  }
  if (
    Array.isArray(value) &&
    value.every((e): e is string => typeof e === 'string')
  ) {
    const emails = value.map((e) => extractEmail(e));
    if (emails.some((e) => e === null)) return null;
    return emails as string[];
  }
  return null; // invalid type
}

// ---------------------------------------------------------------------------
// Workspace member email resolution
// ---------------------------------------------------------------------------

async function getWorkspaceMemberEmails(
  env: RouteContext['env'],
  workspaceId: string
): Promise<Set<string>> {
  const workspaceStub = getWorkspaceStub(env, workspaceId);
  const workspaceInfo = await workspaceStub.getInfo();
  if (!workspaceInfo || workspaceInfo.archived) return new Set();

  const orgStub = getOrgStub(env, workspaceInfo.org_id);
  const members = await orgStub.listWorkspaceMembers(workspaceId);
  const activeMembers = members.filter((m) => m.access_level !== 'none');

  console.log(`[EmailSendProxy] workspace=${workspaceId} members=${members.length} active=${activeMembers.length}`);

  const emails = await Promise.all(
    activeMembers.map(async (member) => {
      try {
        const userStub = getUserStub(env, member.user_id);
        const profile = await userStub.getProfile();
        const email = profile?.email?.toLowerCase() ?? null;
        if (!email) {
          console.warn(`[EmailSendProxy] user=${member.user_id} profile has no email (profile=${profile ? 'exists' : 'null'})`);
        }
        return email;
      } catch (err) {
        console.error(`[EmailSendProxy] failed to resolve email for user=${member.user_id}:`, err);
        return null;
      }
    })
  );

  const emailSet = new Set(emails.filter((e): e is string => e !== null));
  console.log(`[EmailSendProxy] allowed emails: [${[...emailSet].join(', ')}]`);
  return emailSet;
}

async function getWorkspaceThread(
  env: RouteContext['env'],
  orgId: string,
  workspaceId: string,
  threadId: string | undefined,
): Promise<OrgThread | null> {
  if (!threadId) return null;
  const thread = await getOrgStub(env, orgId).getThread(threadId);
  if (!thread || thread.workspace_id !== workspaceId) return null;
  return thread;
}

async function readEmailThreadReferenceIds(
  env: RouteContext['env'],
  workspaceId: string,
  threadId: string,
  thread: OrgThread | null,
): Promise<string[]> {
  let rawReferences: string | null = null;
  try {
    rawReferences = await env.APP_KV.get(
      getEmailThreadReferencesKey(workspaceId, threadId),
    );
  } catch (error) {
    console.error('[email-send-proxy] failed to read email thread metadata', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId,
      threadId,
    });
    return [];
  }

  if (rawReferences) {
    try {
      const parsed = JSON.parse(rawReferences);
      if (Array.isArray(parsed)) {
        const ids = appendEmailThreadReferenceIds(
          parsed.filter((value): value is string => typeof value === 'string'),
        );
        if (ids.length > 0) return ids;
      }
    } catch {
      // Ignore malformed KV data and fall back to real channel metadata.
    }
  }

  if (
    thread?.source?.trim() !== 'channel' ||
    thread.channel_kind !== 'email' ||
    !thread.channel_message_id
  ) {
    return [];
  }
  return appendEmailThreadReferenceIds([], thread?.channel_message_id);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /api/email/send
 */
export async function handleEmailSendProxy({ req, env }: RouteContext): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  // 1. Sandbox proxy auth
  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return errorResponse('Unauthorized: sandbox proxy auth required', 401);
  }

  const { orgId, workspaceId } = proxyAuth;

  if (isSelfhostRuntime(env)) {
    return errorResponse(SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE, 503);
  }

  const orgInfo = await getOrgStub(env, orgId).getInfo();
  if (
    !orgInfo ||
    !getBillingPlanLimits(orgInfo.billing_plan, orgInfo.billing_status)
      .emailInbox
  ) {
    return errorResponse('Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan', 403);
  }

  // 2. Require Cloudflare Email Sending binding
  const email = resolveEmailBinding(env);
  if (!email) {
    return errorResponse('Cloudflare Email Sending binding EMAIL is not configured', 503);
  }

  // 3. Parse request body
  let payload: EmailSendProxyRequest;
  try {
    payload = (await req.json()) as EmailSendProxyRequest;
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!payload.to || !payload.subject) {
    return errorResponse('Missing required fields: to, subject', 400);
  }

  // 4. Collect all recipient emails
  const toEmails = normalizeRecipients(payload.to);
  const ccEmails = normalizeRecipients(payload.cc);
  const bccEmails = normalizeRecipients(payload.bcc);
  if (toEmails === null || ccEmails === null || bccEmails === null) {
    return errorResponse('Invalid recipient field: to, cc, and bcc must be strings or arrays of strings', 400);
  }
  if (payload.reply_to !== undefined && typeof payload.reply_to !== 'string') {
    return errorResponse('Invalid reply_to field: reply_to must be a string', 400);
  }
  const allRecipients = [...toEmails, ...ccEmails, ...bccEmails];

  if (allRecipients.length === 0) {
    return errorResponse('No recipients specified', 400);
  }

  // 5. Resolve workspace from address
  const workspaceStubForInfo = getWorkspaceStub(env, workspaceId);
  const workspaceInfo = await workspaceStubForInfo.getInfo();
  const emailDomain = getWorkspaceEmailDomain(env);
  if (!workspaceInfo?.email_handle || !emailDomain) {
    return errorResponse('Workspace email not configured', 503);
  }
  const workspaceFromAddress = buildWorkspaceEmailSenderAddress(
    workspaceInfo.email_handle,
    emailDomain,
  );
  const workspaceThread = await getWorkspaceThread(
    env,
    orgId,
    workspaceId,
    proxyAuth.threadId,
  );
  const emailReferenceIds =
    proxyAuth.threadId && workspaceThread
      ? await readEmailThreadReferenceIds(
          env,
          workspaceId,
          proxyAuth.threadId,
          workspaceThread,
        )
      : [];
  const emailReplyHeaders = emailReferenceIds.length > 0
    ? buildEmailReplyHeaders({
        inReplyToMessageId: emailReferenceIds[emailReferenceIds.length - 1],
        referenceMessageIds: emailReferenceIds,
      })
    : undefined;

  // 6. Validate recipients against workspace member whitelist
  console.log(`[EmailSendProxy] validating recipients: [${allRecipients.join(', ')}] workspace=${workspaceId}`);
  const allowedEmails = await getWorkspaceMemberEmails(env, workspaceId);
  const disallowed = allRecipients.filter((email) => !allowedEmails.has(email));
  if (disallowed.length > 0) {
    console.warn(`[EmailSendProxy] rejected recipients: [${disallowed.join(', ')}] allowed: [${[...allowedEmails].join(', ')}]`);
    return errorResponse(
      `Recipients not in workspace: ${disallowed.join(', ')}. Only workspace members can be emailed.`,
      403
    );
  }

  // 7. Rate limit check (atomic inside WorkspaceDO)
  const workspaceStub = getWorkspaceStub(env, workspaceId);
  const rateCheck = await workspaceStub.checkAndRecordEmailSendRateLimit(
    allRecipients.length,
    RATE_LIMIT_HOURLY,
    RATE_LIMIT_DAILY
  );
  if (!rateCheck.allowed) {
    return errorResponse(rateCheck.reason!, 429);
  }

  const sendBody: EmailSendBody = {
    from: workspaceFromAddress,
    to: toEmails,
    ...(ccEmails.length > 0 ? { cc: ccEmails } : {}),
    ...(bccEmails.length > 0 ? { bcc: bccEmails } : {}),
    ...(payload.reply_to ? { replyTo: payload.reply_to } : {}),
    ...(emailReplyHeaders ? { headers: emailReplyHeaders } : {}),
    subject: payload.subject,
    ...(payload.text ? { text: payload.text } : {}),
    ...(payload.html ? { html: payload.html } : {}),
  };

  // 8. Send through Cloudflare Email Sending (always from workspace address)
  let emailResult: { messageId?: string };
  try {
    emailResult = await email.send(sendBody);
  } catch (error) {
    console.error('[email-send-proxy] upstream error', {
      error: error instanceof Error ? error.message : String(error),
      orgId,
      workspaceId,
    });
    return errorResponse('Failed to send email', 502);
  }

  if (proxyAuth.threadId && workspaceThread && emailResult.messageId) {
    const nextReferenceIds = appendEmailThreadReferenceIds(
      emailReferenceIds,
      emailResult.messageId,
    );
    await Promise.all([
      env.APP_KV.put(
        getEmailReplyReferenceKey(workspaceId, emailResult.messageId),
        proxyAuth.threadId,
        { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
      ),
      nextReferenceIds.length > 0
        ? env.APP_KV.put(
            getEmailThreadReferencesKey(workspaceId, proxyAuth.threadId),
            JSON.stringify(nextReferenceIds),
            { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
          )
        : Promise.resolve(),
    ]).catch((error) => {
      console.error('[email-send-proxy] failed to persist email thread metadata', {
        error: error instanceof Error ? error.message : String(error),
        orgId,
        workspaceId,
        threadId: proxyAuth.threadId,
        messageId: emailResult.messageId,
      });
    });
  }

  return jsonResponse({ id: emailResult.messageId, from: workspaceFromAddress }, 200);
}
