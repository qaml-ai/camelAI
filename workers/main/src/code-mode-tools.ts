// Code-mode tool layer, extracted from chat-thread-do.ts to keep the
// ChatThreadDO Durable Object file focused. Contains the code-mode
// tool-definition registry/helpers and the CodeModeToolsBinding
// WorkerEntrypoint. Behavior is unchanged by the extraction.
//
// ChatThreadDO is imported as a type only (for the chat-thread DO stub
// signature), so there is no runtime import cycle with ./chat-thread-do.
import { WorkerEntrypoint } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { OrgDO, WorkerScript } from "./auth";
import { Type, type TSchema } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { WorkspaceDO } from "./workspace";
import type { WorkspaceCronDO } from "./workspace-cron";
import { ProjectFilesystemClient, WorkspaceFilesystemClient, normalizeWorkspacePath as normalizeDurableWorkspacePath, type WorkspaceFileStoreLike, type WorkspaceProject, type WorkspaceProjectCloneSummary, projectNameKey } from "./workspace-filesystem-do";
import type { RuntimeCallArtifact, RuntimeCallArtifactKind } from "../../../src/lib/runtime-artifacts";
import { getPreferredAppUrl } from "../../../src/lib/app-url";
import {
  deleteDeployedAppRuntime,
  getDispatchScriptName,
} from "../../../src/lib/deployed-app-delete.server";
import { findConnectionMethodEntry, getConnection, invokeConnectionMethod, listConnectionMethods, listConnections, listConnectionTools, testConnectionMethodEntry, verifyConnection } from "./connections-runtime";
import { confirmDestructiveAction, DESTRUCTIVE_CONFIRM_LABEL } from "./confirmed-destructive-action";
import { collectProjectDeletionTargets } from "./project-deletion";
import {
  connectionsBindingEnabled,
} from "../../../src/lib/connections-binding";
import { DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT } from "./pi-system-prompt";
import {
  listAgentSkillFiles,
  readAgentSkillFile,
  resolveAgentSkillCatalog,
  type AgentSkillReadResult,
} from "./selfhost-agent-pack";
import { PiContainerTools, PI_CONTAINER_TOOL_DEFINITIONS } from "./pi-container-tools";
import { parseFilePreviewPath } from "./preview-paths";
import type { ConnectionSetupResponse } from "./chat-thread-browser-prompts";
import {
  boundLakeErrorMessage,
  sendToolCallRecords,
  toolBlocksOnHuman,
} from "./lake-streams";
import type { HostedCapability } from "../../../src/lib/capability-allowances";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths";
import { retryR2Read } from "../../../src/lib/r2-read-retry";
import { buildWorkspaceEmailAddress, getWorkspaceEmailDomain } from "../../../src/lib/workspace-email";
import { isSelfhostRuntime } from "../../../src/lib/selfhost-runtime";
import { SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE } from "../../../src/lib/selfhost-capabilities";
import { CodeModeCustomDomains } from "./code-mode-custom-domains";
import { detectImageMimeType as detectSharedImageMimeType, getSupportedImageMimeTypeFromContentType, inlineImageMaxBase64Chars, prepareInlineImageFromStream, readImageSniffBytesAndReplayStream, type PreparedInlineImage, readStreamBytes } from "./image-tool-content";
import { CodeModeScheduledPrompts } from "./code-mode-scheduled-prompts";
import { CodeModeDeterministicAutomations } from "./code-mode-deterministic-automations";
import { CodeModeIntegrations } from "./code-mode-integrations";
import {
  deriveVerifiedWorkEvidence,
  type VerifiedWorkEvidence,
} from "./chat-thread/verified-work-state";
import { PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS } from "./container-sizing";
import { recordErrorEvent, recordObservabilityEvent } from "./observability";
import { buildLogTail, cleanBuildLog, DEFAULT_BUILD_TIMEOUT_MS, projectBuildSandboxKey, runProjectAddDependency, runProjectBuild, type ProjectBuildResult } from "./project-build-service";
import {
  createProjectBuildReadinessGate,
  ensureBuildSandboxReady,
  withProjectBuildServiceErrorMapping,
  type ProjectBuildReadinessEvent,
  type ProjectBuildReadinessGate,
  type ProjectBuildReadinessResult,
} from "./project-build-readiness";
import { collectWorkerBundleFromSandbox, findUnexportedDurableObjectClasses, type ProjectBuildSandboxLike } from "./project-worker-bundle";
import { buildNotebookWorkerBundle, resolveNotebookDeployPath } from "./notebook-worker-bundle";
import {
  ANALYSIS_DEFAULT_DEP_TIMEOUT_MS,
  ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
  ANALYSIS_DEFAULT_NOTEBOOK_TIMEOUT_MS,
  ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
  ANALYSIS_NOTEBOOK_STDERR_MAX_CHARS,
  ANALYSIS_NOTEBOOK_STDOUT_MAX_CHARS,
  ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS,
  ANALYSIS_SESSION_RESTARTED_MESSAGE,
  clampOutputTail,
  isSandboxSessionDeathError,
} from "./analysis-service";
import {
  createSandboxExecDeadline,
  SANDBOX_EXEC_DEADLINE_GRACE_MS,
  type SandboxDeadlineExceededEvent,
  type SandboxExecDeadline,
} from "./sandbox-exec-deadline";
import type { ProjectScaffoldResult } from "./project-scaffold";
import { connectAppBrowserSession, launchAppBrowserSession } from "./app-browser-binding";
import { deployWorkerModulesDirect, rollbackWorkerDeployFromArtifactCache, type DirectDispatchDeployResult } from "./direct-dispatch-deploy";
import { handleDeploySideEffects } from "./services/deploy";
import { editAutomationVirtualFile, listAutomationVirtualFiles, normalizeAutomationVirtualPath, readAutomationVirtualFile, writeAutomationVirtualFile } from "./deterministic-automation-virtual-files";
import { applyTextEdits, normalizeTextEditArguments } from "./text-edit";
import type { DynamicIntegrationSchema } from "../../../src/lib/integration-registry";
import type { ChatThreadDO } from "./chat-thread-do";
import { ChannelTools } from "./chat-channels";
import {
  PI_TOOL_RESULT_MAX_BYTES,
  PI_TOOL_RESULT_MAX_LINES,
} from "./pi-message-storage";
import type {
  ChatEnv,
  ChatContextState,
  PreviewTarget,
  NormalizedTodoItem,
  NormalizedTodoStatus,
} from "./chat-thread-do";

export interface CodeModeToolsProps {
  orgId: string;
  workspaceId: string;
  threadId?: string;
  userId?: string;
  parentToolUseId?: string;
  /** Explicitly false for main-agent js_exec; Research opts in to web tools. */
  allowWebTools?: boolean;
}

export interface AIVirtualBindingProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

/**
 * Size of a tool result for telemetry only. Never throws and never retains the
 * serialized copy: an unserializable or oversized result reports 0 rather than
 * failing the tool call it is measuring.
 */
function measureResultChars(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function simplifyAgentWebToolResult(name: string, value: unknown): unknown {
  if (name !== "WebSearch" && name !== "WebFetch") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return name === "WebSearch" ? [] : "";
  }
  const record = value as Record<string, unknown>;
  const results = Array.isArray(record.results)
    ? record.results.filter((result): result is Record<string, unknown> => (
      Boolean(result) && typeof result === "object" && !Array.isArray(result)
    ))
    : [];
  if (name === "WebSearch") {
    return results.map((result) => {
      const compact: Record<string, string> = {};
      for (const key of ["title", "url", "snippet"] as const) {
        const field = result[key];
        if (typeof field === "string" && field.trim()) compact[key] = field;
      }
      return compact;
    }).filter((result) => Object.keys(result).length > 0);
  }
  const first = results[0];
  if (!first) return "";
  if (typeof first.text === "string" && first.text.trim()) return first.text;
  return typeof first.snippet === "string" ? first.snippet : "";
}

interface CodeModeToolDefinition {
  name: string;
  description: string;
  parameters: TSchema;
  category: CodeModeToolCategory;
  examples: string[];
  sideEffect: boolean;
  externalDelivery: boolean;
  /**
   * Callable but not discoverable: retained compatibility tools stay on the
   * js_exec `tools` object while being omitted from help, search, prompt
   * inventories, and Pi top-level registration.
   */
  hidden: boolean;
}

interface CodeModeToolRegistration extends CodeModeToolDefinition {
  piPassthrough: boolean;
}

type CodeModeToolCategory =
  | "workspace"
  | "user_interaction"
  | "communication"
  | "apps"
  | "schedules"
  | "workflows"
  | "integrations"
  | "domains"
  | "web"
  | "agents"
  // Notebook/python/shell execution in the analysis sandbox. Split out of
  // "connections" so the primary data-analysis path is not filed under the
  // connection-management long tail.
  | "analysis"
  | "connections";

interface CodeModeToolOptions {
  piPassthrough?: boolean;
  category?: CodeModeToolCategory;
  examples?: string[];
  sideEffect?: boolean;
  externalDelivery?: boolean;
  hidden?: boolean;
}

type CodeModeToolCallHandler = (
  binding: CodeModeToolsBinding,
  args: Record<string, unknown>,
  name: string,
) => Promise<unknown> | unknown;

type CodeModeR2Mount = "uploads" | "outputs" | "tmp";

interface CodeModeR2Path {
  mount: CodeModeR2Mount;
  key: string;
  path: string;
  relativePath: string;
}

type CodeModeFileLocation = "workspace" | "project" | "r2";

interface CodeModeMoveEndpoint {
  location: CodeModeFileLocation;
  path: string;
  project?: string;
  contentType?: string;
}

interface CodeModeMoveFile {
  path: string;
  relativePath: string;
  size?: number;
  contentType?: string;
}

export const CODE_MODE_COMPATIBILITY_DATE = "2026-05-11";
export const CODE_MODE_MAX_TIMEOUT_MS = 600_000;
export const CODE_MODE_DEFAULT_TIMEOUT_MS = CODE_MODE_MAX_TIMEOUT_MS;
export const CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS = 60_000;
export const CODE_MODE_MAX_OUTPUT_CHARACTERS = 200_000;
const CODE_MODE_R2_READ_NOTICE_RESERVED_BYTES = 1024;
const CODE_MODE_R2_MAX_WRITE_BYTES = 10 * 1024 * 1024;
const ARCHIVE_TOOL_COMMAND = "python /usr/local/bin/camelai-archive";

/**
 * File extensions whose contents are binary. Writing text to one of these
 * produces a file that downloads but will not open.
 */
const CODE_MODE_BINARY_EXTENSIONS = new Set([
  "xlsx", "xls", "xlsm", "docx", "doc", "pptx", "ppt", "pdf",
  "zip", "gz", "tar", "7z", "rar",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff",
  "mp3", "mp4", "wav", "mov", "avi", "webm",
  "parquet", "db", "sqlite", "wasm", "woff", "woff2", "ttf", "otf",
]);

/** Long, unbroken, base64-alphabet text — what an encoded binary looks like. */
function looksLikeBase64Payload(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 512) return false;
  return /^[A-Za-z0-9+/\r\n=]+$/.test(trimmed);
}

/**
 * Reject base64 text written to a binary filename.
 *
 * `write` is text-only — there is no encoding parameter — so an agent trying to
 * deliver a generated spreadsheet would base64 it and write that string to
 * `outputs/report.xlsx`. R2 accepted it, the tool reported success, and the user
 * got a download that would not open. This happened in production: the agent
 * wrote 9,556 characters of base64 to a .xlsx twice, saw no error either time,
 * and eventually deployed a Worker to serve the file instead.
 *
 * Fail loudly and point at the mount that actually carries bytes.
 */
export function assertNotBase64IntoBinaryFile(path: string, content: string): void {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (!CODE_MODE_BINARY_EXTENSIONS.has(extension)) return;
  if (!looksLikeBase64Payload(content)) return;
  throw new Error(
    `Refusing to write base64 text to ${path}: the write tool stores content verbatim, so this would produce a corrupt .${extension} that will not open. ` +
    `Generate the file in the analysis sandbox and save it straight to the writable /outputs mount instead — e.g. run_code with wb.save('/outputs/${path.split("/").pop()}') — ` +
    `which writes real bytes to the same outputs/ object the user downloads.`,
  );
}
const CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES = 10 * 1024 * 1024;
const JS_EXEC_EXCLUDED_TOOL_NAMES = new Set([
  // This tool waits for human input and can outlive js_exec's short sandbox
  // timeout. Keep it as a top-level Pi tool so the agent sees the submission.
  "prompt_connection_setup",
  "delete_connection",
  "delete_app",
  "delete_project",
  // Blocks on human input the same way; keep it out of the js_exec catalog so
  // tools.search() can't advertise burying a user prompt inside the sandbox
  // timeout. It stays a top-level Pi tool.
  "AskUserQuestion",
  // Backing tool for env.WORKSPACE.*. Keep the user-facing runtime facade in
  // tools.help(), not the implementation detail.
  "workspace_info",
]);

