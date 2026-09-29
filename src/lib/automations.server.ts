import type { AppLoadContext } from "react-router";
import { getEnv, type CloudflareEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import type { OrgDO, OrgThread } from "../../workers/main/src/auth";
import type { WorkspaceDO, WorkspaceRunningThreadStatus } from "../../workers/main/src/workspace";
import type {
  AutomationRunCursor,
  AutomationRunRecord,
  WorkspaceCronDO,
  WorkspaceDeterministicAutomation,
  WorkspaceScheduledPrompt,
} from "../../workers/main/src/workspace-cron";
import {
  type AutomationKind,
  type AutomationListItem,
  type AutomationRunsPage,
  type AutomationRunSummary,
  sortAutomations,
} from "@/lib/automations-shared";
import type { User } from "@/types";
import {
  loadUserProfileSummaries,
  type UserProfileSummary,
} from "@/lib/user-profiles.server";

interface BuildAutomationsPageDataInput {
  context: AppLoadContext;
  workspaceId: string;
  orgId: string;
  userId: string;
  canManage: boolean;
  request?: Request;
  currentUser?: User;
}

interface MutateAutomationInput {
  context: AppLoadContext;
  workspaceId: string;
  orgId: string;
  userId: string;
  canManage: boolean;
  intent: string;
  kind: AutomationKind;
  id: string;
  name?: string;
  enabled?: boolean;
}

export type AutomationActionResult =
  | { success: true; automation: AutomationListItem }
  | { success: false; automation: AutomationListItem; error: string }
  | { success: true; id: string; kind: AutomationKind }
  | { error: string };

function getWorkspaceCronStub(
  env: CloudflareEnv,
  workspaceId: string,
): DurableObjectStub<WorkspaceCronDO> {
  return env.WORKSPACE_CRON.get(
    env.WORKSPACE_CRON.idFromName(workspaceId),
  ) as DurableObjectStub<WorkspaceCronDO>;
}

function getWorkspaceStub(
  env: CloudflareEnv,
  workspaceId: string,
): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId),
  ) as DurableObjectStub<WorkspaceDO>;
}

function getOrgStub(env: CloudflareEnv, orgId: string): DurableObjectStub<OrgDO> {
  return env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
}

async function listStreamingThreadStatuses(
  env: CloudflareEnv,
  workspaceId: string,
): Promise<WorkspaceRunningThreadStatus[]> {
  try {
    return await getWorkspaceStub(env, workspaceId).listStreamingThreadStatuses();
  } catch (error) {
    console.error("[automations] Failed to load streaming thread statuses", error);
    return [];
  }
}

type AutomationCreator = UserProfileSummary;

async function getCreators(
  env: CloudflareEnv,
  creatorIds: string[],
  options: {
    request?: Request;
    preloadedUsers?: Iterable<User | null | undefined>;
  } = {},
): Promise<Map<string, AutomationCreator>> {
  const authEnv = getAuthEnv(env);
  try {
    return await loadUserProfileSummaries(authEnv, creatorIds, {
      ...options,
      allowPartialFailures: true,
    });
  } catch (error) {
    console.error("[automations] Failed to load creator profiles", { error });
    return new Map();
  }
}

function toRunSummary(run: AutomationRunRecord): AutomationRunSummary {
  return {
    id: run.id,
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at,
    trigger: run.trigger,
    message: run.message,
    thread_id: run.thread_id,
    instance_id: run.instance_id,
  };
}

function toRunKind(
  kind: AutomationKind,
): "scheduled_prompt" | "deterministic_automation" {
  return kind === "agent_task" ? "scheduled_prompt" : "deterministic_automation";
}

/** Opaque keyset cursor encoded as `${startedAt}:${id}` for the runs endpoint. */
function encodeRunsCursor(cursor: AutomationRunCursor | null): string | null {
  return cursor ? `${cursor.startedAt}:${cursor.id}` : null;
}

