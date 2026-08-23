/**
 * Integration OAuth routes
 * Supports: Slack, Notion
 */

import type { RouteContext } from "../types.js";
import {
  createIntegrationOAuthState,
  validateAndConsumeIntegrationOAuthState,
  type IntegrationOAuthState,
} from "../integration-oauth-state.js";
import { INTEGRATION_REGISTRY } from "../../../../src/lib/integration-registry.js";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../src/lib/integration-crypto.js";
import { requireSession } from "../helpers/auth.js";
import { completeConnectionSetupPromptContext } from "../connection-setup-completion.js";
import { getOrgStub } from "../helpers/stubs.js";
import { redirect, text } from "../helpers/response.js";
import { sanitizeOAuthRedirectPath as sanitizeRedirectPath } from "./oauth-helpers.js";
import type { SlackEventCallbackPayload } from "../slack-types.js";
import { isOrgBanned } from "../ban-list.js";
import {
  enqueueChannelMessage,
  getChannelThreadMapKey,
  getChannelDedupeKey,
  getOrCreateChannelThread,
} from "../channels.js";
import { buildWorkspaceScopedR2Key } from "../../../../src/lib/workspace-r2-paths.js";
import type { TelegramChatBinding } from "../../../../src/lib/telegram-channel.js";
import { transcribeAudioBytes } from "../audio-transcription.js";
import {
  getSlackTeamRegistryStub,
  getTelegramRegistryStub,
  type SlackTeamInstallationRecord,
} from "../channel-registries.js";
import {
  buildRemoteMcpAuthorizationUrl,
  createPkceChallenge,
  createPkceVerifier,
  discoverRemoteMcpOAuth,
  exchangeRemoteMcpOAuthCode,
  registerRemoteMcpOAuthClient,
  RemoteMcpOAuthError,
} from "../remote-mcp-oauth.js";
import { getAppIndexReadDatabase } from "../app-index-db.js";
import type { OrgDO } from "../auth.js";
import type { WorkspaceIntegrationRecord } from "../workspace.js";
import { resolveQueueBinding } from "../binding-facades/managed.js";
import { resolveObjectStore } from "../binding-facades/object-store.js";

interface SlackCredentials {
  access_token?: string;
  bot_user_id?: string;
  team_id?: string;
}

interface SlackResolvedInstallation {
  workspaceId: string;
  orgId: string;
  teamId: string;
  integrationId: string;
  botUserId?: string;
  accessToken: string;
}

const SLACK_EVENT_DEDUPE_PREFIX = "slack_event:";
const SLACK_MESSAGE_DEDUPE_PREFIX = "slack_message:";
const SLACK_EVENT_DEDUPE_TTL_SECONDS = 10 * 60;
const SLACK_EVENT_FILE_MAX_BYTES = 25 * 1024 * 1024;
const TELEGRAM_EVENT_DEDUPE_TTL_SECONDS = 10 * 60;
const TELEGRAM_FILE_MAX_BYTES = 25 * 1024 * 1024;
const WORKSPACE_ORG_INDEX_PREFIX = "workspace_org:";

async function getWorkspaceOrgId(
  env: RouteContext["env"],
  workspaceId: string,
): Promise<string | null> {
  const indexed = await env.APP_KV.get(`${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`);
  if (indexed) return indexed;
  const appIndex = getAppIndexReadDatabase(env);
  const orgId = appIndex ? await appIndex.getWorkspaceOrgId(workspaceId) : null;
  if (orgId) {
    await env.APP_KV.put(`${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`, orgId);
  }
  return orgId;
}

async function getWorkspaceOrgStub(
  env: RouteContext["env"],
  workspaceId: string,
): Promise<{ orgId: string; orgStub: OrgDO } | null> {
  const orgId = await getWorkspaceOrgId(env, workspaceId);
  if (!orgId) return null;
  return {
    orgId,
    orgStub: getOrgStub(env, orgId) as unknown as OrgDO,
  };
}

async function getWorkspaceIntegration(
  env: RouteContext["env"],
  workspaceId: string,
  integrationId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const owner = await getWorkspaceOrgStub(env, workspaceId);
  if (!owner) return null;
  return owner.orgStub.getWorkspaceIntegration(workspaceId, integrationId);
}

export class SlackChannelBusyError extends Error {
  constructor(message = "Slack channel thread is busy") {
    super(message);
    this.name = "SlackChannelBusyError";
  }
}

interface TelegramUpdatePayload {
  update_id?: number;
  message?: TelegramMessagePayload;
}