export function clampCodeModeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function truncateCodeModeText(value: unknown, maxCharacters: number): string {
  const text = String(value ?? "");
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n\n[Truncated: ${maxCharacters} of ${text.length} characters]`;
}

/**
 * Clamp an analysis run result's stdout/stderr for the model, keeping the TAIL
 * (nbconvert puts the failing cell + Python traceback at the END of stderr,
 * while the model-side tool-result cap truncates head-first over the whole
 * JSON). When anything was clamped, `fullLog` carries the untruncated combined
 * output for the caller to spill to R2 — the escape-hatch log the agent can
 * read back in full. Pure; exported for tests.
 */
export function clampAnalysisRunOutputs(result: Record<string, unknown>): {
  result: Record<string, unknown>;
  fullLog: string | null;
} {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stdout.length <= ANALYSIS_NOTEBOOK_STDOUT_MAX_CHARS && stderr.length <= ANALYSIS_NOTEBOOK_STDERR_MAX_CHARS) {
    return { result, fullLog: null };
  }
  const fullLog =
    `=== stdout (${stdout.length} chars) ===\n${stdout}\n\n` +
    `=== stderr (${stderr.length} chars) ===\n${stderr}\n`;
  return {
    result: {
      ...result,
      stdout: clampOutputTail(stdout, ANALYSIS_NOTEBOOK_STDOUT_MAX_CHARS),
      stderr: clampOutputTail(stderr, ANALYSIS_NOTEBOOK_STDERR_MAX_CHARS),
    },
    fullLog,
  };
}

function basenameForMove(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}

function joinRelativeMovePath(root: string, child: string): string {
  const cleanRoot = root.replace(/^\/+|\/+$/g, "");
  const cleanChild = child.replace(/^\/+|\/+$/g, "");
  if (!cleanRoot) return cleanChild;
  if (!cleanChild) return cleanRoot;
  return `${cleanRoot}/${cleanChild}`;
}

function joinMoveDestinationPath(location: CodeModeFileLocation, root: string, child: string): string {
  const cleanChild = child.replace(/^\/+/, "");
  if (location === "r2") {
    const cleanRoot = root.replace(/^\/+|\/+$/g, "");
    return cleanRoot ? `${cleanRoot}/${cleanChild}` : cleanChild;
  }
  const cleanRoot = root.replace(/\/+$/g, "");
  if (!cleanRoot || cleanRoot === "/") return `/${cleanChild}`;
  return `${cleanRoot}/${cleanChild}`;
}

function bytesToBase64ForMove(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Warn (not block) when a notebook is deployed without any cell outputs — the
// published report would render code and prose but no charts/tables. Parse
// failures return true so the deploy proceeds without a misleading warning.
function notebookHasCellOutputs(notebookBytes: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(notebookBytes)) as { cells?: unknown };
    const cells = Array.isArray(parsed?.cells) ? parsed.cells : null;
    if (!cells) return true;
    return cells.some((cell) => {
      if (!cell || typeof cell !== "object") return false;
      const record = cell as { cell_type?: unknown; outputs?: unknown };
      return record.cell_type === "code" && Array.isArray(record.outputs) && record.outputs.length > 0;
    });
  } catch {
    return true;
  }
}

function base64ToBytesForMove(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeTodoStatus(value: unknown): NormalizedTodoStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (status) {
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "inprogress":
    case "in_progress":
    case "in-progress":
    case "running":
    case "active":
      return "in_progress";
    default:
      return "pending";
  }
}

function normalizeTodoText(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value
      .map(normalizeTodoText)
      .filter(Boolean)
      .join("");
  }
  return "";
}

function normalizeTodoItem(value: unknown, index: number): NormalizedTodoItem | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const content = String(value).trim();
    return content ? { content, status: "pending", activeForm: content } : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const content =
    normalizeTodoText(record.content) ||
    normalizeTodoText(record.step) ||
    normalizeTodoText(record.title) ||
    normalizeTodoText(record.task) ||
    normalizeTodoText(record.text) ||
    normalizeTodoText(record.description) ||
    normalizeTodoText(record.name) ||
    `Task ${index + 1}`;
  const activeForm =
    normalizeTodoText(record.activeForm) ||
    normalizeTodoText(record.active_form) ||
    normalizeTodoText(record.active) ||
    content;

  return {
    content,
    status: normalizeTodoStatus(record.status),
    activeForm,
  };
}

export function normalizeTodoItems(values: unknown[]): NormalizedTodoItem[] {
  return values
    .map(normalizeTodoItem)
    .filter((todo): todo is NormalizedTodoItem => todo !== null);
}

const EMPTY_PARAMETERS = Type.Object({});
const CONNECTION_QUERY_PARAMETERS = Type.Object({
  query: Type.Union([
    Type.String(),
    Type.Object({}, { additionalProperties: true }),
  ]),
});

function codeModeTool(
  name: string,
  description: string,
  parameters: TSchema = EMPTY_PARAMETERS,
  options: CodeModeToolOptions = {},
): CodeModeToolRegistration {
  return {
    name,
    description,
    parameters,
    category: options.category ?? "workspace",
    examples: options.examples ?? [],
    sideEffect: options.sideEffect ?? false,
    externalDelivery: options.externalDelivery ?? false,
    hidden: options.hidden ?? false,
    piPassthrough: options.piPassthrough ?? false,
  };
}

function codeModePassthroughTool(
  name: string,
  description: string,
  parameters: TSchema = EMPTY_PARAMETERS,
  options: Omit<CodeModeToolOptions, "piPassthrough"> = {},
): CodeModeToolRegistration {
  return codeModeTool(name, description, parameters, { ...options, piPassthrough: true });
}

function codeModeDefinition(
  registration: CodeModeToolRegistration,
): CodeModeToolDefinition {
  return {
    name: registration.name,
    description: registration.description,
    parameters: registration.parameters,
    category: registration.category,
    examples: registration.examples,
    sideEffect: registration.sideEffect,
    externalDelivery: registration.externalDelivery,
    hidden: registration.hidden,
  };
}

const CODE_MODE_CONTAINER_TOOL_NAMES = [
  "read",
  "write",
  "ls",
  "edit",
  "grep",
  "find",
  "delete",
] as const;

const CODE_MODE_CONTAINER_TOOL_DEFINITIONS = CODE_MODE_CONTAINER_TOOL_NAMES.map(
  (name) => {
    const definition = PI_CONTAINER_TOOL_DEFINITIONS[name];
    return codeModeTool(definition.name, definition.description, definition.parameters, {
      category: "workspace",
      sideEffect: ["write", "edit"].includes(definition.name),
    });
  },
);

const MOVE_ENDPOINT_PARAMETERS = Type.Object({
  location: Type.Union([
    Type.Literal("workspace"),
    Type.Literal("project"),
    Type.Literal("r2"),
  ], {
    description: "Required filesystem location: workspace, project, or r2.",
  }),
  path: Type.String({
    description: "Path at that location. R2 paths must be uploads/<path>, outputs/<path>, or tmp/<path> with no leading slash.",
  }),
  project: Type.Optional(Type.String({
    description: "Required when location is project; unique workspace project name.",
  })),
  content_type: Type.Optional(Type.String({
    description: "Destination R2 content type override.",
  })),
}, { additionalProperties: false });

const ASK_USER_QUESTION_TOOL = codeModePassthroughTool(
  "AskUserQuestion",
  "Ask the user one or more multiple-choice questions in the chat UI and wait for answers. Arguments: { questions }.",
  Type.Object({
    questions: Type.Array(Type.Object({}, { additionalProperties: true })),
  }),
  {
    category: "user_interaction",
  },
);
const CHANNEL_ATTACHMENT_PARAMETERS = Type.Optional(Type.Array(Type.Object({
  path: Type.String(),
  filename: Type.Optional(Type.String()),
  content_type: Type.Optional(Type.String()),
  caption: Type.Optional(Type.String()),
  send_as: Type.Optional(Type.String()),
})));
const SEND_EMAIL_TOOL = codeModeTool(
  "send_email",
  "Send an email from the current workspace. This tool is available only inside js_exec as tools.send_email(...) or deterministic workflows as this.env.TOOLS.send_email(...); it is not a top-level tool. Use this only when channel instructions require an external reply or the user explicitly asks to send an email. Normal assistant replies stay in chat and must not be emailed. Arguments: { to, subject, text?, html?, reply_to?, attachments? }.",
  Type.Object({
    to: Type.String(),
    subject: Type.String(),
    text: Type.Optional(Type.String()),
    html: Type.Optional(Type.String()),
    reply_to: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
  {
    category: "communication",
    examples: [
      `await tools.send_email({ to: "person@example.com", subject: "Update", text: "Here is the update." })`,
      `await tools.send_email({ to: "person@example.com", subject: "Files", text: "Attached.", attachments: [{ path: "uploads/report.pdf" }] })`,
    ],
    sideEffect: true,
    externalDelivery: true,
  },
);
const SEND_SLACK_MESSAGE_TOOL = codeModeTool(
  "send_slack_message",
  "Send a Slack message from the current workspace. This tool is available only inside js_exec as tools.send_slack_message(...) or deterministic workflows as this.env.TOOLS.send_slack_message(...); it is not a top-level tool. In a Slack-originated thread, routing defaults to that Slack conversation. Otherwise provide channel_id and, when multiple Slack connections exist, integration_id or team_id. Use thread_ts to reply in a Slack thread. Arguments: { text?, integration_id?, team_id?, channel_id?, thread_ts?, attachments? }.",
  Type.Object({
    text: Type.Optional(Type.String()),
    integration_id: Type.Optional(Type.String()),
    team_id: Type.Optional(Type.String()),
    channel_id: Type.Optional(Type.String()),
    thread_ts: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
  {
    category: "communication",
    examples: [
      `await tools.send_slack_message({ channel_id: "C123", text: "Here is the update." })`,
      `await tools.send_slack_message({ integration_id: "slack_prod", channel_id: "C123", thread_ts: "1712345678.901", text: "Replying in thread." })`,
    ],
    sideEffect: true,
    externalDelivery: true,
  },
);
const SEND_TELEGRAM_MESSAGE_TOOL = codeModeTool(
  "send_telegram_message",
  "Send a Telegram message from the current workspace. This tool is available only inside js_exec as tools.send_telegram_message(...) or deterministic workflows as this.env.TOOLS.send_telegram_message(...); it is not a top-level tool. In a Telegram-originated thread, routing defaults to that chat. Outside Telegram threads, integration_id is optional when exactly one connected Telegram integration exists; if there are multiple, call tools.list_integrations({}) and use the Telegram integration id. Do not invent chat ids. Image attachments are sent as native Telegram photos when possible; use attachments[].send_as = 'document' to force file/document delivery. Arguments: { text?, chat_id?, integration_id?, attachments? }.",
  Type.Object({
    text: Type.Optional(Type.String()),
    chat_id: Type.Optional(Type.String()),
    integration_id: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
  {
    category: "communication",
    examples: [
      `await tools.send_telegram_message({ integration_id: "telegram_direct", text: "Here is the update." })`,
      `await tools.send_telegram_message({ integration_id: "telegram_direct", text: "Attached.", attachments: [{ path: "uploads/photo.jpg" }] })`,
    ],
    sideEffect: true,
    externalDelivery: true,
  },
);
const SEND_DISCORD_MESSAGE_TOOL = codeModeTool(
  "send_discord_message",
  "Send a Discord message through the workspace's native Discord channel. This tool is available only inside js_exec as tools.send_discord_message(...) or deterministic workflows as this.env.TOOLS.send_discord_message(...); it is not a top-level tool. In a Discord-originated thread, routing is fixed to that Camel-created Discord thread. Outside Discord threads, integration_id is optional only when exactly one active Discord channel exists. Do not invent server, channel, or thread ids. Arguments: { text?, integration_id?, attachments? }.",
  Type.Object({
    text: Type.Optional(Type.String()),
    integration_id: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
  {
    category: "communication",
    examples: [
      `await tools.send_discord_message({ integration_id: "discord_team", text: "Here is the update." })`,
      `await tools.send_discord_message({ integration_id: "discord_team", text: "Attached.", attachments: [{ path: "uploads/report.pdf" }] })`,
    ],
    sideEffect: true,
    externalDelivery: true,
  },
);
const WEB_SEARCH_TOOL = codeModePassthroughTool(
  "WebSearch",
  "Search the web. Arguments: { query, numResults?, maxCharacters? }. In js_exec, result.data is an array of { title?, url?, snippet? } results.",
  Type.Object({
    query: Type.String(),
    numResults: Type.Optional(Type.Number()),
    maxCharacters: Type.Optional(Type.Number()),
    includeDomains: Type.Optional(Type.Array(Type.String())),
    excludeDomains: Type.Optional(Type.Array(Type.String())),
    startPublishedDate: Type.Optional(Type.String()),
    endPublishedDate: Type.Optional(Type.String()),
    searchType: Type.Optional(Type.String()),
    category: Type.Optional(Type.String()),
  }),
  {
    category: "web",
    examples: [`await tools.WebSearch({ query: "Cloudflare Workers Durable Objects", numResults: 5 })`],
  },
);
const WEB_FETCH_TOOL = codeModePassthroughTool(
  "WebFetch",
  "Fetch text from a URL. Arguments: { url, maxCharacters? }. In js_exec, result.data is the fetched markdown string.",
  Type.Object({
    url: Type.String(),
    maxCharacters: Type.Optional(Type.Number()),
    query: Type.Optional(Type.String()),
    content: Type.Optional(Type.String()),
  }),
  {
    category: "web",
    examples: [`await tools.WebFetch({ url: "https://developers.cloudflare.com/workers/", maxCharacters: 12000 })`],
  },
);
const AGENT_TOOL = codeModeTool(
  "Agent",
  "Run a focused subagent in the same workspace. Arguments: { prompt, description?, agent?, model? }.",
  Type.Object({
    prompt: Type.String(),
    description: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
  }),
  {
    category: "agents",
  },
);
const EXPLORE_TOOL = codeModeTool(
  "Explore",
  "Run a focused read-oriented exploration subagent in the same workspace. Arguments: { prompt? or query?, description?, agent?, model? }.",
  Type.Object({
    prompt: Type.Optional(Type.String()),
    query: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
  }),
  {
    category: "agents",
  },
);

const CODE_MODE_TOOL_REGISTRY: CodeModeToolRegistration[] = [
  ...CODE_MODE_CONTAINER_TOOL_DEFINITIONS,
  codeModeTool(
    "move",
    "Transfer files between any two explicit locations: workspace, project, or r2. Copies by default and overwrites the destination. Use deleteSource: true only when you intentionally want a destructive move after a successful copy. Arguments: { source: { location, path, project? }, destination: { location, path, project?, content_type? }, deleteSource? }.",
    Type.Object({
      source: MOVE_ENDPOINT_PARAMETERS,
      destination: MOVE_ENDPOINT_PARAMETERS,
      deleteSource: Type.Optional(Type.Boolean({
        description: "Delete the source after all destination writes succeed. Defaults to false.",
      })),
    }, { additionalProperties: false }),
    { category: "workspace", sideEffect: true },
  ),
  codeModePassthroughTool(
    "read_skill",
    "Read a bundled agent skill or one of its Markdown reference files. Use this instead of the generic read tool for skills; it never reads from project storage and needs no location, project, or absolute path. Omit file to read SKILL.md. Arguments: { skill, file? }.",
    Type.Object({
      skill: Type.String({
        description: "Bundled skill name, for example 'developing-software'.",
      }),
      file: Type.Optional(Type.String({
        description: "Markdown file within the skill, for example 'VANILLA-APPS.md' or 'references/example.md'. Defaults to SKILL.md.",
      })),
    }, { additionalProperties: false }),
  ),
  codeModePassthroughTool(
    "list_projects",
    "List known projects for this workspace as a nested tree, including descriptions. Top-level rows are source projects; clone projects are nested under each source project's clones[] with cloneCount. Arguments: {}.",
  ),
  codeModePassthroughTool(
    "create_project",
    "REQUIRED PRECONDITION: before calling create_project for the first time in a task, read the developing-software skill by calling read_skill with skill='developing-software', then read the entire result. Skip that read only if it already succeeded during the current task. Do not treat this as optional guidance. This tool creates a new DO-backed project and seeds a scaffold. The skill explains template selection, how to reshape each starter, and the build/deploy workflow. Project names must be unique within the workspace. New projects require a concise description. The default template is 'crud': a deployable React Router app with a SQLite Durable Object and working list/create/update/delete flow. Other templates: 'vanilla' for dependency-light client-only HTML/CSS/JavaScript experiences and simple browser games, 'ai-chat' for a virtual-AI-powered assistant, 'integration-dashboard' for workspace connection catalogs, 'data-dashboard' for interactive charts/tables, and 'data-analysis' for a notebook report. Arguments: { name, description, template? }.",
    Type.Object({
      name: Type.String(),
      description: Type.String(),
      template: Type.Optional(Type.Union([
        Type.Literal("crud"),
        Type.Literal("vanilla"),
        Type.Literal("ai-chat"),
        Type.Literal("integration-dashboard"),
        Type.Literal("data-dashboard"),
        Type.Literal("data-analysis"),
      ], {
        description: "Optional scaffold template. Defaults to crud. Choose vanilla for client-only plain HTML/CSS/JavaScript or a simple browser game; use data-analysis only for notebook-first reports.",
      })),
    }, { additionalProperties: false }),
  ),
  codeModePassthroughTool(
    "set_project_description",
    "Set the description for an existing project by its unique workspace project name. Use this when the project's purpose changes or needs clarification. Arguments: { project, description }.",
    Type.Object({
      project: Type.String(),
      description: Type.String(),
    }, { additionalProperties: false }),
    {
      sideEffect: true,
    },
  ),
  codeModeTool(
    "add_dependency",
    "Add one npm registry dependency to a DO-backed project with the platform dependency pipeline. This runs a fixed bun add command and persists package.json plus bun.lock back to project storage. Arguments: { project, dependency, dev? }.",
    Type.Object({
      project: Type.String(),
      dependency: Type.String(),
      dev: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    { category: "workspace", sideEffect: true },
  ),
  codeModeTool(
    "add_shadcn_component",
    "Add bundled shadcn/ui components or full blocks (login pages, sidebar layouts, dashboards) to a DO-backed React Router project without npm registry access. Registry dependencies are resolved transitively and any npm packages a component needs are added to package.json automatically (installed on the next build). Prefer this over hand-writing standard UI components. Block pages land under /app/blocks/<name>/page.tsx and must be registered as a route in app/routes.ts. Use standard shadcn component or block names; an unsupported name returns the available catalog. Arguments: { project, component? or components?, force? }.",
    Type.Object({
      project: Type.String(),
      component: Type.Optional(Type.String()),
      components: Type.Optional(Type.Array(Type.String())),
      force: Type.Optional(Type.Boolean({ description: "Overwrite existing component files. Defaults to false." })),
    }, { additionalProperties: false }),
    { category: "workspace", sideEffect: true },
  ),
  codeModeTool(
    "revert_project",
    "Restore a DO-backed project's source files to a previous source snapshot. Use snapshot_id from list_commits.commits[]; list_deploy_versions is for deployed artifact rollback, not source snapshots. Restoring source does not publish the live app unless deploy=true or you subsequently call deploy_project. Arguments: { project, snapshot_id, deploy?, script_name? }.",
    Type.Object({
      project: Type.String(),
      snapshot_id: Type.String(),
      deploy: Type.Optional(Type.Boolean()),
      script_name: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    { category: "workspace", sideEffect: true },
  ),
  codeModeTool(
    "list_commits",
    "List source snapshots for a DO-backed project, newest first. These snapshot ids are the current platform source-version keys and can be passed to revert_project. Arguments: { project, limit? }.",
    Type.Object({
      project: Type.String(),
      limit: Type.Optional(Type.Number()),
    }, { additionalProperties: false }),
    { category: "workspace" },
  ),
  codeModePassthroughTool(
    "deploy_project",
    "Build, deploy, return the live URL, and open a DO-backed project in preview through the platform direct deploy path. A successful call proves publication, not feature correctness or live-data quality. Pass dry_run=true to validate without publishing or changing preview. A validation, build, or deploy failure is returned with diagnostics. Data-analysis notebook publication is an external side effect and requires publish_intent='user_requested'; creating or previewing a report alone does not authorize publication. Run run_notebook first so outputs are fresh. Arguments: { project, script_name?, path?, timeoutMs?, dry_run?, publish_intent? }.",
    Type.Object({
      project: Type.String(),
      script_name: Type.Optional(Type.String()),
      path: Type.Optional(Type.String({
        description: "Notebook path inside the project to publish (data-analysis projects only). Defaults to analysis.ipynb or the project's single notebook.",
      })),
      timeoutMs: Type.Optional(Type.Number()),
      dry_run: Type.Optional(Type.Boolean({
        description: "Validate/build without deploying or changing the active preview. Defaults to false.",
      })),
      publish_intent: Type.Optional(Type.Literal("user_requested", {
        description: "Required to publish a data-analysis notebook; confirms the user explicitly asked to publish, deploy, or create a shareable app.",
      })),
    }, { additionalProperties: false }),
    { category: "workspace", sideEffect: true },
  ),
  codeModeTool(
    "rollback_deploy",
    "Rollback a deployed app by re-uploading a cached deploy artifact without rebuilding. Use artifact_cache_key to target a specific cached artifact; otherwise the app's latest registered artifact is used. Arguments: { script_name, artifact_cache_key? }.",
    Type.Object({
      script_name: Type.String(),
      artifact_cache_key: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    { category: "apps", sideEffect: true },
  ),
  codeModeTool(
    "list_deploy_versions",
    "List cached deploy versions for an app, newest first. Use artifact_cache_key values with rollback_deploy to restore a version without rebuilding. Arguments: { script_name, limit? }.",
    Type.Object({
      script_name: Type.String(),
      limit: Type.Optional(Type.Number()),
    }, { additionalProperties: false }),
    { category: "apps" },
  ),
  codeModePassthroughTool(
    "delete_app",
    "Delete a deployed app after the user confirms in chat. This removes the live deployment but keeps its source project. Use this as a top-level tool, not from js_exec. Arguments: { script_name }.",
    Type.Object({
      script_name: Type.String(),
    }, { additionalProperties: false }),
    {
      category: "apps",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "delete_project",
    "Delete a project after the user confirms in chat. Any deployed apps linked to the project are always deleted first so no live app is orphaned. Use this as a top-level tool, not from js_exec. Accepts the unique workspace project name. Deleting a source project also deletes its clone projects and their linked apps. Arguments: { project }.",
    Type.Object({
      project: Type.String(),
    }, { additionalProperties: false }),
    {
      sideEffect: true,
    },
  ),
  ASK_USER_QUESTION_TOOL,
  SEND_EMAIL_TOOL,
  SEND_SLACK_MESSAGE_TOOL,
  SEND_TELEGRAM_MESSAGE_TOOL,
  SEND_DISCORD_MESSAGE_TOOL,
  codeModePassthroughTool(
    "TodoWrite",
    "Update the visible task list in the chat UI. Arguments: { todos: [{ content, status, activeForm? }] }. Status is pending, in_progress, or completed.",
    Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.Optional(Type.String()),
          step: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          task: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          activeForm: Type.Optional(Type.String()),
          active_form: Type.Optional(Type.String()),
        }, { additionalProperties: true }),
      ),
    }),
    {
      category: "user_interaction",
      sideEffect: true,
    },
  ),
  codeModeTool(
    "workspace_info",
    "Get current workspace metadata for js_exec, including email_address when users can email the current workspace. Prefer await env.WORKSPACE.emailAddress() when you only need the address. Arguments: {}.",
    EMPTY_PARAMETERS,
    {
      category: "workspace",
    },
  ),
  codeModePassthroughTool(
    "set_preview",
    "Manually set the active preview to exactly one existing app or file. deploy_project already previews a successful new deploy, so a follow-up call is not required, but this tool remains available whenever you explicitly want to reopen, switch, or override the preview. App example: { app_name: 'poll-maker' }. Durable workspace file example: { location: 'workspace', path: '/notes.md' }. DO-backed project file example: { location: 'project', project: 'menu-app', path: 'index.html' }. R2 file example: { location: 'r2', path: 'outputs/report.html' }. Successful file previews are validated before the preview changes. Arguments: { script_name?, app_name?, path?, content_type?, location?, project? }.",
    Type.Object({
      script_name: Type.Optional(Type.String()),
      app_name: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      content_type: Type.Optional(Type.String()),
      location: Type.Optional(Type.Union([
        Type.Literal("workspace"),
        Type.Literal("project"),
        Type.Literal("r2"),
      ])),
      project: Type.Optional(Type.String()),
    }),
    {
      category: "apps",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "list_apps",
    "List previously deployed apps for discovery or inspection. deploy_project already returns the new app URL and confirms successful publishing, so list_apps is not needed merely to verify a successful deploy. Optional filters keep output small: name matches app/custom-domain names, project matches project_id or app name, limit caps results, and sort defaults to updated_desc. Arguments: { name?, project?, limit?, sort? }.",
    Type.Object({
      name: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      sort: Type.Optional(Type.Union([Type.Literal("updated_desc"), Type.Literal("updated_asc"), Type.Literal("name_asc")])),
    }, { additionalProperties: false }),
    {
      category: "apps",
    },
  ),
  codeModePassthroughTool(
    "set_app_visibility",
    "Change a deployed app visibility. Arguments: { script_name, is_public }.",
    Type.Object({
      script_name: Type.String(),
      is_public: Type.Boolean(),
    }),
    {
      category: "apps",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "get_latest_logs",
    "Get recent logs for a deployed app. Arguments: { script_name, limit?, since_ms? }.",
    Type.Object({
      script_name: Type.String(),
      limit: Type.Optional(Type.Number()),
      since_ms: Type.Optional(Type.Number()),
    }),
    {
      category: "apps",
    },
  ),
  codeModePassthroughTool(
    "take_screenshot",
    "Opt-in visual verification for a deployed workspace app. Do not capture a screenshot automatically after every successful deploy; use this when the user or task explicitly requests a visual check or when diagnosing a deployed UI issue. Returns concise metadata by default; pass include_image_data_url=true only when the inline base64 image is needed. Arguments: { script_name, path?, width?, height?, wait_ms?, include_image_data_url? }.",
    Type.Object({
      script_name: Type.String(),
      path: Type.Optional(Type.String()),
      width: Type.Optional(Type.Number()),
      height: Type.Optional(Type.Number()),
      wait_ms: Type.Optional(Type.Number()),
      include_image_data_url: Type.Optional(Type.Boolean()),
    }),
    {
      category: "apps",
    },
  ),
  codeModePassthroughTool(
    "run_notebook",
    "Execute a Jupyter notebook (.ipynb) in a DO-backed project, persist the executed notebook + any changed files, and open a clean successful run in preview automatically. This is the PRIMARY data-analysis path — one call runs `jupyter nbconvert --execute --inplace`, validates the result, and previews it, so you don't drive nbconvert/validate or call set_preview by hand. The default Python data stack (pandas, numpy, polars, duckdb, pyarrow, altair, plotly, matplotlib, seaborn, scipy, scikit-learn, statsmodels, openpyxl, pdfplumber, jupyter) is PREINSTALLED — no setup needed; use add_python_dependency for anything else. Read big inputs from the read-only mounts — uploaded files at /uploads/<name> (the R2 uploads/<name> reference with a leading slash) and connection exports at '/' + r2_key — keep large intermediates in the per-run $SCRATCH directory (created for you, cleaned up after the run), and put notebooks + small results in the project. To hand the user a generated FILE (.xlsx, .csv, .pdf, .zip, an image), write it to the writable /outputs mount: `wb.save('/outputs/costs.xlsx')` makes it the R2 outputs/costs.xlsx reference, downloadable at /api/workspaces/<workspaceId>/outputs/costs.xlsx and previewable with set_preview({ location: 'r2', path: 'outputs/costs.xlsx' }). Never base64 a binary through the text-only write tool, and never deploy an app just to serve a file. deploy_project publishes the executed notebook as a static report app, returns the live URL, and opens that app in preview automatically when the user wants a shareable link. Returns { ok, executed, validation: { clean, issues }, preview?, message?, stdout, stderr, exitCode, changedFiles, removedFiles, skippedOversize, durationMs }. If ok is false, the current preview is unchanged; fix the failing cells and re-run — never suppress errors: error carries the Python traceback, and when stdout/stderr are truncated inline, fullOutput.path is an R2 log with the complete output (read({ location: 'r2', path: fullOutput.path })). Arguments: { project, path, timeoutMs? }.",
    Type.Object({
      project: Type.String(),
      path: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    {
      category: "analysis",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "run_code",
    "Run a Python string in this workspace's analysis sandbox for heavy cross-source data work too big for a Durable Object. STRONGLY PREFER DuckDB (pre-installed): `import duckdb`. Bring big data in by exporting a connection: call a connection's `export` method (via env.CONNECTIONS, e.g. `connections[alias].export({ query })`), which streams the full result to R2 server-side (credentials stay server-side) and returns { r2_key }. Each export is mounted read-only at the path '/' + r2_key. Read it with the reader that matches the export FORMAT: SQL databases + ClickHouse export Parquet → `duckdb.read_parquet('/' + r2_key)`; **BigQuery exports NDJSON** → `duckdb.read_json_auto('/' + r2_key)`. The r2_key extension (.parquet vs .ndjson) tells you which; analysis_list_connections reports each connection's `exportFormat`. Pass values via `params` (a JSON dict) instead of interpolating into the code string — they arrive as a Python `params` dict, e.g. `duckdb.read_parquet('/' + params['r2_key'])`. Each call runs isolated. Returns { ok, stdout, stderr, error } — read printed output from `stdout` (e.g. `print` CSV/JSON, then write it with tools.write). To hand the user a generated FILE instead of printed text, write it to the writable /outputs mount (e.g. `df.to_excel('/outputs/costs.xlsx')`); it becomes the R2 outputs/costs.xlsx reference, downloadable at /api/workspaces/<workspaceId>/outputs/costs.xlsx. Never base64 a binary through the text-only write tool. Arguments: { code, params? }.",
    Type.Object({
      code: Type.String(),
      params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    {
      category: "analysis",
    },
  ),
  codeModePassthroughTool(
    "analysis_exec",
    "Run a shell command in the workspace analysis sandbox. Pass a `project` to run inside that DO-backed project's working tree; changed files persist back to project storage. Use purpose-built project tools first (`add_dependency`, `add_shadcn_component`, `deploy_project`); use analysis_exec only for project-local CLIs those tools do not cover. It is also the escape hatch for data work run_notebook doesn't cover (usql/sqlite3 schema poking, file-format conversions, quick `python -c` probes over a mounted upload). Omit `project` for scratch work over the mounts. Files written to /outputs/<name> are delivered to the user as the R2 outputs/<name> reference. Returns { ok, stdout, stderr, exitCode, changedFiles, removedFiles, skippedOversize, durationMs }. Arguments: { command, project?, cwd?, env?, timeoutMs? }.",
    Type.Object({
      command: Type.String(),
      project: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    {
      category: "analysis",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "inspect_archive",
    "Safely inspect an uploaded ZIP before extracting it. Pass the uploads/<name>.zip path. With no entry, returns a paginated manifest, size totals, safety issues, and whether the archive is extractable. Pass entry to read one UTF-8 text member (such as a script or Dockerfile) without extracting it. Always inspect an archive and any executable/configuration entries before calling extract_archive. Arguments: { path, entry?, offset?, limit? }.",
    Type.Object({
      path: Type.String({ description: "Read-only R2 upload path, starting with uploads/." }),
      entry: Type.Optional(Type.String({ description: "Exact archive member path to read as UTF-8 text." })),
      offset: Type.Optional(Type.Number({ description: "Zero-based manifest offset. Defaults to 0." })),
      limit: Type.Optional(Type.Number({ description: "Manifest entries to return. Defaults to 200; maximum 500." })),
    }, { additionalProperties: false }),
    {
      category: "analysis",
    },
  ),
  codeModePassthroughTool(
    "extract_archive",
    "Safely extract an uploaded ZIP into an existing DO-backed project after inspect_archive. The archive is fully validated and staged before project files are changed. Extraction rejects absolute/traversal paths, symlinks, special or encrypted entries, duplicate/conflicting paths, unsupported compression, more than 2,000 entries, files over 25 MiB, or more than 250 MiB expanded. Existing files at matching paths are replaced. Arguments: { path, project, destination? }.",
    Type.Object({
      path: Type.String({ description: "Read-only R2 upload path, starting with uploads/." }),
      project: Type.String({ description: "Existing destination project name." }),
      destination: Type.Optional(Type.String({ description: "Relative directory inside the project. Defaults to the project root." })),
    }, { additionalProperties: false }),
    {
      category: "analysis",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "add_python_dependency",
    "Add one or more PyPI packages to a DO-backed project's Python environment (`uv add`), persisting pyproject.toml + uv.lock back to the project. The default data stack is already preinstalled — only use this for packages beyond it. The first add on a project initializes a pyproject.toml seeded with the default stack plus your packages, so notebooks keep the full environment. Arguments: { project, packages: string[], dev? }.",
    Type.Object({
      project: Type.String(),
      packages: Type.Array(Type.String()),
      dev: Type.Optional(Type.Boolean()),
    }),
    {
      category: "analysis",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "analysis_list_connections",
    "List workspace data, database, and warehouse connections usable for analytics or analysis. Use this when asked to list warehouse connections. Returns [{ id, name, type, displayName, exportable, exportFormat }]: `exportable: true` connections (SQL databases, ClickHouse, BigQuery) have an `export` method that streams a query's full result to R2 — `connections[alias].export({ query })` — which run_code then reads with DuckDB. `exportFormat` is `'parquet'` (SQL + ClickHouse → read with read_parquet) or `'ndjson'` (BigQuery → read with read_json_auto), so you pick the right DuckDB reader. Reference connections BY NAME.",
    EMPTY_PARAMETERS,
    {
      category: "connections",
    },
  ),
  // Customer compatibility aliases. They remain callable from persisted
  // workflows and old js_exec snippets but are hidden from agent discovery.
  codeModePassthroughTool(
    "warehouse_run_code",
    "Deprecated alias for run_code. Arguments: { code, params? }.",
    Type.Object({
      code: Type.String(),
      params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    {
      category: "connections",
      hidden: true,
    },
  ),
  codeModePassthroughTool(
    "warehouse_list_connections",
    "Deprecated alias for analysis_list_connections.",
    EMPTY_PARAMETERS,
    {
      category: "connections",
      hidden: true,
    },
  ),
  codeModePassthroughTool("list_scheduled_prompts", "List scheduled prompts for the current workspace.", EMPTY_PARAMETERS, {
    category: "schedules",
  }),
  codeModePassthroughTool(
    "create_scheduled_prompt",
    "Create a scheduled prompt. Arguments: { name, prompt, cron_expression, enabled? }.",
    Type.Object({
      name: Type.String(),
      prompt: Type.String(),
      cron_expression: Type.String(),
      enabled: Type.Optional(Type.Boolean()),
    }),
    {
      category: "schedules",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "update_scheduled_prompt",
    "Update a scheduled prompt. Arguments: { prompt_id, name?, prompt?, cron_expression?, enabled? }.",
    Type.Object({
      prompt_id: Type.String(),
      name: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      cron_expression: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
    }),
    {
      category: "schedules",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "delete_scheduled_prompt",
    "Delete a scheduled prompt. Arguments: { prompt_id }.",
    Type.Object({ prompt_id: Type.String() }),
    {
      category: "schedules",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "run_scheduled_prompt_now",
    "Trigger a scheduled prompt immediately. Arguments: { prompt_id }.",
    Type.Object({ prompt_id: Type.String() }),
    {
      category: "schedules",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "list_workflows",
    "List workflows for the current workspace. Workflows are deterministic JavaScript code that runs on a schedule.",
    EMPTY_PARAMETERS,
    {
      category: "workflows",
    },
  ),
  codeModePassthroughTool(
    "validate_workflow",
    "Validate workflow source without saving it: checks that it exports `class AutomationWorkflow extends WorkflowEntrypoint` and compiles. IMPORTANT: a workflow runs as a single module with ONLY the injected bindings (env.TOOLS, env.CONNECTIONS, env.AI, …) — the only import you may use is `import { WorkflowEntrypoint } from \"cloudflare:workers\"`. npm packages, URL/CDN imports (e.g. esm.sh), and relative/multi-file modules are NOT available and fail at runtime, so never import them. Arguments: { source }.",
    Type.Object({ source: Type.String() }),
    {
      category: "workflows",
    },
  ),
  codeModePassthroughTool(
    "create_workflow",
    "Create a workflow. The source runs as a single module with ONLY the injected bindings — the one allowed import is `import { WorkflowEntrypoint } from \"cloudflare:workers\"`; do NOT import npm packages, URLs/CDNs (e.g. esm.sh), or relative modules (they fail at runtime). Use env.TOOLS / env.CONNECTIONS / env.AI for everything else. Arguments: { name, source, cron_expression, description, enabled? }.",
    Type.Object({
      name: Type.String(),
      source: Type.String(),
      cron_expression: Type.String(),
      description: Type.String(),
      enabled: Type.Optional(Type.Boolean()),
    }),
    {
      category: "workflows",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "update_workflow",
    "Update a workflow. Arguments: { workflow_id, name?, source?, cron_expression?, description?, enabled? }.",
    Type.Object({
      workflow_id: Type.String(),
      name: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      cron_expression: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
    }),
    {
      category: "workflows",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "delete_workflow",
    "Delete a workflow. Arguments: { workflow_id }.",
    Type.Object({ workflow_id: Type.String() }),
    {
      category: "workflows",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "run_workflow_now",
    "Start a workflow immediately. Returns the run's instance_id; the run is asynchronous, so poll get_workflow_run to see when it finishes and whether it failed (do NOT block-wait). Arguments: { workflow_id }.",
    Type.Object({ workflow_id: Type.String() }),
    {
      category: "workflows",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "get_workflow_run",
    "Inspect a workflow's recent runs — use after run_workflow_now (or to debug a failed scheduled run) instead of blindly waiting. Returns { latest, runs: [{ instance_id, status, trigger, started_at, completed_at, duration_ms, error }] }. status is `started` (still running), `success`, or `error` (with the message in `error`); each completed run reports duration_ms (sample recent runs for a rough ETA). Poll a few times if the latest run is still `started`. Arguments: { workflow_id, limit? }.",
    Type.Object({ workflow_id: Type.String(), limit: Type.Optional(Type.Number()) }),
    {
      category: "workflows",
    },
  ),
  codeModePassthroughTool(
    "list_integrations",
    "List configured integrations for the current workspace. Channel integrations include recommended_access.recommended_actions with js_exec examples such as tools.send_telegram_message(...). Arguments: { category? }.",
    Type.Object({ category: Type.Optional(Type.String()) }),
    {
      category: "integrations",
      examples: [`await tools.list_integrations({ category: "communication" })`],
    },
  ),
  codeModePassthroughTool(
    "list_integration_types",
    "List available integration types. Arguments: { category? }. For a native remote MCP server, use integration_type `remote_mcp`; the returned type metadata includes setup hints and MCP capability flags.",
    Type.Object({ category: Type.Optional(Type.String()) }),
    {
      category: "integrations",
    },
  ),
  codeModePassthroughTool(
    "create_integration",
    "Create an integration. Arguments: { integration_type, name, config?, credentials? }. Use integration_type `remote_mcp` for native remote MCP servers; set config.server_url, config.auth_type, and credentials.token when token auth is required.",
    Type.Object({
      integration_type: Type.String(),
      name: Type.String(),
      config: Type.Optional(Type.Object({}, { additionalProperties: true })),
      credentials: Type.Optional(Type.Object({}, { additionalProperties: true })),
    }),
    {
      category: "integrations",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "prompt_connection_setup",
    "Prompt the user to set up or reauthorize a connection in the chat UI and wait for completion. Use this as a top-level tool, not from js_exec. Use integration_type `remote_mcp` for native remote MCP servers. Pass integration_id or connection_id to update an existing connection during reauth. You may pass config and credentials to pre-populate known form fields. Arguments: { integration_type, integration_id?, connection_id?, suggested_name?, message?, config?, credentials?, display_name?, description?, instructions?, fields? }.",
    Type.Object({
      integration_type: Type.String(),
      integration_id: Type.Optional(Type.String()),
      connection_id: Type.Optional(Type.String()),
      suggested_name: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      config: Type.Optional(Type.Object({}, { additionalProperties: true })),
      credentials: Type.Optional(Type.Object({}, { additionalProperties: true })),
      display_name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      fields: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
    }),
    {
      category: "integrations",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "delete_connection",
    "Delete a workspace connection after the user confirms in chat. Use this as a top-level tool, not from js_exec. Accepts a connection id, alias, type, or name. Arguments: { connection }.",
    Type.Object({
      connection: Type.String(),
    }, { additionalProperties: false }),
    {
      category: "integrations",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool("get_custom_domain", "Get custom domain diagnostics for deployed apps.", EMPTY_PARAMETERS, {
    category: "domains",
  }),
  codeModePassthroughTool(
    "set_custom_domain",
    "Set an exact custom hostname for an app. Arguments: { app_name, hostname }.",
    Type.Object({
      app_name: Type.String(),
      hostname: Type.String(),
    }),
    {
      category: "domains",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "remove_custom_domain",
    "Remove a custom hostname from an app. Arguments: { app_name }.",
    Type.Object({ app_name: Type.String() }),
    {
      category: "domains",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "retry_custom_domain_hostnames",
    "Retry hostname provisioning for configured app custom domains.",
    EMPTY_PARAMETERS,
    {
      category: "domains",
      sideEffect: true,
    },
  ),
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  AGENT_TOOL,
  EXPLORE_TOOL,
  codeModeTool(
    "connections_list",
    "List workspace connections. Prefer calling this from js_exec as await env.CONNECTIONS.list().",
    EMPTY_PARAMETERS,
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.list()`],
    },
  ),
  codeModeTool(
    "connections_get",
    "Get one workspace connection. Prefer calling this from js_exec as await env.CONNECTIONS.get(connection). Arguments: { connection }.",
    Type.Object({ connection: Type.String() }),
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.get("telegram_direct")`],
    },
  ),
  codeModeTool(
    "connections_tools",
    "List MCP-backed tools for a workspace connection. Prefer calling this from js_exec as await env.CONNECTIONS.tools(connection). Arguments: { connection }.",
    Type.Object({ connection: Type.String() }),
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.tools("stripe")`],
    },
  ),
  codeModeTool(
    "connections_methods",
    "List workspace connections and their method aliases, virtual channel actions, tool names, examples, and input schemas. Prefer calling this from js_exec as await env.CONNECTIONS.methods().",
    EMPTY_PARAMETERS,
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.methods()`],
    },
  ),
  codeModeTool(
    "connections_find",
    "Find one workspace connection method catalog entry by alias, id, type, or name. Prefer calling this from js_exec as await env.CONNECTIONS.find(query). Arguments: { query }.",
    CONNECTION_QUERY_PARAMETERS,
    {
      category: "connections",
      examples: [`const entry = await env.CONNECTIONS.find("clickhouse")`],
    },
  ),
  codeModeTool(
    "connections_test",
    "Run a quick workspace connection smoke test. Prefer calling this from js_exec as await env.CONNECTIONS.test(query). Arguments: { query }.",
    CONNECTION_QUERY_PARAMETERS,
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.test("clickhouse")`],
    },
  ),
  codeModeTool(
    "connections_verify",
    "Verify a workspace connection with its normalized adapter strategy. Live-capable adapters make a bounded read-only provider call; configuration-only adapters validate setup. Prefer await env.CONNECTIONS.verify(query). Arguments: { query }.",
    CONNECTION_QUERY_PARAMETERS,
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.verify("slack")`],
    },
  ),
];

export const CODE_MODE_TOOL_DEFINITIONS: CodeModeToolDefinition[] = CODE_MODE_TOOL_REGISTRY
  .map(codeModeDefinition);
export const CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS: CodeModeToolDefinition[] =
  CODE_MODE_TOOL_REGISTRY
    .filter((registration) => registration.piPassthrough)
    .map(codeModeDefinition);

const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "ls", "delete", "grep", "find"]);
const AGENT_WEB_TOOL_NAMES = new Set(["WebSearch", "WebFetch"]);

function requireFileLocation(toolName: string, args: Record<string, unknown>): CodeModeFileLocation {
  const location = args.location;
  if (location !== "workspace" && location !== "project" && location !== "r2") {
    throw new Error(`${toolName} requires an explicit location: "workspace", "project", or "r2"`);
  }
  if (location === "project" && (typeof args.project !== "string" || args.project.trim().length === 0)) {
    throw new Error(`${toolName} with location "${location}" requires a project name`);
  }
  if ((toolName === "grep" || toolName === "find") && location === "r2") {
    throw new Error(`${toolName} does not support location "r2"; use ls/read for R2 objects`);
  }
  return location;
}

function hasProjectTarget(args: Record<string, unknown>): boolean {
  return args.location === "project";
}

function hasR2Target(args: Record<string, unknown>): boolean {
  return args.location === "r2";
}

/** Skills that advertise deployed-app CONNECTIONS and need an override banner. */
const DEPLOYED_CONNECTIONS_SKILL_OVERRIDES = new Set([
  "developing-software",
  "camelai-platform-faq",
  "data-analysis",
]);

function withDeployedConnectionsSkillOverride(
  skill: AgentSkillReadResult,
  env: { CONNECTIONS_BINDING_ENABLED?: string },
): AgentSkillReadResult {
  if (connectionsBindingEnabled(env)) return skill;
  if (!DEPLOYED_CONNECTIONS_SKILL_OVERRIDES.has(skill.skill)) return skill;
  // CONNECTIONS-AND-STORAGE.md and SKILL.md for developing-software; FAQ and
  // data-analysis also teach deployed-app CONNECTIONS. Deterministic
  // automations keep their CONNECTIONS docs — those are workflow bindings, not
  // the deployed-app broker this flag disables.
  const banner =
    `> **Deployment override:** ${DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT}\n\n`;
  const text = `${banner}${skill.text}`;
  return {
    ...skill,
    text,
    size: text.length,
  };
}

function skillReadResponse(skill: AgentSkillReadResult) {
  return {
    text: skill.text,
    content: [{ type: "text", text: skill.text }],
    details: {
      skill: skill.skill,
      file: skill.file,
      size: skill.size,
      encoding: skill.encoding,
      source: skill.source,
    },
  };
}

function skillTargetFromArgs(
  args: Record<string, unknown>,
  availableSkillNames: readonly string[],
): { skill: string; file: string } {
  const skill = typeof args.skill === "string" ? args.skill.trim() : "";
  if (!skill || !/^[a-z0-9][a-z0-9._-]*$/i.test(skill)) {
    throw new Error(`read_skill requires one of these skill names: ${availableSkillNames.join(", ")}`);
  }

  if (args.file != null && typeof args.file !== "string") {
    throw new Error("read_skill file must be a string when provided");
  }
  const file = typeof args.file === "string" ? args.file.trim() : "SKILL.md";
  const segments = file.split("/");
  if (
    !file ||
    file.startsWith("/") ||
    file.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("read_skill file must be a relative path within the skill");
  }
  return { skill, file };
}

function normalizeDeployScriptName(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!normalized) throw new Error("script_name is required");
  return normalized;
}

