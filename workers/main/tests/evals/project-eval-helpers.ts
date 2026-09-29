import { defaultProjectScaffoldFiles, type ProjectScaffoldTemplate } from "../../src/project-scaffold";
import {
  ProjectFilesystemClient,
  type WorkspaceFilesystemEnv,
  type WorkspaceProject,
} from "../../src/workspace-filesystem-do";

export type RuntimeItem = Record<string, unknown>;

export type RuntimeEvidence = {
  commands: string[];
  jsExecCodeBlocks: string[];
  tools: string[];
};

export type ProjectFileSnapshot = Record<string, string>;

export type ProjectFileDiff = {
  addedPaths: string[];
  removedPaths: string[];
  modifiedPaths: string[];
  changedPaths: string[];
};

export type WorkspaceFilesystemStub = {
  createProject(input: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    workspaceId?: unknown;
    backend?: unknown;
  }): Promise<WorkspaceProject>;
};

export async function seedDoProjectFiles(
  workspaceFs: WorkspaceFilesystemStub,
  testEnv: WorkspaceFilesystemEnv,
  input: {
    workspaceId: string;
    name: string;
    description: string;
    template?: ProjectScaffoldTemplate;
    resetNotebookExecution?: boolean;
    files: Record<string, string>;
  },
): Promise<{ project: WorkspaceProject; files: ProjectFilesystemClient }> {
  const template = input.template ?? "crud";
  const project = await workspaceFs.createProject({
    name: input.name,
    description: input.description,
    workspaceId: input.workspaceId,
    backend: "do-r2",
  });
  const files = new ProjectFilesystemClient(testEnv, project.id);
  for (const file of defaultProjectScaffoldFiles(input.name, template, input.name)) {
    const content = input.resetNotebookExecution && file.path.endsWith(".ipynb")
      ? clearNotebookExecutionState(file.content)
      : file.content;
    const written = await files.writeFile(file.path, content);
    if (!written.success) {
      throw new Error(`Failed to seed scaffold file ${file.path}: ${written.error ?? "unknown error"}`);
    }
  }
  for (const [path, content] of Object.entries(input.files)) {
    const seededContent = input.resetNotebookExecution && path.endsWith(".ipynb")
      ? clearNotebookExecutionState(content)
      : content;
    const written = await files.writeFile(path, seededContent);
    if (!written.success) {
      throw new Error(`Failed to seed fixture file ${path}: ${written.error ?? "unknown error"}`);
    }
  }
  return { project, files };
}

export function clearNotebookExecutionState(content: string): string {
  const notebook = JSON.parse(content) as Record<string, unknown>;
  if (!Array.isArray(notebook.cells)) {
    throw new Error("Notebook fixture must contain a cells array");
  }
  for (const rawCell of notebook.cells) {
    const cell = asRecord(rawCell);
    if (cell?.cell_type !== "code") continue;
    cell.execution_count = null;
    cell.outputs = [];
  }
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function runtimeToolName(item: RuntimeItem): string | undefined {
  return asString(item.tool)?.toLowerCase();
}

function isJsExecItem(item: RuntimeItem): boolean {
  const tool = runtimeToolName(item);
  return tool === "js_exec" || tool?.endsWith("__js_exec") === true;
}

function isExecutableCodePosition(code: string, targetIndex: number): boolean {
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < targetIndex; index += 1) {
    const char = code[index];
    const next = code[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    }
  }
  return !quote && !lineComment && !blockComment;
}

function callArgumentsAt(code: string, openParenIndex: number): string | undefined {
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = openParenIndex; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(openParenIndex + 1, index);
    }
  }
  return undefined;
}

function jsExecToolCalls(
  code: string,
  toolName: string,
): Array<{ index: number; argumentsText: string }> {
  // On the agent runtime code reaches chiridion's tools as `tools.camel__<name>`
  // (its MCP server's name, then `__`); the in-DO loop named them bare.
  const escaped = `(?:[a-z0-9_]+__)?${escapeRegex(toolName)}`;
  const patterns = [
    new RegExp(`\\btools\\s*\\.\\s*${escaped}\\s*\\(`, "gi"),
    new RegExp("\\btools\\s*\\[\\s*([\"'`])" + escaped + "\\1\\s*\\]\\s*\\(", "gi"),
    new RegExp("\\bcallTool\\s*\\(\\s*([\"'`])" + escaped + "\\1", "gi"),
  ];
  const calls: Array<{ index: number; argumentsText: string }> = [];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const index = match.index ?? -1;
      if (index < 0 || !isExecutableCodePosition(code, index)) continue;
      const openParenOffset = match[0].indexOf("(");
      if (openParenOffset < 0) continue;
      const argumentsText = callArgumentsAt(code, index + openParenOffset);
      if (argumentsText !== undefined) calls.push({ index, argumentsText });
    }
  }
  return calls.sort((left, right) => left.index - right.index);
}

