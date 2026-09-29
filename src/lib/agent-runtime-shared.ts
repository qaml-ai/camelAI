/**
 * Pure helpers for threads on the hosted agent runtime, shared by the Worker
 * (routes, ChatThreadDO's runtime session) and the browser (the direct
 * runtime-thread view, plans/runtime-threads-direct.md): chiridion's tool
 * names on the runtime, provider error text, and how a runtime human input is
 * asked in the chat's question card.
 */

/**
 * A request id the runtime accepts (its `requestId`, our client message id):
 * letters, digits, `_` and `-`, at most 80.
 */
export const RUNTIME_REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Whether new web threads run directly on the runtime in this deployment: its
 * runtime tenant (operator token, tenant id, agent definition) is set and
 * AGENT_RUNTIME_DIRECT_THREADS is on.
 */
export function runtimeDirectThreadsEnabled(env: {
  AGENT_RUNTIME_API_TOKEN?: string;
  AGENT_RUNTIME_TENANT?: string;
  AGENT_RUNTIME_DEFINITION?: string;
  AGENT_RUNTIME_DIRECT_THREADS?: string;
}): boolean {
  return Boolean(
    env.AGENT_RUNTIME_API_TOKEN?.trim() &&
      env.AGENT_RUNTIME_TENANT?.trim() &&
      env.AGENT_RUNTIME_DEFINITION?.trim() &&
      env.AGENT_RUNTIME_DIRECT_THREADS?.trim() === "1",
  );
}

/** The agent reads a browser token allows, which chiridion's read proxy passes through. */
export const RUNTIME_BROWSER_READS: ReadonlySet<string> = new Set(["events", "history", "state", "inputs"]);

/**
 * Where the browser reads a runtime thread's agent when the runtime is
 * private (self-host): through chiridion, at this base on its own origin
 * (routes/api/threads.$id.runtime.ts), which the watcher appends
 * `/v1/agents/:id/<read>` to. The workspace is a path segment because the
 * watcher adds its own query string. A runtime says it is private by minting
 * browser tokens that name no URL (its AGENT_BROWSER_URL is empty); the
 * hosted runtime names its own, and browsers read it directly.
 */