/**
 * Distinct tool failures one binding instance records as
 * `code_mode_project_tool_call_failed`. A js_exec script is model-written and
 * can loop; the budget keeps a pathological loop from turning one bad tool call
 * into thousands of error rows while still capturing every distinct failure of
 * a normal turn.
 */
export const CODE_MODE_TOOL_FAILURE_EVENT_BUDGET = 20;

/**
 * Bound on a value-failure message.
 *
 * It is both the AE blob and the dedupe key, so an unbounded message would let
 * distinct platform text burn the per-instance budget one row at a time. Long
 * enough to identify a failure, short enough that the key stays a key.
 */
export const CODE_MODE_VALUE_FAILURE_MESSAGE_MAX = 200;

/**
 * The message for a tool failure that arrived as a VALUE, or null when the
 * result is not a recordable failure.
 *
 * Code Mode's operational tools report their outcome in the payload
 * (`{ success: false }` for deploy_project/add_shadcn_component/…, `{ ok:
 * false }` for run_notebook), and that is the class this event exists for: a
 * gated deploy that failed every attempt used to show nothing in telemetry.
 *
 * Two shapes are deliberately NOT failures here:
 *
 *  - A SHELL OUTCOME (`exitCode`/`stdout`/`stderr` present): `analysis_exec`,
 *    `run_code`, `run_notebook` and `add_python_dependency` set `ok:false` for
 *    any non-zero exit of user/agent code — a `grep` that matched nothing is not
 *    a tool failure. Their `error` field is `execError()`, i.e. the container's
 *    RAW stderr (falling back to raw stdout), which must never be lifted into
 *    the error-analytics dataset: it is user program output over connected data.
 *    The full text still reaches the agent, the tool result and the R2 spill.
 *  - A CANCELLATION (`cancelled: true`): a user declining a destructive
 *    confirmation is a deliberate no-op, not an error.
 */
export function toolValueFailureMessage(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.success !== false && record.ok !== false) return null;
  if (record.cancelled === true) return null;
  if (isShellOutcomeResult(record)) return null;
  for (const key of ["errorSummary", "error", "errorMessage", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, CODE_MODE_VALUE_FAILURE_MESSAGE_MAX);
    }
  }
  return "tool reported an unsuccessful outcome";
}

/** Error shape for a failure that was a VALUE: named, stackless, low-cardinality. */
function stacklessValueFailure(message: string): Error {
  const error = new Error(message);
  error.name = "ToolValueFailure";
  error.stack = "";
  return error;
}

/** A result carrying a command's own exit status/output rather than a tool error. */
function isShellOutcomeResult(record: Record<string, unknown>): boolean {
  return typeof record.exitCode === "number" ||
    typeof record.stdout === "string" ||
    typeof record.stderr === "string";
}

/**
 * Upper bound on an agent-supplied build timeout. `timeoutMs` reaches us from
 * model-written js_exec code with no clamp of its own; capping it at the warm
 * session window keeps a single build from outliving the window that is meant
 * to cover the gap BETWEEN builds (and from pinning a standard-3 indefinitely).
 */
export const PROJECT_BUILD_MAX_TIMEOUT_MS = PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS;

function clampProjectBuildTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(1, Math.floor(value)), PROJECT_BUILD_MAX_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Client-side deadlines for sandbox exec-class tools
// ---------------------------------------------------------------------------
//
// Container-side `timeout` stays the primary enforcement (better error, knows
// the exit code); these bound OUR await so a container that never answers can
// no longer occupy the turn until the 20-minute tool backstop. Defaults and
// maxes are the SAME constants the services forward container-side — a second
// set of numbers here would either strangle legitimate work or fail to bound
// the run it is supposed to bound.
//
// `overheadMs` is the wall-clock an operation legitimately spends OUTSIDE the
// timed command: materializing the project tree into the container, hashing and
// persisting the changed set back out, and (for notebooks) the fixed validator
// leg. Same idea as db-query-service's EXEC_OVERHEAD_MS. Without it a
// declared-timeout-plus-grace deadline would fire during file transfer on a
// large project — a regression the deadline exists to avoid causing.

/**
 * BASE materialize-in + persist-out allowance for the project-tree analysis legs.
 *
 * It is a floor, not the whole story: unlike the build path (which reads with
 * SOURCE_READ_CONCURRENCY 16, skips unchanged files via a manifest and ships a
 * lane-parallel archive), the analysis legs wipe and rewrite the whole tree
 * every run with one sequential mkdir + readFileStream + writeFile round trip
 * PER FILE, then hash and persist the changed set back. That is proportional to
 * the project, not to the declared command timeout — so a fixed 120s let the
 * deadline fire AFTER a successful command on a big tree and invite the agent
 * to re-run a non-idempotent one. `analysisProjectIoOverheadMs` scales it.
 */
export const ANALYSIS_PROJECT_IO_OVERHEAD_MS = 120_000;
/** Per-file allowance: one mkdir + readFileStream + writeFile, two DO hops each. */
export const ANALYSIS_PROJECT_IO_PER_FILE_MS = 120;
/** Per-MiB allowance: R2 → WorkspaceFilesystemDO → AnalysisService → container. */
export const ANALYSIS_PROJECT_IO_PER_MIB_MS = 400;
/**
 * Ceiling on the scaled allowance. Without it a pathological tree would push
 * the exec budget toward (and past) the 20-minute tool backstop, which must
 * stay the outermost bound.
 */
export const ANALYSIS_PROJECT_IO_MAX_OVERHEAD_MS = 600_000;
/** Files listed when sizing the overhead; matches collectProjectSourceFiles. */
const ANALYSIS_PROJECT_IO_LISTING_LIMIT = 50_000;

/** Size the materialize/persist allowance to the tree that will actually move. */
export function analysisProjectIoOverheadMs(
  listing: { fileCount: number; totalBytes: number },
): number {
  const scaled =
    ANALYSIS_PROJECT_IO_OVERHEAD_MS +
    Math.max(0, listing.fileCount) * ANALYSIS_PROJECT_IO_PER_FILE_MS +
    (Math.max(0, listing.totalBytes) / (1024 * 1024)) * ANALYSIS_PROJECT_IO_PER_MIB_MS;
  return Math.min(ANALYSIS_PROJECT_IO_MAX_OVERHEAD_MS, Math.round(scaled));
}
/** Source collect + materialize + lockfile/bundle persist around a build. */
export const PROJECT_BUILD_IO_OVERHEAD_MS = 120_000;

interface SandboxExecLimits {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  overheadMs: number;
}