function runtimeItemCallsTool(item: RuntimeItem, toolName: string): boolean {
  const expected = toolName.toLowerCase();
  const tool = runtimeToolName(item);
  if (tool === expected || tool?.endsWith(`__${expected}`)) return true;
  if (!isJsExecItem(item)) return false;
  const code = asString(asRecord(item.arguments)?.code) ?? "";
  return jsExecToolCalls(code, expected).length > 0;
}

function runtimeItemToolCallReferences(
  item: RuntimeItem,
  toolName: string,
  expectedText: string,
): boolean {
  const needle = expectedText.toLowerCase();
  if (isJsExecItem(item)) {
    const code = asString(asRecord(item.arguments)?.code) ?? "";
    return jsExecToolCalls(code, toolName)
      .some((call) => !needle || call.argumentsText.toLowerCase().includes(needle));
  }
  return runtimeItemCallsTool(item, toolName) &&
    (!needle || JSON.stringify(item.arguments ?? {}).toLowerCase().includes(needle));
}

function collectRuntimeItems(events: Array<Record<string, unknown>>): RuntimeItem[] {
  const items: RuntimeItem[] = [];
  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    if (event?.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(event.event);
    if (runtimeEvent?.method !== "item/completed") continue;
    const params = asRecord(runtimeEvent.params);
    const item = asRecord(params?.item);
    if (item) items.push(item);
  }
  return items;
}

export function collectRuntimeEvidence(
  events: Array<Record<string, unknown>>,
): RuntimeEvidence {
  const items = collectRuntimeItems(events);
  const jsExecCodeBlocks = items
    .filter(isJsExecItem)
    .map((item) => asString(asRecord(item.arguments)?.code) ?? "")
    .filter(Boolean);
  const topLevelCommands = items
    .filter((item) => item.type === "commandExecution")
    .map((item) => asString(item.command) ?? "")
    .filter(Boolean);
  const topLevelTools = items
    .map(runtimeToolName)
    .filter((tool): tool is string => Boolean(tool));
  return {
    commands: uniqueStrings(topLevelCommands),
    jsExecCodeBlocks,
    tools: uniqueStrings(topLevelTools),
  };
}

export function jsExecCodeMentionsTool(code: string, toolName: string): boolean {
  return jsExecToolCalls(code, toolName).length > 0;
}

export function usedTool(
  events: Array<Record<string, unknown>>,
  toolName: string,
  extraCodePatterns: RegExp[] = [],
): boolean {
  const expected = toolName.toLowerCase();
  const evidence = collectRuntimeEvidence(events);
  return (
    evidence.tools.some((tool) => tool === expected || tool.endsWith(`__${expected}`)) ||
    evidence.jsExecCodeBlocks.some((code) =>
      jsExecCodeMentionsTool(code, expected) ||
      extraCodePatterns.some((pattern) => pattern.test(stripComments(code)))
    )
  );
}

/**
 * Like `usedTool`, but requires the call to have actually SUCCEEDED.
 *
 * `usedTool` only proves a call was issued — it ignores status/isError, and it
 * additionally matches a tool name appearing in js_exec source text, so a block
 * that merely writes `tools.foo(...)` and then throws still counts. That is the
 * right semantics for NEGATIVE assertions ("did not reach for X") and the wrong
 * semantics for positive ones: an eval asserting a capability works must fail
 * when the capability is dead. A run where the analysis sandbox returned
 * "internal error" on 6 of 8 calls passed 7/7 criteria because of this.
 *
 * Prefer this for any pass/fail criterion that claims a tool worked.
 */
export function succeededWithTool(
  events: Array<Record<string, unknown>>,
  toolName: string,
): boolean {
  const expected = toolName.toLowerCase();
  const items = collectRuntimeItems(events);

  // A top-level call that succeeded.
  const succeededTopLevel = items.some((item) => {
    const tool = runtimeToolName(item);
    if (tool !== expected && !tool?.endsWith(`__${expected}`)) return false;
    return runtimeItemSucceeded(item);
  });
  if (succeededTopLevel) return true;

  // Or a SUCCEEDED js_exec whose code calls it. Lean-mode tools live only inside
  // js_exec (`tools.<name>()`) and emit no runtime item of their own, so
  // requiring a top-level item rejects the very path those evals are testing:
  // custom-domain-live and warehouse-list-live both failed this way while the
  // agent had in fact got a real answer — get_custom_domain returned
  // `{ ok: true, data: {...} }` from inside js_exec.
  //
  // Requiring the js_exec item itself to have succeeded is what separates this
  // from usedTool, which matches the tool name in code even when the block threw.
  return items.some(
    (item) =>
      isJsExecItem(item) &&
      runtimeItemSucceeded(item) &&
      jsExecCodeMentionsTool(asString(asRecord(item.arguments)?.code) ?? "", expected),
  );
}

