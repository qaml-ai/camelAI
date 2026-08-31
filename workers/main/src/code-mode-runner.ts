import { transform as sucraseTransform } from "sucrase";

// js_exec user code runs inside an async function body, so wrap it the same way
// before handing it to sucrase: that makes top-level `return`/`await` parse. The
// wrapper contains no TypeScript, so it survives the transform byte-for-byte and
// can be sliced back off. Executor-style: models may write idiomatic TypeScript
// and the type syntax is stripped before execution. Anything sucrase cannot
// parse falls back to the original code so plain-JS behavior never regresses.
const TS_STRIP_PREFIX = "async function __camelTypeStrip__() {\n";
const TS_STRIP_SUFFIX = "\n}";

export function stripTypeScriptFromUserCode(userCode: string): string {
  if (!userCode.trim()) return userCode;
  try {
    const wrapped = `${TS_STRIP_PREFIX}${userCode}${TS_STRIP_SUFFIX}`;
    const stripped = sucraseTransform(wrapped, { transforms: ["typescript"] }).code;
    if (!stripped.startsWith(TS_STRIP_PREFIX) || !stripped.endsWith(TS_STRIP_SUFFIX)) {
      return userCode;
    }
    return stripped.slice(TS_STRIP_PREFIX.length, stripped.length - TS_STRIP_SUFFIX.length);
  } catch {
    return userCode;
  }
}

export function prepareCodeModeUserCode(userCode: string): string {
  if (!userCode.trim() || /\breturn\b/.test(userCode)) return userCode;

  const trailingWhitespace = userCode.match(/\s*$/)?.[0] ?? "";
  const body = userCode.slice(0, userCode.length - trailingWhitespace.length);
  const lines = body.split("\n");
  const lastCodeLineIndex = lines.findLastIndex((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("//");
  });
  if (lastCodeLineIndex < 0) return userCode;

  const lastLine = lines[lastCodeLineIndex];
  const expression = lastLine.trim().replace(/;$/, "").trim();
  if (
    !expression ||
    expression.endsWith("}") ||
    /^(?:break|case|catch|class|const|continue|debugger|default|do|else|export|finally|for|function|if|import|let|return|switch|throw|try|var|while|with)\b/.test(expression)
  ) {
    return userCode;
  }

  const indent = lastLine.match(/^\s*/)?.[0] ?? "";
  lines[lastCodeLineIndex] = `${indent}return ${expression};`;
  return `${lines.join("\n")}${trailingWhitespace}`;
}

