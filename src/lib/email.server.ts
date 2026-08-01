import type { CloudflareEnv } from './cloudflare.server';
import type { ReactElement } from 'react';
import { sendEmail as sendCloudflareEmail } from './cloudflare-email.server';
import {
  recordDevEmailOutboxEntry,
  type DevEmailOutboxStatus,
  type DevEmailOutboxTransport,
} from './dev-email-outbox';
import { isSelfhostRuntime } from './selfhost-runtime';
import { SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE } from './selfhost-capabilities';

export type EmailDeliveryStatus = 'sent' | 'skipped' | 'failed';

export interface EmailDeliveryResult {
  status: EmailDeliveryStatus;
  reason?: string;
}

type EmailEnvBindings = Pick<CloudflareEnv, 'EMAIL' | 'EMAIL_FROM_ADDRESS'> &
  Partial<
    Pick<
      CloudflareEnv,
      'APP_KV' | 'NEXTJS_ENV' | 'CF_ACCOUNT_ID' | 'CF_DISPATCH_NAMESPACE'
    >
  >;

interface OrgInvitationEmailArgs {
  env: EmailEnvBindings;
  to: string;
  orgName: string;
  inviterName: string | null;
  role: string;
  invitationUrl: string;
  expiresAt: number;
}

interface EmailVerificationEmailArgs {
  env: EmailEnvBindings;
  to: string;
  verificationUrl: string;
  expiresAt: number;
}

interface ScheduledPromptPausedEmailArgs {
  env: EmailEnvBindings;
  to: string;
  scheduleName: string;
  workspaceName: string | null;
  billingError: string;
  automationsUrl: string | null;
}

interface HelpConfirmationEmailArgs {
  env: EmailEnvBindings;
  to: string;
  firstName: string;
  userEmail: string;
  category: string;
  severity: string;
  subject: string;
  description: string;
  cc?: string;
  replyTo?: string;
}

interface HelpSupportEmailArgs {
  env: EmailEnvBindings;
  to: string;
  userName: string | null;
  userEmail: string;
  userId: string;
  orgName: string;
  orgSlug: string;
  orgId: string;
  billingPlan: string;
  billingStatus: string;
  workspaceName: string | null;
  workspaceId: string | null;
  pageUrl: string | null;
  category: string;
  severity: string;
  subject: string;
  description: string;
  submittedAt: string;
  userAgent: string | null;
  screenSize: string | null;
  referer: string | null;
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function roleLabel(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'admin') return 'Admin';
  if (normalized === 'member') return 'Member';
  if (normalized === 'viewer') return 'Viewer';
  return role;
}

export function resolveAppBaseUrl(
  env: Pick<CloudflareEnv, 'WORKER_BASE_URL'>,
  requestUrl: URL
): string {
  const configured = env.WORKER_BASE_URL?.trim();
  if (!configured) {
    return requestUrl.origin;
  }

  try {
    return normalizeBaseUrl(new URL(configured).toString());
  } catch {
    return requestUrl.origin;
  }
}

export function buildInvitationUrl(baseUrl: string, orgId: string, invitationId: string): string {
  return new URL(`/invitations/${orgId}/${invitationId}`, normalizeBaseUrl(baseUrl)).toString();
}

function formatExpiration(expiresAt: number): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    return 'soon';
  }
  return date.toUTCString();
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeOptionalEmail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function supportCategoryTag(category: string): string {
  const normalized = category.trim().toLowerCase();
  if (normalized.startsWith('bug')) return 'Bug';
  if (normalized.startsWith('feature')) return 'Feature';
  if (normalized.includes('billing')) return 'Billing';
  if (normalized.startsWith('question')) return 'Question';
  return 'Other';
}

function supportSeverityTag(severity: string): string {
  const normalized = severity.trim().toLowerCase();
  if (normalized === 'high') return 'High';
  if (normalized === 'medium') return 'Medium';
  return 'Low';
}