export function toolCallReferences(
  events: Array<Record<string, unknown>>,
  toolName: string,
  expectedText: string,
): boolean {
  return collectRuntimeItems(events).some((item) => {
    const result = asRecord(item.result);
    const details = asRecord(result?.details);
    const failedOutcome = result?.ok === false || result?.success === false ||
      details?.ok === false || details?.success === false;
    return item.isError !== true && !failedOutcome &&
      asString(item.status)?.toLowerCase() === "completed" &&
      runtimeItemToolCallReferences(item, toolName, expectedText);
  });
}

/**
 * Whether the agent read `skill`'s `file` (its SKILL.md by default) with the
 * read_skill tool, which is how the agent runtime's model reads skills (the
 * in-DO loop read them as files: `read` of `<skill>/SKILL.md`).
 */
export function readSkillWithTool(
  events: Array<Record<string, unknown>>,
  skill: string,
  file = "SKILL.md",
): boolean {
  return collectRuntimeItems(events).some((item) => {
    if (!runtimeItemSucceeded(item) || asString(item.status)?.toLowerCase() !== "completed") return false;
    if (isJsExecItem(item)) {
      // From code: tools.camel__read_skill({ skill: "<skill>" }) (a file argument names another file).
      const code = asString(asRecord(item.arguments)?.code) ?? "";
      return jsExecToolCalls(code, "read_skill").some((call) =>
        call.argumentsText.includes(skill) &&
        (file === "SKILL.md" ? !/\bfile\s*:/.test(call.argumentsText) || call.argumentsText.includes("SKILL.md") : call.argumentsText.includes(file)));
    }
    const tool = runtimeToolName(item);
    if (tool !== "read_skill" && !tool?.endsWith("__read_skill")) return false;
    const args = asRecord(item.arguments);
    const readFile = asString(args?.file)?.trim() || "SKILL.md";
    return asString(args?.skill) === skill && readFile === file;
  });
}

export function completedToolDetails(
  events: Array<Record<string, unknown>>,
  toolName: string,
): Record<string, unknown> | undefined {
  const expected = toolName.toLowerCase();
  const item = collectRuntimeItems(events).find((candidate) => {
    const tool = runtimeToolName(candidate);
    return candidate.isError !== true &&
      asString(candidate.status)?.toLowerCase() === "completed" &&
      (tool === expected || tool?.endsWith(`__${expected}`));
  });
  return asRecord(asRecord(item?.result)?.details);
}

export function capabilityChildUsedTools(
  events: Array<Record<string, unknown>>,
  capability: string,
): string[] {
  const details = completedToolDetails(events, capability);
  return Array.isArray(details?.childToolsUsed)
    ? details.childToolsUsed.filter((value): value is string => typeof value === "string")
    : [];
}