export function codeModeWorkerModule(userCode: string): string {
  const executableUserCode = prepareCodeModeUserCode(stripTypeScriptFromUserCode(userCode));
  const workerPrefixTemplate = String.raw`
import { WorkerEntrypoint } from "cloudflare:workers";

const USER_CODE_START_LINE = __USER_CODE_START_LINE__;
const USER_CODE_END_LINE = __USER_CODE_END_LINE__;
const store = new Map();

function stringifyOutput(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function stringifyConsoleArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  return stringifyOutput(value);
}

function formatRuntimeError(error) {
  const message = error && typeof error.message === "string" && error.message
    ? error.message
    : String(error);
  const stack = error && typeof error.stack === "string" && error.stack
    ? error.stack
    : "";
  const location = userCodeLocationFromStack(stack);
  const hints = [];
  if (message.includes('"[object Object]" is not valid JSON')) {
    hints.push(
      "JSON.parse received an object. js_exec tools return { ok, data }; for tools.read text, check result.ok and parse result.data.text.",
    );
  }
  const formatted = message + (location ? " at js_exec code line " + location.line + ", column " + location.column : "");
  return formatted + (hints.length ? "\n\nHint: " + hints.join(" ") : "");
}

function userCodeLocationFromStack(stack) {
  if (!stack) return null;
  for (const line of stack.split("\n")) {
    const match = line.match(/(?:^|[\s(])[^\s()]*index\.js:(\d+):(\d+)/);
    if (!match) continue;
    const generatedLine = Number(match[1]);
    if (!Number.isFinite(generatedLine) || generatedLine < USER_CODE_START_LINE || generatedLine > USER_CODE_END_LINE) {
      continue;
    }
    const column = Number(match[2]);
    return {
      line: generatedLine - USER_CODE_START_LINE + 1,
      column: Number.isFinite(column) ? column : 1,
    };
  }
  return null;
}

function createOutputConsole(output) {
  const originalConsole = globalThis.console || {};
  const capture = (...args) => {
    output.push(args.map(stringifyConsoleArg).join(" "));
  };
  return Object.freeze({
    ...originalConsole,
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
  });
}

function hardenTimingSurface() {
  globalThis.performance = undefined;
  globalThis.SharedArrayBuffer = undefined;
  globalThis.Atomics = undefined;

  const NativeDate = Date;
  const coarseNow = () => Math.floor(NativeDate.now() / 1000) * 1000;
  function CoarseDate(...args) {
    if (new.target) {
      return args.length === 0 ? new NativeDate(coarseNow()) : new NativeDate(...args);
    }
    return new NativeDate(coarseNow()).toString();
  }
  Object.setPrototypeOf(CoarseDate, NativeDate);
  CoarseDate.prototype = NativeDate.prototype;
  Object.defineProperty(CoarseDate, "now", { value: coarseNow });
  Object.defineProperty(CoarseDate, "parse", { value: NativeDate.parse });
  Object.defineProperty(CoarseDate, "UTC", { value: NativeDate.UTC });
  globalThis.Date = CoarseDate;
}

const TOOL_CATEGORY_DESCRIPTIONS = Object.freeze({
  workspace: "Read, edit, search, and run commands in the workspace.",
  user_interaction: "Ask the user questions or update visible chat state.",
  communication: "Send external channel messages. These are side-effecting delivery actions.",
  apps: "Inspect deployed apps, previews, logs, and screenshots.",
  schedules: "Manage scheduled prompts.",
  workflows: "Manage deterministic JavaScript workflows.",
  integrations: "List, create, and set up workspace integrations.",
  domains: "Manage custom domains for apps.",
  web: "Search or fetch public web content.",
  agents: "Run focused subagents.",
  connections: "Inspect and call workspace connections through env.CONNECTIONS.",
  runtime: "Helpers that exist only inside js_exec.",
  ai_media: "AI and media helpers exposed through env.AI and env.CAMELAI.",
});

const TOOL_HELP_DEFINITION = Object.freeze({
  name: "help",
  description:
    "Show js_exec tool and runtime help. Call await tools.help() for expandable categories, await tools.help(\"communication\") for one category, or await tools.help(\"list_apps\") for one tool.",
  parameters: {
    type: "object",
    properties: {
      category: { type: "string", description: "Exact category name to expand." },
      tool: { type: "string", description: "Exact tool name to inspect." },
      runtime: { type: "string", description: "Exact runtime helper name such as env.CAMELAI." },
    },
    additionalProperties: false,
  },
  category: "runtime",
  examples: [
    "await tools.help()",
    "await tools.help(\"communication\")",
    "await tools.help(\"list_apps\")",
    "await tools.help({ runtime: \"env.CAMELAI\" })",
  ],
  sideEffect: false,
  externalDelivery: false,
});

const TOOL_SEARCH_DEFINITION = Object.freeze({
  name: "search",
  description:
    "Rank harness tools and runtime helpers by relevance to a query. Returns { query, total, items, usage } DIRECTLY — no { ok, data } wrapper — where items is an array of lightweight matches ({ name, kind, category, score }). Follow up with await tools.describe(name) to see arguments, then call await tools.<name>(args). Prefer this over loading every tool up front.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Intent plus key nouns, e.g. \"send slack message\"." },
      limit: { type: "number", description: "Max results to return (default 12)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  category: "runtime",
  examples: [
    "await tools.search(\"send slack message\")",
    "await tools.search({ query: \"list deployed apps\", limit: 5 })",
  ],
  sideEffect: false,
  externalDelivery: false,
});

const TOOL_DESCRIBE_DEFINITION = Object.freeze({
  name: "describe",
  description:
    "Return the full definition (description, category, parameter schema, examples) for one harness tool or runtime helper by exact name. Use after tools.search to learn how to call a tool.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact tool or runtime helper name." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  category: "runtime",
  examples: [
    "await tools.describe(\"list_apps\")",
    "await tools.describe(\"env.CAMELAI\")",
  ],
  sideEffect: false,
  externalDelivery: false,
});

const RUNTIME_HELP_ENTRIES = Object.freeze([
  Object.freeze({
    name: "env.WORKSPACE",
    category: "workspace",
    kind: "runtime_binding",
    description:
      "Current workspace metadata helpers, including the inbound email address users can send mail to when configured.",
    examples: [
      "await env.WORKSPACE.info()",
      "await env.WORKSPACE.emailAddress()",
    ],
    methods: [
      {
        name: "info",
        usage: "await env.WORKSPACE.info()",
        returns: "{ id, name, email_address }",
      },
      {
        name: "emailAddress",
        usage: "await env.WORKSPACE.emailAddress()",
        returns: "The workspace email address string, or null when unavailable.",
      },
    ],
  }),
  Object.freeze({
    name: "env.CONNECTIONS",
    category: "connections",
    kind: "runtime_binding",
    description:
      "Virtual Worker binding for listing workspace connections and method catalogs.",
    examples: [
      "await env.CONNECTIONS.list()",
      "await env.CONNECTIONS.methods()",
      "const entry = await env.CONNECTIONS.find(\"clickhouse\")",
    ],
    methods: [
      { name: "list", usage: "await env.CONNECTIONS.list()" },
      { name: "methods", usage: "await env.CONNECTIONS.methods()" },
      { name: "find", usage: "await env.CONNECTIONS.find(\"provider-or-type\")" },
      { name: "test", usage: "await env.CONNECTIONS.test(\"provider-or-type\")" },
      { name: "get", usage: "await env.CONNECTIONS.get(\"connection-id-or-name\")" },
      { name: "tools", usage: "await env.CONNECTIONS.tools(\"connection-id-or-name\")" },
    ],
  }),
  Object.freeze({
    name: "connections",
    category: "connections",
    kind: "runtime_facade",
    description:
      "Convenience facade for calling connection methods after resolving an alias from env.CONNECTIONS.find().",
    examples: [
      "const entry = await env.CONNECTIONS.find(\"clickhouse\"); await connections[entry.alias].query({ query: \"SELECT 1 AS ok\" })",
    ],
  }),
  Object.freeze({
    name: "env.AI",
    category: "ai_media",
    kind: "runtime_binding",
    description:
      "Virtual AI binding. Use run() with model tiers cheap, fast, auto, smart, or an OpenRouter model id.",
    examples: [
      "await env.AI.run(\"auto\", { messages: [{ role: \"user\", content: \"hello\" }] })",
    ],
    methods: [
      { name: "run", usage: "await env.AI.run(\"auto\", { messages })" },
    ],
  }),
  Object.freeze({
    name: "env.CAMELAI",
    category: "ai_media",
    kind: "runtime_binding",
    description:
      "camelAI media helpers for image generation and audio transcription.",
    examples: [
      "await env.CAMELAI.generateImage(\"A product screenshot style hero image\")",
      "await env.CAMELAI.transcribeAudio({ path: \"uploads/audio.ogg\" })",
      "await env.CAMELAI.help()",
    ],
    methods: [
      {
        name: "generateImage",
        usage: "await env.CAMELAI.generateImage(\"prompt\")",
        parameters: "{ prompt: string, referenceImageUrl?: string } or a prompt string",
        returns: "{ text, imageDataUrl, images }",
      },
      {
        name: "transcribeAudio",
        usage: "await env.CAMELAI.transcribeAudio({ path })",
        parameters: "{ path?: string, base64?: string, mediaType?: string }",
        returns: "{ text }",
      },
      {
        name: "help",
        usage: "await env.CAMELAI.help()",
        returns: "This env.CAMELAI capability catalog.",
      },
    ],
  }),
  Object.freeze({
    name: "env.SCREENSHOT",
    category: "apps",
    kind: "runtime_binding",
    description:
      "Opt-in visual verification for deployed workspace apps, including access-controlled apps, via Browser Rendering. Do not capture screenshots automatically after every successful deploy; use this when the user or task explicitly calls for a visual check or when diagnosing a deployed UI issue.",
    examples: [
      "await env.SCREENSHOT.capture({ scriptName: \"web-app\", path: \"/\" })",
      "await tools.take_screenshot({ script_name: \"web-app\", path: \"/dashboard\" })",
    ],
    methods: [
      {
        name: "capture",
        usage: "await env.SCREENSHOT.capture({ scriptName, path?, width?, height?, waitMs? })",
        returns: "{ imageDataUrl, width, height }",
      },
    ],
  }),
  Object.freeze({
    name: "env.BROWSER",
    category: "apps",
    kind: "runtime_binding",
    description:
      "Opt-in Interactive Browser Rendering for requested or task-required testing of deployed workspace apps (including access-controlled apps). Do not launch a session automatically after every successful deploy. Supports Playwright-style scripts: navigate, click, fill, wait for text, evaluate JS in the page, screenshot, and read console/page errors. Always await session.close() when done. Sessions auto-close after 5 minutes. When this workspace (or the account) already has too many browser sessions running, launch() throws — close finished sessions or retry shortly. Note: for access-controlled apps, server-streamed responses (SSE / streaming fetch) are buffered, so realtime/SSE-driven UI will not update mid-session. Where public visibility is available, use it for those flows only when the user authorizes public access; otherwise use direct authenticated E2E coverage where available or test the streaming path at the unit/integration layer.",
    examples: [
      "const b = await env.BROWSER.launch({ scriptName: \"web-app\", path: \"/\" });\ntry {\n  await b.fill(\"#todo-input\", \"buy milk\");\n  await b.click(\"button[type=submit]\");\n  await b.waitForText(\"buy milk\");\n  const count = await b.count(\".todo-item\");\n  const logs = await b.logs();\n  console.log({ count, pageErrors: logs.pageErrors });\n} finally {\n  await b.close();\n}",
    ],
    methods: [
      {
        name: "launch",
        usage: "await env.BROWSER.launch({ scriptName, path?, width?, height? })",
        returns: "A session with the methods below. Launch navigates to path (default \"/\").",
      },
      { name: "goto", usage: "await session.goto(\"/dashboard\")", returns: "{ url, status }" },
      { name: "click", usage: "await session.click(\"button.submit\", { timeoutMs? })" },
      { name: "fill", usage: "await session.fill(\"#email\", \"a@b.com\") — clears the field first" },
      { name: "type", usage: "await session.type(\"#search\", \"query\") — appends keystrokes" },
      { name: "press", usage: "await session.press(\"Enter\", { selector? }) — without selector, dispatches to the currently focused element/page; verify the resulting UI state" },
      { name: "select", usage: "await session.select(\"select#plan\", \"pro\")" },
      { name: "hover", usage: "await session.hover(\".menu\")" },
      { name: "waitForSelector", usage: "await session.waitForSelector(\".toast\", { timeoutMs?, hidden? })" },
      { name: "waitForText", usage: "await session.waitForText(\"Saved\", { timeoutMs? })" },
      { name: "waitForFunction", usage: "await session.waitForFunction(\"document.querySelectorAll('li').length >= 3\")" },
      { name: "waitForTimeout", usage: "await session.waitForTimeout(500) — fixed sleep in ms (max 60s); prefer waitForSelector/waitForText when possible" },
      { name: "evaluate", usage: "await session.evaluate(\"document.title\")", returns: "JSON-safe result" },
      { name: "textContent", usage: "await session.textContent(selector?) — defaults to visible body text", returns: "{ text, truncated }" },
      { name: "hasText", usage: "await session.hasText(\"Saved\", { selector? }) — immediate check; defaults to body", returns: "boolean" },
      { name: "getAttribute", usage: "await session.getAttribute(\"a.cta\", \"href\")" },
      { name: "count", usage: "await session.count(\".todo-item\")", returns: "number" },
      { name: "exists", usage: "await session.exists(\".error-banner\")", returns: "boolean" },
      { name: "content", usage: "await session.content({ selector?, maxChars? })", returns: "{ html, truncated }" },
      { name: "url", usage: "await session.url()" },
      { name: "title", usage: "await session.title()" },
      { name: "screenshot", usage: "await session.screenshot({ fullPage? })", returns: "{ imageDataUrl, width, height }" },
      { name: "logs", usage: "await session.logs()", returns: "{ console, pageErrors, requestFailures, truncated }" },
      { name: "close", usage: "await session.close()" },
    ],
  }),
  Object.freeze({
    name: "env.PROJECTS",
    category: "workspace",
    kind: "runtime_binding",
    description:
      "Project facade for listing, creating, and describing workspace projects. Backed by the list_projects/create_project/set_project_description tools.",
    examples: [
      "await env.PROJECTS.list()",
      "await env.PROJECTS.create({ name: \"my-app\", description: \"What this app does\" })",
    ],
    methods: [
      { name: "list", usage: "await env.PROJECTS.list()" },
      { name: "create", usage: "await env.PROJECTS.create({ name, description, template? })" },
      { name: "setDescription", usage: "await env.PROJECTS.setDescription({ project, description })" },
    ],
  }),
  Object.freeze({
    name: "text/store/load",
    category: "runtime",
    kind: "runtime_helper",
    description:
      "Use text(value) to append output and store(key, value)/load(key) for per-runner scratch state.",
    examples: [
      "text({ ok: true })",
      "store(\"lastResult\", result); load(\"lastResult\")",
    ],
  }),
]);

function categoryDescription(category) {
  return TOOL_CATEGORY_DESCRIPTIONS[category] || "No category description available.";
}

function cloneHelpValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeHelpInput(input) {
  if (input === undefined || input === null) return {};
  if (typeof input === "string") {
    return { key: input };
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  throw new Error("tools.help expects no arguments, a category/tool string, or { category?, tool?, runtime? }");
}

// The full js_exec usage guide, returned by a no-argument tools.help() call.
// This is the executor-style split: the always-loaded js_exec tool description
// stays tiny (a pointer here plus the tool inventory), and this long-form
// guidance is fetched on demand the moment the model actually writes code.
const JS_EXEC_GUIDE = Object.freeze([
  "Results: the final expression is returned automatically and console.log/warn/error output is captured; use an explicit return inside branches or loops. You may write TypeScript — type annotations are stripped before execution.",
  "Tool results: every await tools.<name>(args) call resolves to { ok: true, data } on success or { ok: false, error: { tool, message, origin } } on failure — branch on result.ok and read result.data. Operational results include completionEvidence; use its supportedClaims and never assert an unsupported completion. Unknown tool names return discovery suggestions instead of throwing. Equivalent failures have a retry budget: when recovery.blocked is true, change arguments or approach rather than looping. deploy_project and run_notebook resolve ok: false when their operational outcome fails, with full diagnostics retained in data. EXCEPTION: runtime bindings (env.*, connections[alias]) and tools.search/describe/help return their values directly with NO { ok, data } wrapper.",
  "Discovery: await tools.search(\"<intent + key nouns>\") ranks matching tools; await tools.describe(name) returns one definition with a compact inputTypeScript argument shape; await tools.help(\"<category>\") expands a category. Results with kind \"tool\" run as await tools.<name>(args); kind \"runtime\" results are sandbox globals (env.*, connections, text/store/load) used directly, never through tools.",
  "Every top-level harness tool is also on tools, e.g. await tools.create_project(...).",
  "Connections: const entry = await env.CONNECTIONS.find(\"clickhouse\"); return await connections[entry.alias].query({ query: \"SELECT 1 AS ok\" }). Use env.CONNECTIONS.methods() for the full catalog, env.CONNECTIONS.verify(\"clickhouse\") for normalized health, or env.CONNECTIONS.test(\"clickhouse\") for the legacy smoke test; custom \"other\" connections expose fetch.",
  "File tools require an explicit location (\"workspace\" | \"project\" | \"r2\"), e.g. const file = await tools.read({ location: \"project\", project: project.name, path: \"src/App.tsx\" }); if (!file.ok) throw new Error(file.error.message); then use file.data.text for text file contents. R2 mounts are uploads/ (read-only), outputs/ (user-visible), tmp/. tools.grep, tools.find, and tools.move are also available.",
  "Projects: use env.PROJECTS to list/create projects; edit DO-backed project files with the file tools at location \"project\", then call tools.deploy_project to build, deploy, and open preview. Pass dry_run: true only for validation without publishing.",
  "Deploy results: deploy_project returns the live app URL and opens successful deploys in preview automatically, so no manual set_preview or list_apps call is needed. set_preview remains available for an explicit preview switch.",
  "Hosted helpers: env.AI.run(\"auto\", { messages }) with tiers cheap/fast/auto/smart or any OpenRouter id, env.CAMELAI.generateImage/transcribeAudio, env.WORKSPACE.info(). Global fetch() auto-authenticates to this workspace's deployed apps and supports direct app and API requests.",
  "Scratch state: text(value) appends user-visible output; store(key, value)/load(key) keep per-runner scratch state.",
  "Interactive tools that wait for the user (prompt_connection_setup, delete_connection, delete_app, delete_project, AskUserQuestion) are top-level only and cannot be called from js_exec.",
]);

function createToolHelp(allTools) {
  const toolsByName = new Map(allTools.map((tool) => [tool.name.toLowerCase(), tool]));
  const runtimeByName = new Map(RUNTIME_HELP_ENTRIES.map((entry) => [entry.name.toLowerCase(), entry]));
  const categories = new Map();
  for (const tool of allTools) {
    const category = tool.category || "workspace";
    if (!categories.has(category)) {
      categories.set(category, { tools: [], runtimes: [] });
    }
    categories.get(category).tools.push(tool);
  }
  for (const entry of RUNTIME_HELP_ENTRIES) {
    const category = entry.category || "runtime";
    if (!categories.has(category)) {
      categories.set(category, { tools: [], runtimes: [] });
    }
    categories.get(category).runtimes.push(entry);
  }

  function categorySummary() {
    return [...categories.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => ({
        name,
        description: categoryDescription(name),
        tool_count: entry.tools.length,
        runtime_count: entry.runtimes.length,
        expand: "await tools.help(" + JSON.stringify(name) + ")",
      }));
  }

  return (input) => {
    const request = normalizeHelpInput(input);
    const requestedKey = typeof request.key === "string" ? request.key.trim().toLowerCase() : "";
    const requestedTool = typeof request.tool === "string" ? request.tool.trim().toLowerCase() : "";
    const requestedCategory = typeof request.category === "string" ? request.category.trim().toLowerCase() : "";
    const requestedRuntime = typeof request.runtime === "string" ? request.runtime.trim().toLowerCase() : "";

    if (!requestedKey && !requestedTool && !requestedCategory && !requestedRuntime) {
      return {
        usage: "Expand a category with await tools.help(\"communication\") or inspect one tool with await tools.help(\"list_apps\").",
        guide: cloneHelpValue(JS_EXEC_GUIDE),
        categories: categorySummary(),
      };
    }

    const toolKey = requestedTool || requestedKey;
    if (toolKey && toolsByName.has(toolKey)) {
      return { tool: cloneHelpValue(toolsByName.get(toolKey)) };
    }

    // For a bare-string key, resolve categories before runtime helpers: the
    // "connections" category and the "connections" runtime facade share a name,
    // and category browsing is the discovery path for tools hidden from the
    // top-level list. Nothing is lost — the category view lists its runtime
    // entries too, and an explicit { runtime: "connections" } stays precise.
    const categoryKey = requestedCategory || requestedKey;
    if (categoryKey && categories.has(categoryKey) && !requestedRuntime) {
      const entry = categories.get(categoryKey);
      return {
        category: categoryKey,
        description: categoryDescription(categoryKey),
        tools: cloneHelpValue(entry.tools),
        runtimes: cloneHelpValue(entry.runtimes),
      };
    }

    const runtimeKey = requestedRuntime || requestedKey;
    if (runtimeKey && runtimeByName.has(runtimeKey)) {
      return { runtime: cloneHelpValue(runtimeByName.get(runtimeKey)) };
    }

    return {
      error: "No exact js_exec help entry matched " + JSON.stringify(requestedKey || requestedTool || requestedCategory || requestedRuntime) + ".",
      usage: "Use await tools.help() to list categories, then expand one exact category or tool name.",
      categories: categorySummary(),
    };
  };
}

// Executor-style tool search: a small dependency-free weighted scorer over the
// tool catalog. No embeddings; ranks by token overlap and substring/prefix hits
// across name/category/description/examples with a coverage gate.
function leanNormalizeText(value) {
  return String(value == null ? "" : value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase();
}

function leanTokenize(value) {
  return leanNormalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

const SEARCH_FIELD_WEIGHTS = Object.freeze({ name: 10, category: 6, description: 4, examples: 2 });

function scoreSearchField(fieldText, queryTokens, weight, matchedTokens) {
  if (!fieldText) return 0;
  const normalized = leanNormalizeText(fieldText);
  const fieldTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const fieldTokenSet = new Set(fieldTokens);
  let score = 0;
  for (const token of queryTokens) {
    if (fieldTokenSet.has(token)) {
      score += weight * 4;
      matchedTokens.add(token);
    } else if (fieldTokens.some((ft) => ft.startsWith(token) || token.startsWith(ft))) {
      score += weight * 2;
      matchedTokens.add(token);
    } else if (normalized.includes(token)) {
      score += weight * 1;
      matchedTokens.add(token);
    }
  }
  return score;
}

function scoreSearchEntry(ref, queryTokens, phrase) {
  const matchedTokens = new Set();
  let score = 0;
  score += scoreSearchField(ref.name, queryTokens, SEARCH_FIELD_WEIGHTS.name, matchedTokens);
  score += scoreSearchField(ref.category, queryTokens, SEARCH_FIELD_WEIGHTS.category, matchedTokens);
  score += scoreSearchField(ref.description, queryTokens, SEARCH_FIELD_WEIGHTS.description, matchedTokens);
  const exampleText = Array.isArray(ref.examples) ? ref.examples.join(" ") : "";
  score += scoreSearchField(exampleText, queryTokens, SEARCH_FIELD_WEIGHTS.examples, matchedTokens);

  const normalizedName = leanNormalizeText(ref.name);
  if (normalizedName === phrase) score += 40;
  else if (normalizedName.startsWith(phrase)) score += 12;
  else if (normalizedName.includes(phrase)) score += 6;

  const coverage = queryTokens.length ? matchedTokens.size / queryTokens.length : 0;
  const minimumCoverage = queryTokens.length <= 2 ? 1 : 0.6;
  const phraseMatch =
    normalizedName.includes(phrase) || leanNormalizeText(ref.description).includes(phrase);
  if (coverage < minimumCoverage && !phraseMatch) return null;
  score += coverage >= 1 ? 25 : Math.round(coverage * 10);
  return score;
}

function normalizeSearchInput(input) {
  if (typeof input === "string") return { query: input };
  if (input === undefined || input === null) return {};
  if (typeof input === "object" && !Array.isArray(input)) return input;
  throw new Error("tools.search expects a query string or { query, limit }");
}

function createToolSearch(allTools) {
  const entries = [
    ...allTools.map((tool) => ({ kind: "tool", ref: tool })),
    ...RUNTIME_HELP_ENTRIES.map((entry) => ({ kind: "runtime", ref: entry })),
  ];
  return (input) => {
    const request = normalizeSearchInput(input);
    const query = typeof request.query === "string" ? request.query.trim() : "";
    if (!query) {
      throw new Error("tools.search requires a query string, e.g. await tools.search(\"send email\")");
    }
    const limit = Number.isFinite(request.limit)
      ? Math.max(1, Math.min(50, Math.trunc(request.limit)))
      : 12;
    const queryTokens = leanTokenize(query);
    const phrase = leanNormalizeText(query).trim();
    const scored = [];
    for (const entry of entries) {
      const ref = entry.ref;
      const score = scoreSearchEntry(ref, queryTokens, phrase);
      if (score === null) continue;
      const firstExample = Array.isArray(ref.examples) && ref.examples.length ? ref.examples[0] : null;
      scored.push({
        name: ref.name,
        kind: entry.kind,
        category: ref.category || "workspace",
        description: ref.description || "",
        score,
        describe: "await tools.describe(" + JSON.stringify(ref.name) + ")",
        call: entry.kind === "tool"
          ? "await tools[" + JSON.stringify(ref.name) + "](args)"
          : "Runtime global, NOT callable via tools.<name>." + (firstExample ? " Example: " + firstExample : ""),
      });
    }
    scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
    const items = scored.slice(0, limit);
    return {
      query,
      total: scored.length,
      items,
      usage: items.length
        ? "Inspect a result with await tools.describe(name), then invoke it as its call field shows: kind \"tool\" results run as await tools.<name>(args); kind \"runtime\" results are sandbox globals used directly, never through tools."
        : "No tools matched. Try broader terms or await tools.help() to browse categories.",
    };
  };
}

// Compact executor-style TypeScript rendering of a JSON Schema parameters
// object: "{ name: string, enabled?: boolean }" reads at a fraction of the
// context cost of the raw schema. Best-effort — anything unrecognized prints
// as unknown rather than throwing.
function schemaToTypeScript(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf : (Array.isArray(schema.oneOf) ? schema.oneOf : null);
  if (variants && variants.length) {
    return [...new Set(variants.map(schemaToTypeScript))].join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return [...new Set(schema.type.map((type) => schemaToTypeScript({ ...schema, type })))].join(" | ");
  }
  switch (schema.type) {
    case "string": return "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      const item = schemaToTypeScript(schema.items);
      return (item.includes(" | ") ? "(" + item + ")" : item) + "[]";
    }
    case "object": {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const properties = schema.properties && typeof schema.properties === "object"
        ? Object.entries(schema.properties)
        : [];
      if (!properties.length) {
        return schema.additionalProperties ? "Record<string, unknown>" : "{}";
      }
      const fields = properties.map(([key, value]) =>
        key + (required.has(key) ? "" : "?") + ": " + schemaToTypeScript(value));
      return "{ " + fields.join(", ") + " }";
    }
    default: return "unknown";
  }
}

function createToolDescribe(allTools) {
  const toolsByName = new Map(allTools.map((tool) => [tool.name.toLowerCase(), tool]));
  const runtimeByName = new Map(RUNTIME_HELP_ENTRIES.map((entry) => [entry.name.toLowerCase(), entry]));
  const search = createToolSearch(allTools);
  return (input) => {
    const name = typeof input === "string"
      ? input.trim()
      : (input && typeof input === "object" && typeof input.name === "string" ? input.name.trim() : "");
    if (!name) {
      throw new Error("tools.describe requires a tool name, e.g. await tools.describe(\"list_apps\")");
    }
    const key = name.toLowerCase();
    if (toolsByName.has(key)) {
      const tool = toolsByName.get(key);
      const definition = cloneHelpValue(tool);
      delete definition.parameters;
      definition.inputTypeScript = schemaToTypeScript(tool.parameters);
      return {
        tool: definition,
        usage: "Call it as await tools." + tool.name + "(args); the call resolves to { ok: true, data } or { ok: false, error: { message, origin } } — branch on ok.",
      };
    }
    if (runtimeByName.has(key)) {
      const entry = runtimeByName.get(key);
      const firstExample = Array.isArray(entry.examples) && entry.examples.length ? entry.examples[0] : null;
      return {
        runtime: cloneHelpValue(entry),
        usage: "Runtime global available directly in js_exec, NOT callable via tools.<name>." +
          (firstExample ? " Example: " + firstExample : ""),
      };
    }
    const suggestions = search({ query: name, limit: 5 }).items.map((item) => item.name);
    return {
      error: "No tool or runtime helper named " + JSON.stringify(name) + ".",
      suggestions,
      usage: "Use await tools.search(\"...\") to find tools, then await tools.describe(name).",
    };
  };
}

// Executor-style result envelope for tools.<name>() calls: expected tool/domain
// failures come back as values the model can branch on inside the same script.
// The runner also emits compact completion evidence and stops equivalent retry
// loops; those controls are more reliable than asking the model to infer state
// from prose or repeatedly rediscover the same contract.
const OPERATIONAL_OUTCOME_TOOLS = new Set(["deploy_project", "run_notebook"]);
const COMPLETION_EVIDENCE_TOOLS = new Set([
  "deploy_project",
  "run_notebook",
  "send_email",
  "send_slack_message",
  "send_telegram_message",
  "create_scheduled_prompt",
  "create_workflow",
  "set_preview",
]);
const NON_RETRYABLE_TOOL_ERROR = /(?:\\b401\\b|\\b402\\b|unauthori[sz]ed|forbidden|permission denied|credits? (?:are )?(?:used up|exhausted)|quota|billing|reserved for the Research agent|unknown (?:code mode )?tool|not configured)/i;

function stableToolArgs(value) {
  if (Array.isArray(value)) return value.map(stableToolArgs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableToolArgs(item)]),
  );
}

function toolAttemptKey(name, args) {
  try {
    return name + ":" + JSON.stringify(stableToolArgs(args));
  } catch {
    return name + ":" + String(args);
  }
}

function completionEvidenceFor(name, envelope) {
  if (!envelope || envelope.ok !== true) {
    return {
      tool: name,
      status: "failed",
      supportedClaims: [],
      instruction: "Do not claim this operation succeeded. Report the blocker or change approach.",
    };
  }
  if (!COMPLETION_EVIDENCE_TOOLS.has(name)) return null;
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
  if (name === "deploy_project") {
    if (data.dryRun === true) {
      return {
        tool: name,
        status: "succeeded",
        supportedClaims: ["build validated"],
        unsupportedClaims: ["deployed", "published", "live"],
      };
    }
    const url = typeof data.url === "string" ? data.url : (typeof data.appUrl === "string" ? data.appUrl : null);
    return url
      ? { tool: name, status: "succeeded", supportedClaims: ["deployed", "published"], target: url, instruction: "Publication is proven; feature correctness and live-data quality are not." }
      : { tool: name, status: "partial", supportedClaims: [], unsupportedClaims: ["deployed", "published", "live"], instruction: "No live URL was returned; do not claim deployment." };
  }
  if (name === "run_notebook") {
    const clean = data.ok !== false && (!data.validation || data.validation.clean !== false);
    return clean
      ? { tool: name, status: "succeeded", supportedClaims: ["notebook executed", "notebook validated"], unsupportedClaims: ["published"] }
      : { tool: name, status: "failed", supportedClaims: [], unsupportedClaims: ["validated", "complete", "published"] };
  }
  if (name.startsWith("send_")) {
    return { tool: name, status: "succeeded", supportedClaims: ["sent"], instruction: "The send operation is proven only for the returned destination." };
  }
  if (name === "create_scheduled_prompt" || name === "create_workflow") {
    return { tool: name, status: "succeeded", supportedClaims: ["created"], instruction: "Creation does not prove a future run succeeded." };
  }
  return { tool: name, status: "succeeded", supportedClaims: ["preview changed"] };
}

function withCompletionEvidence(name, envelope) {
  const completionEvidence = completionEvidenceFor(name, envelope);
  return completionEvidence ? { ...envelope, completionEvidence } : envelope;
}

function createEnvelopeToolCall(name, invokeEnvelope, failureBudget = new Map()) {
  return async (args = {}) => {
    const attemptKey = toolAttemptKey(name, args);
    const previous = failureBudget.get(attemptKey);
    if (previous && previous.count >= previous.limit) {
      return withCompletionEvidence(name, {
        ok: false,
        error: {
          tool: name,
          message: "Blocked an equivalent retry after " + previous.count + " failed attempt(s): " + previous.message,
          origin: "retry_budget",
        },
        recovery: {
          blocked: true,
          instruction: "Change the arguments or approach. Use tools.search/describe when the contract is unclear; do not repeat this call.",
        },
      });
    }

    let envelope;
    try {
      envelope = await invokeEnvelope(name, args);
      const outcomeFailed =
        OPERATIONAL_OUTCOME_TOOLS.has(name) &&
        envelope && envelope.ok === true &&
        envelope.data && typeof envelope.data === "object" &&
        (envelope.data.success === false || envelope.data.ok === false);
      if (outcomeFailed) {
        const message = typeof envelope.data.errorSummary === "string" && envelope.data.errorSummary
          ? envelope.data.errorSummary
          : typeof envelope.data.error === "string" && envelope.data.error
            ? envelope.data.error
            : name + " reported an unsuccessful outcome";
        envelope = {
          ok: false,
          error: {
            tool: name,
            message,
            origin: "tool",
            ...(typeof envelope.data.stage === "string" ? { stage: envelope.data.stage } : {}),
          },
          data: envelope.data,
        };
      }
    } catch (error) {
      const message = error && typeof error.message === "string" && error.message
        ? error.message
        : String(error);
      console.error("[code-mode] tools RPC failed", {
        toolName: name,
        origin: "transport",
        error: message,
      });
      envelope = { ok: false, error: { tool: name, message, origin: "transport" } };
    }

    if (!envelope || envelope.ok !== true) {
      const message = envelope && envelope.error && typeof envelope.error.message === "string"
        ? envelope.error.message
        : "tool call failed";
      const limit = NON_RETRYABLE_TOOL_ERROR.test(message) ? 1 : 2;
      const count = previous && previous.message === message ? previous.count + 1 : 1;
      failureBudget.set(attemptKey, { count, limit, message });
      envelope = {
        ...envelope,
        recovery: {
          blocked: count >= limit,
          remainingEquivalentRetries: Math.max(0, limit - count),
          instruction: count >= limit
            ? "Do not repeat this call. Change the arguments or approach."
            : "Inspect the error and change course if the next attempt fails identically.",
        },
      };
    } else {
      failureBudget.delete(attemptKey);
    }
    return withCompletionEvidence(name, envelope);
  };
}

function createToolsFacade(entries, search) {
  const target = Object.freeze(Object.fromEntries(entries));
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property === "then") return undefined;
      if (typeof property !== "string" || Reflect.has(object, property)) {
        return Reflect.get(object, property, receiver);
      }
      return async () => {
        const suggestions = search({ query: property, limit: 5 }).items.map((item) => item.name);
        return withCompletionEvidence(property, {
          ok: false,
          error: {
            tool: property,
            message: "Unknown tool " + JSON.stringify(property) + "." +
              (suggestions.length ? " Suggested tools: " + suggestions.join(", ") + "." : " Browse tools with await tools.help()."),
            origin: "discovery",
            suggestions,
          },
          recovery: {
            blocked: true,
            instruction: "Use await tools.search(\"<intent>\") and await tools.describe(name) before calling a replacement.",
          },
        });
      };
    },
  });
}

function createScreenshotFacade(binding) {
  return Object.freeze({
    capture: (...args) => binding.capture.call(binding, ...args),
  });
}

function createBrowserFacade(callTool) {
  const sessionMethods = [
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
  ];
  const sessionMethodList = sessionMethods.join(", ");
  const sessionMethodHints = Object.freeze({
    text: 'To read visible page text, use await session.textContent() and then result.text. '
      + 'To read HTML, use await session.content().',
    innerText: 'To read visible page text, use await session.textContent() and then result.text, '
      + 'or await session.evaluate("document.body.innerText").',
    html: 'To read page HTML, use await session.content(). '
      + 'To read a specific element, use await session.content({ selector: "..." }).',
    json: 'env.BROWSER is an interactive page session, not a fetch Response. '
      + 'Use fetch(...).json() for HTTP JSON, or session.evaluate(...) to read page state.',
  });
  const unsupportedSessionMethod = (method) => async () => {
    const hint = sessionMethodHints[method] || 'Run await tools.help({ runtime: "env.BROWSER" }) for examples.';
    throw new Error(
      'env.BROWSER session has no method "' + method + '". Supported session methods: '
        + sessionMethodList + '. ' + hint,
    );
  };
  const openSessions = new Map();
  const createSessionFacade = (handle) => {
    let closed = false;
    openSessions.set(handle.sessionId, handle);
    const call = async (method, args) => {
      if (method === "close" && closed) return undefined;
      if (closed) {
        throw new Error("Browser session is closed. Launch a new session with env.BROWSER.launch(...).");
      }
      try {
        return await callTool("browser_action", {
          sessionId: handle.sessionId,
          scriptName: handle.scriptName,
          method,
          args,
        });
      } finally {
        if (method === "close") {
          closed = true;
          openSessions.delete(handle.sessionId);
        }
      }
    };
    const target = Object.freeze(Object.fromEntries(
      sessionMethods.map((method) => [method, (...args) => call(method, args)]),
    ));
    return new Proxy(target, {
      get(object, property, receiver) {
        if (property === "then") return undefined;
        if (property in object) return Reflect.get(object, property, receiver);
        if (typeof property !== "string") return undefined;
        return unsupportedSessionMethod(property);
      },
    });
  };
  const facadeTarget = Object.freeze({
    launch: async (input = {}) => {
      const handle = await callTool("browser_launch", input);
      if (!handle || typeof handle.sessionId !== "string" || !handle.sessionId) {
        throw new Error("env.BROWSER.launch returned an invalid session handle");
      }
      return createSessionFacade(handle);
    },
  });
  const facade = new Proxy(facadeTarget, {
    get(object, property, receiver) {
      if (property === "then") return undefined;
      if (property in object) return Reflect.get(object, property, receiver);
      if (typeof property !== "string") return undefined;
      return async () => {
        throw new Error(
          'env.BROWSER has no method "' + property + '". '
            + 'Use await env.BROWSER.launch({ scriptName, path? }) to create a session first, '
            + 'then call session methods such as click, waitForText, hasText, textContent, content, logs, and close. '
            + 'Run await tools.help({ runtime: "env.BROWSER" }) for examples.',
        );
      };
    },
  });
  const cleanup = async () => {
    const handles = Array.from(openSessions.values());
    openSessions.clear();
    await Promise.all(handles.map((handle) =>
      callTool("browser_action", {
        sessionId: handle.sessionId,
        scriptName: handle.scriptName,
        method: "close",
        args: [],
      }).catch(() => undefined)
    ));
  };
  return { facade, cleanup };
}

function createCamelAiFacade(binding) {
  const helpEntry = RUNTIME_HELP_ENTRIES.find((entry) => entry.name === "env.CAMELAI");
  return Object.freeze({
    help: () => cloneHelpValue(helpEntry),
    generateImage: (...args) => binding.generateImage.call(binding, ...args),
    transcribeAudio: (...args) => binding.transcribeAudio.call(binding, ...args),
  });
}

function createWorkspaceFacade(callTool) {
  const info = () => callTool("workspace_info", {});
  return Object.freeze({
    info,
    emailAddress: async () => {
      const workspace = await info();
      return workspace && typeof workspace === "object" ? workspace.email_address || null : null;
    },
  });
}

function createConnectionsFacade(binding) {
  const legacyInvokeMethod = ["_", "_", "invoke"].join("");
  const invokeConnectionMethod = (request) => {
    if (typeof binding.invoke === "function") {
      return binding.invoke(request);
    }
    if (typeof binding[legacyInvokeMethod] === "function") {
      return binding[legacyInvokeMethod](request);
    }
    throw new Error("CONNECTIONS method invocation is not configured");
  };

  async function findConnection(query) {
    const result = await binding.find(query);
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    const connection = result.connection && typeof result.connection === "object"
      ? result.connection
      : null;
    const verificationQuery = typeof connection?.name === "string" && connection.name
      ? connection.name
      : String(query || result.alias || "");
    return {
      ...result,
      recommendedVerificationCall: "await env.CONNECTIONS.verify(" + JSON.stringify(verificationQuery) + ")",
      verificationNote: "Run the recommended verification call when verification is requested; inspecting status alone does not perform verification.",
    };
  }

  function responseFromFetchPayload(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.status !== "number") {
      return payload;
    }
    const headers = new Headers(payload.headers || {});
    if (payload.truncated) headers.set("x-camelai-truncated", "true");
    return new Response(payload.bodyText || "", {
      status: payload.status,
      statusText: payload.statusText || "",
      headers,
    });
  }

  async function serializeFetchInput(input) {
    if (input instanceof Request) {
      return {
        input: input.url,
        init: {
          method: input.method,
          headers: Object.fromEntries(input.headers.entries()),
          body: input.method === "GET" || input.method === "HEAD" ? undefined : await input.text(),
        },
      };
    }
    return { input: String(input), init: {} };
  }

  function serializeFetchInit(init) {
    if (!init || typeof init !== "object") return {};
    const output = { ...init };
    if (init.headers) {
      output.headers = Object.fromEntries(new Headers(init.headers).entries());
    }
    return output;
  }

  return new Proxy({}, {
    get(_target, connectionName) {
      if (connectionName === "then") return undefined;
      if (connectionName === "$methods") return () => binding.methods();
      if (connectionName === "$find") return (query) => findConnection(query);
      if (connectionName === "$test") return (query) => binding.test(query);
      if (connectionName === "$verify") return (query) => binding.verify(query);
      if (connectionName === "$list") return () => binding.list();
      if (connectionName === "$get") return (connection) => binding.get(connection);
      if (connectionName === "$tools") return (connection) => binding.tools(connection);
      if (typeof connectionName !== "string") return binding[connectionName];
      if ([
        "list",
        "get",
        "tools",
        "methods",
        "find",
        "test",
        "verify",
        "invoke",
        legacyInvokeMethod,
      ].includes(connectionName)) {
        if (connectionName === "find") return (query) => findConnection(query);
        const value = binding[connectionName];
        return typeof value === "function" ? (...args) => value.apply(binding, args) : value;
      }

      return new Proxy({}, {
        get(_connectionTarget, methodName) {
          if (methodName === "then") return undefined;
          if (typeof methodName !== "string") return undefined;
          return async (...args) => {
            // Connection-level verification is an intuitive spelling and must
            // use the normalized registry operation, not method invocation.
            // It preserves configuration-only semantics for imported APIs and
            // persists the resulting health snapshot.
            if (methodName === "verify") return binding.verify(connectionName);
            if (methodName === "test") return binding.test(connectionName);

            let input = args[0] ?? {};
            if (methodName === "fetch") {
              const serialized = await serializeFetchInput(args[0] ?? "");
              input = {
                ...serialized,
                init: {
                  ...serialized.init,
                  ...serializeFetchInit(args[1]),
                },
              };
            }
            try {
              const result = await invokeConnectionMethod({
                connection: connectionName,
                method: methodName,
                input,
              });
              return methodName === "fetch" ? responseFromFetchPayload(result) : result;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(
                message + " Use await env.CONNECTIONS.find(\"" + connectionName
                  + "\") to inspect callable methods, or await env.CONNECTIONS.verify(\""
                  + connectionName + "\") for normalized verification.",
              );
            }
          };
        },
      });
    },
  });
}

function createToolBackedConnectionsBinding(callTool) {
  return Object.freeze({
    list: () => callTool("connections_list", {}),
    get: (connection) => callTool("connections_get", { connection }),
    tools: (connection) => callTool("connections_tools", { connection }),
    methods: () => callTool("connections_methods", {}),
    find: (query) => callTool("connections_find", { query }),
    test: (query) => callTool("connections_test", { query }),
    verify: (query) => callTool("connections_verify", { query }),
    invoke: (request) => callTool("connections_invoke", request),
  });
}

function createProjectsFacade(tools) {
  return Object.freeze({
    list: () => tools.list_projects({}),
    create: (options = {}) => tools.create_project(options),
    setDescription: (options = {}) => tools.set_project_description(options),
  });
}

async function runUserCode() {
  "use strict";
`;
  const userCodeStartLine = workerPrefixTemplate.split("\n").length;
  const userCodeEndLine = userCodeStartLine + Math.max(1, executableUserCode.split("\n").length) - 1;
  const workerPrefix = workerPrefixTemplate
    .replace("__USER_CODE_START_LINE__", String(userCodeStartLine))
    .replace("__USER_CODE_END_LINE__", String(userCodeEndLine));
  return `${workerPrefix}${executableUserCode}${String.raw`
}