interface TelegramMessagePayload {
  message_id?: number;
  text?: string;
  caption?: string;
  chat?: {
    id?: number | string;
    type?: string;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  from?: {
    id?: number | string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  photo?: Array<{
    file_id?: string;
    file_size?: number;
    width?: number;
    height?: number;
  }>;
  voice?: {
    file_id?: string;
    duration?: number;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id?: string;
    duration?: number;
    performer?: string;
    title?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video?: {
    file_id?: string;
    width?: number;
    height?: number;
    duration?: number;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  video_note?: {
    file_id?: string;
    length?: number;
    duration?: number;
    file_size?: number;
  };
}

function getSlackMappingRootTs(
  event: NonNullable<SlackEventCallbackPayload["event"]>,
  isDm: boolean,
): string {
  const explicitThreadTs = (event.thread_ts || "").trim();
  if (explicitThreadTs) return explicitThreadTs;
  if (isDm) return "dm";
  return (event.ts || "").trim();
}

function getSlackMessageDedupeKey(
  payload: SlackEventCallbackPayload,
): string | null {
  const event = payload.event;
  const teamId = payload.team_id?.trim();
  if (!event || !teamId) return null;
  if (event.type !== "message" && event.type !== "app_mention") return null;
  if (event.subtype) return null;

  const channelId = event.channel?.trim() || "";
  const userId = event.user?.trim() || "";
  const eventTs = (event.ts || "").trim();
  if (!channelId || !userId || !eventTs) return null;

  // Slack may emit both app_mention and message.* for a single @mention post.
  // Dedupe by message identity (not event_id) so we only process once.
  return `${SLACK_MESSAGE_DEDUPE_PREFIX}${teamId}:${channelId}:${userId}:${eventTs}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function verifySlackSignature(
  req: Request,
  rawBody: string,
  signingSecret: string,
): Promise<boolean> {
  const signature = req.headers.get("x-slack-signature") || "";
  const timestampHeader = req.headers.get("x-slack-request-timestamp") || "";
  const timestamp = Number(timestampHeader);

  if (!signature || !timestampHeader || !Number.isFinite(timestamp)) {
    return false;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowInSeconds - timestamp) > 60 * 5) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const base = `v0:${timestampHeader}:${rawBody}`;
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  const digest = `v0=${Array.from(new Uint8Array(signed))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
  return timingSafeEqual(digest, signature);
}

function toSlackJsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chooseSlackInstallationCandidates(
  records: SlackTeamInstallationRecord[],
  authorizations: Array<{ user_id?: string }> | undefined,
): SlackTeamInstallationRecord[] {
  if (!authorizations || authorizations.length === 0) return records;
  const botUserIds = new Set(
    authorizations
      .map((entry) => entry.user_id)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
  );
  if (botUserIds.size === 0) return records;

  const preferred = records.filter(
    (record) => record.bot_user_id && botUserIds.has(record.bot_user_id),
  );
  if (preferred.length > 0) return preferred;
  return records;
}

function normalizeSlackMessageText(
  rawText: string,
  botUserId?: string,
): string {
  let text = rawText.trim();
  if (botUserId) {
    const mention = new RegExp(`<@${botUserId}>`, "g");
    text = text.replace(mention, "").trim();
  }
  return text;
}

/**
 * Complete a chat connection setup prompt after OAuth succeeds.
 */
export async function completeConnectionSetupPrompt(
  env: RouteContext["env"],
  stateData: IntegrationOAuthState,
  integrationId: string,
  integrationType: string,
  integrationName: string,
): Promise<boolean> {
  const chatRequestId = stateData.extra_config?.chat_request_id;
  const chatThreadId = stateData.extra_config?.chat_thread_id;
  if (typeof chatRequestId !== "string" || typeof chatThreadId !== "string") {
    return false;
  }

  return completeConnectionSetupPromptContext(
    env,
    {
      requestId: chatRequestId,
      threadId: chatThreadId,
    },
    integrationId,
    integrationType,
    integrationName,
  );
}

export function buildConnectionSetupOAuthExtraConfig(
  reauthIntegrationId: string | undefined,
  chatRequestId: string | null,
  chatThreadId: string | null,
): Record<string, unknown> | undefined {
  const extraConfig: Record<string, unknown> = {};
  if (reauthIntegrationId) {
    extraConfig.reauth_integration_id = reauthIntegrationId;
  }
  if (chatRequestId && chatThreadId) {
    extraConfig.chat_request_id = chatRequestId;
    extraConfig.chat_thread_id = chatThreadId;
  }
  return Object.keys(extraConfig).length > 0 ? extraConfig : undefined;
}

export function hasConnectionSetupPromptContext(stateData: IntegrationOAuthState): boolean {
  return Boolean(
    typeof stateData.extra_config?.chat_request_id === "string" &&
      typeof stateData.extra_config?.chat_thread_id === "string",
  );
}

export function integrationOAuthCallbackUrl(url: URL, integrationType: string): string {
  return new URL(
    `/api/integrations/${encodeURIComponent(integrationType)}/callback`,
    url.origin,
  ).toString();
}

function reauthIntegrationId(stateData: IntegrationOAuthState): string | null {
  const value = stateData.extra_config?.reauth_integration_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalOAuthString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function remoteMcpOAuthStateValue(stateData: IntegrationOAuthState, key: string): string | null {
  const value = stateData.extra_config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function verifyWorkspaceManageConnectionsAccess(
  env: RouteContext["env"],
  workspaceId: string,
  userId: string,
): Promise<{ ok: true; orgId: string } | { ok: false; error: string }> {
  const owner = await getWorkspaceOrgStub(env, workspaceId);
  if (!owner) {
    return { ok: false, error: "workspace_not_found" };
  }
  const wsInfo = await owner.orgStub.getWorkspaceRecord(workspaceId);
  if (!wsInfo || wsInfo.archived) {
    return { ok: false, error: "workspace_not_found" };
  }

  const orgStub = owner.orgStub;
  if (!(await orgStub.isMember(userId))) {
    return { ok: false, error: "access_denied" };
  }

  const workspaceAccess = await orgStub.getWorkspaceAccess(workspaceId, userId);
  if (workspaceAccess !== "full") {
    return { ok: false, error: "access_denied" };
  }

  if (!(await orgStub.isAdmin(userId))) {
    return { ok: false, error: "admin_required" };
  }

  return { ok: true, orgId: owner.orgId };
}

// =============================================================================
// Remote MCP OAuth
// =============================================================================

export async function handleRemoteMcpOAuthStart({
  req,
  env,
  url,
}: RouteContext): Promise<Response> {
  const auth = await requireSession(req, env);
  if ("error" in auth)
    return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id)
    return redirect(`${url.origin}/connections?error=no_workspace`);

  const integrationId = url.searchParams.get("integration_id")?.trim();
  if (!integrationId) {
    return redirect(`${url.origin}/connections?error=oauth_invalid`);
  }

  const access = await verifyWorkspaceManageConnectionsAccess(env, session.workspace_id, session.user_id);
  if (!access.ok) {
    return redirect(`${url.origin}/connections?error=${access.error}`);
  }

  const integration = await getWorkspaceIntegration(env, session.workspace_id, integrationId);
  if (!integration || integration.integration_type !== "remote_mcp") {
    return redirect(`${url.origin}/connections?error=reauth_integration_not_found`);
  }

  const config = JSON.parse(integration.config || "{}") as Record<string, unknown>;
  if (config.auth_type !== "oauth" || typeof config.server_url !== "string") {
    return redirect(`${url.origin}/connections?error=oauth_invalid`);
  }

  try {
    const redirectTo = sanitizeRedirectPath(
      url.searchParams.get("redirect") || "/connections",
    );
    const chatRequestId = url.searchParams.get("chat_request_id");
    const chatThreadId = url.searchParams.get("chat_thread_id");
    const callbackUrl = `${url.origin}/api/integrations/remote_mcp/callback`;
    const discovery = await discoverRemoteMcpOAuth(config.server_url);
    const client = await registerRemoteMcpOAuthClient(discovery, callbackUrl);
    const codeVerifier = createPkceVerifier();
    const codeChallenge = await createPkceChallenge(codeVerifier);
    const state = await createIntegrationOAuthState(
      env.SESSIONS,
      "remote_mcp",
      session.workspace_id,
      session.user_id,
      redirectTo,
      {
        reauth_integration_id: integrationId,
        code_verifier: codeVerifier,
        oauth_client_id: client.client_id,
        oauth_client_secret: client.client_secret,
        oauth_token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
        oauth_token_endpoint: discovery.metadata.token_endpoint,
        oauth_authorization_server: discovery.authorizationServer,
        oauth_resource: discovery.resource,
        oauth_scope: discovery.scope,
        ...(chatRequestId && chatThreadId
          ? {
              chat_request_id: chatRequestId,
              chat_thread_id: chatThreadId,
            }
          : {}),
      },
    );

    return redirect(
      buildRemoteMcpAuthorizationUrl({
        discovery,
        client,
        redirectUri: callbackUrl,
        state,
        codeChallenge,
      }),
    );
  } catch (err) {
    console.error("[remote-mcp-oauth] OAuth start failed:", err, err instanceof RemoteMcpOAuthError ? err.details : undefined);
    const redirectUrl = new URL("/connections", url.origin);
    redirectUrl.searchParams.set("error", "oauth_config");
    if (err instanceof RemoteMcpOAuthError) {
      redirectUrl.searchParams.set("reason", err.code);
    }
    return redirect(redirectUrl.toString());
  }
}

export async function handleRemoteMcpOAuthCallback({
  env,
  url,
  ctx: _ctx,
}: RouteContext): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state)
    return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(
    env.SESSIONS,
    state,
  );
  if (!stateData || stateData.integration_type !== "remote_mcp") {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  const integrationId = reauthIntegrationId(stateData);
  const codeVerifier = remoteMcpOAuthStateValue(stateData, "code_verifier");
  const clientId = remoteMcpOAuthStateValue(stateData, "oauth_client_id");
  const tokenEndpoint = remoteMcpOAuthStateValue(stateData, "oauth_token_endpoint");
  const resource = remoteMcpOAuthStateValue(stateData, "oauth_resource");
  if (!integrationId || !codeVerifier || !clientId || !tokenEndpoint || !resource) {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  try {
    const access = await verifyWorkspaceManageConnectionsAccess(env, stateData.workspace_id, stateData.user_id);
    if (!access.ok) {
      return redirect(`${url.origin}/connections?error=${access.error}`);
    }

    const owner = await getWorkspaceOrgStub(env, stateData.workspace_id);
    if (!owner) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }
    const integration = await owner.orgStub.getWorkspaceIntegration(
      stateData.workspace_id,
      integrationId,
    );
    if (!integration || integration.integration_type !== "remote_mcp") {
      return redirect(`${url.origin}/connections?error=reauth_integration_not_found`);
    }

    const callbackUrl = `${url.origin}/api/integrations/remote_mcp/callback`;
    const tokenData = await exchangeRemoteMcpOAuthCode({
      tokenEndpoint,
      clientId,
      clientSecret: remoteMcpOAuthStateValue(stateData, "oauth_client_secret") ?? undefined,
      tokenEndpointAuthMethod: remoteMcpOAuthStateValue(stateData, "oauth_token_endpoint_auth_method") ?? "none",
      code,
      redirectUri: callbackUrl,
      codeVerifier,
      resource,
    });
    const tokenExpiresAt = Date.now() + (tokenData.expires_in ?? 3600) * 1000;
    const credentials = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type,
      scope: tokenData.scope ?? remoteMcpOAuthStateValue(stateData, "oauth_scope") ?? undefined,
      expires_at: tokenExpiresAt,
      oauth_client_id: clientId,
      oauth_client_secret: remoteMcpOAuthStateValue(stateData, "oauth_client_secret") ?? undefined,
      oauth_token_endpoint: tokenEndpoint,
      oauth_token_endpoint_auth_method: remoteMcpOAuthStateValue(stateData, "oauth_token_endpoint_auth_method") ?? "none",
      oauth_authorization_server: remoteMcpOAuthStateValue(stateData, "oauth_authorization_server") ?? undefined,
      oauth_resource: resource,
    };
    const encrypted = await encryptCredentials(
      credentials,
      env.INTEGRATION_SECRET_KEY,
    );

    await owner.orgStub.updateWorkspaceIntegration(
      stateData.workspace_id,
      integrationId,
      {
        credentialsEncrypted: encrypted,
        tokenExpiresAt,
      },
      stateData.user_id,
    );

    if (hasConnectionSetupPromptContext(stateData)) {
      await completeConnectionSetupPrompt(
        env,
        stateData,
        integrationId,
        "remote_mcp",
        integration.name,
      );
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set("success", "remote_mcp_connected");
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error("[remote-mcp-oauth] OAuth callback failed:", err);
    return redirect(`${url.origin}/connections?error=oauth_token_failed`);
  }
}

export async function handleSlackOAuthStart({
  req,
  env,
  url,
}: RouteContext): Promise<Response> {
  const slackDef = INTEGRATION_REGISTRY.slack;
  if (!slackDef?.oauthConfig || !env.SLACK_CLIENT_ID) {
    return text("Slack OAuth is not configured", 500);
  }

  const auth = await requireSession(req, env);
  if ("error" in auth)
    return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id)
    return redirect(`${url.origin}/connections?error=no_workspace`);

  const access = await verifyWorkspaceManageConnectionsAccess(env, session.workspace_id, session.user_id);
  if (!access.ok) {
    return redirect(`${url.origin}/connections?error=${access.error}`);
  }

  const redirectTo = sanitizeRedirectPath(
    url.searchParams.get("redirect") || "/connections",
  );
  const reauthIntegrationId = url.searchParams.get("integration_id")?.trim();
  const callbackUrl = `${url.origin}/api/integrations/slack/callback`;

  const chatRequestId = url.searchParams.get("chat_request_id");
  const chatThreadId = url.searchParams.get("chat_thread_id");

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    "slack",
    session.workspace_id,
    session.user_id,
    redirectTo,
    buildConnectionSetupOAuthExtraConfig(reauthIntegrationId, chatRequestId, chatThreadId),
  );

  const authUrl = new URL(slackDef.oauthConfig.authorizationUrl);
  authUrl.searchParams.set("client_id", env.SLACK_CLIENT_ID);
  authUrl.searchParams.set("scope", slackDef.oauthConfig.scopes.join(","));
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("state", state);

  return redirect(authUrl.toString());
}

export async function handleSlackOAuthCallback({
  env,
  url,
  ctx: _ctx,
}: RouteContext): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state)
    return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(
    env.SESSIONS,
    state,
  );
  if (!stateData || stateData.integration_type !== "slack") {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/slack/callback`;
    const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.SLACK_CLIENT_ID,
        client_secret: env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      token_type?: string;
      scope?: string;
      bot_user_id?: string | null;
      app_id?: string | null;
      team?: { id?: string | null; name?: string | null };
      authed_user?: { id?: string | null; access_token?: string | null };
    };

    if (!tokenData.ok || !tokenData.access_token) {
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access before creating integration.
    // User may have been removed, demoted, or workspace archived since OAuth started.
    const access = await verifyWorkspaceManageConnectionsAccess(
      env,
      stateData.workspace_id,
      stateData.user_id,
    );
    if (!access.ok) {
      return redirect(`${url.origin}/connections?error=${access.error}`);
    }

    const owner = await getWorkspaceOrgStub(env, stateData.workspace_id);
    if (!owner) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }
    const appId = optionalOAuthString(tokenData.app_id);
    const botUserId = optionalOAuthString(tokenData.bot_user_id);
    const teamId = optionalOAuthString(tokenData.team?.id);
    const teamName = optionalOAuthString(tokenData.team?.name);
    const authedUserId = optionalOAuthString(tokenData.authed_user?.id);
    const userAccessToken = optionalOAuthString(tokenData.authed_user?.access_token);

    const credentials = {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type,
      scope: tokenData.scope,
      bot_user_id: botUserId,
      app_id: appId,
      team_id: teamId,
      team_name: teamName,
      user_access_token: userAccessToken,
      authed_user_id: authedUserId,
    };

    const encrypted = await encryptCredentials(
      credentials,
      env.INTEGRATION_SECRET_KEY,
    );
    const slackConfig = {
      team_id: teamId ?? null,
      team_name: teamName ?? null,
      bot_user_id: botUserId ?? null,
    };
    const name = teamName || "Slack";
    const requestedReauthId = reauthIntegrationId(stateData);
    const existingIntegration = requestedReauthId
      ? await owner.orgStub.getWorkspaceIntegration(
          stateData.workspace_id,
          requestedReauthId,
        )
      : null;
    if (requestedReauthId && existingIntegration?.integration_type !== "slack") {
      return redirect(`${url.origin}/connections?error=reauth_integration_not_found`);
    }
    const integrationId = requestedReauthId ?? crypto.randomUUID();

    if (requestedReauthId) {
      await owner.orgStub.updateWorkspaceIntegration(
        stateData.workspace_id,
        requestedReauthId,
        { name, config: JSON.stringify(slackConfig), credentialsEncrypted: encrypted },
        stateData.user_id,
      );
    } else {
      await owner.orgStub.createWorkspaceIntegration(
        stateData.workspace_id,
        integrationId,
        "slack",
        name,
        "communication",
        "oauth2",
        JSON.stringify(slackConfig),
        encrypted,
        stateData.user_id,
      );
    }

    if (teamId) {
      const registry = getSlackTeamRegistryStub(env, teamId);
      await registry.upsertInstallation({
        workspace_id: stateData.workspace_id,
        org_id: access.orgId,
        integration_id: integrationId,
        team_id: teamId,
        bot_user_id: botUserId,
        updated_at: Date.now(),
      });
    }

    // Complete the waiting chat connection prompt if OAuth was started there.
    if (hasConnectionSetupPromptContext(stateData)) {
      await completeConnectionSetupPrompt(
        env,
        stateData,
        integrationId,
        "slack",
        name,
      );
    }

    // Sanitize redirect URL again as defense-in-depth
    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set("success", "slack_connected");
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error("[slack-oauth] OAuth callback failed:", err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

async function resolveSlackInstallationForEvent(
  env: RouteContext["env"],
  payload: SlackEventCallbackPayload,
): Promise<SlackResolvedInstallation> {
  const teamId = payload.team_id?.trim();
  if (!teamId) {
    throw new Error("Missing Slack team ID");
  }

  const registry = getSlackTeamRegistryStub(env, teamId);
  const stored = await registry.listInstallations();
  if (stored.length === 0) {
    throw new Error(`No Slack installation index found for team ${teamId}`);
  }

  const candidates = chooseSlackInstallationCandidates(
    stored,
    payload.authorizations,
  );
  const staleIntegrationIds = new Set<string>();

  for (const candidate of candidates) {
    const orgStub = getOrgStub(env, candidate.org_id) as unknown as OrgDO;
    const [wsInfo, integration] = await Promise.all([
      orgStub.getWorkspaceRecord(candidate.workspace_id),
      orgStub.getWorkspaceIntegration(candidate.workspace_id, candidate.integration_id),
    ]);

    if (!wsInfo || wsInfo.archived) {
      staleIntegrationIds.add(candidate.integration_id);
      continue;
    }
    if (!integration || integration.integration_type !== "slack") {
      staleIntegrationIds.add(candidate.integration_id);
      continue;
    }

    let credentials: SlackCredentials;
    try {
      credentials = await decryptCredentials<SlackCredentials>(
        integration.credentials_encrypted,
        env.INTEGRATION_SECRET_KEY,
      );
    } catch {
      continue;
    }

    if (credentials.team_id && credentials.team_id !== teamId) {
      continue;
    }

    const token =
      typeof credentials.access_token === "string"
        ? credentials.access_token
        : "";
    if (!token) continue;

    const botUserId =
      typeof credentials.bot_user_id === "string"
        ? credentials.bot_user_id
        : candidate.bot_user_id;

    return {
      workspaceId: candidate.workspace_id,
      orgId: candidate.org_id,
      teamId,
      integrationId: candidate.integration_id,
      botUserId,
      accessToken: token,
    };
  }

  if (staleIntegrationIds.size > 0) {
    const filtered = stored.filter(
      (record) => !staleIntegrationIds.has(record.integration_id),
    );
    await registry.replaceInstallations(filtered);
  }

  throw new Error(`No active Slack installation found for team ${teamId}`);
}

async function getOrCreateSlackThreadId(
  env: RouteContext["env"],
  args: {
    workspaceId: string;
    orgId: string;
    integrationId: string;
    teamId: string;
    channelId: string;
    rootTs: string;
    initialText: string;
    initialMessageId?: string | null;
  },
): Promise<string> {
  const title = args.initialText.trim().slice(0, 100) || "Slack conversation";
  const thread = await getOrCreateChannelThread(env, {
    kind: "slack",
    workspaceId: args.workspaceId,
    orgId: args.orgId,
    connectionId: args.integrationId,
    remoteConversationId: `${args.teamId}:${args.channelId}:${args.rootTs}`,
    title,
    createdBy: "slack",
    firstUserMessage: args.initialText,
    firstRemoteMessageId: args.initialMessageId || args.rootTs,
  });

  return thread.threadId;
}

async function getMappedSlackThreadId(
  env: RouteContext["env"],
  installation: SlackResolvedInstallation,
  channelId: string,
  rootTs: string,
): Promise<string | null> {
  const mappingKey = getChannelThreadMapKey({
    kind: "slack",
    workspaceId: installation.workspaceId,
    orgId: installation.orgId,
    connectionId: installation.integrationId,
    remoteConversationId: `${installation.teamId}:${channelId}:${rootTs}`,
  });
  const mappedThreadId = await env.APP_KV.get(mappingKey);
  return mappedThreadId || null;
}

function sanitizeSlackAttachmentName(
  file: NonNullable<SlackEventCallbackPayload["event"]>["files"] extends Array<infer T>
    ? T
    : never,
  index: number,
): string {
  const candidate =
    (typeof file.name === "string" && file.name.trim()) ||
    (typeof file.title === "string" && file.title.trim()) ||
    (typeof file.id === "string" && file.id.trim()) ||
    `slack-file-${index + 1}`;
  const sanitized = candidate
    .replace(/[\r\n"]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 180);
  return sanitized || `slack-file-${index + 1}`;
}

function uniqueSlackUploadFilename(base: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${name}-${timestamp}-${random}${ext}`;
}

function appendSlackUploadRefsToMessage(
  content: string,
  uploadPaths: string[],
): string {
  if (uploadPaths.length === 0) return content.trim();
  const refs = uploadPaths
    .map((path) => `(user uploaded file to ${path})`)
    .join("\n");
  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n\n${refs}` : refs;
}

function isOverFileSizeLimit(size: unknown, maxBytes: number): boolean {
  return (
    typeof size === "number" &&
    Number.isFinite(size) &&
    size > maxBytes
  );
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function uploadSlackEventFiles(
  env: RouteContext["env"],
  installation: SlackResolvedInstallation,
  files: NonNullable<SlackEventCallbackPayload["event"]>["files"],
): Promise<string[]> {
  if (!Array.isArray(files) || files.length === 0) return [];
  const uploadPaths: string[] = [];

  for (const [index, file] of files.entries()) {
    const url =
      (typeof file.url_private_download === "string" &&
        file.url_private_download) ||
      (typeof file.url_private === "string" && file.url_private) ||
      "";
    if (!url) continue;

    try {
      if (isOverFileSizeLimit(file.size, SLACK_EVENT_FILE_MAX_BYTES)) {
        console.warn("[slack-events] skipping oversized Slack file", {
          fileId: file.id || null,
          size: file.size,
          maxBytes: SLACK_EVENT_FILE_MAX_BYTES,
        });
        continue;
      }

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${installation.accessToken}` },
      });
      if (!response.ok) {
        console.warn("[slack-events] failed to download Slack file", {
          fileId: file.id || null,
          status: response.status,
        });
        continue;
      }
      const contentLength = parseContentLength(
        response.headers.get("content-length"),
      );
      if (contentLength !== null && contentLength > SLACK_EVENT_FILE_MAX_BYTES) {
        console.warn("[slack-events] skipping oversized Slack file response", {
          fileId: file.id || null,
          size: contentLength,
          maxBytes: SLACK_EVENT_FILE_MAX_BYTES,
        });
        continue;
      }
      const body = await response.arrayBuffer();
      if (body.byteLength === 0) continue;
      if (body.byteLength > SLACK_EVENT_FILE_MAX_BYTES) {
        console.warn("[slack-events] skipping oversized Slack file body", {
          fileId: file.id || null,
          size: body.byteLength,
          maxBytes: SLACK_EVENT_FILE_MAX_BYTES,
        });
        continue;
      }
      const originalName = sanitizeSlackAttachmentName(file, index);
      const storedFilename = uniqueSlackUploadFilename(originalName);
      const contentType =
        (typeof file.mimetype === "string" && file.mimetype.trim()) ||
        response.headers.get("content-type") ||
        "application/octet-stream";
      const r2Key = buildWorkspaceScopedR2Key(
        installation.orgId,
        installation.workspaceId,
        `user-uploads/${storedFilename}`,
      );
      await resolveObjectStore(env).put(r2Key, body, {
        httpMetadata: { contentType },
        customMetadata: {
          originalName,
          uploadedAt: new Date().toISOString(),
          source: "slack-ingress",
          slackFileId: typeof file.id === "string" ? file.id : "",
        },
      });
      uploadPaths.push(`uploads/${storedFilename}`);
    } catch (error) {
      console.error("[slack-events] failed to upload Slack file", {
        fileId: file.id || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return uploadPaths;
}

export async function processSlackEventCallback(
  env: RouteContext["env"],
  payload: SlackEventCallbackPayload,
): Promise<void> {
  const event = payload.event;
  if (!event) return;
  if (event.type !== "message" && event.type !== "app_mention") return;
  if (event.subtype && event.subtype !== "file_share") return;

  const installation = await resolveSlackInstallationForEvent(env, payload);
  const orgBan = await isOrgBanned(env.APP_KV, { orgId: installation.orgId });
  if (orgBan) return;
  const channelId = event.channel?.trim() || "";
  const userId = event.user?.trim() || "";
  if (!channelId || !userId) return;
  if (event.bot_id) return;
  if (installation.botUserId && installation.botUserId === userId) return;

  const rawText = typeof event.text === "string" ? event.text : "";
  const isDm = event.channel_type === "im";
  const rootTs = getSlackMappingRootTs(event, isDm);
  if (!rootTs) return;

  const mappedThreadId = await getMappedSlackThreadId(
    env,
    installation,
    channelId,
    rootTs,
  );
  const mentionsBot = installation.botUserId
    ? rawText.includes(`<@${installation.botUserId}>`)
    : false;
  const shouldHandle =
    isDm ||
    event.type === "app_mention" ||
    mentionsBot ||
    Boolean(mappedThreadId);
  if (!shouldHandle) return;

  const messageText = normalizeSlackMessageText(
    rawText,
    installation.botUserId,
  );
  const uploadedAttachmentPaths = await uploadSlackEventFiles(
    env,
    installation,
    event.files,
  );
  const userMessage = appendSlackUploadRefsToMessage(
    messageText,
    uploadedAttachmentPaths,
  );
  if (!userMessage) return;

  const threadId =
    mappedThreadId ||
    (await getOrCreateSlackThreadId(env, {
      workspaceId: installation.workspaceId,
      orgId: installation.orgId,
      integrationId: installation.integrationId,
      teamId: installation.teamId,
      channelId,
      rootTs,
      initialText: userMessage,
      initialMessageId: event.ts || null,
    }));

  const enqueueResult = await enqueueChannelMessage(env, {
    channelKind: "slack",
    threadId,
    workspaceId: installation.workspaceId,
    orgId: installation.orgId,
    userName: `Slack ${userId}`,
    userEmail: null,
    message: userMessage,
  });

  if (enqueueResult.status === "busy") {
    throw new SlackChannelBusyError(enqueueResult.error);
  }

  if (enqueueResult.status !== "accepted") {
    throw new Error(
      enqueueResult.error ||
        `Channel Slack message was not accepted (${enqueueResult.status})`,
    );
  }
}

function parseTelegramStartToken(textValue: string | undefined): string | null {
  const text = (textValue || "").trim();
  const match = text.match(/^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/);
  return match?.[1] || null;
}

function telegramChatId(message: TelegramMessagePayload): string {
  const value = message.chat?.id;
  return value === undefined || value === null ? "" : String(value).trim();
}

function telegramSenderName(message: TelegramMessagePayload): string {
  const from = message.from;
  const parts = [from?.first_name, from?.last_name]
    .map((part) => (part || "").trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (from?.username) return `@${from.username}`;
  return "Telegram user";
}

function telegramChatTitle(message: TelegramMessagePayload): string {
  const chat = message.chat;
  const title = (chat?.title || "").trim();
  if (title) return title;
  const parts = [chat?.first_name, chat?.last_name]
    .map((part) => (part || "").trim())
    .filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (chat?.username) return `@${chat.username}`;
  return "Telegram chat";
}

function telegramUniqueUploadFilename(base: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return `${name}-${timestamp}-${random}${ext}`;
}

function sanitizeTelegramAttachmentName(
  name: string | undefined,
  fallback: string,
): string {
  const candidate = (name || fallback).trim();
  const sanitized = candidate
    .replace(/[\r\n"]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 180);
  return sanitized || fallback;
}

function appendTelegramUploadRefsToMessage(
  content: string,
  uploadPaths: string[],
): string {
  if (uploadPaths.length === 0) return content.trim();
  const refs = uploadPaths
    .map((path) => `(user uploaded file to ${path})`)
    .join("\n");
  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n\n${refs}` : refs;
}

function appendTelegramTranscriptsToMessage(
  content: string,
  transcripts: Array<{ label: string; text: string }>,
): string {
  const transcriptText = transcripts
    .map(({ label, text: transcript }) => `${label} transcript:\n${transcript}`)
    .join("\n\n");
  const trimmed = content.trim();
  if (!transcriptText) return trimmed;
  const systemMessage = [
    "<camelai system message>",
    "The Telegram message included audio that camelAI already transcribed automatically. Treat the transcript below as the user's spoken message and do not transcribe the attached audio file again unless the user explicitly asks or the transcript is insufficient.",
    "</camelai system message>",
  ].join("");
  const contentWithTranscript = trimmed
    ? `${trimmed}\n\n${transcriptText}`
    : transcriptText;
  return `${systemMessage}\n\n${contentWithTranscript}`;
}

async function sendTelegramText(
  token: string,
  chatId: string,
  textValue: string,
): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: textValue }),
  });
  const responseJson = await response.json().catch(() => null) as {
    ok?: boolean;
    description?: string;
  } | null;
  if (!response.ok || responseJson?.ok !== true) {
    throw new Error(
      `Telegram send failed: ${responseJson?.description || response.statusText}`,
    );
  }
}

async function completeTelegramSetup(
  env: RouteContext["env"],
  token: string,
  message: TelegramMessagePayload,
  botToken: string,
): Promise<void> {
  const chatId = telegramChatId(message);
  if (!chatId) return;

  const registry = getTelegramRegistryStub(env);
  const setup = await registry.consumeSetupToken(token);
  if (!setup) {
    await sendTelegramText(
      botToken,
      chatId,
      "This Telegram setup link is expired or invalid. Create a new Telegram connection in camelAI.",
    ).catch((error) => {
      console.error("[telegram-events] failed to send invalid setup message", error);
    });
    return;
  }

  const orgStub = getOrgStub(env, setup.orgId) as unknown as OrgDO;
  const integration = await orgStub.getWorkspaceIntegration(
    setup.workspaceId,
    setup.integrationId,
  );
  if (!integration || integration.integration_type !== "telegram") {
    return;
  }

  const existingConfig = JSON.parse(integration.config || "{}") as Record<string, unknown>;
  const nextConfig = {
    ...existingConfig,
    status: "active",
    chat_id: chatId,
    chat_type: message.chat?.type || null,
    chat_title: telegramChatTitle(message),
    connected_at: Date.now(),
    connected_by_telegram_user_id:
      message.from?.id === undefined || message.from?.id === null
        ? null
        : String(message.from.id),
  };
  delete nextConfig.setup_token;
  delete nextConfig.setup_expires_at;

  await orgStub.updateWorkspaceIntegration(
    setup.workspaceId,
    setup.integrationId,
    { config: JSON.stringify(nextConfig) },
    setup.userId,
  );

  const binding: TelegramChatBinding = {
    workspaceId: setup.workspaceId,
    orgId: setup.orgId,
    integrationId: setup.integrationId,
  };
  await registry.bindChat(chatId, binding);

  await sendTelegramText(
    botToken,
    chatId,
    "Telegram is connected to this camelAI workspace.",
  ).catch((error) => {
    console.error("[telegram-events] failed to send setup confirmation", error);
  });
}

async function resolveTelegramFile(
  token: string,
  fileId: string,
): Promise<{ filePath: string; fileSize?: number } | null> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const responseJson = await response.json().catch(() => null) as {
    ok?: boolean;
    description?: string;
    result?: { file_path?: string; file_size?: number };
  } | null;
  if (!response.ok || responseJson?.ok !== true || !responseJson.result?.file_path) {
    console.warn("[telegram-events] failed to resolve Telegram file", {
      fileId,
      error: responseJson?.description || response.statusText,
    });
    return null;
  }
  return {
    filePath: responseJson.result.file_path,
    fileSize: responseJson.result.file_size,
  };
}

async function uploadTelegramFile(args: {
  env: RouteContext["env"];
  token: string;
  binding: TelegramChatBinding;
  fileId: string;
  originalName: string;
  contentType: string;
  size?: number;
}): Promise<{
  path: string;
  filename: string;
  contentType: string;
  content: ArrayBuffer;
} | null> {
  if (isOverFileSizeLimit(args.size, TELEGRAM_FILE_MAX_BYTES)) {
    console.warn("[telegram-events] skipping oversized Telegram file", {
      fileId: args.fileId,
      size: args.size,
      maxBytes: TELEGRAM_FILE_MAX_BYTES,
    });
    return null;
  }

  const resolved = await resolveTelegramFile(args.token, args.fileId);
  if (!resolved) return null;
  if (isOverFileSizeLimit(resolved.fileSize, TELEGRAM_FILE_MAX_BYTES)) {
    console.warn("[telegram-events] skipping oversized Telegram file", {
      fileId: args.fileId,
      size: resolved.fileSize,
      maxBytes: TELEGRAM_FILE_MAX_BYTES,
    });
    return null;
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot${args.token}/${resolved.filePath}`,
  );
  if (!response.ok) {
    console.warn("[telegram-events] failed to download Telegram file", {
      fileId: args.fileId,
      status: response.status,
    });
    return null;
  }

  const contentLength = parseContentLength(
    response.headers.get("content-length"),
  );
  if (contentLength !== null && contentLength > TELEGRAM_FILE_MAX_BYTES) {
    console.warn("[telegram-events] skipping oversized Telegram file response", {
      fileId: args.fileId,
      size: contentLength,
      maxBytes: TELEGRAM_FILE_MAX_BYTES,
    });
    return null;
  }

  const body = await response.arrayBuffer();
  if (body.byteLength === 0) return null;
  if (body.byteLength > TELEGRAM_FILE_MAX_BYTES) {
    console.warn("[telegram-events] skipping oversized Telegram file body", {
      fileId: args.fileId,
      size: body.byteLength,
      maxBytes: TELEGRAM_FILE_MAX_BYTES,
    });
    return null;
  }

  const storedFilename = telegramUniqueUploadFilename(args.originalName);
  const r2Key = buildWorkspaceScopedR2Key(
    args.binding.orgId,
    args.binding.workspaceId,
    `user-uploads/${storedFilename}`,
  );
  const contentType =
    args.contentType ||
    response.headers.get("content-type") ||
    "application/octet-stream";
  await resolveObjectStore(args.env).put(r2Key, body, {
    httpMetadata: {
      contentType,
    },
    customMetadata: {
      originalName: args.originalName,
      uploadedAt: new Date().toISOString(),
      source: "telegram-ingress",
      telegramFileId: args.fileId,
    },
  });
  return {
    path: `uploads/${storedFilename}`,
    filename: storedFilename,
    contentType,
    content: body,
  };
}

async function uploadTelegramMessageFiles(
  env: RouteContext["env"],
  token: string,
  binding: TelegramChatBinding,
  message: TelegramMessagePayload,
): Promise<{
  uploadPaths: string[];
  transcripts: Array<{ label: string; text: string }>;
}> {
  const uploads: string[] = [];
  const transcripts: Array<{ label: string; text: string }> = [];

  const uploadAudioWithTranscript = async (args: {
    fileId: string;
    originalName: string;
    contentType: string;
    size?: number;
    label: string;
  }) => {
    const uploaded = await uploadTelegramFile({
      env,
      token,
      binding,
      fileId: args.fileId,
      originalName: args.originalName,
      contentType: args.contentType,
      size: args.size,
    });
    if (!uploaded) return;
    uploads.push(uploaded.path);
    try {
      const transcript = await transcribeAudioBytes(env.AI, uploaded.content);
      if (transcript.text) {
        transcripts.push({ label: args.label, text: transcript.text });
      }
    } catch (error) {
      console.warn("[telegram-events] failed to transcribe Telegram audio", {
        fileId: args.fileId,
        label: args.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (message.document?.file_id) {
    const originalName = sanitizeTelegramAttachmentName(
      message.document.file_name,
      `telegram-document-${message.message_id || Date.now()}`,
    );
    const uploaded = await uploadTelegramFile({
      env,
      token,
      binding,
      fileId: message.document.file_id,
      originalName,
      contentType: message.document.mime_type || "application/octet-stream",
      size: message.document.file_size,
    });
    if (uploaded) uploads.push(uploaded.path);
  }

  const largestPhoto = Array.isArray(message.photo) && message.photo.length > 0
    ? [...message.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0]
    : null;
  if (largestPhoto?.file_id) {
    const uploaded = await uploadTelegramFile({
      env,
      token,
      binding,
      fileId: largestPhoto.file_id,
      originalName: sanitizeTelegramAttachmentName(
        undefined,
        `telegram-photo-${message.message_id || Date.now()}.jpg`,
      ),
      contentType: "image/jpeg",
      size: largestPhoto.file_size,
    });
    if (uploaded) uploads.push(uploaded.path);
  }

  if (message.voice?.file_id) {
    await uploadAudioWithTranscript({
      fileId: message.voice.file_id,
      originalName: sanitizeTelegramAttachmentName(
        undefined,
        `telegram-voice-${message.message_id || Date.now()}.ogg`,
      ),
      contentType: message.voice.mime_type || "audio/ogg",
      size: message.voice.file_size,
      label: "Voice message",
    });
  }

  if (message.audio?.file_id) {
    await uploadAudioWithTranscript({
      fileId: message.audio.file_id,
      originalName: sanitizeTelegramAttachmentName(
        message.audio.file_name,
        `telegram-audio-${message.message_id || Date.now()}.mp3`,
      ),
      contentType: message.audio.mime_type || "audio/mpeg",
      size: message.audio.file_size,
      label: "Audio message",
    });
  }

  if (message.video?.file_id) {
    const uploaded = await uploadTelegramFile({
      env,
      token,
      binding,
      fileId: message.video.file_id,
      originalName: sanitizeTelegramAttachmentName(
        message.video.file_name,
        `telegram-video-${message.message_id || Date.now()}.mp4`,
      ),
      contentType: message.video.mime_type || "video/mp4",
      size: message.video.file_size,
    });
    if (uploaded) uploads.push(uploaded.path);
  }

  if (message.video_note?.file_id) {
    const uploaded = await uploadTelegramFile({
      env,
      token,
      binding,
      fileId: message.video_note.file_id,
      originalName: sanitizeTelegramAttachmentName(
        undefined,
        `telegram-video-note-${message.message_id || Date.now()}.mp4`,
      ),
      contentType: "video/mp4",
      size: message.video_note.file_size,
    });
    if (uploaded) uploads.push(uploaded.path);
  }

  return { uploadPaths: uploads, transcripts };
}

async function processTelegramMessage(
  env: RouteContext["env"],
  update: TelegramUpdatePayload,
  message: TelegramMessagePayload,
  botToken: string,
): Promise<void> {
  const chatId = telegramChatId(message);
  if (!chatId) return;

  const setupToken = parseTelegramStartToken(message.text);
  if (setupToken) {
    await completeTelegramSetup(env, setupToken, message, botToken);
    return;
  }

  const binding = await getTelegramRegistryStub(env).getChatBinding(chatId);
  if (!binding) return;
  const orgStub = getOrgStub(env, binding.orgId) as unknown as OrgDO;
  const [wsInfo, integration] = await Promise.all([
    orgStub.getWorkspaceRecord(binding.workspaceId),
    orgStub.getWorkspaceIntegration(binding.workspaceId, binding.integrationId),
  ]);
  if (!wsInfo || wsInfo.archived) return;
  if (!integration || integration.integration_type !== "telegram") return;
  const config = JSON.parse(integration.config || "{}") as Record<string, unknown>;
  const configuredChatId =
    config.chat_id === undefined || config.chat_id === null
      ? ""
      : String(config.chat_id).trim();
  if (configuredChatId !== chatId) return;
  const orgBan = await isOrgBanned(env.APP_KV, { orgId: binding.orgId });
  if (orgBan) return;

  const remoteMessageId =
    message.message_id === undefined || message.message_id === null
      ? `update:${update.update_id || Date.now()}`
      : `${chatId}:${message.message_id}`;
  const dedupeKey = getChannelDedupeKey(
    "telegram",
    binding.workspaceId,
    remoteMessageId,
  );
  if (await env.APP_KV.get(dedupeKey)) return;
  await env.APP_KV.put(dedupeKey, "processing", {
    expirationTtl: TELEGRAM_EVENT_DEDUPE_TTL_SECONDS,
  });

  let dedupeFinalized = false;
  try {
    const { uploadPaths, transcripts } = await uploadTelegramMessageFiles(
      env,
      botToken,
      binding,
      message,
    );
    const contentWithTranscripts = appendTelegramTranscriptsToMessage(
      message.text || message.caption || "",
      transcripts,
    );
    const userMessage = appendTelegramUploadRefsToMessage(
      contentWithTranscripts,
      uploadPaths,
    );
    if (!userMessage) return;

    const thread = await getOrCreateChannelThread(env, {
      kind: "telegram",
      workspaceId: binding.workspaceId,
      orgId: binding.orgId,
      connectionId: binding.integrationId,
      remoteConversationId: chatId,
      title: telegramChatTitle(message),
      createdBy: "telegram",
      firstUserMessage: userMessage,
      firstRemoteMessageId: remoteMessageId,
    });

    const enqueueResult = await enqueueChannelMessage(env, {
      channelKind: "telegram",
      threadId: thread.threadId,
      workspaceId: binding.workspaceId,
      orgId: binding.orgId,
      userName: telegramSenderName(message),
      userEmail: null,
      message: userMessage,
    });

    if (enqueueResult.status !== "accepted") {
      throw new Error(
        enqueueResult.error ||
          `Channel Telegram message was not accepted (${enqueueResult.status})`,
      );
    }

    await env.APP_KV.put(dedupeKey, "done", {
      expirationTtl: TELEGRAM_EVENT_DEDUPE_TTL_SECONDS,
    });
    dedupeFinalized = true;
  } finally {
    if (!dedupeFinalized) {
      await env.APP_KV.delete(dedupeKey).catch((error) => {
        console.warn("[telegram-events] failed to clear dedupe marker", {
          key: dedupeKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }
}

export async function handleTelegramWebhook({
  req,
  env,
}: RouteContext): Promise<Response> {
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    return text("Telegram webhook secret is not configured", 500);
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret) {
    return text("Invalid Telegram webhook secret", 401);
  }
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return text("Telegram bot token is not configured", 500);
  }

  let update: TelegramUpdatePayload;
  try {
    update = await req.json() as TelegramUpdatePayload;
  } catch {
    return text("Invalid JSON payload", 400);
  }

  if (update.message) {
    await processTelegramMessage(env, update, update.message, botToken);
  }

  return text("ok", 200);
}

export async function handleSlackEvents({
  req,
  env,
  ctx,
}: RouteContext): Promise<Response> {
  const signingSecret = env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return text("Slack signing secret is not configured", 500);
  }

  const rawBody = await req.text();
  const signatureValid = await verifySlackSignature(
    req,
    rawBody,
    signingSecret,
  );
  if (!signatureValid) {
    return text("Invalid Slack signature", 401);
  }

  let payload: SlackEventCallbackPayload;
  try {
    payload = JSON.parse(rawBody) as SlackEventCallbackPayload;
  } catch {
    return text("Invalid JSON payload", 400);
  }

  if (
    payload.type === "url_verification" &&
    typeof payload.challenge === "string"
  ) {
    return toSlackJsonResponse({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") {
    return text("ok", 200);
  }

  const eventId = payload.event_id?.trim();
  if (eventId) {
    const dedupeKey = `${SLACK_EVENT_DEDUPE_PREFIX}${eventId}`;
    const seen = await env.APP_KV.get(dedupeKey);
    if (seen) {
      return text("ok", 200);
    }
    await env.APP_KV.put(dedupeKey, "1", {
      expirationTtl: SLACK_EVENT_DEDUPE_TTL_SECONDS,
    });
  }

  const messageDedupeKey = getSlackMessageDedupeKey(payload);
  if (messageDedupeKey) {
    const seenMessage = await env.APP_KV.get(messageDedupeKey);
    if (seenMessage) {
      return text("ok", 200);
    }
    await env.APP_KV.put(messageDedupeKey, "1", {
      expirationTtl: SLACK_EVENT_DEDUPE_TTL_SECONDS,
    });
  }

  const slackEventsQueue = resolveQueueBinding(
    env,
    "SLACK_EVENTS_QUEUE",
    env.SLACK_EVENTS_QUEUE,
  );
  if (slackEventsQueue) {
    try {
      await slackEventsQueue.send({
        payload,
        received_at: Date.now(),
      });
    } catch (error) {
      console.error("[slack-events] failed to enqueue event callback", error);
      ctx.waitUntil(
        processSlackEventCallback(env, payload).catch((callbackError) => {
          console.error(
            "[slack-events] failed to process callback fallback",
            callbackError,
          );
        }),
      );
    }
  } else {
    ctx.waitUntil(
      processSlackEventCallback(env, payload).catch((error) => {
        console.error("[slack-events] failed to process callback", error);
      }),
    );
  }

  return text("ok", 200);
}

// =============================================================================
// Notion OAuth
// =============================================================================

export async function handleNotionOAuthStart({
  req,
  env,
  url,
}: RouteContext): Promise<Response> {
  const notionDef = INTEGRATION_REGISTRY.notion;
  if (!notionDef?.oauthConfig || !env.NOTION_CLIENT_ID) {
    return text("Notion OAuth is not configured", 500);
  }

  const auth = await requireSession(req, env);
  if ("error" in auth)
    return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id)
    return redirect(`${url.origin}/connections?error=no_workspace`);

  const access = await verifyWorkspaceManageConnectionsAccess(env, session.workspace_id, session.user_id);
  if (!access.ok) {
    return redirect(`${url.origin}/connections?error=${access.error}`);
  }

  const redirectTo = sanitizeRedirectPath(
    url.searchParams.get("redirect") || "/connections",
  );
  const reauthIntegrationId = url.searchParams.get("integration_id")?.trim();
  const callbackUrl = `${url.origin}/api/integrations/notion/callback`;

  const chatRequestId = url.searchParams.get("chat_request_id");
  const chatThreadId = url.searchParams.get("chat_thread_id");

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    "notion",
    session.workspace_id,
    session.user_id,
    redirectTo,
    buildConnectionSetupOAuthExtraConfig(reauthIntegrationId, chatRequestId, chatThreadId),
  );

  const authUrl = new URL(notionDef.oauthConfig.authorizationUrl);
  authUrl.searchParams.set("client_id", env.NOTION_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("owner", "user");
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("state", state);

  return redirect(authUrl.toString());
}

export async function handleNotionOAuthCallback({
  env,
  url,
  ctx: _ctx,
}: RouteContext): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state)
    return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(
    env.SESSIONS,
    state,
  );
  if (!stateData || stateData.integration_type !== "notion") {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/notion/callback`;

    // Notion uses Basic Auth for token exchange
    const basicAuth = btoa(
      `${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`,
    );
    const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
      }),
    });

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number; // Token lifetime in seconds
      refresh_token?: string; // For refreshing the access token
      bot_id?: string;
      workspace_id?: string;
      workspace_name?: string;
      workspace_icon?: string;
      owner?: {
        type: string;
        user?: {
          id: string;
          name?: string;
          avatar_url?: string;
          person?: { email?: string };
        };
      };
      duplicated_template_id?: string;
      request_id?: string;
      error?: string;
    };

    if (!tokenData.access_token) {
      console.error("[notion-oauth] Token exchange failed:", tokenData.error);
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access before creating integration.
    const access = await verifyWorkspaceManageConnectionsAccess(
      env,
      stateData.workspace_id,
      stateData.user_id,
    );
    if (!access.ok) {
      return redirect(`${url.origin}/connections?error=${access.error}`);
    }

    const owner = await getWorkspaceOrgStub(env, stateData.workspace_id);
    if (!owner) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }

    // Calculate token expiry time (Notion tokens expire after ~1 hour)
    // Default to 1 hour if expires_in not provided
    const expiresInSeconds = tokenData.expires_in ?? 3600;
    const tokenExpiresAt = Date.now() + expiresInSeconds * 1000;

    const credentials = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token, // Stored but never pushed to containers
      expires_at: tokenExpiresAt,
      token_type: tokenData.token_type,
      bot_id: tokenData.bot_id,
      notion_workspace_id: tokenData.workspace_id,
      notion_workspace_name: tokenData.workspace_name,
      owner_user_id: tokenData.owner?.user?.id,
      owner_user_name: tokenData.owner?.user?.name,
      owner_user_email: tokenData.owner?.user?.person?.email,
    };

    const encrypted = await encryptCredentials(
      credentials,
      env.INTEGRATION_SECRET_KEY,
    );
    const name = tokenData.workspace_name || "Notion";
    const requestedReauthId = reauthIntegrationId(stateData);
    const existingIntegration = requestedReauthId
      ? await owner.orgStub.getWorkspaceIntegration(
          stateData.workspace_id,
          requestedReauthId,
        )
      : null;
    if (requestedReauthId && existingIntegration?.integration_type !== "notion") {
      return redirect(`${url.origin}/connections?error=reauth_integration_not_found`);
    }
    const integrationId = requestedReauthId ?? crypto.randomUUID();

    if (requestedReauthId) {
      await owner.orgStub.updateWorkspaceIntegration(
        stateData.workspace_id,
        requestedReauthId,
        {
          name,
          config: JSON.stringify({}),
          credentialsEncrypted: encrypted,
          tokenExpiresAt,
        },
        stateData.user_id,
      );
    } else {
      await owner.orgStub.createWorkspaceIntegration(
        stateData.workspace_id,
        integrationId,
        "notion",
        name,
        "saas",
        "oauth2",
        JSON.stringify({}),
        encrypted,
        stateData.user_id,
        tokenExpiresAt, // Pass expiry for alarm scheduling
      );
    }


    // Complete the waiting chat connection prompt if OAuth was started there.
    if (hasConnectionSetupPromptContext(stateData)) {
      await completeConnectionSetupPrompt(
        env,
        stateData,
        integrationId,
        "notion",
        name,
      );
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set("success", "notion_connected");
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error("[notion-oauth] OAuth flow failed:", err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

// =============================================================================
// Google Analytics 4 OAuth
// =============================================================================

function googleAnalyticsOAuthCredentials(env: RouteContext['env']): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = env.GOOGLE_ANALYTICS_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_ANALYTICS_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export async function handleGoogleAnalyticsOAuthStart({
  req,
  env,
  url,
}: RouteContext): Promise<Response> {
  const definition = INTEGRATION_REGISTRY.google_analytics;
  const oauth = googleAnalyticsOAuthCredentials(env);
  if (!definition?.oauthConfig || !oauth) {
    return text('Google Analytics OAuth is not configured', 500);
  }
  const auth = await requireSession(req, env);
  if ('error' in auth) return redirect(`${url.origin}/login?error=unauthorized`);
  const { session } = auth;
  if (!session.workspace_id) return redirect(`${url.origin}/connections?error=no_workspace`);
  const access = await verifyWorkspaceManageConnectionsAccess(env, session.workspace_id, session.user_id);
  if (!access.ok) return redirect(`${url.origin}/connections?error=${access.error}`);

  const redirectTo = sanitizeRedirectPath(url.searchParams.get('redirect') || '/connections');
  const reauthId = url.searchParams.get('integration_id')?.trim();
  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    'google_analytics',
    session.workspace_id,
    session.user_id,
    redirectTo,
    buildConnectionSetupOAuthExtraConfig(
      reauthId,
      url.searchParams.get('chat_request_id'),
      url.searchParams.get('chat_thread_id'),
    ),
  );
  const authUrl = new URL(definition.oauthConfig.authorizationUrl);
  const callbackUrl = integrationOAuthCallbackUrl(url, 'google_analytics');
  authUrl.searchParams.set('client_id', oauth.clientId);
  authUrl.searchParams.set('redirect_uri', callbackUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', definition.oauthConfig.scopes.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  authUrl.searchParams.set('state', state);
  return redirect(authUrl.toString());
}

interface GoogleAnalyticsPropertySummary {
  property: string;
  displayName?: string;
  propertyType?: string;
  parent?: string;
}

interface GoogleAnalyticsAccountSummary {
  account?: string;
  displayName?: string;
  propertySummaries?: GoogleAnalyticsPropertySummary[];
}

export async function handleGoogleAnalyticsOAuthCallback({
  env,
  url,
}: RouteContext): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (url.searchParams.get('error')) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state) return redirect(`${url.origin}/connections?error=oauth_invalid`);
  const stateData = await validateAndConsumeIntegrationOAuthState(env.SESSIONS, state);
  if (!stateData || stateData.integration_type !== 'google_analytics') {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }
  const oauth = googleAnalyticsOAuthCredentials(env);
  if (!oauth) return redirect(`${url.origin}/connections?error=oauth_config`);

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: integrationOAuthCallbackUrl(url, 'google_analytics'),
      }),
    });
    const tokenData = await tokenResponse.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('[google-analytics-oauth] token exchange failed', tokenData.error, tokenData.error_description);
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    const access = await verifyWorkspaceManageConnectionsAccess(
      env,
      stateData.workspace_id,
      stateData.user_id,
    );
    if (!access.ok) return redirect(`${url.origin}/connections?error=${access.error}`);
    const owner = await getWorkspaceOrgStub(env, stateData.workspace_id);
    if (!owner) return redirect(`${url.origin}/connections?error=workspace_not_found`);

    const summariesResponse = await fetch(
      'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200',
      { headers: { authorization: `Bearer ${tokenData.access_token}` } },
    );
    const summariesData = await summariesResponse.json() as {
      accountSummaries?: GoogleAnalyticsAccountSummary[];
      error?: { message?: string };
    };
    if (!summariesResponse.ok) {
      console.error('[google-analytics-oauth] account discovery failed', summariesData.error?.message);
      return redirect(`${url.origin}/connections?error=oauth_failed`);
    }
    const properties = (summariesData.accountSummaries ?? []).flatMap((account) =>
      (account.propertySummaries ?? []).map((property) => ({
        id: property.property?.replace(/^properties\//, ''),
        name: property.displayName,
        account: account.account,
        account_name: account.displayName,
      })),
    ).filter((property) => property.id);
    const defaultProperty = properties[0];
    if (defaultProperty) {
      const healthResponse = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(defaultProperty.id)}/metadata`,
        { headers: { authorization: `Bearer ${tokenData.access_token}` } },
      );
      if (!healthResponse.ok && healthResponse.status !== 404) {
        console.error('[google-analytics-oauth] metadata health check failed', healthResponse.status);
        return redirect(`${url.origin}/connections?error=oauth_failed`);
      }
    }

    const expiresAt = Date.now() + (tokenData.expires_in ?? 3600) * 1000;
    const credentials = await encryptCredentials({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
      token_type: tokenData.token_type ?? 'Bearer',
      scope: tokenData.scope,
    }, env.INTEGRATION_SECRET_KEY);
    const config = JSON.stringify({
      property_id: defaultProperty?.id,
      property_name: defaultProperty?.name,
      available_properties: properties,
    });
    const requestedReauthId = reauthIntegrationId(stateData);
    const existing = requestedReauthId
      ? await owner.orgStub.getWorkspaceIntegration(stateData.workspace_id, requestedReauthId)
      : null;
    if (requestedReauthId && existing?.integration_type !== 'google_analytics') {
      return redirect(`${url.origin}/connections?error=reauth_integration_not_found`);
    }
    const integrationId = requestedReauthId ?? crypto.randomUUID();
    const name = defaultProperty?.name ? `GA4 — ${defaultProperty.name}` : 'Google Analytics 4';
    if (requestedReauthId) {
      await owner.orgStub.updateWorkspaceIntegration(
        stateData.workspace_id,
        requestedReauthId,
        { name, config, credentialsEncrypted: credentials, tokenExpiresAt: expiresAt },
        stateData.user_id,
      );
    } else {
      await owner.orgStub.createWorkspaceIntegration(
        stateData.workspace_id,
        integrationId,
        'google_analytics',
        name,
        'saas',
        'oauth2',
        config,
        credentials,
        stateData.user_id,
        expiresAt,
      );
    }
    if (hasConnectionSetupPromptContext(stateData)) {
      await completeConnectionSetupPrompt(env, stateData, integrationId, 'google_analytics', name);
    }
    const redirectUrl = new URL(sanitizeRedirectPath(stateData.redirect_url), url.origin);
    redirectUrl.searchParams.set('success', 'google_analytics_connected');
    return redirect(redirectUrl.toString());
  } catch (error) {
    console.error('[google-analytics-oauth] OAuth flow failed', error);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}

// =============================================================================
// Salesforce OAuth
// =============================================================================

export async function handleSalesforceOAuthStart({
  req,
  env,
  url,
}: RouteContext): Promise<Response> {
  const salesforceDef = INTEGRATION_REGISTRY.salesforce;
  if (!salesforceDef?.oauthConfig || !env.SALESFORCE_CLIENT_ID) {
    return text("Salesforce OAuth is not configured", 500);
  }

  const auth = await requireSession(req, env);
  if ("error" in auth)
    return redirect(`${url.origin}/login?error=unauthorized`);

  const { session } = auth;
  if (!session.workspace_id)
    return redirect(`${url.origin}/connections?error=no_workspace`);

  const access = await verifyWorkspaceManageConnectionsAccess(env, session.workspace_id, session.user_id);
  if (!access.ok) {
    return redirect(`${url.origin}/connections?error=${access.error}`);
  }

  const redirectTo = sanitizeRedirectPath(
    url.searchParams.get("redirect") || "/connections",
  );
  const reauthIntegrationId = url.searchParams.get("integration_id")?.trim();
  const callbackUrl = `${url.origin}/api/integrations/salesforce/callback`;

  const chatRequestId = url.searchParams.get("chat_request_id");
  const chatThreadId = url.searchParams.get("chat_thread_id");

  const state = await createIntegrationOAuthState(
    env.SESSIONS,
    "salesforce",
    session.workspace_id,
    session.user_id,
    redirectTo,
    buildConnectionSetupOAuthExtraConfig(reauthIntegrationId, chatRequestId, chatThreadId),
  );

  const authUrl = new URL(salesforceDef.oauthConfig.authorizationUrl);
  authUrl.searchParams.set("client_id", env.SALESFORCE_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", salesforceDef.oauthConfig.scopes.join(" "));
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("state", state);

  return redirect(authUrl.toString());
}

export async function handleSalesforceOAuthCallback({
  env,
  url,
  ctx: _ctx,
}: RouteContext): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return redirect(`${url.origin}/connections?error=oauth_denied`);
  if (!code || !state)
    return redirect(`${url.origin}/connections?error=oauth_invalid`);

  const stateData = await validateAndConsumeIntegrationOAuthState(
    env.SESSIONS,
    state,
  );
  if (!stateData || stateData.integration_type !== "salesforce") {
    return redirect(`${url.origin}/connections?error=oauth_state_invalid`);
  }

  if (!env.SALESFORCE_CLIENT_ID || !env.SALESFORCE_CLIENT_SECRET) {
    return redirect(`${url.origin}/connections?error=oauth_config`);
  }

  try {
    const callbackUrl = `${url.origin}/api/integrations/salesforce/callback`;

    // Salesforce uses form-encoded POST for token exchange
    const tokenRes = await fetch(
      "https://login.salesforce.com/services/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: env.SALESFORCE_CLIENT_ID,
          client_secret: env.SALESFORCE_CLIENT_SECRET,
          code,
          redirect_uri: callbackUrl,
        }),
      },
    );

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      instance_url?: string;
      id?: string;
      token_type?: string;
      issued_at?: string;
      signature?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenData.access_token) {
      console.error(
        "[salesforce-oauth] Token exchange failed:",
        tokenData.error,
        tokenData.error_description,
      );
      return redirect(`${url.origin}/connections?error=oauth_token_failed`);
    }

    // Re-validate workspace access before creating integration.
    const access = await verifyWorkspaceManageConnectionsAccess(
      env,
      stateData.workspace_id,
      stateData.user_id,
    );
    if (!access.ok) {
      return redirect(`${url.origin}/connections?error=${access.error}`);
    }

    const owner = await getWorkspaceOrgStub(env, stateData.workspace_id);
    if (!owner) {
      return redirect(`${url.origin}/connections?error=workspace_not_found`);
    }

    const credentials = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      instance_url: tokenData.instance_url,
      token_type: tokenData.token_type,
      user_id: tokenData.id, // Salesforce user ID URL
      scope: tokenData.scope,
    };

    const encrypted = await encryptCredentials(
      credentials,
      env.INTEGRATION_SECRET_KEY,
    );

    // Extract org name from instance URL (e.g., https://myorg.salesforce.com -> myorg)
    const instanceHost = tokenData.instance_url
      ? new URL(tokenData.instance_url).hostname
      : "";
    const orgName = instanceHost.split(".")[0] || "Salesforce";
    const name = orgName.charAt(0).toUpperCase() + orgName.slice(1);

    // Store instance_url in config for API calls
    const config = { instance_url: tokenData.instance_url };
    const requestedReauthId = reauthIntegrationId(stateData);
    const existingIntegration = requestedReauthId
      ? await owner.orgStub.getWorkspaceIntegration(
          stateData.workspace_id,
          requestedReauthId,
        )
      : null;
    if (requestedReauthId && existingIntegration?.integration_type !== "salesforce") {
      return redirect(`${url.origin}/connections?error=reauth_integration_not_found`);
    }
    const integrationId = requestedReauthId ?? crypto.randomUUID();

    if (requestedReauthId) {
      await owner.orgStub.updateWorkspaceIntegration(
        stateData.workspace_id,
        requestedReauthId,
        { name, config: JSON.stringify(config), credentialsEncrypted: encrypted },
        stateData.user_id,
      );
    } else {
      await owner.orgStub.createWorkspaceIntegration(
        stateData.workspace_id,
        integrationId,
        "salesforce",
        name,
        "saas",
        "oauth2",
        JSON.stringify(config),
        encrypted,
        stateData.user_id,
      );
    }

    // Complete the waiting chat connection prompt if OAuth was started there.
    if (hasConnectionSetupPromptContext(stateData)) {
      await completeConnectionSetupPrompt(
        env,
        stateData,
        integrationId,
        "salesforce",
        name,
      );
    }

    const safePath = sanitizeRedirectPath(stateData.redirect_url);
    const redirectUrl = new URL(safePath, url.origin);
    redirectUrl.searchParams.set("success", "salesforce_connected");
    return redirect(redirectUrl.toString());
  } catch (err) {
    console.error("[salesforce-oauth] OAuth flow failed:", err);
    return redirect(`${url.origin}/connections?error=oauth_failed`);
  }
}