export function toolProgressText(
  events: Array<Record<string, unknown>>,
  toolName: string,
): string[] {
  const expected = toolName.toLowerCase();
  const itemIds = new Set<string>();
  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    if (event?.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(event.event);
    if (runtimeEvent?.method !== "item/started") continue;
    const item = asRecord(asRecord(runtimeEvent.params)?.item);
    const tool = runtimeToolName(item ?? {});
    const id = asString(item?.id);
    if (id && (tool === expected || tool?.endsWith(`__${expected}`))) itemIds.add(id);
  }
  const deltas: string[] = [];
  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    if (event?.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(event.event);
    if (runtimeEvent?.method !== "item/commandExecution/outputDelta") continue;
    const params = asRecord(runtimeEvent.params);
    const itemId = asString(params?.itemId);
    const delta = asString(params?.delta);
    if (itemId && itemIds.has(itemId) && delta.trim()) deltas.push(delta.trim());
  }
  return deltas;
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function hasExplicitRuntimeFailure(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  const parsed = parseJsonText(value);
  if (Array.isArray(parsed)) {
    return parsed.some((entry) => hasExplicitRuntimeFailure(entry, depth + 1));
  }
  const record = asRecord(parsed);
  if (!record) return false;
  const status = asString(record.status)?.toLowerCase();
  if (
    record.success === false ||
    record.ok === false ||
    record.isError === true ||
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled"
  ) {
    return true;
  }
  return Object.values(record).some((entry) =>
    hasExplicitRuntimeFailure(entry, depth + 1)
  );
}

export function runtimeItemSucceeded(item: RuntimeItem): boolean {
  const status = asString(item.status)?.toLowerCase();
  if (
    item.isError === true ||
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled"
  ) {
    return false;
  }
  return !hasExplicitRuntimeFailure(item.result);
}

export function runtimeToolReferenceOrder(
  events: Array<Record<string, unknown>>,
  references: Array<{ id: string; toolName: string; expectedText: string }>,
): string[] {
  const ordered: string[] = [];
  for (const item of collectRuntimeItems(events)) {
    if (!runtimeItemSucceeded(item)) continue;
    if (isJsExecItem(item)) {
      const code = asString(asRecord(item.arguments)?.code) ?? "";
      const matches = references.flatMap((reference) => {
        const needle = reference.expectedText.toLowerCase();
        return jsExecToolCalls(code, reference.toolName)
          .filter((call) => !needle || call.argumentsText.toLowerCase().includes(needle))
          .map((call) => ({ index: call.index, id: reference.id }));
      });
      matches
        .sort((left, right) => left.index - right.index)
        .forEach((match) => ordered.push(match.id));
      continue;
    }
    for (const reference of references) {
      if (runtimeItemToolCallReferences(
        item,
        reference.toolName,
        reference.expectedText,
      )) {
        ordered.push(reference.id);
      }
    }
  }
  return ordered;
}

export function countNotebookErrorOutputs(cells: unknown[]): number {
  return cells
    .map(asRecord)
    .filter((cell): cell is Record<string, unknown> => Boolean(cell))
    .flatMap((cell) => Array.isArray(cell.outputs) ? cell.outputs : [])
    .map(asRecord)
    .filter((output): output is Record<string, unknown> => Boolean(output))
    .filter((output) =>
      output.output_type === "error" ||
      (Array.isArray(output.traceback) &&
        (typeof output.ename === "string" || typeof output.evalue === "string"))
    )
    .length;
}

function isCleanNotebookRunResult(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  const parsed = parseJsonText(value);
  if (Array.isArray(parsed)) {
    return parsed.some((item) => isCleanNotebookRunResult(item, depth + 1));
  }
  const record = asRecord(parsed);
  if (!record) return false;
  const validation = asRecord(record.validation);
  if (
    record.ok === true &&
    record.executed === true &&
    validation?.clean === true &&
    record.exitCode === 0
  ) {
    return true;
  }
  return [record.data, record.details, record.content, record.text]
    .some((candidate) => isCleanNotebookRunResult(candidate, depth + 1));
}

function normalizeProjectPath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

function notebookRunResultReferencesPath(
  value: unknown,
  expectedPath: string,
  depth = 0,
): boolean {
  if (depth > 6) return false;
  const parsed = typeof value === "string"
    ? parseJsonText(value) ?? value
    : value;
  const expected = normalizeProjectPath(expectedPath);
  if (typeof parsed === "string") {
    return normalizeProjectPath(parsed) === expected;
  }
  if (Array.isArray(parsed)) {
    return parsed.some((entry) =>
      notebookRunResultReferencesPath(entry, expected, depth + 1)
    );
  }
  const record = asRecord(parsed);
  if (!record) return false;
  const directPathFields = [record.path, record.notebook, record.notebookPath];
  if (directPathFields.some((entry) =>
    typeof entry === "string" && normalizeProjectPath(entry) === expected
  )) {
    return true;
  }
  return [
    record.changedFiles,
    record.data,
    record.details,
    record.content,
    record.text,
  ].some((candidate) =>
    notebookRunResultReferencesPath(candidate, expected, depth + 1)
  );
}

export function hasSuccessfulNotebookRun(
  events: Array<Record<string, unknown>>,
  expectedPath: string,
): boolean {
  return collectRuntimeItems(events).some((item) => {
    if (!runtimeItemCallsTool(item, "run_notebook")) return false;
    if (item.status !== "completed" || !runtimeItemSucceeded(item)) return false;
    if (!isCleanNotebookRunResult(item.result)) return false;
    return runtimeItemToolCallReferences(item, "run_notebook", expectedPath) ||
      notebookRunResultReferencesPath(item.result, expectedPath);
  });
}

export function runtimeToolMentionOrder(
  events: Array<Record<string, unknown>>,
  toolNames: string[],
): string[] {
  const expected = toolNames.map((toolName) => toolName.toLowerCase());
  const ordered: string[] = [];
  for (const item of collectRuntimeItems(events)) {
    if (!runtimeItemSucceeded(item)) continue;
    const tool = runtimeToolName(item);
    if (tool && expected.some((name) => tool === name || tool.endsWith(`__${name}`))) {
      ordered.push(tool.includes("__") ? tool.slice(tool.lastIndexOf("__") + 2) : tool);
    }
    if (!isJsExecItem(item)) continue;
    const code = asString(asRecord(item.arguments)?.code) ?? "";
    const stripped = stripComments(code);
    const matches = expected.flatMap((toolName) =>
      jsExecToolCalls(stripped, toolName).map((call) => ({
        index: call.index,
        toolName,
      })),
    );
    matches
      .sort((left, right) => left.index - right.index)
      .forEach((match) => ordered.push(match.toolName));
  }
  return ordered;
}

export async function snapshotProjectFiles(
  files: Pick<ProjectFilesystemClient, "listFiles" | "readFile">,
): Promise<ProjectFileSnapshot> {
  const listing = await files.listFiles("/", {
    recursive: true,
    includeHidden: true,
    limit: 50_000,
  });
  if (!listing.success) {
    throw new Error(listing.error ?? "Failed to list project files for snapshot");
  }
  const snapshot: ProjectFileSnapshot = {};
  for (const entry of listing.files) {
    if (entry.type !== "file") continue;
    const path = entry.absolutePath || `/${entry.relativePath || entry.name}`;
    const read = await files.readFile(path);
    if (!read.success || typeof read.content !== "string") {
      throw new Error(read.error ?? `Failed to read ${path} for snapshot`);
    }
    snapshot[path] = JSON.stringify({
      encoding: read.encoding ?? "utf8",
      content: read.content,
    });
  }
  return Object.fromEntries(
    Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function diffProjectFileSnapshots(
  before: ProjectFileSnapshot,
  after: ProjectFileSnapshot,
): ProjectFileDiff {
  const beforePaths = new Set(Object.keys(before));
  const afterPaths = new Set(Object.keys(after));
  const addedPaths = [...afterPaths].filter((path) => !beforePaths.has(path)).sort();
  const removedPaths = [...beforePaths].filter((path) => !afterPaths.has(path)).sort();
  const modifiedPaths = [...beforePaths]
    .filter((path) => afterPaths.has(path) && before[path] !== after[path])
    .sort();
  return {
    addedPaths,
    removedPaths,
    modifiedPaths,
    changedPaths: [...addedPaths, ...removedPaths, ...modifiedPaths].sort(),
  };
}

export function legacyDeployPathEvidence(
  events: Array<Record<string, unknown>>,
): string[] {
  const evidence = collectRuntimeEvidence(events);
  const failures: string[] = [];

  // DO-backed projects must build/deploy through the platform tools, never by
  // shelling out to create-worker / wrangler / create-cloudflare.
  const legacyDeployPattern =
    /\b(create-worker|bun\s+run\s+deploy|wrangler\s+deploy|wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i;

  const topLevelDeployCommands = evidence.commands.filter((command) =>
    legacyDeployPattern.test(command),
  );
  if (topLevelDeployCommands.length) {
    failures.push(
      `used legacy deploy command(s): ${topLevelDeployCommands.join(", ")}`,
    );
  }

  const jsExecLegacyDeploy = evidence.jsExecCodeBlocks.some((code) =>
    legacyDeployPattern.test(stripComments(code)),
  );
  if (jsExecLegacyDeploy) {
    failures.push("used a legacy scaffold or deploy command inside js_exec");
  }

  return failures;
}

export function resolveFetchAttempts(
  init?: RequestInit,
  attempts?: number,
): number | undefined {
  if (attempts !== undefined) return attempts;
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD" ? undefined : 1;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  attempts?: number,
): Promise<Response> {
  let lastError: unknown;
  const method = (init?.method ?? "GET").toUpperCase();
  const canRetryResponse = method === "GET" || method === "HEAD";
  const maxAttempts = resolveFetchAttempts(init, attempts) ?? 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const shouldRetryStatus =
        response.status === 404 ||
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500;
      if (!canRetryResponse || !shouldRetryStatus || attempt === maxAttempts - 1) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
      try {
        await response.body?.cancel();
      } catch {
        // Best effort: avoid leaking retried response bodies in the eval harness.
      }
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