function decodeRunsCursor(
  raw: string | null | undefined,
): AutomationRunCursor | null {
  if (!raw) return null;
  const separator = raw.indexOf(":");
  if (separator <= 0) return null;
  const startedAt = Number(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (!Number.isFinite(startedAt) || !id) return null;
  return { startedAt, id };
}

function normalizeScheduledPrompt(input: {
  prompt: WorkspaceScheduledPrompt;
  canManage: boolean;
  creator: AutomationCreator | null;
  thread: OrgThread | null;
  latestRun: AutomationRunRecord | null;
  streamingStatus: WorkspaceRunningThreadStatus | null;
}): AutomationListItem {
  const { prompt, latestRun, streamingStatus } = input;
  const isStreaming =
    Boolean(streamingStatus) ||
    latestRun?.status === "started";
  const needsInput =
    prompt.last_run_status === "question" ||
    latestRun?.status === "question";
  const runtime_status =
    needsInput ? "needs_input" : isStreaming ? "running" : "idle";
  const runtime_message =
    needsInput
      ? "Waiting for your input"
      : isStreaming
        ? streamingStatus?.latestActivityText ?? "Running now"
        : null;

  return {
    id: prompt.id,
    kind: "agent_task",
    name: prompt.name,
    cron_expression: prompt.cron_expression,
    timezone: "UTC",
    enabled: prompt.enabled,
    can_manage: input.canManage,
    body: prompt.prompt,
    body_label: "Prompt",
    next_run_at: prompt.next_run_at,
    last_run_at: prompt.last_run_at,
    last_run_status: prompt.last_run_status,
    last_run_error: prompt.last_run_error,
    runtime_status,
    runtime_message,
    runtime_updated_at:
      streamingStatus?.updatedAt ??
      (latestRun?.status === "started" ? latestRun.started_at : null),
    thread_id: prompt.thread_id,
    thread_exists: Boolean(input.thread),
    created_by_id: prompt.created_by,
    created_by_name: input.creator
      ? input.creator.name || input.creator.email
      : null,
    created_by_avatar: input.creator?.avatar ?? null,
    model: input.thread?.model ?? null,
    source_version: null,
  };
}

function normalizeDeterministicAutomation(input: {
  automation: WorkspaceDeterministicAutomation;
  canManage: boolean;
  creator: AutomationCreator | null;
}): AutomationListItem {
  const { automation } = input;
  return {
    id: automation.id,
    kind: "workflow",
    name: automation.name,
    cron_expression: automation.cron_expression,
    timezone: "UTC",
    enabled: automation.enabled,
    can_manage: input.canManage,
    body: automation.description,
    body_label: "Description",
    next_run_at: automation.next_run_at,
    last_run_at: automation.last_run_at,
    last_run_status: automation.last_run_status,
    last_run_error: automation.last_run_error,
    runtime_status: automation.last_run_status === "started" ? "running" : "idle",
    runtime_message:
      automation.last_run_status === "started" ? "Running now" : null,
    runtime_updated_at:
      automation.last_run_status === "started" ? automation.updated_at : null,
    thread_id: null,
    thread_exists: null,
    created_by_id: automation.created_by,
    created_by_name: input.creator
      ? input.creator.name || input.creator.email
      : null,
    created_by_avatar: input.creator?.avatar ?? null,
    model: null,
    source_version: automation.source_version,
  };
}

export async function buildAutomationsPageData({
  context,
  workspaceId,
  orgId,
  canManage,
  request,
  currentUser,
}: BuildAutomationsPageDataInput): Promise<{ automations: AutomationListItem[] }> {
  const env = getEnv(context);
  const cronStub = getWorkspaceCronStub(env, workspaceId);
  // Run history is panel-only and paginated, so it is fetched per-automation
  // from /api/automations/:id/runs rather than fanned out across the list here.
  const [prompts, workflows, streamingStatuses, latestRunsByAutomation] = await Promise.all([
    cronStub.listScheduledPrompts(workspaceId),
    cronStub.listDeterministicAutomations(workspaceId),
    listStreamingThreadStatuses(env, workspaceId),
    cronStub.listAutomationRuns(workspaceId, { limitPerAutomation: 1 }),
  ]);

  const streamingByThreadId = new Map(
    streamingStatuses.map((status) => [status.threadId, status] as const),
  );
  const latestScheduledRunByPromptId = new Map(
    prompts.map((prompt) => [
      prompt.id,
      latestRunsByAutomation[`scheduled_prompt:${prompt.id}`]?.[0] ?? null,
    ] as const),
  );
  const threadIds = prompts.map((prompt) => prompt.thread_id);
  const orgStub = getOrgStub(env, orgId);
  const threads = threadIds.length > 0
    ? await orgStub.getThreadsByIds(workspaceId, threadIds)
    : [];
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));

  const creators = await getCreators(env, [
    ...prompts.map((prompt) => prompt.created_by),
    ...workflows.map((automation) => automation.created_by),
  ], {
    request,
    preloadedUsers: currentUser ? [currentUser] : undefined,
  });

  const normalizedPrompts = prompts.map((prompt) =>
    normalizeScheduledPrompt({
      prompt,
      canManage,
      creator: creators.get(prompt.created_by) ?? null,
      thread: threadById.get(prompt.thread_id) ?? null,
      latestRun: latestScheduledRunByPromptId.get(prompt.id) ?? null,
      streamingStatus: streamingByThreadId.get(prompt.thread_id) ?? null,
    }),
  );
  const normalizedWorkflows = workflows.map((automation) =>
    normalizeDeterministicAutomation({
      automation,
      canManage,
      creator: creators.get(automation.created_by) ?? null,
    }),
  );

  return {
    automations: sortAutomations([...normalizedPrompts, ...normalizedWorkflows]),
  };
}