export function runtimeReadProxyBase(threadId: string, workspaceId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/runtime/${encodeURIComponent(workspaceId)}`;
}

/** The request id of a new thread's first message, sent by the new-chat action. */
export function initialRuntimeRequestId(threadId: string): string {
  return `initial_${threadId}`;
}

/**
 * A recorded refusal of a runtime thread's message still describes the thread
 * when nothing reached the agent after it: its newest history is older.
 */
export function startErrorStillCurrent(
  error: { id: string; error: string; at: number } | null,
  entries: ReadonlyArray<{ message: unknown }>,
): { id: string; error: string } | null {
  if (!error) return null;
  const newest = Math.max(0, ...entries.map(({ message }) => {
    const at = (message as { timestamp?: unknown } | null)?.timestamp;
    return typeof at === "number" && Number.isFinite(at) ? at : 0;
  }));
  return newest > error.at ? null : { id: error.id, error: error.error };
}

/**
 * Cross-site request forgery on the runtime-thread routes, which act with the
 * session cookie while user apps are same-site (*.apps.<host>): a write must
 * be a JSON request (a form cannot send one, another origin cannot without
 * CORS) and, where the browser says, from this origin. Throws a JSON Response.
 */
export function requireSameOriginJson(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      throw Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
  }
}

/** Where a runtime thread's scratch space is mounted in its agent (its default workspace volume). */
export const SCRATCH_MOUNT = "/workspace";

/**
 * A path the agent sees under its scratch mount (`/workspace/out/chart.png`),
 * as a path inside the volume (`/out/chart.png`); null for anything else.
 */
export function scratchVolumePath(path: string): string | null {
  if (!path.startsWith(`${SCRATCH_MOUNT}/`) || [...path].some((char) => char.charCodeAt(0) < 0x20)) return null;
  const inner = path.slice(SCRATCH_MOUNT.length);
  if (inner.split("/").some((segment) => segment === ".." || segment === ".")) return null;
  return inner.length > 1 ? inner : null;
}

/** The MCP server name chiridion's tools are served under in the runtime definition. */
export const RUNTIME_TOOL_SERVER = "camel";
export const RUNTIME_TOOL_PREFIX = `${RUNTIME_TOOL_SERVER}__`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `camel__deploy_project` → `deploy_project`, so the UI renders chiridion's tools as it always has. */
export function localToolName(name: unknown): unknown {
  return typeof name === "string" && name.startsWith(RUNTIME_TOOL_PREFIX) ? name.slice(RUNTIME_TOOL_PREFIX.length) : name;
}

/**
 * A provider error as the runtime's client reports it (`openrouter API error
 * (429): {"error":{"message":…}}`, `Unknown: 429: {…}`), reduced to its
 * message, which chiridion's forwarder wrote for the user.
 */
export function readableProviderError(text: string): string {
  const match = /\(?(\d{3})\)?:\s*(\{[\s\S]*\})\s*$/.exec(text);
  if (!match) return text;
  try {
    const body = JSON.parse(match[2]) as { message?: unknown; error?: unknown };
    const error = isRecord(body.error) ? body.error : body;
    const message = typeof error.message === "string" ? error.message : typeof body.error === "string" ? body.error : null;
    return message?.trim() ? message.trim() : text;
  } catch {
    return text;
  }
}

/** A person's input a suspended run waits on (the runtime's human input). */
export interface RuntimeInput {
  id: string;
  kind: "question" | "approval" | "form" | "url";
  message: string;
  /** What it asks, by kind (the runtime's InputDetail); read defensively, as it arrives as JSON. */
  detail: unknown;
  expiresAt?: number;
}

export interface RuntimeInputAnswer {
  action: "accept" | "decline" | "cancel";
  content?: unknown;
}

/** A question card for the chat UI (AskUserQuestion's shape), and how its answers become the input's. */
export interface RuntimeInputCard {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
    allowOther: boolean;
  }>;
  answer(answers: Record<string, unknown>): RuntimeInputAnswer;
}

const YES = "Yes";
const NO = "No";

/**
 * How the chat asks an input: `ask_user` questions as they are; approvals and
 * confirmations (an empty form) as Yes/No; a URL step as Done/Cancel with the
 * link. Forms with fields are not asked in chat (null: the input is cancelled).
 */
export function runtimeInputQuestions(input: RuntimeInput): RuntimeInputCard | null {
  const detail = isRecord(input.detail) ? input.detail : {};
  if (input.kind === "question" && Array.isArray(detail.questions)) {
    const questions = (detail.questions as Array<Record<string, unknown>>).map((question) => ({
      question: String(question.question ?? ""),
      header: String(question.header ?? ""),
      options: (Array.isArray(question.options) ? question.options as Array<Record<string, unknown>> : [])
        .map((option) => ({ label: String(option.label ?? ""), description: String(option.description ?? "") })),
      multiSelect: question.multiSelect === true,
      allowOther: question.allowOther === true,
    }));
    return {
      questions,
      answer: (answers) => ({
        action: "accept",
        content: {
          answers: Object.fromEntries(questions.map((question) => {
            const given = String(answers[question.question] ?? "");
            // The chat joins several choices with ", ".
            const labels = question.options.map((option) => option.label);
            const picked = question.multiSelect ? given.split(", ").filter((label) => labels.includes(label)) : [];
            return [question.question, question.multiSelect ? (picked.length > 0 ? picked : [given]) : given];
          })),
        },
      }),
    };
  }
  const yesNo = (question: string, header: string, yes: string, no: string, onYes: RuntimeInputAnswer, onNo: RuntimeInputAnswer): RuntimeInputCard => ({
    questions: [{
      question,
      header,
      options: [{ label: yes, description: "" }, { label: no, description: "" }],
      multiSelect: false,
      allowOther: false,
    }],
    answer: (answers) => (answers[question] === yes ? onYes : onNo),
  });
  if (input.kind === "approval") {
    const tool = typeof detail.tool === "string" ? localToolName(detail.tool) : "this tool";
    return yesNo(input.message || `Allow ${String(tool)} to run?`, "Approve?", YES, NO, { action: "accept" }, { action: "decline" });
  }
  if (input.kind === "url" && typeof detail.url === "string") {
    return yesNo(`${input.message}\n\n${detail.url}`, "Action needed", "Done", "Cancel", { action: "accept" }, { action: "cancel" });
  }
  const schema = isRecord(detail.requestedSchema) ? detail.requestedSchema : {};
  const fields = isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  if (input.kind === "form" && fields.length === 0) {
    // A tool's confirmation (ctx.confirm): a form with nothing to fill in.
    return yesNo(input.message, "Confirm", YES, NO, { action: "accept", content: {} }, { action: "decline" });
  }
  return null;
}