/** The AnalysisService surface this binding drives (and wraps with deadlines). */
interface AnalysisServiceLike {
  runCode(request: { code: string; params?: Record<string, unknown> }): Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
  runNotebook(request: { projectId: string; path: string; timeoutMs?: number }): Promise<unknown>;
  exec(request: { projectId?: string; command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<unknown>;
  addDependency(request: { projectId: string; packages: string[]; dev?: boolean }): Promise<unknown>;
  listConnections(): Promise<Array<{ id: string; name: string; type: string; displayName: string; exportable: boolean; exportFormat: 'parquet' | 'ndjson' | null }>>;
}

const ANALYSIS_EXEC_LIMITS: SandboxExecLimits = {
  defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
  maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
  overheadMs: ANALYSIS_PROJECT_IO_OVERHEAD_MS,
};

const ANALYSIS_NOTEBOOK_LIMITS: SandboxExecLimits = {
  defaultTimeoutMs: ANALYSIS_DEFAULT_NOTEBOOK_TIMEOUT_MS,
  maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
  // The notebook run is followed by a fixed-budget validator command.
  overheadMs: ANALYSIS_PROJECT_IO_OVERHEAD_MS + ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS,
};

const ANALYSIS_DEPENDENCY_LIMITS: SandboxExecLimits = {
  defaultTimeoutMs: ANALYSIS_DEFAULT_DEP_TIMEOUT_MS,
  maxTimeoutMs: ANALYSIS_DEFAULT_DEP_TIMEOUT_MS,
  overheadMs: ANALYSIS_PROJECT_IO_OVERHEAD_MS,
};

/**
 * Builds legitimately run minutes, so the ceiling here is the build op-class
 * max (the warm session window), NOT any smaller analysis default.
 */
const PROJECT_BUILD_EXEC_LIMITS: SandboxExecLimits = {
  defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
  maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
  overheadMs: PROJECT_BUILD_IO_OVERHEAD_MS,
};

function summarizeProjectBuildResult(build: ProjectBuildResult): Record<string, unknown> {
  const excerpt = build.success ? null : buildLogTail(buildFailureRawOutput(build));
  const errorMessage = build.success ? null : buildErrorMessage(build);
  return {
    success: build.success,
    projectId: build.projectId,
    workdir: build.workdir,
    exitCode: build.exitCode,
    fileCount: build.fileCount,
    sourceBytes: build.sourceBytes,
    durationMs: build.durationMs,
    timings: build.timings,
    lockfilePersisted: build.lockfilePersisted,
    ...(build.buildLogPath ? { buildLogPath: build.buildLogPath } : {}),
    ...(typeof build.buildLogPersisted === "boolean" ? { buildLogPersisted: build.buildLogPersisted } : {}),
    ...(typeof build.buildLogBytes === "number" ? { buildLogBytes: build.buildLogBytes } : {}),
    ...(errorMessage ? { errorMessage, errorSummary: summarizeBuildFailure(build) } : {}),
    // Complete log when modest-sized; otherwise a capped tail. Full latest build
    // output is persisted at buildLogPath when buildLogPersisted is true.
    ...(excerpt ? { logExcerpt: excerpt } : {}),
  };
}

function summarizeDirectDeployResult(deploy: DirectDispatchDeployResult): Record<string, unknown> {
  return {
    success: deploy.success,
    scriptName: deploy.scriptName,
    dispatchScriptName: deploy.dispatchScriptName,
    status: deploy.status,
    ...(deploy.timings ? { timings: deploy.timings } : {}),
    ...(deploy.success ? {} : { errorSummary: summarizeDeployFailure(deploy) }),
    ...(deploy.warnings?.length ? { warnings: deploy.warnings } : {}),
    ...(deploy.skippedAssets?.length ? { skippedAssets: deploy.skippedAssets } : {}),
  };
}

function buildFailureRawOutput(build: ProjectBuildResult): string {
  // stdout first, stderr last — consumers keep a tail of this text, and stderr
  // (where compilers put errors) must never be truncated away by stdout noise.
  return build.error ||
    [build.stdout, build.stderr].filter(Boolean).join("\n") ||
    `Build failed with exit code ${build.exitCode}`;
}

// The summary anchors on the failure marker that vite/rolldown/bun print right
// before the diagnostic block, instead of scanning for "error-looking" lines —
// a last-match scan gets stolen by stack traces and printed error-object tails
// (e.g. "errors: [Getter/Setter]"). Full context stays in buildLogPath.
// bun's wrapper line confirms failure but carries no diagnostic content.
const BUN_SCRIPT_WRAPPER_LINE = /^error: script ".*" exited with code \d+/i;
// Code-frame furniture and stack frames after the diagnostic — never summary
// material, but frame lines are still scanned for the file:line reference.
const CODE_FRAME_LINE = /^\s*(?:[╭│╰├└┌─]|\d+\s*[│|])/;
const STACK_FRAME_LINE = /^\s*(?:at |[}{]+\s*$)/;
const BUILD_FAILURE_MARKER = /(?:Build|Transform) failed with \d+ errors?|✗ Build failed|error during build:/i;
// File reference with optional bundler query suffix (stripped) and position.
const BUILD_FILE_REFERENCE = /([^\s"'`()[\]]+\.(?:tsx?|jsx?|mjs|cjs|css|json))(\?[^\s:'"`)\]]*)?(:\d+(?::\d+)?)?/;

function isBuildSummaryNoise(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed ||
    BUN_SCRIPT_WRAPPER_LINE.test(trimmed) ||
    CODE_FRAME_LINE.test(line) ||
    STACK_FRAME_LINE.test(line);
}

function buildFileReferenceNear(build: ProjectBuildResult, lines: string[], fromIndex: number): string | null {
  for (let index = fromIndex; index < Math.min(lines.length, fromIndex + 8); index += 1) {
    const match = lines[index]?.match(BUILD_FILE_REFERENCE);
    if (match && !match[1]!.includes("node_modules")) {
      return `${relativizeBuildPath(build, match[1]!)}${match[3] ?? ""}`;
    }
  }
  return null;
}

function relativizeBuildPath(build: ProjectBuildResult, value: string): string {
  const workdir = build.workdir.replace(/\/+$/g, "");
  const prefix = `${workdir}/`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function relativizeBuildPaths(build: ProjectBuildResult, value: string): string {
  const workdir = build.workdir.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&").replace(/\\\/+$/g, "");
  return value.replace(new RegExp(`${workdir}/`, "g"), "");
}

function summarizeBuildFailure(build: ProjectBuildResult): string {
  const message = buildErrorMessage(build);
  if (!message) return `Build failed with exit code ${build.exitCode}`;
  if (message.length <= 300 && !message.includes("\n")) return limitSummary(message);
  return limitSummary(`${message} (${buildFailureOutputReference(build)})`);
}

function buildErrorMessage(build: ProjectBuildResult): string {
  const output = cleanBuildLog(buildFailureRawOutput(build));
  if (!output) return `Build failed with exit code ${build.exitCode}`;
  if (output.length <= 300 && !output.includes("\n")) return relativizeBuildPaths(build, output);

  const lines = output.split("\n");
  let summaryStart = -1;
  const markerIndex = lines.reduce(
    (last, line, index) => (BUILD_FAILURE_MARKER.test(line) ? index : last),
    -1,
  );
  const picked: string[] = [];
  if (markerIndex >= 0) {
    // The diagnostic block immediately follows the marker; collect its first
    // one or two informative lines (a bare "[plugin x]" tag plus its message).
    for (let index = markerIndex + 1; index < lines.length && picked.length < 2; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) {
        if (picked.length) break;
        continue;
      }
      if (isBuildSummaryNoise(line)) break;
      if (summaryStart < 0) summaryStart = index;
      picked.push(line.trim());
    }
  }
  if (!picked.length) {
    // No marker (e.g. tsc): the first error-looking line precedes any stack
    // trace or printed error-object tail.
    summaryStart = lines.findIndex((line) => /error|failed/i.test(line) && !isBuildSummaryNoise(line));
    if (summaryStart >= 0) picked.push(lines[summaryStart]!.trim());
  }
  if (picked.length) {
    let summary = relativizeBuildPaths(build, picked.join(" "));
    const fileReference = buildFileReferenceNear(build, lines, summaryStart);
    if (fileReference && !summary.includes(fileReference)) {
      summary = `${summary} (${fileReference})`;
    }
    return limitSummary(summary);
  }
  return `Build failed with exit code ${build.exitCode}`;
}

function buildFailureOutputReference(build: ProjectBuildResult): string {
  return build.buildLogPath && build.buildLogPersisted !== false
    ? `see ${build.buildLogPath} for full output`
    : "see logExcerpt for diagnostic output";
}

function pickBuildFailureFields(build: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["errorMessage", "buildLogPath", "buildLogPersisted", "buildLogBytes", "logExcerpt"]) {
    if (key in build) out[key] = build[key];
  }
  return out;
}

function summarizeDeployFailure(deploy: DirectDispatchDeployResult): string {
  return conciseErrorSummary(deploy.error || `Deploy failed with status ${deploy.status}`);
}

function conciseErrorSummary(value: string): string {
  const fromJson = conciseJsonErrorSummary(value);
  if (fromJson) return limitSummary(fromJson);
  const dynamicRequire = value.match(/Dynamic require of ["'][^"']+["'] is not supported/i)?.[0];
  if (dynamicRequire) return dynamicRequire;
  const uncaught = value.match(/Uncaught (?:Error|Exception|TypeError|ReferenceError|SyntaxError):?[^\n\r]*/i)?.[0];
  if (uncaught) return limitSummary(uncaught);
  const firstMeaningfulLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return limitSummary(firstMeaningfulLine || "Unknown error");
}

function conciseJsonErrorSummary(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    const messages: string[] = [];
    collectJsonMessages(parsed, messages);
    return messages.find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function collectJsonMessages(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonMessages(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "error_message", "detail"]) {
    if (typeof record[key] === "string") out.push(record[key]);
  }
  for (const key of ["errors", "messages", "result"]) {
    collectJsonMessages(record[key], out);
  }
}

function limitSummary(value: string): string {
  const summary = value.trim().replace(/\s+/g, " ");
  return summary.length <= 500 ? summary : `${summary.slice(0, 497)}...`;
}

function projectForAgent(project: WorkspaceProject): Record<string, unknown> {
  return {
    name: project.name,
    description: project.description,
    kind: project.kind,
    backend: "do-r2",
    defaultVmId: project.defaultVmId,
    cloneSource: project.cloneSource
      ? {
          name: project.cloneSource.name,
          description: project.cloneSource.description,
        }
      : undefined,
    clones: project.clones?.map(projectCloneForAgent),
    cloneCount: project.cloneCount,
    artifactRemote: project.artifactRemote,
    artifactDefaultBranch: project.artifactDefaultBranch,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function projectCloneForAgent(project: WorkspaceProjectCloneSummary): Record<string, unknown> {
  return {
    name: project.name,
    description: project.description,
    backend: "do-r2",
    defaultVmId: project.defaultVmId,
    artifactRemote: project.artifactRemote,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

type WorkerScriptListRow = WorkerScript & {
  commit_sha?: string | null;
  artifact_cache_key?: string | null;
};

function appFilterText(script: WorkerScriptListRow): string {
  return [script.script_name, script.custom_domain_hostname, script.project_id]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

export class CodeModeToolsBinding extends WorkerEntrypoint<ChatEnv, CodeModeToolsProps> {
  private static readonly TOOL_CALL_HANDLERS: Record<string, CodeModeToolCallHandler> = {
    AskUserQuestion: (binding, args) => binding.askUserQuestion(args),
    TodoWrite: (binding, args) => binding.updateTodos(args),
    set_preview: (binding, args) => binding.setPreview(args),
    list_apps: (binding, args) => binding.listApps(args),
    set_app_visibility: (binding, args) => binding.setAppVisibility(args),
    get_latest_logs: (binding, args) => binding.getLatestLogs(args),
    take_screenshot: (binding, args) => binding.takeScreenshot(args),
    run_notebook: (binding, args) => binding.analysisRunNotebook(args),
    analysis_exec: (binding, args) => binding.analysisExecCommand(args),
    inspect_archive: (binding, args) => binding.inspectArchive(args),
    extract_archive: (binding, args) => binding.extractArchive(args),
    run_code: (binding, args) => binding.analysisRunCode(args),
    add_python_dependency: (binding, args) => binding.analysisAddDependency(args),
    add_shadcn_component: (binding, args) => binding.addShadcnComponent(args),
    analysis_list_connections: (binding) => binding.analysisListConnections(),
    warehouse_run_code: (binding, args) => binding.analysisRunCode(args),
    warehouse_list_connections: (binding) => binding.analysisListConnections(),
    list_scheduled_prompts: (binding) => binding.listScheduledPrompts(),
    create_scheduled_prompt: (binding, args) => binding.createScheduledPrompt(args),
    update_scheduled_prompt: (binding, args) => binding.updateScheduledPrompt(args),
    delete_scheduled_prompt: (binding, args) => binding.deleteScheduledPrompt(args),
    run_scheduled_prompt_now: (binding, args) => binding.runScheduledPromptNow(args),
    list_workflows: (binding) => binding.listDeterministicAutomations(),
    validate_workflow: (binding, args) => binding.validateDeterministicAutomation(args),
    create_workflow: (binding, args) => binding.createDeterministicAutomation(args),
    update_workflow: (binding, args) => binding.updateDeterministicAutomation(args),
    delete_workflow: (binding, args) => binding.deleteDeterministicAutomation(args),
    run_workflow_now: (binding, args) => binding.runDeterministicAutomationNow(args),
    get_workflow_run: (binding, args) => binding.getDeterministicAutomationRuns(args),
    workspace_info: (binding) => binding.getWorkspaceRuntimeInfo(),
    list_integrations: (binding, args) => binding.listIntegrations(args),
    list_integration_types: (binding, args) => binding.listIntegrationTypes(args),
    create_integration: (binding, args) => binding.createIntegration(args),
    prompt_connection_setup: (binding, args) => binding.promptConnectionSetup(args),
    delete_connection: (binding, args) => binding.deleteConnection(args),
    delete_app: (binding, args) => binding.deleteApp(args),
    delete_project: (binding, args) => binding.deleteProject(args),
    send_email: (binding, args) => binding.sendEmail(args),
    send_slack_message: (binding, args) => binding.sendSlackMessage(args),
    send_telegram_message: (binding, args) => binding.sendTelegramMessage(args),
    send_discord_message: (binding, args) => binding.sendDiscordMessage(args),
    get_custom_domain: (binding) => binding.getCustomDomain(),
    set_custom_domain: (binding, args) => binding.setCustomDomain(args),
    remove_custom_domain: (binding, args) => binding.removeCustomDomain(args),
    retry_custom_domain_hostnames: (binding) => binding.retryCustomDomainHostnames(),
    WebSearch: (binding, args) => binding.webSearch(args),
    WebFetch: (binding, args) => binding.webFetch(args),
    Agent: (binding, args, name) => binding.runSubagentTool(name, args),
    Explore: (binding, args, name) => binding.runSubagentTool(name, args),
    connections_list: (binding) => listConnections(binding.env, binding.connectionsContext),
    connections_get: (binding, args) => {
      const connection = typeof args.connection === "string" ? args.connection : "";
      if (!connection) throw new Error("connection is required");
      return getConnection(binding.env, binding.connectionsContext, connection);
    },
    connections_tools: (binding, args) => {
      const connection = typeof args.connection === "string" ? args.connection : "";
      if (!connection) throw new Error("connection is required");
      return listConnectionTools(binding.env, binding.connectionsContext, connection);
    },
    connections_methods: (binding) => listConnectionMethods(binding.env, binding.connectionsContext),
    connections_find: (binding, args) =>
      findConnectionMethodEntry(binding.env, binding.connectionsContext, binding.connectionQuery(args)),
    connections_test: (binding, args) =>
      testConnectionMethodEntry(binding.env, binding.connectionsContext, binding.connectionQuery(args)),
    connections_verify: (binding, args) =>
      verifyConnection(binding.env, binding.connectionsContext, binding.connectionQuery(args)),
    connections_invoke: (binding, args) => invokeConnectionMethod(binding.env, binding.connectionsContext, {
      connection: typeof args.connection === "string" ? args.connection : "",
      method: typeof args.method === "string" ? args.method : undefined,
      input: args.input,
    }),
  };

  private discordSendInvocationCount = 0;

  /**
   * Dedupe/budget keys for recordCodeModeToolFailure (per binding instance).
   * Lazily created: tests construct this binding with Object.create(), which
   * never runs field initializers.
   */
  private recordedToolFailures?: Set<string>;

  private get workspaceFs(): WorkspaceFilesystemClient {
    const { workspaceId } = this.ctx.props;
    if (!workspaceId) {
      throw new Error("Code mode tool binding is missing workspace scope");
    }
    return new WorkspaceFilesystemClient(this.env, workspaceId);
  }

  private get connectionsContext() {
    const { workspaceId, orgId, userId, threadId } = this.ctx.props;
    if (!workspaceId || !orgId) {
      throw new Error("Code mode tool binding is missing connection scope");
    }
    return { workspaceId, orgId, userId, threadId };
  }

  private get piContainerTools(): PiContainerTools {
    return new PiContainerTools(this.workspaceFs, { images: this.env.IMAGES });
  }

  private async projectFileStore(args: Record<string, unknown>): Promise<ProjectFilesystemClient> {
    const name = typeof args.project === "string" ? args.project.trim() : "";
    if (!name) throw new Error("project is required for location='project'");
    const project = await this.workspaceFs.getProjectByName(name);
    if (!project) throw new Error(`Project not found: ${name}`);
    return new ProjectFilesystemClient(this.env, project.id);
  }

  private async projectContainerTools(args: Record<string, unknown>): Promise<PiContainerTools> {
    return new PiContainerTools(await this.projectFileStore(args), { images: this.env.IMAGES });
  }

  private projectBuildSandbox(): ProjectBuildSandboxLike {
    const { orgId } = this.ctx.props;
    if (!orgId) throw new Error("Project builds require org scope");
    if (!this.env.PROJECT_BUILD_SANDBOX) {
      throw new Error("PROJECT_BUILD_SANDBOX container binding is not configured");
    }
    return getSandbox(this.env.PROJECT_BUILD_SANDBOX, projectBuildSandboxKey(orgId), {
      normalizeId: true,
      transport: "rpc",
    }) as unknown as ProjectBuildSandboxLike;
  }

  /**
   * Readiness gate for a single build-tool call.
   *
   * The gate itself lives in project-build-readiness.ts (the admin verify route
   * runs the same one); this only binds it to the binding's own telemetry,
   * progress streaming and org scope.
   */
  private projectBuildReadinessGate(
    operation: "add_dependency" | "deploy_project",
  ): ProjectBuildReadinessGate {
    return createProjectBuildReadinessGate((sandbox, budgetMs) =>
      this.awaitProjectBuildSandboxReady(sandbox, operation, budgetMs));
  }

  private async awaitProjectBuildSandboxReady(
    sandbox: ProjectBuildSandboxLike,
    operation: "add_dependency" | "deploy_project",
    budgetMs?: number,
  ): Promise<ProjectBuildReadinessResult> {
    const readiness = await ensureBuildSandboxReady(sandbox, {
      ...(budgetMs === undefined ? {} : { budgetMs }),
      onProgress: (message) => {
        // Operator-facing: tells a log reader the wait is a container boot, not
        // a hang.
        console.warn("[project-build] waiting for build container", {
          operation,
          message,
          orgId: this.ctx?.props?.orgId,
        });
        // User-facing: stream the same text as tool output so the person
        // watching the turn sees "starting", not silence, for the whole boot.
        void this.streamProjectBuildProgress(message);
      },
      onEvent: (event) => this.recordProjectBuildReadinessEvent(operation, event),
    });
    if (readiness.coldStart) {
      console.warn("[project-build] build container cold start", {
        operation,
        waitedMs: readiness.waitedMs,
        attempts: readiness.attempts,
        orgId: this.ctx?.props?.orgId,
      });
      void this.streamProjectBuildProgress(
        `Build environment ready after ${Math.round(readiness.waitedMs / 1000)}s; building…`,
      );
    }
    return readiness;
  }

  /**
   * Best-effort live progress for the human watching the turn.
   *
   * add_dependency and compatibility deploy_project calls can run inside
   * js_exec, where the agent-loop `onUpdate` callback is not reachable. The
   * ChatThreadDO stub is — the same seam recordCodeModeArtifact uses — and it
   * can push the `item/commandExecution/outputDelta` runtime event the client
   * already renders as streamed tool output, keyed by the parent js_exec call.
   */
  private async streamProjectBuildProgress(message: string): Promise<void> {
    const parentToolUseId = this.ctx?.props?.parentToolUseId?.trim();
    if (!parentToolUseId) return;
    try {
      await (this.chatThreadStub as unknown as {
        streamToolProgress(parentToolUseId: string, delta: string): Promise<void>;
      }).streamToolProgress(parentToolUseId, message);
    } catch (error) {
      console.warn("[project-build] failed to stream readiness progress", {
        parentToolUseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Keep the container warm for the rest of this build session so the next
   * deploy in the same chat does not pay another cold boot. Called AFTER the
   * build finishes (success or failure), never from the readiness path: the
   * window is a post-build tail, so a long build gets its full window and a
   * build that never ran never extends one.
   */
  private async noteProjectBuildSessionActivity(
    sandbox: ProjectBuildSandboxLike,
    operation: "add_dependency" | "deploy_project",
  ): Promise<void> {
    try {
      await sandbox.noteBuildSessionActivity?.();
    } catch (error) {
      console.warn("[project-build] failed to extend build session window", {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordProjectBuildReadinessEvent(
    operation: "add_dependency" | "deploy_project",
    event: ProjectBuildReadinessEvent,
  ): void {
    const props = this.ctx?.props;
    // A permanently broken container is a configuration problem, not a slow
    // boot — it gets its own event so cold-start dashboards stay boot-shaped.
    // Same for a zombie: the wait is real, but the cause is a dead shell layer,
    // and the DO's own build_sandbox_zombie_restart records what was done.
    const eventName = event.type === "cold_start"
      ? "build_sandbox_cold_start"
      : event.type === "zombie_detected"
        ? "build_sandbox_zombie_detected"
        : event.type === "startup_failed"
          ? "build_sandbox_startup_failed"
          : "build_sandbox_ready_timeout";
    const status = event.type === "cold_start"
      ? "ready"
      : event.type === "zombie_detected"
        ? (event.restarted ? "restarted" : "restart_suppressed")
        : event.type === "startup_failed"
          ? "startup_failed"
          : "timeout";
    recordObservabilityEvent(this.env, {
      event: eventName,
      severity: event.type === "cold_start" ? "info" : "error",
      component: "CodeModeToolsBinding",
      operation,
      status,
      durationMs: event.waitedMs,
      count: event.attempts,
      errorName: event.cause,
      workspaceId: props?.workspaceId,
      threadId: props?.threadId,
      orgId: props?.orgId,
      userId: props?.userId,
    });
  }

  private async resolveProjectForAction(args: Record<string, unknown>): Promise<WorkspaceProject> {
    const name = typeof args.project === "string" ? args.project.trim() : "";
    if (!name) throw new Error("project is required");
    const project = await this.workspaceFs.getProjectByName(name);
    if (!project) throw new Error(`Project not found: ${name}`);
    return project;
  }

  private async resolveDoBackedProjectForAction(args: Record<string, unknown>, _action: string): Promise<WorkspaceProject> {
    return this.resolveProjectForAction(args);
  }

  private async writeProjectScaffold(
    project: WorkspaceProject,
    options: { template?: unknown; force?: boolean } = {},
  ): Promise<ProjectScaffoldResult> {
    // Scaffold source, its pinned lockfile, and the bundled shadcn registry are
    // large immutable strings. Only project creation needs them.
    const { defaultProjectScaffoldFiles, normalizeProjectScaffoldTemplate } =
      await import("./project-scaffold");
    const template = normalizeProjectScaffoldTemplate(options.template);
    const files = defaultProjectScaffoldFiles(project.name, template, normalizeDeployScriptName(project.name));
    const fileStore = new ProjectFilesystemClient(this.env, project.id);
    const filesWritten: string[] = [];
    const filesSkipped: string[] = [];
    for (const file of files) {
      if (!options.force) {
        const exists = await fileStore.exists(file.path);
        if (exists.exists) {
          filesSkipped.push(file.path);
          continue;
        }
      }
      const result = await fileStore.writeFile(file.path, file.content);
      if (!result.success) throw new Error(result.error || `Failed to write scaffold file ${file.path}`);
      filesWritten.push(file.path);
    }
    return { template, filesWritten, filesSkipped };
  }

  private async createProject(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Validate before creating: js_exec calls skip schema validation, and an
    // invalid template must not leave behind an empty registered project.
    const { normalizeProjectScaffoldTemplate } = await import("./project-scaffold");
    const template = normalizeProjectScaffoldTemplate(args.template);
    const project = await this.workspaceFs.createProject(args);
    const scaffold = await this.writeProjectScaffold(project, { template });
    return { ...projectForAgent(project), scaffold };
  }

  private get orgStub(): DurableObjectStub<OrgDO> {
    const { orgId } = this.ctx.props;
    if (!orgId) throw new Error("Code mode tool binding is missing org scope");
    return this.env.ORG.get(this.env.ORG.idFromName(orgId));
  }

  private get workspaceStub(): DurableObjectStub<WorkspaceDO> {
    const { workspaceId } = this.ctx.props;
    if (!workspaceId) {
      throw new Error("Code mode tool binding is missing workspace scope");
    }
    return this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));
  }

  private get chatThreadStub(): DurableObjectStub<ChatThreadDO> {
    const { threadId } = this.ctx.props;
    if (!threadId) throw new Error("This tool requires chat thread scope");
    return this.env.CHAT_THREAD.get(this.env.CHAT_THREAD.idFromName(threadId));
  }

  private get cronStub(): DurableObjectStub<WorkspaceCronDO> {
    const { workspaceId } = this.ctx.props;
    if (!workspaceId) {
      throw new Error("Code mode tool binding is missing workspace scope");
    }
    if (!this.env.WORKSPACE_CRON) {
      throw new Error("Scheduled prompt tools are not configured");
    }
    return this.env.WORKSPACE_CRON.get(this.env.WORKSPACE_CRON.idFromName(workspaceId));
  }

  private async getOrgSlug(): Promise<string | null> {
    const info = await this.orgStub.getInfo();
    return typeof info?.slug === "string" && info.slug.trim() ? info.slug.trim() : null;
  }

  private async getWorkspaceRuntimeInfo(): Promise<Record<string, unknown>> {
    const workspaceInfo = await this.workspaceStub.getInfo();
    const emailDomain = getWorkspaceEmailDomain(this.env);
    const emailHandle = typeof workspaceInfo?.email_handle === "string"
      ? workspaceInfo.email_handle.trim()
      : "";
    const emailAddress = emailDomain && emailHandle
      ? buildWorkspaceEmailAddress(emailHandle, emailDomain)
      : null;
    return {
      id: workspaceInfo?.id ?? this.ctx.props.workspaceId,
      name: workspaceInfo?.name ?? null,
      email_address: emailAddress,
    };
  }

  private safeThreadR2SessionId(): string {
    const { threadId } = this.ctx.props;
    if (!threadId) {
      throw new Error("R2 temp paths require chat thread scope");
    }
    return threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private r2MountBaseKey(mount: CodeModeR2Mount): string {
    const { orgId, workspaceId } = this.ctx.props;
    if (!orgId || !workspaceId) {
      throw new Error("Code mode tool binding is missing R2 scope");
    }
    switch (mount) {
      case "uploads":
        return buildWorkspaceScopedR2Key(orgId, workspaceId, "user-uploads/");
      case "outputs":
        return buildWorkspaceScopedR2Key(orgId, workspaceId, "user-outputs/");
      case "tmp":
        return buildWorkspaceScopedR2Key(
          orgId,
          workspaceId,
          `chat-sessions/${this.safeThreadR2SessionId()}/pi-tool-results/tmp/`,
        );
    }
  }

  private normalizeR2RelativePath(path: string, allowDirectory: boolean): string {
    if (path.startsWith("/")) {
      throw new Error("R2 paths must be relative: use uploads/<path>, outputs/<path>, or tmp/<path>");
    }
    const relativePath = allowDirectory ? path.replace(/\/+$/, "") : path;
    if (relativePath.length > 1024) {
      throw new Error("R2 path exceeds the maximum length of 1024 characters");
    }
    if (!relativePath) return "";
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("R2 paths must not contain empty, '.', or '..' segments");
    }
    return relativePath;
  }

  private r2PathFromRelative(mount: CodeModeR2Mount, relativePath: string): string {
    return relativePath ? `${mount}/${relativePath}` : mount;
  }

  private resolveCodeModeR2Path(
    raw: Record<string, unknown>,
    options: { allowDirectory?: boolean; requireWritable?: boolean } = {},
  ): CodeModeR2Path {
    const rawPath = typeof raw.path === "string" ? raw.path.trim().replace(/\\/g, "/") : "";
    if (!rawPath) throw new Error("R2 path is required");
    const normalizedPath = this.normalizeR2RelativePath(rawPath, options.allowDirectory ?? false);
    const [mountPart, ...rest] = normalizedPath.split("/");
    if (mountPart !== "uploads" && mountPart !== "outputs" && mountPart !== "tmp") {
      throw new Error("R2 path must start with uploads/, outputs/, or tmp/");
    }
    const relativePath = rest.join("/");
    if (!options.allowDirectory && !relativePath) throw new Error("R2 object path is required");
    if (options.requireWritable && mountPart === "uploads") throw new Error("uploads/ is read-only");
    return {
      mount: mountPart,
      key: `${this.r2MountBaseKey(mountPart)}${relativePath}`,
      path: this.r2PathFromRelative(mountPart, relativePath),
      relativePath,
    };
  }

  private r2PublicUrl(target: CodeModeR2Path): string | null {
    if (target.mount === "tmp") return null;
    return `/api/workspaces/${this.ctx.props.workspaceId}/${target.mount}/${target.relativePath}`;
  }

  private formatR2ObjectMetadata(obj: R2Object, target: CodeModeR2Path): Record<string, unknown> {
    return {
      location: "r2",
      path: target.path,
      namespace: target.mount,
      publicUrl: this.r2PublicUrl(target),
      size: obj.size,
      etag: obj.etag,
      uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : String(obj.uploaded),
      contentType: obj.httpMetadata?.contentType ?? null,
      customMetadata: obj.customMetadata ?? {},
    };
  }

  private textByteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }

  private truncateR2ReadHead(
    content: string,
    maxBytes: number,
  ): {
    content: string;
    truncated: boolean;
    truncatedBy: "lines" | "bytes" | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
    firstLineExceedsLimit: boolean;
    maxLines: number;
    maxBytes: number;
  } {
    const lines = content.split("\n");
    const totalLines = lines.length;
    const totalBytes = this.textByteLength(content);
    if (totalLines <= PI_TOOL_RESULT_MAX_LINES && totalBytes <= maxBytes) {
      return {
        content,
        truncated: false,
        truncatedBy: null,
        totalLines,
        totalBytes,
        outputLines: totalLines,
        outputBytes: totalBytes,
        firstLineExceedsLimit: false,
        maxLines: PI_TOOL_RESULT_MAX_LINES,
        maxBytes,
      };
    }
    if (this.textByteLength(lines[0] ?? "") > maxBytes) {
      return {
        content: "",
        truncated: true,
        truncatedBy: "bytes",
        totalLines,
        totalBytes,
        outputLines: 0,
        outputBytes: 0,
        firstLineExceedsLimit: true,
        maxLines: PI_TOOL_RESULT_MAX_LINES,
        maxBytes,
      };
    }
    const selected: string[] = [];
    let outputBytes = 0;
    let truncatedBy: "lines" | "bytes" = "lines";
    for (let index = 0; index < lines.length && index < PI_TOOL_RESULT_MAX_LINES; index += 1) {
      const line = lines[index] ?? "";
      if (selected.length >= PI_TOOL_RESULT_MAX_LINES) {
        truncatedBy = "lines";
        break;
      }
      const lineBytes = this.textByteLength(line) + (selected.length > 0 ? 1 : 0);
      if (outputBytes + lineBytes > maxBytes) {
        truncatedBy = "bytes";
        break;
      }
      selected.push(line);
      outputBytes += lineBytes;
    }
    if (selected.length >= PI_TOOL_RESULT_MAX_LINES && outputBytes <= maxBytes) {
      truncatedBy = "lines";
    }
    const outputContent = selected.join("\n");
    return {
      content: outputContent,
      truncated: true,
      truncatedBy,
      totalLines,
      totalBytes,
      outputLines: selected.length,
      outputBytes: this.textByteLength(outputContent),
      firstLineExceedsLimit: false,
      maxLines: PI_TOOL_RESULT_MAX_LINES,
      maxBytes,
    };
  }

  private r2ImageReadResult(
    head: R2Object,
    target: CodeModeR2Path,
    imageMimeType: string,
    inlineImage: PreparedInlineImage | null,
  ): Record<string, unknown> {
    const metadata = this.formatR2ObjectMetadata(head, target);
    let text = `Read R2 image object [${inlineImage?.mimeType ?? imageMimeType}]`;
    if (inlineImage?.optimizedForInlineView) {
      text += `\n[Image optimized for inline model context and may be scaled/compressed from the source.]`;
    }
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text },
    ];
    if (inlineImage) {
      content.push({ type: "image", data: inlineImage.data, mimeType: inlineImage.mimeType });
    } else {
      text += `\n[Image omitted: could not be resized below the inline image size limit of ${inlineImageMaxBase64Chars()} base64 chars.]`;
      content[0] = { type: "text", text };
    }
    return {
      text,
      content,
      details: {
        ...metadata,
        image: true,
        mimeType: inlineImage?.mimeType ?? imageMimeType,
        originalMimeType: imageMimeType,
        inlineImage: Boolean(inlineImage),
        optimizedForInlineView: inlineImage?.optimizedForInlineView ?? false,
        maxInlineDimension: inlineImage?.maxInlineDimension ?? null,
        usedImagesBinding: inlineImage?.usedImagesBinding ?? false,
        base64Chars: inlineImage?.base64Chars ?? null,
        offset: null,
        nextOffset: null,
        totalLines: null,
        truncation: null,
      },
    };
  }

  private async readR2File(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args);
    const offset = clampCodeModeInteger(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = typeof args.limit === "number"
      ? clampCodeModeInteger(args.limit, PI_TOOL_RESULT_MAX_LINES, 1, PI_TOOL_RESULT_MAX_LINES)
      : undefined;
    const head = await this.env.R2_BUCKET.head(target.key);
    if (!head) {
      throw new Error(`R2 object not found: ${target.path}`);
    }
    const contentTypeImageMimeType = getSupportedImageMimeTypeFromContentType(
      head.httpMetadata?.contentType,
    );
    const object = await this.env.R2_BUCKET.get(target.key);
    if (!object) {
      throw new Error(`R2 object not found: ${target.path}`);
    }
    let bytes: Uint8Array;
    if (object.body) {
      const sniffed = await readImageSniffBytesAndReplayStream(object.body);
      const imageDetection = detectSharedImageMimeType(sniffed.prefix);
      const imageMimeType = imageDetection.kind === "supported"
        ? imageDetection.mimeType
        : imageDetection.kind === "unknown"
          ? contentTypeImageMimeType
          : null;
      if (imageMimeType) {
        const images = this.env.IMAGES;
        if (!images) throw new Error("IMAGES binding is required for image reads");
        const inlineImage = await prepareInlineImageFromStream(sniffed.stream, imageMimeType, images, {
          createRetryStream: async () => {
            const retryObject = await this.env.R2_BUCKET.get(target.key);
            if (!retryObject?.body) throw new Error(`R2 image object is not streamable: ${target.path}`);
            return retryObject.body;
          },
        });
        return this.r2ImageReadResult(head, target, imageMimeType, inlineImage);
      }
      if (head.size > CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES) {
        await sniffed.stream.cancel("R2 object exceeds text read limit").catch(() => undefined);
        throw new Error(
          `R2 object is too large for text read (${head.size} bytes; max ${CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES} bytes)`,
        );
      }
      bytes = await readStreamBytes(sniffed.stream);
    } else {
      bytes = typeof object.arrayBuffer === "function"
        ? new Uint8Array(await object.arrayBuffer())
        : new TextEncoder().encode(await object.text());
      const imageDetection = detectSharedImageMimeType(bytes);
      const imageMimeType = imageDetection.kind === "supported"
        ? imageDetection.mimeType
        : imageDetection.kind === "unknown"
          ? contentTypeImageMimeType
          : null;
      if (imageMimeType) throw new Error(`R2 image object is not streamable: ${target.path}`);
    }
    if (head.size > CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES) {
      throw new Error(
        `R2 object is too large for text read (${head.size} bytes; max ${CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES} bytes)`,
      );
    }
    const fullText = new TextDecoder().decode(bytes);
    const allLines = fullText.split("\n");
    const startLine = offset - 1;
    if (startLine >= allLines.length) {
      throw new Error(`Offset ${offset} is beyond end of R2 object (${allLines.length} lines total)`);
    }
    let selectedContent: string;
    let userLimitedLines: number | undefined;
    if (limit !== undefined) {
      const endLine = Math.min(startLine + limit, allLines.length);
      selectedContent = allLines.slice(startLine, endLine).join("\n");
      userLimitedLines = endLine - startLine;
    } else {
      selectedContent = allLines.slice(startLine).join("\n");
    }
    const maxBytes = PI_TOOL_RESULT_MAX_BYTES - CODE_MODE_R2_READ_NOTICE_RESERVED_BYTES;
    const truncation = this.truncateR2ReadHead(selectedContent, maxBytes);
    const startLineDisplay = startLine + 1;
    let text: string;
    let nextOffset: number | null = null;
    if (truncation.firstLineExceedsLimit) {
      text =
        `[Line ${startLineDisplay} is ${this.textByteLength(allLines[startLine] ?? "")} bytes, exceeds ${maxBytes} byte read budget. R2 path: ${target.path}]`;
    } else if (truncation.truncated) {
      const endLineDisplay = startLine + truncation.outputLines;
      nextOffset = endLineDisplay + 1;
      const limitLabel = truncation.truncatedBy === "bytes"
        ? ` (${maxBytes} byte read budget)`
        : "";
      text = truncation.content;
      text +=
        `${text ? "\n\n" : ""}` +
        `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}${limitLabel}. Use offset=${nextOffset} to continue.]`;
    } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
      const remaining = allLines.length - (startLine + userLimitedLines);
      nextOffset = startLine + userLimitedLines + 1;
      text = `${truncation.content}\n\n[${remaining} more lines in R2 object. Use offset=${nextOffset} to continue.]`;
    } else {
      text = truncation.content;
    }

    return {
      text,
      content: [{ type: "text", text }],
      details: {
        ...this.formatR2ObjectMetadata(head, target),
        offset,
        nextOffset,
        totalLines: allLines.length,
        truncation,
      },
    };
  }

  private async writeR2File(
    args: Record<string, unknown>,
    options: { expectedEtag?: string } = {},
  ): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args, { requireWritable: true });
    const content = typeof args.content === "string" ? args.content : "";
    const contentBytes = new TextEncoder().encode(content).byteLength;
    if (contentBytes > CODE_MODE_R2_MAX_WRITE_BYTES) {
      throw new Error(`R2 write content exceeds ${CODE_MODE_R2_MAX_WRITE_BYTES} bytes`);
    }
    assertNotBase64IntoBinaryFile(target.path, content);
    const contentType = typeof args.content_type === "string" && args.content_type.trim()
      ? args.content_type.trim()
      : "text/plain; charset=utf-8";
    const object = await this.env.R2_BUCKET.put(target.key, content, {
      ...(options.expectedEtag ? { onlyIf: { etagMatches: options.expectedEtag } } : {}),
      httpMetadata: { contentType },
      customMetadata: {
        type: "code-mode-r2-file",
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
        threadId: this.ctx.props.threadId ?? "",
      },
    });
    if (!object && options.expectedEtag) {
      throw new Error(`Edit conflict for ${target.path}: the R2 object changed while the edit was running. Read it again and retry.`);
    }
    const text = `Wrote ${contentBytes} bytes to ${target.path}`;
    return {
      text,
      content: [{ type: "text", text }],
      details: {
        ...(object ? this.formatR2ObjectMetadata(object, target) : {
          location: "r2",
          path: target.path,
          namespace: target.mount,
          publicUrl: this.r2PublicUrl(target),
          size: contentBytes,
          contentType,
        }),
        bytesWritten: contentBytes,
      },
    };
  }

  private async editR2File(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args, { requireWritable: true });
    const edits = normalizeTextEditArguments(args);

    const head = await this.env.R2_BUCKET.head(target.key);
    if (!head) throw new Error(`R2 object not found: ${target.path}`);
    if (head.size > CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES) {
      throw new Error(
        `R2 object is too large for text edit (${head.size} bytes; max ${CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES} bytes)`,
      );
    }
    const object = await this.env.R2_BUCKET.get(target.key);
    if (!object) throw new Error(`R2 object not found: ${target.path}`);
    const originalContent = await object.text();
    const applied = applyTextEdits(originalContent, edits, target.path);
    const written = await this.writeR2File({
      ...args,
      path: target.path,
      content: applied.after,
      content_type: head.httpMetadata?.contentType ?? "text/plain; charset=utf-8",
    }, { expectedEtag: object.etag });
    const text = `Successfully replaced ${edits.length} block(s) in ${target.path}.`;
    return {
      ...written,
      text,
      content: [{ type: "text", text }],
      details: {
        ...((written.details && typeof written.details === "object") ? written.details : {}),
        diff: applied.diff,
        patch: applied.patch,
        firstChangedLine: applied.firstChangedLine,
        usedFuzzyMatch: applied.usedFuzzyMatch,
        replacementCount: edits.length,
      },
    };
  }

  private async listR2Files(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args, { allowDirectory: true });
    const limit = clampCodeModeInteger(args.limit, 100, 1, 1000);
    const cursor = typeof args.cursor === "string" && args.cursor.trim()
      ? args.cursor.trim()
      : undefined;
    const directoryRelativePath = target.relativePath
      ? `${target.relativePath}/`
      : "";
    const baseKey = this.r2MountBaseKey(target.mount);
    const result = await this.env.R2_BUCKET.list({
      prefix: `${baseKey}${directoryRelativePath}`,
      delimiter: "/",
      limit,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    });
    const objects = result.objects.map((object) => {
      const relativePath = object.key.startsWith(baseKey)
        ? object.key.slice(baseKey.length)
        : object.key;
      return this.formatR2ObjectMetadata(object, {
        ...target,
        relativePath,
        path: this.r2PathFromRelative(target.mount, relativePath),
        key: object.key,
      });
    });
    const prefixes = result.delimitedPrefixes.map((prefix) => {
      const relativePath = prefix.startsWith(baseKey)
        ? prefix.slice(baseKey.length).replace(/\/+$/, "")
        : prefix.replace(/\/+$/, "");
      return { path: this.r2PathFromRelative(target.mount, relativePath) };
    });
    const lines = [
      ...prefixes.map((prefix) => `dir  ${prefix.path}/`),
      ...objects.map((object) => `${String(object.size).padStart(8, " ")} ${object.path}`),
    ];
    const text = lines.length > 0 ? lines.join("\n") : "(empty)";
    return {
      text,
      content: [{ type: "text", text }],
      details: {
        location: "r2",
        path: target.path,
        namespace: target.mount,
        objects,
        prefixes,
        truncated: result.truncated,
        cursor: result.truncated ? result.cursor : undefined,
      },
    };
  }

  private async deleteR2File(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args, { requireWritable: true });
    await this.env.R2_BUCKET.delete(target.key);
    const text = `Deleted ${target.path}`;
    return {
      text,
      content: [{ type: "text", text }],
      details: {
        location: "r2",
        path: target.path,
        namespace: target.mount,
        publicUrl: this.r2PublicUrl(target),
        deleted: true,
      },
    };
  }

  private normalizeMoveEndpoint(value: unknown, label: "source" | "destination"): CodeModeMoveEndpoint {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    const raw = value as Record<string, unknown>;
    const location = raw.location;
    if (location !== "workspace" && location !== "project" && location !== "r2") {
      throw new Error(`${label}.location must be "workspace", "project", or "r2"`);
    }
    const path = typeof raw.path === "string" ? raw.path.trim().replace(/\\/g, "/") : "";
    if (!path) throw new Error(`${label}.path is required`);
    const project = typeof raw.project === "string" && raw.project.trim()
      ? raw.project.trim()
      : undefined;
    if (location === "project" && !project) {
      throw new Error(`${label}.project is required when ${label}.location is "${location}"`);
    }
    const contentType = typeof raw.content_type === "string" && raw.content_type.trim()
      ? raw.content_type.trim()
      : undefined;
    return { location, path, project, contentType };
  }

  private async collectMoveSourceFiles(source: CodeModeMoveEndpoint): Promise<{ files: CodeModeMoveFile[]; sourceIsDirectory: boolean }> {
    if (source.location === "workspace") return this.collectWorkspaceMoveFiles(source);
    if (source.location === "project") return this.collectProjectMoveFiles(source);
    return this.collectR2MoveFiles(source);
  }

  private async collectWorkspaceMoveFiles(source: CodeModeMoveEndpoint): Promise<{ files: CodeModeMoveFile[]; sourceIsDirectory: boolean }> {
    return this.collectFileStoreMoveFiles(this.workspaceFs, source);
  }

  private async collectProjectMoveFiles(source: CodeModeMoveEndpoint): Promise<{ files: CodeModeMoveFile[]; sourceIsDirectory: boolean }> {
    return this.collectFileStoreMoveFiles(await this.projectFileStore(source as unknown as Record<string, unknown>), source);
  }

  private async collectFileStoreMoveFiles(
    fileStore: WorkspaceFileStoreLike,
    source: CodeModeMoveEndpoint,
  ): Promise<{ files: CodeModeMoveFile[]; sourceIsDirectory: boolean }> {
    const path = normalizeDurableWorkspacePath(source.path);
    const exists = await fileStore.exists(path);
    if (!exists.exists) throw new Error(`Path not found: ${path}`);
    if (exists.isFile) {
      return {
        files: [{ path, relativePath: basenameForMove(path), size: exists.size, contentType: exists.mimeType }],
        sourceIsDirectory: false,
      };
    }
    if (!exists.isDirectory) throw new Error(`Path is not a file or directory: ${path}`);
    const listing = await fileStore.listFiles(path, { recursive: true, includeHidden: true });
    if (!listing.success) throw new Error(listing.error || `Failed to list ${path}`);
    const rootName = basenameForMove(path);
    const files = listing.files
      .filter((entry) => entry.type === "file")
      .map((entry) => ({
        path: normalizeDurableWorkspacePath(entry.absolutePath),
        relativePath: joinRelativeMovePath(rootName, entry.relativePath),
        size: entry.size,
        contentType: entry.mimeType,
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { files, sourceIsDirectory: true };
  }

  private async collectR2MoveFiles(source: CodeModeMoveEndpoint): Promise<{ files: CodeModeMoveFile[]; sourceIsDirectory: boolean }> {
    const target = this.resolveCodeModeR2Path(source as unknown as Record<string, unknown>, { allowDirectory: true });
    if (target.relativePath) {
      const head = await this.env.R2_BUCKET.head(target.key);
      if (head) {
        return {
          files: [{
            path: target.path,
            relativePath: basenameForMove(target.path),
            size: head.size,
            contentType: head.httpMetadata?.contentType,
          }],
          sourceIsDirectory: false,
        };
      }
    }

    const baseKey = this.r2MountBaseKey(target.mount);
    const directoryRelativePath = target.relativePath ? `${target.relativePath}/` : "";
    const prefix = `${baseKey}${directoryRelativePath}`;
    const rootName = basenameForMove(target.path);
    const files: CodeModeMoveFile[] = [];
    let cursor: string | undefined;
    do {
      const listed = await this.env.R2_BUCKET.list({
        prefix,
        cursor,
        limit: 1000,
        include: ["httpMetadata"],
      });
      for (const object of listed.objects) {
        const objectRelativePath = object.key.startsWith(prefix)
          ? object.key.slice(prefix.length)
          : object.key.slice(baseKey.length);
        if (!objectRelativePath) continue;
        files.push({
          path: this.r2PathFromRelative(target.mount, target.relativePath
            ? `${target.relativePath}/${objectRelativePath}`
            : objectRelativePath),
          relativePath: joinRelativeMovePath(rootName, objectRelativePath),
          size: object.size,
          contentType: object.httpMetadata?.contentType,
        });
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    if (files.length === 0) throw new Error(`R2 path not found: ${target.path}`);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { files, sourceIsDirectory: true };
  }

  private async readMoveSourceFile(source: CodeModeMoveEndpoint, file: CodeModeMoveFile): Promise<{ bytes: Uint8Array; contentType?: string }> {
    if (source.location === "workspace") {
      const read = await this.workspaceFs.readFile(file.path);
      if (!read.success || typeof read.content !== "string") {
        throw new Error(read.error || `Failed to read ${file.path}`);
      }
      return {
        bytes: read.encoding === "base64"
          ? base64ToBytesForMove(read.content)
          : new TextEncoder().encode(read.content),
        contentType: read.mimeType ?? file.contentType,
      };
    }
    if (source.location === "project") {
      const fileStore = await this.projectFileStore(source as unknown as Record<string, unknown>);
      const read = await fileStore.readFile(file.path);
      if (!read.success || typeof read.content !== "string") {
        throw new Error(read.error || `Failed to read ${file.path}`);
      }
      return {
        bytes: read.encoding === "base64"
          ? base64ToBytesForMove(read.content)
          : new TextEncoder().encode(read.content),
        contentType: read.mimeType ?? file.contentType,
      };
    }
    const target = this.resolveCodeModeR2Path({ ...source, path: file.path });
    const object = await this.env.R2_BUCKET.get(target.key);
    if (!object) throw new Error(`R2 object not found: ${target.path}`);
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      contentType: object.httpMetadata?.contentType ?? file.contentType,
    };
  }

  private async writeMoveDestinationFile(
    destination: CodeModeMoveEndpoint,
    path: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<{ path: string; bytes: number }> {
    if (destination.location === "workspace") {
      const normalizedPath = normalizeDurableWorkspacePath(path);
      const result = await this.workspaceFs.writeBinaryFile(normalizedPath, bytesToBase64ForMove(bytes));
      if (!result.success) throw new Error(result.error || `Failed to write ${normalizedPath}`);
      return { path: normalizedPath, bytes: bytes.byteLength };
    }
    if (destination.location === "project") {
      const normalizedPath = normalizeDurableWorkspacePath(path);
      const fileStore = await this.projectFileStore(destination as unknown as Record<string, unknown>);
      const result = await fileStore.writeBinaryFile(normalizedPath, bytesToBase64ForMove(bytes));
      if (!result.success) throw new Error(result.error || `Failed to write ${normalizedPath}`);
      return { path: normalizedPath, bytes: bytes.byteLength };
    }
    const target = this.resolveCodeModeR2Path({ ...destination, path }, { requireWritable: true });
    await this.env.R2_BUCKET.put(target.key, bytes, {
      httpMetadata: { contentType: destination.contentType ?? contentType ?? "application/octet-stream" },
      customMetadata: {
        type: "code-mode-move-file",
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
        threadId: this.ctx.props.threadId ?? "",
      },
    });
    return { path: target.path, bytes: bytes.byteLength };
  }

  private async deleteMoveSource(source: CodeModeMoveEndpoint, files: CodeModeMoveFile[]): Promise<void> {
    if (source.location === "workspace") {
      const result = await this.workspaceFs.deleteFile(source.path, { recursive: true });
      if (!result.success) throw new Error(result.error || `Failed to delete ${source.path}`);
      return;
    }
    if (source.location === "project") {
      const fileStore = await this.projectFileStore(source as unknown as Record<string, unknown>);
      const result = await fileStore.deleteFile(source.path, { recursive: true });
      if (!result.success) throw new Error(result.error || `Failed to delete ${source.path}`);
      return;
    }
    const target = this.resolveCodeModeR2Path(source as unknown as Record<string, unknown>, { allowDirectory: true });
    if (target.mount === "uploads") throw new Error("uploads/ is read-only");
    for (const file of files) {
      const fileTarget = this.resolveCodeModeR2Path({ ...source, path: file.path }, { requireWritable: true });
      await this.env.R2_BUCKET.delete(fileTarget.key);
    }
  }

  private async comparableMovePath(endpoint: CodeModeMoveEndpoint): Promise<string> {
    if (endpoint.location === "workspace") {
      return normalizeDurableWorkspacePath(endpoint.path).replace(/\/+$/g, "") || "/";
    }
    if (endpoint.location === "project") {
      return normalizeDurableWorkspacePath(endpoint.path).replace(/\/+$/g, "") || "/";
    }
    return this.resolveCodeModeR2Path(endpoint as unknown as Record<string, unknown>, { allowDirectory: true }).path.replace(/\/+$/g, "");
  }

  private isMovePathEqualOrDescendant(sourcePath: string, destinationPath: string): boolean {
    if (destinationPath === sourcePath) return true;
    const prefix = sourcePath.endsWith("/") ? sourcePath : `${sourcePath}/`;
    return destinationPath.startsWith(prefix);
  }

  private async assertSafeMoveDeleteDestination(
    source: CodeModeMoveEndpoint,
    destination: CodeModeMoveEndpoint,
    sourceIsDirectory: boolean,
  ): Promise<void> {
    if (source.location !== destination.location) return;
    if (source.location === "project" && source.project !== destination.project) return;

    const sourcePath = await this.comparableMovePath(source);
    const destinationPath = await this.comparableMovePath(destination);
    const overlaps = sourceIsDirectory
      ? this.isMovePathEqualOrDescendant(sourcePath, destinationPath)
      : sourcePath === destinationPath;
    if (overlaps) {
      throw new Error("move with deleteSource cannot use an equal or descendant destination in the same location");
    }
  }

  private async moveFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = this.normalizeMoveEndpoint(args.source, "source");
    const destination = this.normalizeMoveEndpoint(args.destination, "destination");
    const deleteSource = args.deleteSource === true || args.delete_source === true;
    if (deleteSource && source.location === "r2") {
      const sourceTarget = this.resolveCodeModeR2Path(source as unknown as Record<string, unknown>, { allowDirectory: true });
      if (sourceTarget.mount === "uploads") throw new Error("uploads/ is read-only");
    }
    if (destination.location === "r2") {
      this.resolveCodeModeR2Path(destination as unknown as Record<string, unknown>, { allowDirectory: true, requireWritable: true });
    }

    const { files, sourceIsDirectory } = await this.collectMoveSourceFiles(source);
    if (files.length === 0) throw new Error(`No files found at ${source.path}`);
    if (deleteSource) {
      await this.assertSafeMoveDeleteDestination(source, destination, sourceIsDirectory);
    }

    const copied: Array<{ from: string; to: string; bytes: number }> = [];
    let totalBytes = 0;
    const useDestinationAsRoot = sourceIsDirectory || files.length > 1;
    for (const file of files) {
      const destinationPath = useDestinationAsRoot
        ? joinMoveDestinationPath(destination.location, destination.path, file.relativePath)
        : destination.path;
      const read = await this.readMoveSourceFile(source, file);
      const written = await this.writeMoveDestinationFile(destination, destinationPath, read.bytes, read.contentType);
      totalBytes += written.bytes;
      copied.push({ from: file.path, to: written.path, bytes: written.bytes });
    }

    if (deleteSource) await this.deleteMoveSource(source, files);

    const verb = deleteSource ? "Moved" : "Copied";
    const text = `${verb} ${copied.length} file${copied.length === 1 ? "" : "s"} (${totalBytes} bytes)`;
    return {
      text,
      content: [{ type: "text", text }],
      details: {
        source: { location: source.location, path: source.path, project: source.project ?? null },
        destination: { location: destination.location, path: destination.path, project: destination.project ?? null },
        deleteSource,
        files: copied,
        count: copied.length,
        bytes: totalBytes,
      },
    };
  }

  private async getAppUrl(script: WorkerScript): Promise<string> {
    let appHostname = "camelai.dev";
    const workerBaseUrl = (this.env as { WORKER_BASE_URL?: string }).WORKER_BASE_URL;
    if (workerBaseUrl) {
      try {
        appHostname = new URL(workerBaseUrl).host;
      } catch {
        appHostname = "camelai.dev";
      }
    }
    const orgSlug = await this.getOrgSlug();
    return getPreferredAppUrl(script, {
      hostname: {
        hostname: appHostname,
        vanityDomain: this.env.LOCAL_APP_VANITY_DOMAIN,
        iframeDomain: this.env.LOCAL_APP_IFRAME_DOMAIN,
      },
      orgSlug: orgSlug ?? undefined,
      orgCustomDomain: null,
    });
  }

  async listTools(): Promise<CodeModeToolDefinition[]> {
    return CODE_MODE_TOOL_DEFINITIONS
      .filter((definition) => !JS_EXEC_EXCLUDED_TOOL_NAMES.has(definition.name))
      .filter((definition) => (
        definition.name !== "send_email" || !isSelfhostRuntime(this.env)
      ))
      .filter((definition) => (
        this.ctx?.props?.allowWebTools !== false || !AGENT_WEB_TOOL_NAMES.has(definition.name)
      ));
  }

  // Executor-style result envelope for js_exec's `tools.<name>()` calls. Catching
  // on this side of the RPC boundary matters: a thrown error would be delivered
  // to the sandbox by capnweb but still surface as an unhandled rejection in the
  // calling isolate, so expected tool failures must return as values here.
  async callToolEnvelope(
    name: string,
    rawArgs: unknown = {},
  ): Promise<
    | { ok: true; data: unknown }
    | { ok: false; error: { tool: string; message: string; origin: "tool" } }
  > {
    // Inner code-mode calls never produce a pi_core row: to the transcript the
    // whole script is one opaque `js_exec`, which in production is ~35% of all
    // tool calls and hides every build, deploy, notebook and DB timing inside
    // it. Timing them here is the only place those durations are observable.
    const startedAtMs = Date.now();
    try {
      const result = await this.callTool(name, rawArgs);
      const data = simplifyAgentWebToolResult(name, result);
      this.recordCodeModeToolCall(name, startedAtMs, true, "", data);
      // A tool that reports its own operational failure as a VALUE
      // (deploy_project's { success: false }) never reaches the catch below, so
      // the throw-path event above used to miss exactly the failures the agent
      // sees most: production had a build failing every attempt with nothing in
      // telemetry at all. Record it here with the same shape — minus the shell
      // outcomes, which are domain results, not tool failures (see
      // toolValueFailureMessage).
      const valueFailure = toolValueFailureMessage(data);
      if (valueFailure !== null) {
        this.recordCodeModeToolFailure(name, valueFailure, undefined, "value");
      }
      return { ok: true, data };
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      this.recordCodeModeToolCall(name, startedAtMs, false, message, undefined);
      this.recordCodeModeToolFailure(name, message, error, "throw");
      return { ok: false, error: { tool: name, message, origin: "tool" } };
    }
  }

  /**
   * One failure event for both surfaces a code-mode tool can fail through.
   *
   * `surfaced` distinguishes them: "throw" is an exception this envelope caught,
   * "value" is an operational failure the tool returned. They are disjoint by
   * construction (a call either threw or returned), so a throw that the runner
   * later turns into an `ok: false` envelope is still recorded exactly once.
   *
   * Budgeted per binding instance and deduped on tool+message: a js_exec script
   * that loops on the same failing call must not write one event per iteration.
   *
   * Arguments are NEVER logged — they carry user data and secrets — and neither
   * is program output: the value path only ever passes a bounded,
   * platform-authored message (toolValueFailureMessage).
   */
  private recordCodeModeToolFailure(
    name: string,
    message: string,
    error: unknown,
    surfaced: "throw" | "value",
  ): void {
    const recorded = (this.recordedToolFailures ??= new Set<string>());
    const key = `${surfaced}:${name}:${message}`;
    if (recorded.has(key)) return;
    if (recorded.size >= CODE_MODE_TOOL_FAILURE_EVENT_BUDGET) return;
    recorded.add(key);
    const props = this.ctx?.props;
    console.error("[code-mode] project tool call failed", {
      toolName: name,
      origin: "tool",
      surfaced,
      workspaceId: props?.workspaceId,
      threadId: props?.threadId,
      error: message,
    });
    recordErrorEvent(this.env, {
      event: "code_mode_project_tool_call_failed",
      component: "CodeModeToolsBinding",
      operation: name,
      status: "error",
      // Low-cardinality dimension for "did the agent see a throw or a value".
      provider: surfaced,
      workspaceId: props?.workspaceId,
      threadId: props?.threadId,
      orgId: props?.orgId,
      userId: props?.userId,
      // A value failure never had a stack; fabricating one from here would fill
      // the 4096-char errorStack blob with this method's own frames.
      error: error ?? stacklessValueFailure(message),
    });
  }

  /** Emit one `tool_calls` lake row for a call made from inside js_exec. */
  private recordCodeModeToolCall(
    toolName: string,
    startedAtMs: number,
    ok: boolean,
    errorMessage: string,
    result: unknown,
  ): void {
    const props = this.ctx?.props;
    sendToolCallRecords(this.env, [{
      ingested_at_ms: Date.now(),
      ts_ms: startedAtMs,
      thread_id: props?.threadId ?? "",
      org_id: props?.orgId ?? "",
      workspace_id: props?.workspaceId ?? "",
      user_id: props?.userId ?? "",
      turn_id: "",
      tool_call_id: crypto.randomUUID(),
      parent_tool_call_id: props?.parentToolUseId ?? "",
      tool_name: toolName,
      surface: "code_mode",
      model: "",
      provider: "",
      duration_ms: Math.max(0, Date.now() - startedAtMs),
      ok,
      error_message: ok ? "" : boundLakeErrorMessage(errorMessage),
      blocks_on_human: toolBlocksOnHuman(toolName),
      result_chars: measureResultChars(result),
    }]);
  }

  async callTool(name: string, rawArgs: unknown = {}): Promise<unknown> {
    if (name === "send_email" && isSelfhostRuntime(this.env)) {
      throw new Error(SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE);
    }
    if (this.ctx?.props?.allowWebTools === false && AGENT_WEB_TOOL_NAMES.has(name)) {
      throw new Error(`${name} is reserved for the Research agent; delegate web lookup to Research instead`);
    }
    if (rawArgs != null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
      throw new Error("tool arguments must be an object");
    }
    const args = rawArgs == null ? {} : rawArgs as Record<string, unknown>;
    const handler = CodeModeToolsBinding.TOOL_CALL_HANDLERS[name];
    if (handler) {
      return this.callToolWithArtifactCapture(name, args, () => handler(this, args, name));
    }

    return this.callToolWithArtifactCapture(name, args, async () => {
      if (FILE_TOOL_NAMES.has(name)) requireFileLocation(name, args);
      switch (name) {
        case "read_skill":
        {
          const catalog = resolveAgentSkillCatalog(this.env);
          const target = skillTargetFromArgs(args, catalog.skillNames);
          const skill = readAgentSkillFile(this.env, target.skill, target.file);
          if (!skill) {
            const availableFiles = listAgentSkillFiles(this.env, target.skill);
            if (availableFiles.length === 0) {
              throw new Error(
                `Skill not found: ${target.skill}. Available skills: ${catalog.skillNames.join(", ")}`,
              );
            }
            throw new Error(
              `Skill file not found: ${target.skill}/${target.file}. ` +
              `Available files: ${availableFiles.join(", ")}.`,
            );
          }
          return skillReadResponse(
            withDeployedConnectionsSkillOverride(skill, this.env),
          );
        }

        case "read":
          if (hasR2Target(args)) return this.readR2File(args);
          if (hasProjectTarget(args)) return (await this.projectContainerTools(args)).callTool("read", args);
        {
          const path = typeof args.path === "string" ? args.path : "";
          if (normalizeAutomationVirtualPath(path) !== null) {
            const automationFile = await readAutomationVirtualFile({
              cronStub: this.cronStub,
              workspaceId: this.ctx.props.workspaceId,
              path,
            });
            if (automationFile) return automationFile;
          }
        }
        return this.piContainerTools.callTool("read", args);

        case "write":
          if (hasR2Target(args)) return this.writeR2File(args);
          if (hasProjectTarget(args)) return (await this.projectContainerTools(args)).callTool("write", args);
        {
          const path = typeof args.path === "string" ? args.path : "";
          const content = typeof args.content === "string" ? args.content : "";
          if (normalizeAutomationVirtualPath(path) !== null) {
            const automationFile = await writeAutomationVirtualFile({
              cronStub: this.cronStub,
              workspaceId: this.ctx.props.workspaceId,
              path,
              content,
            });
            if (automationFile) return automationFile;
          }
        }
        return this.piContainerTools.callTool("write", args);

        case "ls":
          if (hasR2Target(args)) return this.listR2Files(args);
          if (hasProjectTarget(args)) return (await this.projectContainerTools(args)).callTool("ls", args);
        {
          if (typeof args.path === "string") {
            if (normalizeAutomationVirtualPath(args.path) !== null) {
              const automationListing = await listAutomationVirtualFiles({
                cronStub: this.cronStub,
                workspaceId: this.ctx.props.workspaceId,
                path: args.path,
              });
              if (automationListing) return automationListing;
            }
          }
        }
        return this.piContainerTools.callTool("ls", args);

        case "edit":
          if (hasR2Target(args)) return this.editR2File(args);
          if (hasProjectTarget(args)) return (await this.projectContainerTools(args)).callTool("edit", args);
        {
          const path = typeof args.path === "string" ? args.path : "";
          const edits = normalizeTextEditArguments(args);
          if (normalizeAutomationVirtualPath(path) !== null) {
            const automationFile = await editAutomationVirtualFile({
              cronStub: this.cronStub,
              workspaceId: this.ctx.props.workspaceId,
              path,
              edits,
            });
            if (automationFile) return automationFile;
          }
        }
        return this.piContainerTools.callTool("edit", args);

        case "delete":
          if (hasR2Target(args)) return this.deleteR2File(args);
          if (hasProjectTarget(args)) return (await this.projectContainerTools(args)).callTool("delete", args);
          return this.piContainerTools.callTool("delete", args);

        case "grep":
          if (hasProjectTarget(args)) return (await this.projectContainerTools(args)).callTool("grep", args);
          return this.piContainerTools.callTool("grep", args);

        case "find":
          if (hasProjectTarget(args)) return (await this.projectContainerTools(args)).callTool("find", args);
          return this.piContainerTools.callTool("find", args);

        case "move":
          return this.moveFile(args);

        case "list_projects":
          return (await this.workspaceFs.listProjects()).map(projectForAgent);

        case "create_project":
          // `await` (not bare return): createProject can reject synchronously on an
          // invalid template, and promise adoption attaches its handler late enough
          // to trip workerd's unhandled-rejection detector.
          return await this.createProject(args);


        case "set_project_description":
          return projectForAgent(await this.workspaceFs.setProjectDescription(args));

        case "add_dependency":
          return this.addDependency(args);

        case "revert_project":
          return this.revertProject(args);

        case "list_commits":
          return this.listCommits(args);

        case "deploy_project":
          return this.deployProject(args);

        case "rollback_deploy":
          return this.rollbackDeploy(args);

        case "list_deploy_versions":
          return this.listDeployVersions(args);

        case "delete_project":
          return this.deleteProject(args);

        case "delete_connection":
          return this.deleteConnection(args);

        case "browser_launch":
          return this.browserLaunch(args);

        case "browser_action":
          return this.browserAction(args);

        default:
          throw new Error(`Unknown code mode tool: ${name}`);
      }
    });
  }

  private async callToolWithArtifactCapture(
    name: string,
    args: Record<string, unknown>,
    execute: () => Promise<unknown> | unknown,
  ): Promise<unknown> {
    try {
      const result = await execute();
      await Promise.all([
        this.recordCodeModeArtifactBestEffort(name, args, result),
        this.recordProjectActivityBestEffort(name, args, result),
        this.recordVerifiedWorkEvidenceBestEffort(name, args, result),
      ]);
      return result;
    } catch (error) {
      await Promise.all([
        this.recordCodeModeArtifactBestEffort(name, args, undefined, error),
        this.recordVerifiedWorkEvidenceBestEffort(name, args, undefined, error),
      ]);
      throw error;
    }
  }

  private async recordVerifiedWorkEvidenceBestEffort(
    name: string,
    args: Record<string, unknown>,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    const parentToolUseId = this.ctx?.props?.parentToolUseId?.trim();
    const directToolUseId = typeof args.toolUseId === "string" ? args.toolUseId.trim() : "";
    const threadId = this.ctx?.props?.threadId?.trim();
    const evidenceId = parentToolUseId
      ? `${parentToolUseId}:${name}:${crypto.randomUUID()}`
      : directToolUseId;
    if (!evidenceId || !threadId) return;
    const evidence = deriveVerifiedWorkEvidence({
      toolCallId: evidenceId,
      toolName: name,
      args,
      result,
      isError: error !== undefined,
    });
    if (!evidence) return;
    try {
      await (this.chatThreadStub as unknown as {
        recordVerifiedWorkEvidence(evidence: VerifiedWorkEvidence): Promise<void>;
      }).recordVerifiedWorkEvidence(evidence);
    } catch (recordError) {
      console.error("Failed to record verified work evidence", {
        toolName: name,
        threadId,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
  }

  private async recordProjectActivityBestEffort(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
  ): Promise<void> {
    const props = this.ctx?.props;
    const threadId = props?.threadId?.trim();
    if (!threadId) return;

    try {
      let projectName = '';
      let activityType: 'created' | 'deployed' | null = null;
      const resultRecord =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : null;

      if (name === 'create_project') {
        projectName =
          (typeof resultRecord?.name === 'string' && resultRecord.name.trim()) ||
          (typeof args.name === 'string' && args.name.trim()) ||
          '';
        activityType = 'created';
      } else if (
        name === 'deploy_project' &&
        resultRecord?.success === true &&
        resultRecord.dryRun !== true
      ) {
        projectName =
          (typeof resultRecord.project === 'string' &&
            resultRecord.project.trim()) ||
          (typeof args.project === 'string' && args.project.trim()) ||
          '';
        activityType = 'deployed';
      }

      if (!activityType) return;
      if (!projectName) {
        throw new Error(`Successful ${name} result did not identify a project`);
      }

      const project = await this.workspaceFs.getProjectByName(projectName);
      if (!project) {
        throw new Error('Project activity target was not found');
      }
      await (
        this.chatThreadStub as unknown as {
          recordProjectActivity(input: {
            projectId: string;
            activityType: 'created' | 'deployed';
          }): Promise<void>;
        }
      ).recordProjectActivity({ projectId: project.id, activityType });
    } catch (error) {
      console.error('Failed to record thread project activity', {
        toolName: name,
        workspaceId: props?.workspaceId,
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      recordErrorEvent(this.env, {
        event: 'thread_project_activity_record_failed',
        component: 'CodeModeToolsBinding',
        operation: `recordProjectActivity:${name}`,
        status: 'error',
        workspaceId: props?.workspaceId,
        threadId,
        orgId: props?.orgId,
        userId: props?.userId,
        error,
      });
    }
  }

  private async recordCodeModeArtifactBestEffort(
    name: string,
    args: Record<string, unknown>,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    try {
      await this.maybeRecordCodeModeArtifact(name, args, result, error);
    } catch (recordError) {
      console.error("Failed to record code mode artifact", {
        toolName: name,
        threadId: this.ctx?.props?.threadId,
        parentToolUseId: this.ctx?.props?.parentToolUseId,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
  }

  private async maybeRecordCodeModeArtifact(
    name: string,
    args: Record<string, unknown>,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    const props = this.ctx?.props;
    const parentToolUseId = props?.parentToolUseId?.trim();
    const threadId = props?.threadId?.trim();
    if (!parentToolUseId || !threadId) return;
    const artifact = this.buildCodeModeArtifact(name, args, result, error);
    if (!artifact) return;
    await (this.chatThreadStub as unknown as {
      recordCodeModeArtifact(parentToolUseId: string, artifact: RuntimeCallArtifact): Promise<void>;
    }).recordCodeModeArtifact(parentToolUseId, artifact);
  }

  private buildCodeModeArtifact(
    name: string,
    args: Record<string, unknown>,
    result?: unknown,
    error?: unknown,
  ): RuntimeCallArtifact | null {
    const kindByTool: Record<string, RuntimeCallArtifactKind> = {
      send_email: "outbound_email",
      send_slack_message: "outbound_slack_message",
      send_telegram_message: "outbound_telegram_message",
      send_discord_message: "outbound_discord_message",
    };
    const kind = kindByTool[name];
    if (!kind) return null;
    const now = Date.now();
    const status = error ? "failed" : "sent";
    const details = this.codeModeArtifactDetails(result);
    const summary = this.summarizeCodeModeArtifactArgs(name, args);
    const titleByKind: Record<RuntimeCallArtifactKind, string> = {
      outbound_email: status === "sent" ? "Email sent" : "Email failed",
      outbound_slack_message: status === "sent" ? "Slack message sent" : "Slack message failed",
      outbound_telegram_message: status === "sent" ? "Telegram message sent" : "Telegram message failed",
      outbound_discord_message: status === "sent" ? "Discord message sent" : "Discord message failed",
    };
    return {
      id: `${this.ctx.props.parentToolUseId}:${name}:${crypto.randomUUID()}`,
      kind,
      toolName: name as RuntimeCallArtifact["toolName"],
      status,
      title: titleByKind[kind],
      subtitle: this.codeModeArtifactSubtitle(kind, summary, details),
      createdAt: now,
      updatedAt: now,
      summary,
      ...(Object.keys(details).length > 0 ? { result: details } : {}),
      ...(error ? { error: this.codeModeArtifactError(error) } : {}),
    };
  }

  private summarizeCodeModeArtifactArgs(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
    const text = typeof args.text === "string" ? args.text : "";
    switch (name) {
      case "send_email": {
        const to = typeof args.to === "string" ? args.to.trim() : "";
        return {
          to,
          toDomain: to.includes("@") ? to.split("@").pop() : undefined,
          subject: typeof args.subject === "string" ? args.subject : undefined,
          hasText: typeof args.text === "string" && args.text.length > 0,
          hasHtml: typeof args.html === "string" && args.html.length > 0,
          attachmentCount,
        };
      }
      case "send_slack_message":
        return {
          channelId: typeof args.channel_id === "string" ? args.channel_id : undefined,
          teamId: typeof args.team_id === "string" ? args.team_id : undefined,
          integrationId: typeof args.integration_id === "string" ? args.integration_id : undefined,
          threadTs: typeof args.thread_ts === "string" ? args.thread_ts : undefined,
          hasText: text.length > 0,
          textPreview: text ? this.truncateArtifactPreviewText(text) : undefined,
          attachmentCount,
        };
      case "send_telegram_message":
        return {
          chatId: typeof args.chat_id === "string" ? args.chat_id : undefined,
          integrationId: typeof args.integration_id === "string" ? args.integration_id : undefined,
          hasText: text.length > 0,
          textPreview: text ? this.truncateArtifactPreviewText(text) : undefined,
          attachmentCount,
        };
      case "send_discord_message":
        return {
          integrationId: typeof args.integration_id === "string" ? args.integration_id : undefined,
          hasText: text.length > 0,
          textPreview: text ? this.truncateArtifactPreviewText(text) : undefined,
          attachmentCount,
        };
      default:
        return { attachmentCount };
    }
  }

  private codeModeArtifactDetails(result: unknown): Record<string, unknown> {
    if (!result || typeof result !== "object" || Array.isArray(result)) return {};
    const details = (result as { details?: unknown }).details;
    return details && typeof details === "object" && !Array.isArray(details)
      ? details as Record<string, unknown>
      : {};
  }

  private codeModeArtifactSubtitle(
    kind: RuntimeCallArtifactKind,
    summary: Record<string, unknown>,
    result: Record<string, unknown>,
  ): string | undefined {
    if (kind === "outbound_email") {
      return typeof summary.to === "string" && summary.to ? summary.to : undefined;
    }
    if (kind === "outbound_slack_message") {
      const channelId = typeof result.channelId === "string" ? result.channelId : summary.channelId;
      return typeof channelId === "string" && channelId ? `Channel ${channelId}` : undefined;
    }
    if (kind === "outbound_discord_message") {
      const threadId = typeof result.threadId === "string" ? result.threadId : undefined;
      return threadId ? `Thread ${threadId}` : undefined;
    }
    const chatId = typeof result.chatId === "string" ? result.chatId : summary.chatId;
    return typeof chatId === "string" && chatId ? `Chat ${chatId}` : undefined;
  }

  private codeModeArtifactError(error: unknown): { name: string; message: string } {
    return error instanceof Error
      ? { name: error.name || "Error", message: error.message || "Unknown error" }
      : { name: "Error", message: String(error || "Unknown error") };
  }

  private truncateArtifactPreviewText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
  }

  private askUserQuestion(args: Record<string, unknown>): Promise<unknown> {
    return this.chatThreadStub.askUserQuestion({
      questions: Array.isArray(args.questions) ? args.questions : [args],
      toolUseId: typeof args.toolUseId === "string" ? args.toolUseId : undefined,
    });
  }

  private runSubagentTool(name: string, args: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
    return (this.chatThreadStub as unknown as {
      runCodeModeSubagent(toolName: "Agent" | "Explore", params: unknown): Promise<AgentToolResult<unknown>>;
    }).runCodeModeSubagent(name as "Agent" | "Explore", args);
  }

  private connectionQuery(args: Record<string, unknown>): string | Record<string, string> {
    return typeof args.query === "string" || (args.query && typeof args.query === "object" && !Array.isArray(args.query))
      ? args.query as string | Record<string, string>
      : "";
  }

  private async updateTodos(args: Record<string, unknown>): Promise<unknown> {
    const todos = normalizeTodoItems(
      Array.isArray(args.todos)
        ? args.todos
        : Array.isArray(args.items)
          ? args.items
          : [],
    );
    await this.chatThreadStub.setTodoState(todos);
    return { success: true, todos };
  }

  private async setPreview(args: Record<string, unknown>): Promise<unknown> {
    const scriptNameArg = typeof args.script_name === "string" ? args.script_name.trim() : "";
    const appNameArg = typeof args.app_name === "string" ? args.app_name.trim() : "";
    if (scriptNameArg && appNameArg && scriptNameArg !== appNameArg) {
      throw new Error("set_preview accepts only one app target; use script_name or app_name, not both");
    }
    const scriptName = scriptNameArg || appNameArg;
    const filePath = typeof args.path === "string" ? args.path.trim() : "";
    const targetKinds = [scriptName ? "app" : "", filePath ? "file" : ""].filter(Boolean);
    if (targetKinds.length === 0) {
      throw new Error("set_preview requires app_name/script_name or path");
    }
    if (targetKinds.length > 1) {
      throw new Error("set_preview accepts exactly one target: app_name/script_name or path");
    }
    if (args.location !== "project" && typeof args.project === "string" && args.project.trim()) {
      throw new Error("project is only valid with location: 'project'");
    }
    if (filePath && typeof args.is_public === "boolean") {
      throw new Error("is_public is only valid for app previews");
    }

    if (scriptName) {
      const script = await this.orgStub.getWorkerScript(scriptName);
      if (!script) throw new Error(`App '${scriptName}' not found`);
      if (script.workspace_id !== this.ctx.props.workspaceId) {
        throw new Error(`App '${scriptName}' belongs to a different workspace`);
      }
      const target: PreviewTarget = {
        kind: "app",
        scriptName,
        isPublic: typeof args.is_public === "boolean"
          ? args.is_public
          : script.is_public,
      };
      await this.chatThreadStub.setPreviewTarget(target);
      return { success: true, target, app: { name: scriptName, url: await this.getAppUrl(script), is_public: target.isPublic } };
    }
    const location = typeof args.location === "string" ? args.location.trim() : "";
    if (location && location !== "workspace" && location !== "project" && location !== "r2") {
      throw new Error('set_preview location must be "workspace", "project", or "r2"');
    }
    let parsedPath = parseFilePreviewPath(filePath);
    let source: Extract<PreviewTarget, { kind: "file" }>["source"];
    if (location === "workspace" || location === "project") {
      parsedPath = parseFilePreviewPath(filePath.startsWith("/") ? filePath : `/${filePath}`);
      if (!parsedPath || parsedPath.source !== "workspace") {
        throw new Error("Invalid preview file path");
      }
      source = location;
    } else if (location === "r2") {
      if (!parsedPath || parsedPath.source === "workspace") {
        throw new Error("R2 preview path must start with uploads/ or outputs/");
      }
      source = parsedPath.source;
    } else {
      if (!parsedPath) {
        throw new Error("Invalid preview file path");
      }
      source = parsedPath.source;
    }
    const target: PreviewTarget = {
      kind: "file",
      source,
      workspaceId: this.ctx.props.workspaceId,
      path: parsedPath.path,
      project:
        source === "project" && typeof args.project === "string"
          ? args.project.trim()
          : undefined,
      filename: parsedPath.filename,
      contentType: typeof args.content_type === "string" ? args.content_type.trim() : undefined,
    };
    if (target.source === "project" && !target.project) {
      throw new Error(`project is required when previewing a project file`);
    }
    await this.assertPreviewFileReadable(target);
    await this.chatThreadStub.setPreviewTarget(target);
    return { success: true, target };
  }

  private async assertPreviewFileReadable(target: Extract<PreviewTarget, { kind: "file" }>): Promise<void> {
    switch (target.source) {
      case "workspace": {
        const exists = await this.workspaceFs.exists(target.path);
        if (!exists.exists) {
          throw new Error(`Preview file not found: ${target.path}`);
        }
        if (exists.isDirectory) {
          throw new Error(`Preview path is a directory, not a file: ${target.path}`);
        }
        return;
      }
      case "project": {
        if (!target.project) {
          throw new Error("project is required when previewing a project file");
        }
        const fileStore = await this.projectFileStore({ project: target.project });
        const exists = await fileStore.exists(target.path);
        if (!exists.exists) {
          throw new Error(`Preview file not found: ${target.path}`);
        }
        if (exists.isDirectory) {
          throw new Error(`Preview path is a directory, not a file: ${target.path}`);
        }
        return;
      }
      case "upload":
      case "output": {
        const { orgId, workspaceId } = this.ctx.props;
        if (!orgId || !workspaceId) {
          throw new Error("Code mode tool binding is missing R2 scope");
        }
        const bucketDir = target.source === "upload" ? "user-uploads" : "user-outputs";
        const relativePath = target.path.replace(/^\/+/, "");
        // Retry briefly so a preview set the moment before the producer
        // finishes writing to R2 validates instead of failing the race.
        const object = await retryR2Read(() =>
          this.env.R2_BUCKET.head(
            buildWorkspaceScopedR2Key(orgId, workspaceId, `${bucketDir}/${relativePath}`),
          ),
        );
        if (!object) {
          const publicPath = `${target.source === "upload" ? "uploads" : "outputs"}/${relativePath}`;
          throw new Error(`Preview file not found: ${publicPath}`);
        }
        return;
      }
    }
  }

  private async listApps(args: Record<string, unknown> = {}): Promise<unknown> {
    const nameFilter = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
    const projectFilter = typeof args.project === "string" ? args.project.trim().toLowerCase() : "";
    const sort = args.sort === "updated_asc" || args.sort === "name_asc" ? args.sort : "updated_desc";
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(0, Math.min(100, Math.floor(args.limit)))
      : undefined;
    let scripts: WorkerScriptListRow[] = [...await this.orgStub.listWorkerScriptsByWorkspace(this.ctx.props.workspaceId)];
    if (nameFilter) {
      scripts = scripts.filter((script) => appFilterText(script).includes(nameFilter));
    }
    if (projectFilter) {
      scripts = scripts.filter((script) =>
        (script.project_id ?? "").toLowerCase().includes(projectFilter) ||
        script.script_name.toLowerCase().includes(projectFilter)
      );
    }
    scripts = scripts.sort((a, b) => {
      if (sort === "updated_asc") return a.updated_at - b.updated_at;
      if (sort === "name_asc") return a.script_name.localeCompare(b.script_name);
      return b.updated_at - a.updated_at;
    });
    const total = scripts.length;
    if (limit !== undefined) scripts = scripts.slice(0, limit);
    return {
      total,
      count: scripts.length,
      filters: {
        ...(nameFilter ? { name: args.name } : {}),
        ...(projectFilter ? { project: args.project } : {}),
        ...(limit !== undefined ? { limit } : {}),
        sort,
      },
      apps: await Promise.all(scripts.map(async (script) => ({
        name: script.script_name,
        url: await this.getAppUrl(script),
        is_public: script.is_public,
        created_by: script.created_by,
        created_at: new Date(script.created_at).toISOString(),
        updated_at: new Date(script.updated_at).toISOString(),
        preview_status: script.preview_status,
        project_id: script.project_id,
        commit_sha: script.commit_sha,
        artifact_cache_key: script.artifact_cache_key,
      }))),
    };
  }

  private async setAppVisibility(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    if (typeof args.is_public !== "boolean") throw new Error("is_public must be a boolean");
    const script = await this.orgStub.getWorkerScript(scriptName);
    if (!script) return { success: false, error: `App '${scriptName}' not found` };
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      return { success: false, error: `App '${scriptName}' belongs to a different workspace` };
    }
    const updated = await this.orgStub.setWorkerScriptPublic(
      scriptName,
      args.is_public,
      this.ctx.props.userId || "system",
    );
    if (!updated) return { success: false, error: `Failed to update app '${scriptName}'` };
    await this.chatThreadStub.setPreviewAppVisibility(scriptName, updated.is_public);
    return {
      success: true,
      app: {
        name: updated.script_name,
        url: await this.getAppUrl(updated),
        is_public: updated.is_public,
        updated_at: new Date(updated.updated_at).toISOString(),
      },
      message: `App '${scriptName}' is now ${updated.is_public ? "public" : "private"}`,
    };
  }

  private async getLatestLogs(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    if (!this.env.WORKER_LOGS) throw new Error("Worker logs are not configured");
    const script = await this.orgStub.getWorkerScript(scriptName);
    if (!script) return { success: false, error: `App '${scriptName}' not found` };
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      return { success: false, error: `App '${scriptName}' belongs to a different workspace` };
    }
    const limit = clampCodeModeInteger(args.limit, 100, 1, 500);
    const since = typeof args.since_ms === "number" && Number.isFinite(args.since_ms)
      ? Math.max(0, Math.floor(args.since_ms))
      : undefined;
    const orgSlug = await this.getOrgSlug();
    const storageKey = orgSlug ? `${scriptName}--${orgSlug}` : scriptName;
    const logsStub = this.env.WORKER_LOGS.get(this.env.WORKER_LOGS.idFromName(storageKey));
    const [logs, stats] = await Promise.all([
      logsStub.getLogs({ limit, since }),
      logsStub.getStats(),
    ]);
    return {
      success: true,
      script: { name: scriptName, storage_key: storageKey, dispatch_name: storageKey },
      count: logs.length,
      limit,
      since_ms: since ?? null,
      stats: {
        total_log_count: stats.logCount,
        last_log_at_ms: stats.lastLogAt,
        last_log_at: stats.lastLogAt ? new Date(stats.lastLogAt).toISOString() : null,
      },
      logs: logs.map((entry) => ({
        id: entry.id,
        timestamp_ms: entry.timestamp,
        timestamp: new Date(entry.timestamp).toISOString(),
        level: entry.level,
        message: entry.message,
        exception: entry.exception,
        script_version: entry.scriptVersion,
      })),
    };
  }

  private async takeScreenshot(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    const screenshotBinding = (this.ctx.exports as unknown as {
      AppScreenshotBinding: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => {
        capture(input: {
          scriptName: string;
          path?: string;
          width?: number;
          height?: number;
          waitMs?: number;
        }): Promise<{ imageDataUrl: string; width: number; height: number }>;
      };
    }).AppScreenshotBinding({
      props: {
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
      },
    });
    const result = await screenshotBinding.capture({
      scriptName,
      path: typeof args.path === "string" ? args.path : undefined,
      width: typeof args.width === "number" ? args.width : undefined,
      height: typeof args.height === "number" ? args.height : undefined,
      waitMs: typeof args.wait_ms === "number" ? args.wait_ms : undefined,
    });
    if (args.include_image_data_url === true) return result;
    return {
      success: true,
      width: result.width,
      height: result.height,
      imageDataUrlBytes: result.imageDataUrl.length,
      message: "Screenshot captured. Re-run with include_image_data_url=true only if the inline base64 image is needed.",
    };
  }

  /**
   * Raw AnalysisService binding. Test seam: fakes replace THIS, so every test
   * still exercises the deadline + error mapping that `analysisService()` adds.
   */
  private analysisServiceBinding(): AnalysisServiceLike {
    return (this.ctx.exports as unknown as {
      AnalysisService: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => AnalysisServiceLike;
    }).AnalysisService({
      props: {
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
      },
    });
  }

  /**
   * AnalysisService with the tool-boundary guarantees attached to every
   * exec-class call:
   *   - a client-side deadline derived from the declared timeout (Fix A), so a
   *     wedged container cannot hold the turn to the 20-minute backstop;
   *   - session-death translation, so an SDK error name never reaches a user
   *     even on a path AnalysisService's own recovery did not throw from.
   * Wrapping here rather than at each call site means a new analysis tool is
   * bounded by construction.
   */
  private analysisService(projectIoOverheadMs?: number): AnalysisServiceLike {
    const service = this.analysisServiceBinding();
    // Project legs move the whole tree in and out around the command; the
    // caller sizes that allowance to the tree when it knows which project.
    const ioMs = projectIoOverheadMs ?? ANALYSIS_PROJECT_IO_OVERHEAD_MS;
    const execLimits: SandboxExecLimits = { ...ANALYSIS_EXEC_LIMITS, overheadMs: ioMs };
    const notebookLimits: SandboxExecLimits = {
      ...ANALYSIS_NOTEBOOK_LIMITS,
      overheadMs: ioMs + ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS,
    };
    const dependencyLimits: SandboxExecLimits = { ...ANALYSIS_DEPENDENCY_LIMITS, overheadMs: ioMs };
    return {
      runCode: (request) => this.runSandboxExecOperation(
        "run_code",
        undefined,
        execLimits,
        () => service.runCode(request),
      ),
      runNotebook: (request) => this.runSandboxExecOperation(
        "run_notebook",
        request.timeoutMs,
        notebookLimits,
        () => service.runNotebook(request),
      ),
      exec: (request) => this.runSandboxExecOperation(
        "analysis_exec",
        request.timeoutMs,
        execLimits,
        () => service.exec(request),
      ),
      addDependency: (request) => this.runSandboxExecOperation(
        "add_python_dependency",
        undefined,
        dependencyLimits,
        () => service.addDependency(request),
      ),
      // Catalog read, not an exec: no container command, no deadline.
      listConnections: () => service.listConnections(),
    };
  }

  /**
   * Measure the project tree so the exec deadline covers the IO it will really
   * do. One extra listing RPC against a path that is about to make one per
   * FILE; a failure here degrades to the base allowance rather than failing the
   * tool.
   */
  private async projectIoOverheadMs(projectId: string | undefined): Promise<number> {
    if (!projectId) return ANALYSIS_PROJECT_IO_OVERHEAD_MS;
    try {
      const listing = await new ProjectFilesystemClient(this.env, projectId).listFiles("/", {
        recursive: true,
        includeHidden: true,
        limit: ANALYSIS_PROJECT_IO_LISTING_LIMIT,
      });
      let fileCount = 0;
      let totalBytes = 0;
      for (const entry of listing.files ?? []) {
        if (entry.type !== "file") continue;
        fileCount += 1;
        if (Number.isFinite(entry.size)) totalBytes += entry.size;
      }
      return analysisProjectIoOverheadMs({ fileCount, totalBytes });
    } catch (error) {
      console.warn("[code-mode] could not size the project IO allowance; using the base value", error);
      return ANALYSIS_PROJECT_IO_OVERHEAD_MS;
    }
  }

  /** One deadline-bounded sandbox call, with the tool-boundary error mapping. */
  private async runSandboxExecOperation<T>(
    operation: string,
    declaredTimeoutMs: number | undefined,
    limits: SandboxExecLimits,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sandboxExecDeadline(operation, declaredTimeoutMs, limits).run(run);
    } catch (error) {
      // The environment died under the command and even AnalysisService's
      // one-shot recovery could not get it back: the user gets the plain-English
      // message, never `SessionTerminatedError: ...`.
      if (isSandboxSessionDeathError(error)) {
        throw new Error(ANALYSIS_SESSION_RESTARTED_MESSAGE, { cause: error });
      }
      throw error;
    }
  }

  private sandboxExecDeadline(
    operation: string,
    declaredTimeoutMs: number | undefined,
    limits: SandboxExecLimits,
  ): SandboxExecDeadline {
    return createSandboxExecDeadline({
      operation,
      declaredTimeoutMs,
      defaultTimeoutMs: limits.defaultTimeoutMs,
      maxTimeoutMs: limits.maxTimeoutMs,
      overheadMs: limits.overheadMs,
      graceMs: SANDBOX_EXEC_DEADLINE_GRACE_MS,
      onExceeded: (event) => this.recordSandboxExecDeadlineEvent(event),
    });
  }

  private recordSandboxExecDeadlineEvent(event: SandboxDeadlineExceededEvent): void {
    const props = this.ctx?.props;
    console.error("[code-mode] sandbox operation exceeded its client deadline", {
      operation: event.operation,
      declaredTimeoutMs: event.declaredTimeoutMs,
      budgetMs: event.budgetMs,
      waitedMs: event.waitedMs,
      workspaceId: props?.workspaceId,
    });
    recordObservabilityEvent(this.env, {
      event: "sandbox_exec_deadline_exceeded",
      severity: "error",
      component: "CodeModeToolsBinding",
      operation: event.operation,
      status: "deadline_exceeded",
      durationMs: event.waitedMs,
      count: event.declaredTimeoutMs ?? null,
      size: event.budgetMs,
      errorName: "SandboxDeadlineExceededError",
      workspaceId: props?.workspaceId,
      threadId: props?.threadId,
      orgId: props?.orgId,
      userId: props?.userId,
    });
  }

  private async analysisRunCode(args: Record<string, unknown>): Promise<unknown> {
    const code = typeof args.code === "string" ? args.code : "";
    if (!code.trim()) throw new Error("code is required");
    // Forward the params dict (the tool advertises it) so AnalysisService can
    // inject it as a Python `params` dict; otherwise params['...'] is a NameError.
    const params =
      args.params && typeof args.params === "object" && !Array.isArray(args.params)
        ? (args.params as Record<string, unknown>)
        : undefined;
    return this.analysisService().runCode({ code, params });
  }

  private async analysisRunNotebook(args: Record<string, unknown>): Promise<unknown> {
    const project = await this.resolveDoBackedProjectForAction(args, "run_notebook");
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path) throw new Error("path is required (the .ipynb to execute)");
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
    const raw = await this.analysisService(await this.projectIoOverheadMs(project.id))
      .runNotebook({ projectId: project.id, path, timeoutMs });
    const { result, fullLog } = clampAnalysisRunOutputs(raw as Record<string, unknown>);
    const fullOutput = fullLog ? await this.storeAnalysisRunLog("run-notebook", fullLog) : undefined;
    if (result.ok !== true) {
      return {
        ...result,
        ...(fullOutput ? { fullOutput } : {}),
        project: project.name,
      };
    }
    const preview = await this.setPreview({
      location: "project",
      project: project.name,
      path,
      content_type: "application/x-ipynb+json",
    });
    const message = `Executed and previewed ${path}`;
    console.log(message);
    return {
      ...result,
      preview,
      message,
      ...(fullOutput ? { fullOutput } : {}),
      project: project.name,
    };
  }

  /**
   * Spill an analysis run's untruncated output to the thread's R2 tmp/ mount —
   * the same escape-hatch namespace the read tool advertises — so clamped
   * stdout/stderr never strands information the agent might need. Best-effort:
   * a storage failure degrades to clamped-only output, never fails the run.
   */
  private async storeAnalysisRunLog(
    label: string,
    text: string,
  ): Promise<{ path: string; hint: string } | undefined> {
    try {
      const filename = `${Date.now()}-${label}-${crypto.randomUUID().slice(0, 8)}.log`;
      const key = `${this.r2MountBaseKey("tmp")}${filename}`;
      await this.env.R2_BUCKET.put(key, text, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
      });
      const path = `tmp/${filename}`;
      return {
        path,
        hint: `stdout/stderr were truncated inline. Full output: read({ location: "r2", path: "${path}" })`,
      };
    } catch (error) {
      console.error("[CodeModeTools] failed to store analysis run log in R2", error);
      return undefined;
    }
  }

  private async analysisExecCommand(args: Record<string, unknown>): Promise<unknown> {
    const command = typeof args.command === "string" ? args.command : "";
    if (!command.trim()) throw new Error("command is required");
    let projectId: string | undefined;
    let projectName: string | undefined;
    if (typeof args.project === "string" && args.project.trim()) {
      const project = await this.resolveDoBackedProjectForAction(args, "analysis_exec");
      projectId = project.id;
      projectName = project.name;
    }
    const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
    const env = args.env && typeof args.env === "object" && !Array.isArray(args.env) ? (args.env as Record<string, string>) : undefined;
    const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
    const result = await this.analysisService(await this.projectIoOverheadMs(projectId))
      .exec({ projectId, command, cwd, env, timeoutMs });
    return { ...(result as Record<string, unknown>), ...(projectName ? { project: projectName } : {}) };
  }

  private archiveUploadTarget(args: Record<string, unknown>): CodeModeR2Path {
    const target = this.resolveCodeModeR2Path({ path: args.path });
    if (target.mount !== "uploads") {
      throw new Error("archive path must start with uploads/");
    }
    return target;
  }

  private archiveCommandResult(
    raw: unknown,
    target: CodeModeR2Path,
    projectName?: string,
  ): Record<string, unknown> {
    const execution = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const stdout = typeof execution.stdout === "string" ? execution.stdout.trim() : "";
    let archive: Record<string, unknown> | null = null;
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          archive = parsed as Record<string, unknown>;
        }
      } catch {
        archive = null;
      }
    }
    if (!archive) {
      const stderr = typeof execution.stderr === "string" ? execution.stderr.trim() : "";
      throw new Error(stderr || "archive helper returned an invalid response");
    }
    return {
      ...archive,
      path: target.path,
      ...(projectName ? { project: projectName } : {}),
      durationMs: execution.durationMs ?? 0,
      changedFiles: execution.changedFiles ?? [],
      removedFiles: execution.removedFiles ?? [],
      skippedOversize: execution.skippedOversize ?? [],
    };
  }

  private async inspectArchive(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.archiveUploadTarget(args);
    const entry = typeof args.entry === "string" ? args.entry.trim() : "";
    const action = entry ? "read" : "list";
    const result = await this.analysisService().exec({
      command: ARCHIVE_TOOL_COMMAND,
      env: {
        CAMELAI_ARCHIVE_ACTION: action,
        CAMELAI_ARCHIVE_PATH: `/uploads/${target.relativePath}`,
        ...(entry ? { CAMELAI_ARCHIVE_ENTRY: entry } : {}),
        ...(!entry ? {
          CAMELAI_ARCHIVE_OFFSET: String(clampCodeModeInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)),
          CAMELAI_ARCHIVE_LIMIT: String(clampCodeModeInteger(args.limit, 200, 1, 500)),
        } : {}),
      },
    });
    return this.archiveCommandResult(result, target);
  }

  private normalizeArchiveDestination(value: unknown): string {
    const raw = typeof value === "string" ? value.trim().replace(/\\/g, "/") : ".";
    if (!raw || raw === ".") return ".";
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
      throw new Error("archive destination must be relative to the project root");
    }
    const parts = raw.replace(/\/+$/, "").split("/");
    if (parts.some((part) => part === "..")) {
      throw new Error("archive destination must not contain '..'");
    }
    const normalized = parts.filter((part) => part && part !== ".").join("/");
    if (normalized.length > 1024) {
      throw new Error("archive destination exceeds 1024 characters");
    }
    return normalized || ".";
  }

  private async extractArchive(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.archiveUploadTarget(args);
    const project = await this.resolveDoBackedProjectForAction(args, "extract_archive");
    const destination = this.normalizeArchiveDestination(args.destination);
    const result = await this.analysisService(await this.projectIoOverheadMs(project.id)).exec({
      projectId: project.id,
      command: ARCHIVE_TOOL_COMMAND,
      env: {
        CAMELAI_ARCHIVE_ACTION: "extract",
        CAMELAI_ARCHIVE_PATH: `/uploads/${target.relativePath}`,
        CAMELAI_ARCHIVE_DESTINATION: destination,
      },
    });
    return this.archiveCommandResult(result, target, project.name);
  }

  private async analysisAddDependency(args: Record<string, unknown>): Promise<unknown> {
    const project = await this.resolveDoBackedProjectForAction(args, "add_python_dependency");
    const packages = Array.isArray(args.packages)
      ? (args.packages as unknown[]).filter((p): p is string => typeof p === "string")
      : typeof args.package === "string"
        ? [args.package]
        : [];
    if (!packages.length) throw new Error("packages is required (one or more PyPI specs)");
    const result = await this.analysisService(await this.projectIoOverheadMs(project.id))
      .addDependency({ projectId: project.id, packages, dev: args.dev === true });
    return { ...(result as Record<string, unknown>), project: project.name };
  }

  private async analysisListConnections(): Promise<unknown> {
    return this.analysisService().listConnections();
  }

  private get scheduledPrompts(): CodeModeScheduledPrompts {
    return new CodeModeScheduledPrompts({
      cronStub: this.cronStub,
      workspaceId: this.ctx.props.workspaceId,
      threadId: this.ctx.props.threadId,
      userId: this.ctx.props.userId,
    });
  }

  private get deterministicAutomations(): CodeModeDeterministicAutomations {
    return new CodeModeDeterministicAutomations({
      cronStub: this.cronStub,
      workspaceId: this.ctx.props.workspaceId,
      userId: this.ctx.props.userId,
    });
  }

  private async listScheduledPrompts(): Promise<unknown> {
    return this.scheduledPrompts.list();
  }

  private async createScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    return this.scheduledPrompts.create(args);
  }

  private async updateScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    return this.scheduledPrompts.update(args);
  }

  private async deleteScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    return this.scheduledPrompts.delete(args);
  }

  private async runScheduledPromptNow(args: Record<string, unknown>): Promise<unknown> {
    return this.scheduledPrompts.runNow(args);
  }

  private async listDeterministicAutomations(): Promise<unknown> {
    return this.deterministicAutomations.list();
  }

  private async validateDeterministicAutomation(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.validate(args);
  }

  private async createDeterministicAutomation(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.create(args);
  }

  private async updateDeterministicAutomation(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.update(args);
  }

  private async deleteDeterministicAutomation(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.delete(args);
  }

  private async runDeterministicAutomationNow(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.runNow(args);
  }

  private async getDeterministicAutomationRuns(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.getRuns(args);
  }

  private get integrations(): CodeModeIntegrations {
    return new CodeModeIntegrations({
      env: this.env,
      orgStub: this.orgStub,
      workspaceId: this.ctx.props.workspaceId,
      userId: this.ctx.props.userId,
      promptConnectionSetup: (input) =>
        (this.chatThreadStub as unknown as {
          promptConnectionSetup(input: {
            integrationId?: string;
            integrationType: string;
            suggestedName?: string;
            message?: string;
            instructions?: string;
            initialConfig?: Record<string, unknown>;
            initialCredentials?: Record<string, unknown>;
            dynamicSchema?: DynamicIntegrationSchema;
          }): Promise<ConnectionSetupResponse>;
        }).promptConnectionSetup(input),
    });
  }

  private async listIntegrations(args: Record<string, unknown>): Promise<unknown> {
    return this.integrations.list(args);
  }

  private listIntegrationTypes(args: Record<string, unknown>): Promise<unknown> {
    return this.integrations.listTypes(args);
  }

  private async createIntegration(args: Record<string, unknown>): Promise<unknown> {
    return this.integrations.create(args);
  }

  private async promptConnectionSetup(args: Record<string, unknown>): Promise<unknown> {
    return this.integrations.promptConnectionSetup(args);
  }

  private async deleteConnection(args: Record<string, unknown>): Promise<unknown> {
    const connection = typeof args.connection === "string" ? args.connection.trim() : "";
    if (!connection) throw new Error("connection is required");

    const entry = await findConnectionMethodEntry(this.env, this.connectionsContext, connection);
    const summary = entry.connection;
    const question =
      `Delete connection "${summary.name}" (${summary.type})? This removes its stored configuration and cannot be undone.`;
    const confirmation = await confirmDestructiveAction(
      (questionArgs) => this.askUserQuestion(questionArgs),
      {
        question,
        header: "Delete connection?",
        confirmLabel: DESTRUCTIVE_CONFIRM_LABEL,
      },
    );
    if (confirmation.unavailableReason) {
      return {
        success: false,
        cancelled: true,
        unavailable_reason: confirmation.unavailableReason,
        message: confirmation.unavailableReason,
      };
    }
    if (!confirmation.confirmed) {
      return {
        success: false,
        cancelled: true,
        message: "Connection deletion cancelled.",
      };
    }

    const actorId = this.ctx.props.userId?.trim() || "system";
    await this.orgStub.deleteWorkspaceIntegration(
      this.ctx.props.workspaceId,
      summary.id,
      actorId,
    );
    return {
      success: true,
      connection: summary.name,
      message: `Deleted connection "${summary.name}"`,
    };
  }

  private async addDependency(args: Record<string, unknown>): Promise<unknown> {
    const gate = this.projectBuildReadinessGate("add_dependency");
    const deadline = this.sandboxExecDeadline("add_dependency", undefined, PROJECT_BUILD_EXEC_LIMITS);
    return gate.annotate(await withProjectBuildServiceErrorMapping("add_dependency", async () => {
      const project = await this.resolveDoBackedProjectForAction(args, "add_dependency");
      const dependency = typeof args.dependency === "string" ? args.dependency : "";
      const sandbox = this.projectBuildSandbox();
      // Cold-boot waiting is charged to the GATE's own 240s budget, not to the
      // install's: a container that has to wake first must not hand the install
      // a truncated (or empty) slice of the exec budget.
      await deadline.excluding(() => gate.ensureReady(sandbox));
      try {
        const result = await deadline.run(() => runProjectAddDependency({
          projectId: project.id,
          dependency,
          dev: args.dev === true,
          files: new ProjectFilesystemClient(this.env, project.id),
          sandbox,
        }));
        return {
          ...result,
          project: project.name,
          backend: "do-r2",
        };
      } finally {
        // Warm window is anchored to the END of the install, not its start.
        await this.noteProjectBuildSessionActivity(sandbox, "add_dependency");
      }
    }, {
      onTransient: () => gate.invalidate(),
      unavailableMessage: () => gate.unavailableMessage(),
      deadline,
    }));
  }

  private async addShadcnComponent(args: Record<string, unknown>): Promise<unknown> {
    const project = await this.resolveDoBackedProjectForAction(args, "add_shadcn_component");
    const { addShadcnComponentsToProject, normalizeShadcnComponentList } =
      await import("./shadcn-components");
    const components = normalizeShadcnComponentList(args);
    const result = await addShadcnComponentsToProject(
      new ProjectFilesystemClient(this.env, project.id),
      components,
      { force: args.force === true },
    );
    return {
      ...result,
      project: project.name,
      backend: "do-r2",
    };
  }

  private browserLaunchInput(args: Record<string, unknown>): {
    scriptName: string;
    path?: string;
    width?: number;
    height?: number;
  } {
    return {
      scriptName: typeof args.scriptName === "string"
        ? args.scriptName
        : typeof args.script_name === "string"
          ? args.script_name
          : "",
      path: typeof args.path === "string" ? args.path : undefined,
      width: typeof args.width === "number" ? args.width : undefined,
      height: typeof args.height === "number" ? args.height : undefined,
    };
  }

  private browserMethodAllowlist(): Set<string> {
    return new Set([
      "goto",
      "click",
      "fill",
      "type",
      "press",
      "select",
      "hover",
      "waitForSelector",
      "waitForText",
      "waitForFunction",
      "waitForTimeout",
      "evaluate",
      "textContent",
      "hasText",
      "getAttribute",
      "count",
      "exists",
      "content",
      "url",
      "title",
      "screenshot",
      "logs",
      "close",
    ]);
  }

  private async browserLaunch(args: Record<string, unknown>): Promise<unknown> {
    const session = await launchAppBrowserSession(this.env, {
      orgId: this.ctx.props.orgId,
      workspaceId: this.ctx.props.workspaceId,
    }, this.browserLaunchInput(args));
    try {
      const sessionId = session.sessionId();
      if (!sessionId) {
        throw new Error("Browser session did not expose a reconnectable sessionId");
      }
      return {
        sessionId,
        scriptName: this.browserLaunchInput(args).scriptName,
      };
    } finally {
      await session.disconnect().catch(() => {});
    }
  }

  private async browserAction(args: Record<string, unknown>): Promise<unknown> {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) throw new Error("sessionId is required");
    const scriptName = typeof args.scriptName === "string"
      ? args.scriptName
      : typeof args.script_name === "string"
        ? args.script_name
        : "";
    const method = typeof args.method === "string" ? args.method.trim() : "";
    if (!this.browserMethodAllowlist().has(method)) {
      throw new Error(`Unsupported browser session method: ${method || "(empty)"}`);
    }
    const session = await connectAppBrowserSession(this.env, {
      orgId: this.ctx.props.orgId,
      workspaceId: this.ctx.props.workspaceId,
    }, { sessionId, scriptName });
    try {
      const callable = (session as unknown as Record<string, (...methodArgs: unknown[]) => Promise<unknown>>)[method];
      if (typeof callable !== "function") {
        throw new Error(`Browser session method is not callable: ${method}`);
      }
      const methodArgs = Array.isArray(args.args) ? args.args : [];
      return await callable.apply(session, methodArgs);
    } finally {
      if (method === "close") {
        await session.close().catch(() => {});
      } else {
        await session.disconnect().catch(() => {});
      }
    }
  }

  private async revertProject(args: Record<string, unknown>): Promise<unknown> {
    const project = await this.resolveDoBackedProjectForAction(args, "revert_project");
    const snapshotId = typeof args.snapshot_id === "string" ? args.snapshot_id.trim() : "";
    if (!snapshotId) throw new Error("snapshot_id is required");
    const files = new ProjectFilesystemClient(this.env, project.id);
    const snapshot = await files.restoreSourceSnapshot(snapshotId);
    const restored = {
      id: snapshot.id,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      createdAt: snapshot.createdAt,
    };
    if (args.deploy === true) {
      const deployArgs: Record<string, unknown> = { project: project.name };
      if (typeof args.script_name === "string" && args.script_name.trim()) deployArgs.script_name = args.script_name.trim();
      const deploy = await this.deployProject(deployArgs);
      return { success: true, project: project.name, backend: "do-r2", restored, deploy };
    }
    return {
      success: true,
      project: project.name,
      backend: "do-r2",
      restored,
      message: "Source restored. The deployed app is unchanged until you call deploy_project (or pass deploy=true).",
    };
  }

  private async listCommits(args: Record<string, unknown>): Promise<unknown> {
    const project = await this.resolveDoBackedProjectForAction(args, "list_commits");
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const snapshots = await new ProjectFilesystemClient(this.env, project.id).listSourceSnapshots(limit);
    return {
      project: project.name,
      backend: "do-r2",
      count: snapshots.length,
      commits: snapshots.map((snapshot) => ({
        snapshot_id: snapshot.id,
        id: snapshot.id,
        sha: snapshot.id,
        created_at: snapshot.createdAt,
        message: snapshot.message ?? null,
        file_count: snapshot.fileCount,
        total_bytes: snapshot.totalBytes,
      })),
    };
  }

  private async deployProject(args: Record<string, unknown>): Promise<unknown> {
    const gate = this.projectBuildReadinessGate("deploy_project");
    // ONE budget for the whole tool call, shared by every ladder attempt: a
    // wedged container must not multiply the wait by the attempt count.
    const deadline = this.sandboxExecDeadline(
      "deploy_project",
      clampProjectBuildTimeoutMs(args.timeoutMs),
      PROJECT_BUILD_EXEC_LIMITS,
    );
    return gate.annotate(await withProjectBuildServiceErrorMapping("deploy_project", async () => {
      const project = await this.resolveDoBackedProjectForAction(args, "deploy_project");
      const notebookProjectFiles = new ProjectFilesystemClient(this.env, project.id);
      const notebookPath = await resolveNotebookDeployPath(
        notebookProjectFiles,
        typeof args.path === "string" && args.path.trim() ? args.path.trim() : null,
      );
      if (notebookPath) {
        if (args.dry_run !== true && args.publish_intent !== "user_requested") {
          throw new Error(
            "Publishing a data-analysis notebook requires publish_intent='user_requested'. " +
            "Creating or previewing an analysis does not authorize deployment; ask the user to publish or use run_notebook for chat preview.",
          );
        }
        return await this.deployNotebookProject(project, notebookProjectFiles, notebookPath, args);
      }
      const sandbox = this.projectBuildSandbox();
      // Cold-boot waiting is charged to the GATE's own 240s budget, not to the
      // build's: a container that has to wake first (or reboot between ladder
      // attempts) must not hand the build a truncated slice of the exec budget.
      await deadline.excluding(() => gate.ensureReady(sandbox));
      const timeoutMs = clampProjectBuildTimeoutMs(args.timeoutMs);
      let build: ProjectBuildResult;
      try {
        build = await deadline.run(() => runProjectBuild({
          projectId: project.id,
          files: new ProjectFilesystemClient(this.env, project.id),
          sandbox,
          timeoutMs,
        }));
      } finally {
        // Warm window is anchored to the END of the build, not its start, so a
        // long build still leaves a full window for the next deploy.
        await this.noteProjectBuildSessionActivity(sandbox, "deploy_project");
      }
      if (!build.success) {
        const summarizedBuild = summarizeProjectBuildResult(build);
        return {
          success: false,
          stage: "build",
          project: project.name,
          errorSummary: summarizeBuildFailure(build),
          ...pickBuildFailureFields(summarizedBuild),
          build: summarizedBuild,
          ...(args.dry_run === true ? { dryRun: true } : {}),
        };
      }
      if (args.dry_run === true) {
        return {
          ...summarizeProjectBuildResult(build),
          ...(build.stdout ? { stdout: buildLogTail(build.stdout) } : {}),
          success: true,
          dryRun: true,
          stage: "build",
          project: project.name,
          backend: "do-r2",
          message: "Build validation passed; nothing was deployed and preview was unchanged.",
        };
      }
      const projectFiles = new ProjectFilesystemClient(this.env, project.id);
      const snapshot = await projectFiles.createSourceSnapshot({ message: `Deploy ${project.name}` });
      const bundle = await collectWorkerBundleFromSandbox(sandbox, build.workdir);
      // Catch a Durable Object binding whose class the entry module doesn't
      // export before the upload, where CF would reject it with an opaque
      // migration error, and name the class so the agent can fix it directly.
      const unexportedDoClasses = findUnexportedDurableObjectClasses(bundle);
      if (unexportedDoClasses.length > 0) {
        const classList = unexportedDoClasses.map((name) => `"${name}"`).join(", ");
        const plural = unexportedDoClasses.length > 1;
        return {
          success: false,
          stage: "validate",
          project: project.name,
          errorSummary:
            `Durable Object ${plural ? "classes" : "class"} ${classList} ${plural ? "are" : "is"} declared in ` +
            `wrangler.jsonc but not exported from the worker entry (${bundle.metadata.main_module}). ` +
            `Add \`export class ${unexportedDoClasses[0]} …\` (or \`export { ${unexportedDoClasses[0]} }\`) ` +
            `to the module set as \`main\`, matching the binding's class_name exactly.`,
          build: summarizeProjectBuildResult(build),
        };
      }
      const orgSlug = await this.getOrgSlug();
      if (!orgSlug) throw new Error("Current org has no slug; cannot deploy project");
      // Script-name precedence: explicit arg > wrangler config name > project
      // name. VM-era deploys were driven by the config name, so honoring it
      // keeps a migrated project's app identity and URL instead of forking a
      // duplicate app under the durable project name.
      const scriptName = normalizeDeployScriptName(
        typeof args.script_name === "string" && args.script_name.trim()
          ? args.script_name
          : bundle.configName || project.name,
      );
      const deploy = await deployWorkerModulesDirect(this.env, {
        scriptName,
        hostname: this.deployHostname(),
        identity: {
          orgId: this.ctx.props.orgId,
          orgSlug,
          workspaceId: this.ctx.props.workspaceId,
          userId: this.ctx.props.userId,
          threadId: this.ctx.props.threadId,
          projectId: project.id,
        },
        metadata: bundle.metadata,
        modules: bundle.modules,
        assets: bundle.assets,
        commitSha: snapshot.id,
      }, {
        onDeploySideEffects: (info) => handleDeploySideEffects(this.env as never, info),
      });
      if (!deploy.success) {
        return {
          success: false,
          stage: "deploy",
          project: project.name,
          scriptName: deploy.scriptName,
          dispatchScriptName: deploy.dispatchScriptName,
          status: deploy.status,
          errorSummary: summarizeDeployFailure(deploy),
          build: summarizeProjectBuildResult(build),
          deploy: summarizeDirectDeployResult(deploy),
        };
      }
      const appUrl = await this.appUrlForScriptName(scriptName);
      const warnings = [...(deploy.warnings ?? []), ...this.localDeployReachabilityWarnings()];
      const preview = await this.setPreview({ app_name: scriptName });
      const message = `Deployed and previewed at ${appUrl}`;
      console.log(message);
      return {
        success: true,
        project: project.name,
        scriptName: deploy.scriptName,
        dispatchScriptName: deploy.dispatchScriptName,
        status: deploy.status,
        url: appUrl,
        appUrl,
        preview,
        message,
        buildSuccess: true,
        sourceSnapshot: {
          id: snapshot.id,
          fileCount: snapshot.fileCount,
          totalBytes: snapshot.totalBytes,
        },
        // Deliberately compact on success: full timings/log detail is noise the
        // model has to carry (and re-render); failures keep the rich shapes.
        build: {
          success: true,
          durationMs: build.durationMs,
          fileCount: build.fileCount,
          sourceBytes: build.sourceBytes,
        },
        deploy: {
          success: true,
          scriptName: deploy.scriptName,
          dispatchScriptName: deploy.dispatchScriptName,
          status: deploy.status,
          ...(deploy.skippedAssets?.length ? { skippedAssets: deploy.skippedAssets } : {}),
        },
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }, {
      onTransient: () => gate.invalidate(),
      unavailableMessage: () => gate.unavailableMessage(),
      deadline,
    }));
  }

  // Publish an executed notebook as a static app: the pre-built renderer SPA
  // (main app ASSETS, /notebook-renderer/) plus the .ipynb, uploaded through the
  // same direct-dispatch deploy + app registration path as built projects.
  private async deployNotebookProject(
    project: WorkspaceProject,
    projectFiles: ProjectFilesystemClient,
    notebookPath: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const rendererAssets = this.env.ASSETS;
    if (!rendererAssets) {
      throw new Error("Notebook publishing is unavailable: the ASSETS binding is not configured on this worker");
    }
    const read = await projectFiles.readFile(notebookPath);
    if (!read.success || typeof read.content !== "string") {
      throw new Error(read.error || `Failed to read notebook ${notebookPath}`);
    }
    const notebookBytes = read.encoding === "base64"
      ? base64ToBytesForMove(read.content)
      : new TextEncoder().encode(read.content);
    const warnings: string[] = [];
    if (!notebookHasCellOutputs(notebookBytes)) {
      warnings.push(
        `${notebookPath} has no cell outputs — run run_notebook before deploying so the published report includes charts and tables.`,
      );
    }
    const filename = notebookPath.split("/").filter(Boolean).pop() || "notebook.ipynb";
    const bundle = await buildNotebookWorkerBundle({ rendererAssets, filename, notebook: notebookBytes });
    if (args.dry_run === true) {
      return {
        success: true,
        dryRun: true,
        stage: "validate",
        mode: "notebook",
        project: project.name,
        notebook: notebookPath,
        message: "Notebook publish validation passed; nothing was deployed and preview was unchanged.",
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    const snapshot = await projectFiles.createSourceSnapshot({ message: `Deploy ${project.name}` });
    const orgSlug = await this.getOrgSlug();
    if (!orgSlug) throw new Error("Current org has no slug; cannot deploy project");
    const scriptName = normalizeDeployScriptName(
      typeof args.script_name === "string" && args.script_name.trim() ? args.script_name : project.name,
    );
    const deploy = await deployWorkerModulesDirect(this.env, {
      scriptName,
      hostname: this.deployHostname(),
      identity: {
        orgId: this.ctx.props.orgId,
        orgSlug,
        workspaceId: this.ctx.props.workspaceId,
        userId: this.ctx.props.userId,
        threadId: this.ctx.props.threadId,
        projectId: project.id,
      },
      metadata: bundle.metadata,
      modules: bundle.modules,
      assets: bundle.assets,
      commitSha: snapshot.id,
    }, {
      onDeploySideEffects: (info) => handleDeploySideEffects(this.env as never, info),
    });
    if (!deploy.success) {
      return {
        success: false,
        stage: "deploy",
        mode: "notebook",
        project: project.name,
        notebook: notebookPath,
        scriptName: deploy.scriptName,
        dispatchScriptName: deploy.dispatchScriptName,
        status: deploy.status,
        errorSummary: summarizeDeployFailure(deploy),
        deploy: summarizeDirectDeployResult(deploy),
      };
    }
    const appUrl = await this.appUrlForScriptName(scriptName);
    const allWarnings = [...warnings, ...(deploy.warnings ?? []), ...this.localDeployReachabilityWarnings()];
    const preview = await this.setPreview({ app_name: scriptName });
    const message = `Deployed and previewed at ${appUrl}`;
    console.log(message);
    return {
      success: true,
      mode: "notebook",
      project: project.name,
      notebook: notebookPath,
      scriptName: deploy.scriptName,
      dispatchScriptName: deploy.dispatchScriptName,
      status: deploy.status,
      url: appUrl,
      appUrl,
      preview,
      message,
      sourceSnapshot: {
        id: snapshot.id,
        fileCount: snapshot.fileCount,
        totalBytes: snapshot.totalBytes,
      },
      deploy: summarizeDirectDeployResult(deploy),
      ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    };
  }

  private localDeployReachabilityWarnings(): string[] {
    const workerBaseUrl = (this.env as { WORKER_BASE_URL?: string }).WORKER_BASE_URL;
    if (!workerBaseUrl) return [];
    let hostname = "";
    try {
      hostname = new URL(workerBaseUrl).hostname.toLowerCase();
    } catch {
      return [];
    }
    const isLocalMainWorker = hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";
    if (!isLocalMainWorker) return [];
    if (this.isRemoteDispatcherHostConfigured()) return [];
    return [
      "App deployed successfully. If the app URL is unreachable in local dev with `chiridion-dispatcher-local` not found, start the local dispatcher worker (`wrangler dev -c workers/dispatcher/wrangler.jsonc --env local`) and retry the URL.",
    ];
  }

  private isRemoteDispatcherHostConfigured(): boolean {
    const dispatchNamespace = this.env.CF_DISPATCH_NAMESPACE?.trim();
    if (!dispatchNamespace || !dispatchNamespace.startsWith("chiridion-platform") || dispatchNamespace === "chiridion-platform-local") return false;
    const domains = [this.env.LOCAL_APP_VANITY_DOMAIN, this.env.LOCAL_APP_IFRAME_DOMAIN]
      .map((value) => typeof value === "string" ? value.trim().toLowerCase() : "")
      .filter(Boolean);
    return domains.some((domain) =>
      domain === "camelai.app" ||
      domain.endsWith(".camelai.app") ||
      domain === "apps.camelai.dev" ||
      domain.endsWith(".camelai.dev"),
    );
  }

  private async rollbackDeploy(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    const script = await this.orgStub.getWorkerScript(scriptName);
    if (!script) throw new Error(`App '${scriptName}' not found`);
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      throw new Error(`App '${scriptName}' belongs to a different workspace`);
    }
    const artifactCacheKey = typeof args.artifact_cache_key === "string" && args.artifact_cache_key.trim()
      ? args.artifact_cache_key.trim()
      : script.artifact_cache_key;
    if (!artifactCacheKey) {
      throw new Error(`App '${scriptName}' does not have a cached deploy artifact`);
    }
    const deploy = await rollbackWorkerDeployFromArtifactCache(this.env, {
      artifactCacheKey,
      hostname: this.deployHostname(),
      expected: {
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
        scriptName,
      },
      threadId: this.ctx.props.threadId,
    }, {
      onDeploySideEffects: (info) => handleDeploySideEffects(this.env as never, info),
    });
    if (!deploy.success) {
      return { success: false, app: scriptName, deploy };
    }
    return {
      success: true,
      app: scriptName,
      artifactCacheKey,
      deploy: {
        scriptName: deploy.scriptName,
        dispatchScriptName: deploy.dispatchScriptName,
        status: deploy.status,
        result: deploy.result,
      },
      appUrl: await this.appUrlForScriptName(scriptName),
    };
  }

  private async listDeployVersions(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    const script = await this.orgStub.getWorkerScript(scriptName);
    if (!script) throw new Error(`App '${scriptName}' not found`);
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      throw new Error(`App '${scriptName}' belongs to a different workspace`);
    }
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const versions = await this.orgStub.listWorkerScriptDeployVersions(scriptName, this.ctx.props.workspaceId, limit);
    return {
      app: scriptName,
      count: versions.length,
      versions: versions.map((version) => ({
        id: version.id,
        created_at: new Date(version.created_at).toISOString(),
        created_by: version.created_by,
        project_id: version.project_id,
        commit_sha: version.commit_sha,
        artifact_cache_key: version.artifact_cache_key,
        config_path: version.config_path,
      })),
    };
  }

  private deployHostname(): string {
    try {
      return new URL(this.env.WORKER_BASE_URL || "https://camelai.dev").hostname;
    } catch {
      return "camelai.dev";
    }
  }

  private async appUrlForScriptName(scriptName: string): Promise<string> {
    const script = await this.orgStub.getWorkerScript(scriptName);
    return script ? this.getAppUrl(script) : this.getAppUrl({ script_name: scriptName, custom_domain_hostname: null } as WorkerScript);
  }

  private async deleteAppDeployment(script: WorkerScript): Promise<void> {
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      throw new Error(`App '${script.script_name}' belongs to a different workspace`);
    }
    const orgSlug = await this.getOrgSlug();
    if (!orgSlug) {
      throw new Error(`Organization slug is required to delete app '${script.script_name}'`);
    }

    await deleteDeployedAppRuntime(this.env, {
      scriptName: script.script_name,
      orgSlug,
    });
    const deleted = await this.orgStub.deleteWorkerScript(
      script.script_name,
      this.ctx.props.userId || "system",
    );
    if (!deleted) {
      throw new Error(`Failed to delete app metadata for '${script.script_name}'`);
    }
    await this.env.APP_KV.delete(
      `script:${getDispatchScriptName(script.script_name, orgSlug)}`,
    );
  }

  private async deleteApp(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    const script = await this.orgStub.getWorkerScript(scriptName);
    if (!script) throw new Error(`App '${scriptName}' not found`);
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      throw new Error(`App '${scriptName}' belongs to a different workspace`);
    }

    const question =
      `Delete deployed app "${script.script_name}"? This permanently removes its live deployment and URL. Its source project will be kept.`;
    const confirmation = await confirmDestructiveAction(
      (questionArgs) => this.askUserQuestion(questionArgs),
      {
        question,
        header: "Delete app?",
        confirmLabel: DESTRUCTIVE_CONFIRM_LABEL,
      },
    );
    if (confirmation.unavailableReason) {
      return {
        success: false,
        cancelled: true,
        unavailable_reason: confirmation.unavailableReason,
        message: confirmation.unavailableReason,
      };
    }
    if (!confirmation.confirmed) {
      return {
        success: false,
        cancelled: true,
        message: "App deletion cancelled.",
      };
    }

    await this.deleteAppDeployment(script);
    return {
      success: true,
      deleted: script.script_name,
      message: `Deleted deployed app "${script.script_name}"`,
    };
  }

  private async deleteProject(args: Record<string, unknown>): Promise<unknown> {
    const projectName = typeof args.project === "string" ? args.project.trim() : "";
    if (!projectName) throw new Error("project is required");

    const projects = await this.workspaceFs.listProjectsForMigrationReset();
    const nameKey = projectNameKey(projectName);
    const target = projects.find((project) => projectNameKey(project.name) === nameKey);
    if (!target) {
      throw new Error(`Project not found: ${projectName}`);
    }

    const confirmedTargets = collectProjectDeletionTargets(projects, target);
    const confirmedTargetIds = new Set(confirmedTargets.map((project) => project.id));
    const linkedApps = (
      await this.orgStub.listWorkerScriptsByWorkspace(this.ctx.props.workspaceId)
    ).filter(
      (script) =>
        typeof script.project_id === "string" &&
        confirmedTargetIds.has(script.project_id),
    );
    const cloneNames = confirmedTargets
      .filter((project) => project.id !== target.id)
      .map((project) => project.name);
    const projectScope = cloneNames.length > 0
      ? `project "${target.name}" and its ${cloneNames.length} clone project(s) (${cloneNames.join(", ")})`
      : `project "${target.name}"`;
    const appScope = linkedApps.length > 0
      ? ` It will also permanently delete ${linkedApps.length} linked deployed app(s) and their live URLs: ${linkedApps.map((script) => script.script_name).join(", ")}.`
      : "";
    const question =
      `Delete ${projectScope}? This removes the project files and metadata.${appScope} This cannot be undone.`;
    const confirmation = await confirmDestructiveAction(
      (questionArgs) => this.askUserQuestion(questionArgs),
      {
        question,
        header: "Delete project?",
        confirmLabel: DESTRUCTIVE_CONFIRM_LABEL,
      },
    );
    if (confirmation.unavailableReason) {
      return {
        success: false,
        cancelled: true,
        unavailable_reason: confirmation.unavailableReason,
        message: confirmation.unavailableReason,
      };
    }
    if (!confirmation.confirmed) {
      return {
        success: false,
        cancelled: true,
        message: "Project deletion cancelled.",
      };
    }

    const deletedNames: string[] = [];

    // Live deployments are part of the project lifecycle. Remove them first;
    // if any deployment deletion fails, retain all project source so the user
    // can retry without creating an uneditable orphan app.
    for (const script of linkedApps) {
      await this.deleteAppDeployment(script);
    }

    let deletedFileEntries = 0;
    let deletedSourceSnapshots = 0;
    let deletedSourceSnapshotBlobs = 0;
    for (const project of confirmedTargets) {
      const cleanup = await this.deleteDoBackedProjectFiles(project);
      deletedFileEntries += cleanup.fileEntries;
      deletedSourceSnapshots += cleanup.sourceSnapshots;
      deletedSourceSnapshotBlobs += cleanup.sourceSnapshotBlobs;
    }
    const cleanup = confirmedTargets.length > 0
      ? await this.workspaceFs.removeProjects(confirmedTargets.map((project) => project.id))
      : { deleted: [] };
    deletedNames.push(...cleanup.deleted.map((project) => project.name));

    return {
      success: true,
      deleted: deletedNames,
      deleted_file_entries: deletedFileEntries,
      deleted_source_snapshots: deletedSourceSnapshots,
      deleted_source_snapshot_blobs: deletedSourceSnapshotBlobs,
      deleted_apps: linkedApps.map((script) => script.script_name),
      message:
        deletedNames.length === 1
          ? `Deleted project "${deletedNames[0]}"`
          : `Deleted ${deletedNames.length} projects: ${deletedNames.join(", ")}`,
    };
  }

  private async deleteDoBackedProjectFiles(project: WorkspaceProject): Promise<{ fileEntries: number; sourceSnapshots: number; sourceSnapshotBlobs: number }> {
    const files = new ProjectFilesystemClient(this.env, project.id);
    const listing = await files.listFiles("/", { recursive: true, includeHidden: true, limit: 50_000 });
    if (!listing.success) {
      const notFound = typeof listing.error === "string" && /not found/i.test(listing.error);
      if (notFound) return { fileEntries: 0, sourceSnapshots: 0, sourceSnapshotBlobs: 0 };
      throw new Error(listing.error || `Failed to list project files for ${project.name}`);
    }
    let deleted = 0;
    for (const entry of listing.files) {
      const result = await files.deleteFile(entry.absolutePath, { recursive: true, force: true });
      if (!result.success) {
        throw new Error(result.error || `Failed to delete project file ${entry.absolutePath}`);
      }
      deleted += 1;
    }
    const snapshots = await files.deleteSourceSnapshots();
    return {
      fileEntries: deleted,
      sourceSnapshots: snapshots.snapshotsDeleted,
      sourceSnapshotBlobs: snapshots.blobsDeleted,
    };
  }

  private chatContextFromProps(): ChatContextState {
    return {
      orgId: this.ctx.props.orgId,
      workspaceId: this.ctx.props.workspaceId,
      threadId: this.ctx.props.threadId || "",
      userId: this.ctx.props.userId ?? null,
      userName: null,
      userEmail: null,
    };
  }

  private get channelTools(): ChannelTools {
    return new ChannelTools(this.env);
  }

  private async sendEmail(args: Record<string, unknown>): Promise<unknown> {
    return this.channelTools.sendChannelEmailTool(this.chatContextFromProps(), args);
  }

  private async sendSlackMessage(args: Record<string, unknown>): Promise<unknown> {
    return this.channelTools.sendChannelSlackMessageTool(this.chatContextFromProps(), args);
  }

  private async sendTelegramMessage(args: Record<string, unknown>): Promise<unknown> {
    return this.channelTools.sendChannelTelegramMessageTool(this.chatContextFromProps(), args);
  }

  private async sendDiscordMessage(args: Record<string, unknown>): Promise<unknown> {
    this.discordSendInvocationCount += 1;
    const parentToolUseId = this.ctx.props.parentToolUseId?.trim();
    const operationId = parentToolUseId
      ? `discord-tool:${parentToolUseId}:${this.discordSendInvocationCount}`
      : `discord-tool-fallback:${crypto.randomUUID()}`;
    return this.channelTools.sendChannelDiscordMessageTool(
      this.chatContextFromProps(),
      args,
      { operationId },
    );
  }

  private get customDomains(): CodeModeCustomDomains {
    return new CodeModeCustomDomains({
      env: this.env,
      orgStub: this.orgStub,
      workspaceId: this.ctx.props.workspaceId,
      userId: this.ctx.props.userId,
    });
  }

  private async getCustomDomain(): Promise<unknown> {
    return this.customDomains.get();
  }

  private async setCustomDomain(args: Record<string, unknown>): Promise<unknown> {
    return this.customDomains.set(args);
  }

  private async removeCustomDomain(args: Record<string, unknown>): Promise<unknown> {
    return this.customDomains.remove(args);
  }

  private async retryCustomDomainHostnames(): Promise<unknown> {
    return this.customDomains.retryHostnames();
  }

  private async webSearchClient(
    onProviderFailure?: (result: unknown) => Promise<void>,
  ) {
    // Web search pulls HTML parsing/readability dependencies into its module
    // graph. Most coding turns never use it, so pay that heap cost on demand.
    const { CodeModeWebSearch } = await import("./code-mode-web-search");
    return new CodeModeWebSearch(
      this.env,
      this.ctx.props.threadId || this.ctx.props.workspaceId,
      { onProviderFailure },
    );
  }

  private async consumeHostedCapability(
    capability: HostedCapability,
    args: Record<string, unknown>,
  ): Promise<string> {
    const explicitKey = typeof args.toolUseId === "string"
      ? args.toolUseId.trim()
      : "";
    const idempotencyKey = explicitKey || crypto.randomUUID();
    const invocationScope = this.ctx.props.threadId || this.ctx.props.workspaceId;
    const scopedIdempotencyKey = `${invocationScope}:${idempotencyKey}`;
    const allowance = await this.orgStub.consumeCapabilityAllowance({
      capability,
      user_id: this.ctx.props.userId,
      idempotency_key: scopedIdempotencyKey,
    });
    if (!allowance.allowed) {
      throw new Error(
        `Daily ${capability.replaceAll("_", " ")} allowance reached. ` +
        `This allowance resets at ${new Date(allowance.reset_at_ms).toISOString()}.`,
      );
    }
    return scopedIdempotencyKey;
  }

  private async recordHostedCapabilityCost(
    capability: HostedCapability,
    idempotencyKey: string,
    result: unknown,
  ): Promise<void> {
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const record = result as Record<string, unknown>;
    const costUsd = Number(record.costUSD ?? 0);
    const provider = typeof record.provider === "string"
      ? record.provider
      : "unknown";
    const durationMs = Number(record.durationMs ?? 0);
    await this.orgStub.recordUsage({
      workspace_id: this.ctx.props.workspaceId,
      user_id: this.ctx.props.userId ?? "",
      thread_id: this.ctx.props.threadId ?? "",
      model: capability,
      provider,
      billing_source: "hosted_capability",
      credit_chargeable: false,
      usage_kind: "capability",
      usage_surface: "capability",
      cost_usd: Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0,
      duration_ms: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined,
      created_at_ms: Date.now(),
      source: capability,
      source_id: `${capability}:${idempotencyKey}`,
    });
  }

  private async webFetch(args: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = await this.consumeHostedCapability("web_fetch", args);
    let failedAttempt = 0;
    const client = await this.webSearchClient(async (failure) => {
      failedAttempt += 1;
      await this.recordHostedCapabilityCost(
        "web_fetch",
        `${idempotencyKey}:failed-attempt:${failedAttempt}`,
        failure,
      );
    });
    const result = await client.fetch(args);
    await this.recordHostedCapabilityCost("web_fetch", idempotencyKey, result);
    return result;
  }

  private async webSearch(args: Record<string, unknown>): Promise<unknown> {
    const idempotencyKey = await this.consumeHostedCapability("web_search", args);
    const client = await this.webSearchClient();
    const result = await client.search(args);
    await this.recordHostedCapabilityCost("web_search", idempotencyKey, result);
    return result;
  }
}