export async function listAutomationRunsPageData(input: {
  context: AppLoadContext;
  workspaceId: string;
  kind: AutomationKind;
  automationId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<AutomationRunsPage> {
  const env = getEnv(input.context);
  const cronStub = getWorkspaceCronStub(env, input.workspaceId);
  const fromCursor = input.cursor ?? null;
  const page = await cronStub.listAutomationRunsPage(input.workspaceId, {
    kind: toRunKind(input.kind),
    automationId: input.automationId,
    limit: input.limit,
    cursor: decodeRunsCursor(fromCursor),
  });
  return {
    id: input.automationId,
    kind: input.kind,
    fromCursor,
    runs: page.runs.map(toRunSummary),
    cursor: encodeRunsCursor(page.nextCursor),
  };
}

function findAutomation(
  items: AutomationListItem[],
  kind: AutomationKind,
  id: string,
): AutomationListItem | null {
  return items.find((item) => item.kind === kind && item.id === id) ?? null;
}

export async function mutateAutomation(
  input: MutateAutomationInput,
): Promise<AutomationActionResult> {
  if (!input.canManage) return { error: "Forbidden" };
  const env = getEnv(input.context);
  const cronStub = getWorkspaceCronStub(env, input.workspaceId);
  const existingData = await buildAutomationsPageData(input);
  const existing = findAutomation(existingData.automations, input.kind, input.id);
  if (!existing) return { error: "Automation not found" };
  let runError: string | null = null;

  if (input.intent === "run") {
    const result = input.kind === "agent_task"
      ? await cronStub.runScheduledPromptNow(input.workspaceId, input.id)
      : await cronStub.runDeterministicAutomationNow(input.workspaceId, input.id);
    if (!result) return { error: "Automation not found" };
    if (result.dispatch.status === "error" || result.dispatch.status === "busy") {
      runError = result.dispatch.error ?? "Failed to start run";
    }
  } else if (input.intent === "setEnabled") {
    if (typeof input.enabled !== "boolean") {
      return { error: "enabled is required" };
    }
    const result = input.kind === "agent_task"
      ? await cronStub.updateScheduledPrompt({
          workspaceId: input.workspaceId,
          id: input.id,
          enabled: input.enabled,
        })
      : await cronStub.updateDeterministicAutomation({
          workspaceId: input.workspaceId,
          id: input.id,
          enabled: input.enabled,
        });
    if (!result) return { error: "Automation not found" };
  } else if (input.intent === "rename") {
    const name = input.name?.trim();
    if (!name) return { error: "Name is required" };
    const result = input.kind === "agent_task"
      ? await cronStub.updateScheduledPrompt({
          workspaceId: input.workspaceId,
          id: input.id,
          name,
        })
      : await cronStub.updateDeterministicAutomation({
          workspaceId: input.workspaceId,
          id: input.id,
          name,
        });
    if (!result) return { error: "Automation not found" };
  } else if (input.intent === "delete") {
    const deleted = input.kind === "agent_task"
      ? await cronStub.deleteScheduledPrompt(input.workspaceId, input.id)
      : await cronStub.deleteDeterministicAutomation(input.workspaceId, input.id);
    if (!deleted) return { error: "Automation not found" };
    return { success: true, id: input.id, kind: input.kind };
  } else {
    return { error: "Unknown action" };
  }

  const nextData = await buildAutomationsPageData(input);
  const automation = findAutomation(nextData.automations, input.kind, input.id);
  if (!automation) return { error: "Automation not found" };
  if (runError) return { success: false, automation, error: runError };
  return { success: true, automation };
}