async function renderEmailElement(element: ReactElement): Promise<{ htmlBody: string; textBody: string }> {
  const { render, toPlainText } = await import('@react-email/render');
  const htmlBody = await render(element);
  const textBody = toPlainText(htmlBody);
  return { htmlBody, textBody };
}

async function finalizeEmailDelivery(
  env: EmailEnvBindings,
  email: {
    to: string;
    cc?: string;
    replyTo?: string;
    subject: string;
    textBody: string;
    htmlBody: string;
  },
  result: { status: DevEmailOutboxStatus; reason?: string },
  transport: DevEmailOutboxTransport
): Promise<EmailDeliveryResult> {
  await recordDevEmailOutboxEntry(env, {
    to: email.to,
    cc: email.cc,
    replyTo: email.replyTo,
    subject: email.subject,
    textBody: email.textBody,
    htmlBody: email.htmlBody,
    status: result.status,
    reason: result.reason,
    transport,
  });
  return result;
}

async function deliverEmail({
  env,
  to,
  cc,
  replyTo,
  subject,
  htmlBody,
  textBody,
}: {
  env: EmailEnvBindings;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}): Promise<EmailDeliveryResult> {
  const normalizedCc = normalizeOptionalEmail(cc);
  const normalizedReplyTo = normalizeOptionalEmail(replyTo);
  const emailContent = {
    to,
    cc: normalizedCc,
    replyTo: normalizedReplyTo,
    subject,
    textBody,
    htmlBody,
  };

  if (isSelfhostRuntime(env)) {
    return finalizeEmailDelivery(
      env,
      emailContent,
      {
        status: 'skipped',
        reason: SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE,
      },
      'none'
    );
  }

  if (!env.EMAIL) {
    return finalizeEmailDelivery(
      env,
      emailContent,
      {
        status: 'skipped',
        reason: 'Cloudflare Email Sending binding EMAIL is not configured',
      },
      'none'
    );
  }

  const from = env.EMAIL_FROM_ADDRESS?.trim();
  if (!from) {
    return finalizeEmailDelivery(
      env,
      emailContent,
      {
        status: 'skipped',
        reason: 'EMAIL_FROM_ADDRESS is not configured',
      },
      'none'
    );
  }

  const result = await sendCloudflareEmail(
    {
      email: env.EMAIL,
      fromAddress: sanitizeHeaderValue(from),
    },
    {
      to,
      cc: normalizedCc,
      replyTo: normalizedReplyTo,
      subject,
      textBody,
      htmlBody,
    }
  );
  if (result.success) {
    return finalizeEmailDelivery(env, emailContent, { status: 'sent' }, 'cloudflare_email');
  }
  return finalizeEmailDelivery(
    env,
    emailContent,
    { status: 'failed', reason: result.error },
    'cloudflare_email'
  );
}

export async function sendOrgInvitationEmail({
  env,
  to,
  orgName,
  inviterName,
  role,
  invitationUrl,
  expiresAt,
}: OrgInvitationEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const inviter = inviterName?.trim() || 'A team member';
  const subject = sanitizeHeaderValue(`You're invited to join ${orgName} on camelAI`);
  const expiration = formatExpiration(expiresAt);
  const displayRole = roleLabel(role);

  const [{ createElement }, { OrgInvitationEmailTemplate }] = await Promise.all([
    import('react'),
    import('./email/templates/org-invitation-email'),
  ]);
  const { htmlBody, textBody } = await renderEmailElement(
    createElement(OrgInvitationEmailTemplate, {
      orgName,
      inviterName: inviter,
      role: displayRole,
      invitationUrl,
      expirationLabel: expiration,
    })
  );

  return deliverEmail({
    env,
    to: normalizedTo,
    subject,
    htmlBody,
    textBody,
  });
}

export async function sendEmailVerificationEmail({
  env,
  to,
  verificationUrl,
  expiresAt,
}: EmailVerificationEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const subject = sanitizeHeaderValue('Verify your email for camelAI');
  const expiration = formatExpiration(expiresAt);

  const [{ createElement }, { EmailVerificationEmailTemplate }] = await Promise.all([
    import('react'),
    import('./email/templates/email-verification-email'),
  ]);
  const { htmlBody, textBody } = await renderEmailElement(
    createElement(EmailVerificationEmailTemplate, {
      verificationUrl,
      expirationLabel: expiration,
    })
  );

  return deliverEmail({
    env,
    to: normalizedTo,
    subject,
    htmlBody,
    textBody,
  });
}