function installRuntimeGlobals(values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
  }
  return () => {
    for (const [key, descriptor] of previous.entries()) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  };
}

function installSecureFetch(secureFetchBinding) {
  if (!secureFetchBinding || typeof secureFetchBinding.fetch !== "function") {
    return () => {};
  }
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => secureFetchBinding.fetch(input, init);
  return () => {
    globalThis.fetch = nativeFetch;
  };
}

export class CodeModeRunner extends WorkerEntrypoint {
  async run(timeoutMs, maxTimeoutMs) {
    hardenTimingSurface();
    const output = [];
    globalThis.console = createOutputConsole(output);
    const cleanupSecureFetch = installSecureFetch(this.env.SECURE_FETCH);
    const registeredTools = Object.freeze((await this.env.TOOLS.listTools()).map((tool) => Object.freeze({
      ...tool,
      parameters: tool.parameters,
      examples: Array.isArray(tool.examples) ? tool.examples : [],
      sideEffect: Boolean(tool.sideEffect),
      externalDelivery: Boolean(tool.externalDelivery),
    })));
    // Compatibility aliases stay callable on the tools object but do not appear in
    // help, search, or describe results.
    const ALL_TOOLS = Object.freeze([
      TOOL_HELP_DEFINITION,
      TOOL_SEARCH_DEFINITION,
      TOOL_DESCRIBE_DEFINITION,
      ...registeredTools.filter((tool) => !tool.hidden),
    ]);
    const callTool = (name, args = {}) => this.env.TOOLS.callTool(name, args);
    const invokeEnvelope = (name, args = {}) => this.env.TOOLS.callToolEnvelope(name, args);
    const help = createToolHelp(ALL_TOOLS);
    const search = createToolSearch(ALL_TOOLS);
    const describe = createToolDescribe(ALL_TOOLS);
    const rawTools = Object.freeze(Object.fromEntries(
      registeredTools.map((tool) => [tool.name, (args = {}) => callTool(tool.name, args)]),
    ));
    const failureBudget = new Map();
    const toolEntries = registeredTools.map((tool) => [
      tool.name,
      createEnvelopeToolCall(tool.name, invokeEnvelope, failureBudget),
    ]);
    const tools = createToolsFacade([
      ["help", help],
      ["search", search],
      ["describe", describe],
      ...toolEntries,
    ], search);
    const CONNECTIONS_BINDING = createToolBackedConnectionsBinding(callTool);
    const connections = createConnectionsFacade(CONNECTIONS_BINDING);
    const CONNECTIONS = connections;
    const AI = this.env.AI;
    const CAMELAI = createCamelAiFacade(this.env.CAMELAI);
    const SCREENSHOT = createScreenshotFacade(this.env.SCREENSHOT);
    const browserRuntime = createBrowserFacade(callTool);
    const BROWSER = browserRuntime.facade;
    const WORKSPACE = createWorkspaceFacade(callTool);
    const PROJECTS = createProjectsFacade(rawTools);
    const env = Object.freeze({ CONNECTIONS, AI, CAMELAI, SCREENSHOT, BROWSER, WORKSPACE, PROJECTS });
    const context = Object.freeze({ cloudflare: Object.freeze({ env, connections, projects: env.PROJECTS }) });
    const text = (value) => {
      output.push(stringifyOutput(value));
    };
    const load = (key) => {
      if (typeof key !== "string" || !key) throw new Error("load key must be a non-empty string");
      return store.get(key);
    };
    const save = (key, value) => {
      if (typeof key !== "string" || !key) throw new Error("store key must be a non-empty string");
      store.set(key, value);
    };

    const cleanupRuntimeGlobals = installRuntimeGlobals({
      tools,
      CONNECTIONS,
      connections,
      PROJECTS,
      env,
      context,
      ALL_TOOLS,
      text,
      store: save,
      save,
      load,
    });
    let timeoutHandle;
    try {
      const result = await Promise.race([
        runUserCode(),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const error = new Error(
              "JavaScript execution timed out after " + timeoutMs +
              "ms. Do not retry this js_exec in the same turn. " +
              "If a longer run is needed, start a new turn with a timeout up to " +
              maxTimeoutMs + "ms."
            );
            error.name = "CodeModeTimeoutError";
            reject(error);
          }, timeoutMs);
        }),
      ]);
      if (result !== undefined) output.push(stringifyOutput(result));
      if (output.length === 0) {
        // A silent blank reads as a rendering failure and sends agents down
        // rabbit holes. Common cause: the script's last statement is a block
        // (if/else, loop), so bare expressions inside it are evaluated and
        // discarded — only a top-level final expression is auto-returned.
        return {
          text:
            "(js_exec completed: no return value and no console output.) " +
            "To see results, return a value, end with a top-level expression (auto-returned; " +
            "expressions inside if/else or loop blocks are not), or print with console.log(...).",
        };
      }
      return { text: output.join("\n") };
    } catch (error) {
      if (error && error.name === "CodeModeTimeoutError") throw error;
      const formatted = formatRuntimeError(error);
      const prefix = output.length ? output.join("\n") + "\n\n" : "";
      throw new Error(prefix + "JavaScript execution failed: " + formatted);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      await browserRuntime.cleanup();
      cleanupSecureFetch();
      cleanupRuntimeGlobals();
    }
  }
}
`}`;
}