export async function sendScheduledPromptPausedEmail({
  env,
  to,
  scheduleName,
  workspaceName,
  billingError,
  automationsUrl,
}: ScheduledPromptPausedEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const subject = sanitizeHeaderValue(
    `Your scheduled prompt "${scheduleName}" was paused after billing failures`
  );
  const normalizedBillingError = truncateWithEllipsis(billingError.trim(), 500);

  const [{ createElement }, { ScheduledPromptPausedEmailTemplate }] = await Promise.all([
    import('react'),
    import('./email/templates/scheduled-prompt-paused-email'),
  ]);
  const { htmlBody, textBody } = await renderEmailElement(
    createElement(ScheduledPromptPausedEmailTemplate, {
      scheduleName,
      workspaceName,
      billingError: normalizedBillingError,
      automationsUrl,
    })
  );

  return deliverEmail({
    env,
    to: normalizedTo,
    subject,
    htmlBody,
    textBody,
  });
}

export async function sendHelpConfirmationEmail({
  env,
  to,
  firstName,
  userEmail,
  category,
  severity,
  subject,
  description,
  cc,
  replyTo,
}: HelpConfirmationEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const normalizedFirstName = firstName.trim() || 'there';
  const normalizedSubjectText = subject.trim() || category;
  const emailSubject = sanitizeHeaderValue(
    `We received your request - ${normalizedSubjectText}`
  );
  const normalizedDescription = truncateWithEllipsis(description.trim(), 500);

  const [{ createElement }, { HelpConfirmationEmailTemplate }] = await Promise.all([
    import('react'),
    import('./email/templates/help-confirmation-email'),
  ]);
  const { htmlBody, textBody } = await renderEmailElement(
    createElement(HelpConfirmationEmailTemplate, {
      firstName: normalizedFirstName,
      userEmail,
      category,
      severity,
      description: normalizedDescription,
    })
  );

  return deliverEmail({
    env,
    to: normalizedTo,
    cc,
    replyTo,
    subject: emailSubject,
    htmlBody,
    textBody,
  });
}

export async function sendHelpSupportEmail({
  env,
  to,
  userName,
  userEmail,
  userId,
  orgName,
  orgSlug,
  orgId,
  billingPlan,
  billingStatus,
  workspaceName,
  workspaceId,
  pageUrl,
  category,
  severity,
  subject,
  description,
  submittedAt,
  userAgent,
  screenSize,
  referer,
}: HelpSupportEmailArgs): Promise<EmailDeliveryResult> {
  const normalizedTo = to.trim().toLowerCase();
  const userDisplayName = userName?.trim() || userEmail;
  const severityTag = supportSeverityTag(severity);
  const categoryTag = supportCategoryTag(category);
  const normalizedSubjectText = subject.trim() || category;
  const emailSubject = sanitizeHeaderValue(
    `[${severityTag}] [${categoryTag}] ${normalizedSubjectText} - ${userDisplayName} (${orgSlug})`
  );

  const [{ createElement }, { HelpSupportEmailTemplate }] = await Promise.all([
    import('react'),
    import('./email/templates/help-support-email'),
  ]);
  const { htmlBody, textBody } = await renderEmailElement(
    createElement(HelpSupportEmailTemplate, {
      userName,
      userEmail,
      userId,
      orgName,
      orgSlug,
      orgId,
      billingPlan,
      billingStatus,
      workspaceName,
      workspaceId,
      pageUrl,
      category,
      severity: severityTag,
      subject: normalizedSubjectText,
      description,
      submittedAt,
      userAgent,
      screenSize,
      referer,
    })
  );

  return deliverEmail({
    env,
    to: normalizedTo,
    subject: emailSubject,
    htmlBody,
    textBody,
  });
}
