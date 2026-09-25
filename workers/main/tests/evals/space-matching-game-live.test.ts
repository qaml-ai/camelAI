import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreCriterion,
  scoreLatestPreview,
  scoreSignalEfficiency,
} from "./eval-criteria";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";
import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import {
  assertDeployedApp,
  countWorkspaceApps,
  fetchJsonWithRetry,
  type EvalDeployedApp,
} from "./eval-deploy-assert";
import { emitEvalTranscript } from "./eval-transcript";
import type { ChatThreadDO } from "../../src/chat-thread-do";
import {
  ProjectFilesystemClient,
  type WorkspaceFilesystemDO,
  type WorkspaceFilesystemEnv,
  type WorkspaceProject,
} from "../../src/workspace-filesystem-do";
import { legacyDeployPathEvidence } from "./project-eval-helpers";

type SpaceMatchingGameEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  APP_DB?: D1Database;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

type RuntimeItem = Record<string, unknown>;

type RuntimeEvidence = {
  commands: string[];
  jsExecCodeBlocks: string[];
  jsExecResultTexts: string[];
  tools: string[];
};

type SourceFile = {
  path: string;
  text: string;
  size: number;
};

type SourceInspection = {
  appDir?: string;
  checkedFiles: string[];
  sourceFiles: Array<{ path: string; size: number }>;
  taskFiles?: string[];
  packageName?: string;
  deployScript?: string;
  signalHits: Record<string, string[]>;
  persistenceFiles: string[];
  failures: string[];
  error?: string;
};

type ProjectMetadata = {
  id: string;
  name: string;
  description: string;
  defaultVmId: string;
  kind?: WorkspaceProject["kind"];
  clonedFromProjectId?: string;
  artifactRemote?: string;
  artifactStatus?: WorkspaceProject["artifactStatus"];
  createdAt: string;
  updatedAt: string;
};

type ProjectCreationInspection = {
  initialProjects: ProjectMetadata[];
  finalProjects: ProjectMetadata[];
  newProjects: ProjectMetadata[];
  selectedProject?: ProjectMetadata;
  failures: string[];
};

type SourceInspectionCandidate = {
  project: ProjectMetadata;
  score: number;
  appDir?: string;
  packageName?: string;
  deployScript?: string;
  sourceFileCount: number;
  failures: string[];
};

type PageSmoke = {
  url?: string;
  status?: number;
  bodyLength?: number;
  errorStrings: string[];
  error?: string;
  attempts?: number;
};

const EVAL_ID = "space-matching-game-live";
const APP_NAME_HINTS = [
  "space-matching-game",
  "space-game",
  "matching-game",
  "space-memory",
  "memory-game",
];
const testEnv = env as unknown as SpaceMatchingGameEvalEnv;
// This eval needs the real testing-grounds deploy path because it asserts a live app.
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 900_000);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function relativeToAppDir(appDir: string, path: string): string {
  const base = appDir.replace(/\/+$/, "");
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path.replace(/^\/+/, "");
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function lowerText(value: unknown): string {
  return JSON.stringify(value).toLowerCase();
}

// Real code spells these concepts as compound identifiers — LeaderboardDO, addScore,
// getLeaderboard, time_seconds — and hasTerm's word boundaries can never match inside
// them, so a genuine DO+SQLite leaderboard scored zero persistence/task hits
// (run eval-20260702-081333Z-6c9ef776). Split camelCase and snake_case into words
// before matching game/persistence vocabulary.
function searchableSourceText(text: string): string {
  return stripComments(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTerm(text: string, term: string): boolean {
  const pattern = escapeRegex(term.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9_])${pattern}([^a-z0-9_]|$)`, "i").test(text);
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => hasTerm(text, term));
}

function hitsFor(text: string, terms: string[]): string[] {
  return terms.filter((term) => hasTerm(text, term));
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function projectMetadata(project: WorkspaceProject): ProjectMetadata {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    defaultVmId: project.defaultVmId,
    kind: project.kind,
    clonedFromProjectId: project.clonedFromProjectId,
    artifactRemote: project.artifactRemote,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function diffNewProjects(
  initialProjects: WorkspaceProject[],
  finalProjects: WorkspaceProject[],
): WorkspaceProject[] {
  const initialIds = new Set(initialProjects.map((project) => project.id));
  return finalProjects.filter((project) => !initialIds.has(project.id));
}

function describeProjects(projects: WorkspaceProject[]): string {
  return projects
    .map((project) => `${project.name} (${project.id})`)
    .join(", ");
}

function buildProjectCreationInspection(
  initialProjects: WorkspaceProject[],
  finalProjects: WorkspaceProject[],
  selectedProject?: WorkspaceProject,
): ProjectCreationInspection {
  const newProjects = diffNewProjects(initialProjects, finalProjects);
  const failures: string[] = [];
  if (initialProjects.length > 0) {
    failures.push(
      `harness/environment failure: workspace started with existing project(s): ${
        describeProjects(initialProjects)
      }`,
    );
  } else if (newProjects.length === 0) {
    failures.push("agent failed to create a project from the empty workspace");
  }

  return {
    initialProjects: initialProjects.map(projectMetadata),
    finalProjects: finalProjects.map(projectMetadata),
    newProjects: newProjects.map(projectMetadata),
    selectedProject: selectedProject ? projectMetadata(selectedProject) : undefined,
    failures,
  };
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

function resultText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value : "";
  const text = asString(record.text);
  if (text) return text;
  const content = record.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => asString(asRecord(part)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function extractJsStringLiterals(code: string): string[] {
  const literals: string[] = [];
  const pattern = /(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    literals.push(match[2]);
  }
  return literals;
}

function extractCommandEvidenceFromJsExec(code: string): string[] {
  const commandSignal =
    /\b(create-worker|bun\s+run\s+deploy|wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i;
  const stripped = stripComments(code);
  return uniqueStrings(
    extractJsStringLiterals(stripped).filter((literal) =>
      commandSignal.test(literal),
    ),
  );
}

function jsExecCodeMentionsTool(code: string, toolName: string): boolean {
  const stripped = stripComments(code);
  const escaped = escapeRegex(toolName);
  return [
    new RegExp(`\\btools\\s*\\.\\s*${escaped}\\s*\\(`, "i"),
    new RegExp(`\\btools\\s*\\[\\s*(["'\`])${escaped}\\1\\s*\\]\\s*\\(`, "i"),
    new RegExp(`\\bcallTool\\s*\\(\\s*(["'\`])${escaped}\\1`, "i"),
  ].some((pattern) => pattern.test(stripped));
}

function collectRuntimeEvidence(events: Array<Record<string, unknown>>): RuntimeEvidence {
  const items = collectRuntimeItems(events);
  const jsExecCodeBlocks = items
    .filter(isJsExecItem)
    .map((item) => asString(asRecord(item.arguments)?.code) ?? "")
    .filter(Boolean);
  const jsExecResultTexts = items
    .filter(isJsExecItem)
    .map((item) => resultText(item.result))
    .filter(Boolean);

  const topLevelCommands = items
    .filter((item) => item.type === "commandExecution")
    .map((item) => asString(item.command) ?? "")
    .filter(Boolean);
  const jsExecCommands = jsExecCodeBlocks.flatMap(extractCommandEvidenceFromJsExec);
  const topLevelTools = items
    .map(runtimeToolName)
    .filter((tool): tool is string => Boolean(tool));

  return {
    commands: uniqueStrings([...topLevelCommands, ...jsExecCommands]),
    jsExecCodeBlocks,
    jsExecResultTexts,
    tools: uniqueStrings(topLevelTools),
  };
}

function usedTool(events: Array<Record<string, unknown>>, toolName: string): boolean {
  const expected = toolName.toLowerCase();
  const evidence = collectRuntimeEvidence(events);
  return (
    evidence.tools.some((tool) => tool === expected || tool.endsWith(`__${expected}`)) ||
    evidence.jsExecCodeBlocks.some((code) => jsExecCodeMentionsTool(code, expected))
  );
}

const APP_URL_PATTERN = /https?:\/\/[^\s"'`\\]+/i;

// Extract every parseable JSON object embedded in free-form js_exec output (which
// typically interleaves logs with JSON.stringify'd tool results).
function extractJsonObjects(text: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("{", index);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      index = start + 1;
      continue;
    }
    try {
      const record = asRecord(JSON.parse(text.slice(start, end + 1)));
      if (record) objects.push(record);
      index = end + 1;
    } catch {
      index = start + 1;
    }
  }
  return objects;
}

// True when the object looks like a *successful* deploy_project result carrying the
// live app URL: an explicit success marker (success/ok/buildSuccess true, or a
// sourceSnapshot — deploy_project result fields) plus a url/appUrl field with an
// http(s) URL on the same object. Explicitly failed envelopes (ok:false /
// success:false) never count and are not recursed into; unmarked wrapper objects are
// searched for a nested deploy result.
function isSuccessfulDeployResultObject(record: Record<string, unknown>): boolean {
  if (record.success === false || record.ok === false) return false;
  const url = [record.url, record.appUrl].find(
    (value): value is string => typeof value === "string" && APP_URL_PATTERN.test(value),
  );
  const marked =
    record.success === true ||
    record.ok === true ||
    record.buildSuccess === true ||
    asRecord(record.sourceSnapshot) !== undefined;
  if (url && marked) return true;
  return Object.values(record).some((value) => {
    const nested = asRecord(value);
    return nested ? isSuccessfulDeployResultObject(nested) : false;
  });
}

// A deploy_project call only substitutes for list_apps when it actually delivered the
// live app URL: the result (top-level item or js_exec output) must contain a
// successful deploy result *object* whose own url/appUrl carries the URL. This
// matters even for top-level items with a non-failed status, because deploy_project
// returns completed { success: false, stage: "build"|"deploy", ... } envelopes on
// build/deploy failures rather than throwing (see code-mode-tools.ts) — so an
// incidental docs/log URL in a failure summary must not count.
function deployProjectYieldedAppUrl(events: Array<Record<string, unknown>>): boolean {
  return collectRuntimeItems(events).some((item) => {
    const tool = runtimeToolName(item);
    if (tool === "deploy_project" || tool?.endsWith("__deploy_project") === true) {
      if (item.status === "failed") return false;
      return extractJsonObjects(resultText(item.result)).some(isSuccessfulDeployResultObject);
    }
    if (isJsExecItem(item)) {
      const code = asString(asRecord(item.arguments)?.code) ?? "";
      if (!jsExecCodeMentionsTool(code, "deploy_project")) return false;
      return extractJsonObjects(resultText(item.result)).some(isSuccessfulDeployResultObject);
    }
    return false;
  });
}

function readDevelopingSoftwareSkill(
  events: Array<Record<string, unknown>>,
): boolean {
  const evidence = collectRuntimeEvidence(events);
  if (collectRuntimeItems(events).some((item) => {
    const tool = asString(item.tool)?.toLowerCase();
    if (tool !== "read") return false;
    const args = asRecord(item.arguments);
    const result = asRecord(item.result);
    const details = asRecord(result?.details);
    const pathText = [
      asString(args?.path),
      asString(details?.path),
    ].filter(Boolean).join(" ").toLowerCase();
    const itemText = lowerText(item);
    return (
      pathText.includes("developing-software/skill.md") &&
      (
        details?.source === "bundled_skill" ||
        itemText.includes("deploying software to cloudflare") ||
        itemText.includes("use `create-worker`")
      )
    );
  })) {
    return true;
  }

  return (
    evidence.jsExecCodeBlocks.some((code) => {
      const lowerCode = stripComments(code).toLowerCase();
      return (
        lowerCode.includes("developing-software/skill.md") &&
        jsExecCodeMentionsTool(code, "read")
      );
    }) ||
    evidence.jsExecResultTexts.some((text) => {
      const lower = text.toLowerCase();
      return (
        lower.includes("deploying software to cloudflare") ||
        lower.includes("use `create-worker`")
      );
    })
  );
}

function evaluateRuntimeAssertions(
  result: { events: Array<Record<string, unknown>> },
): {
  commands: string[];
  failures: string[];
  usedCreateProject: boolean;
  usedDeployProject: boolean;
} {
  const evidence = collectRuntimeEvidence(result.events);
  const commands = evidence.commands;
  const commandSignalText = [
    ...commands,
    ...evidence.jsExecCodeBlocks.map(stripComments),
  ].join("\n").toLowerCase();
  const failures: string[] = [];

  // The live path is create_project + deploy_project; deploy_project returns the URL directly.
  const usedCreateProject = usedTool(result.events, "create_project");
  const usedDeployProject = usedTool(result.events, "deploy_project");

  if (!readDevelopingSoftwareSkill(result.events)) {
    failures.push("agent did not read developing-software/SKILL.md");
  }
  if (!/\bcreate-worker\b/.test(commandSignalText) && !usedCreateProject) {
    failures.push("agent did not run the create-worker scaffold command");
  }
  if (!/\bbun\s+run\s+deploy\b/.test(commandSignalText) && !usedDeployProject) {
    failures.push("agent did not run bun run deploy");
  }
  // Only a deploy_project that actually returned the app URL substitutes for
  // list_apps; a failed or URL-less deploy_project must still flag the miss.
  if (
    !usedTool(result.events, "list_apps") &&
    !(usedDeployProject && deployProjectYieldedAppUrl(result.events))
  ) {
    failures.push("agent did not call list_apps after deploy");
  }
  if (
    !usedTool(result.events, "set_preview") &&
    !(usedDeployProject && deployProjectYieldedAppUrl(result.events))
  ) {
    failures.push("agent did not preview the deployed app");
  }

  const wrongScaffoldCommands = commands.filter((command) =>
    /\b(wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i
      .test(command),
  );
  if (
    wrongScaffoldCommands.length === 0 &&
    evidence.jsExecCodeBlocks.some((code) =>
      /\b(wrangler\s+init|npm\s+create\s+cloudflare|pnpm\s+create\s+cloudflare|yarn\s+create\s+cloudflare)\b/i
        .test(stripComments(code)),
    )
  ) {
    wrongScaffoldCommands.push("js_exec code referenced unsupported scaffold command");
  }
  if (wrongScaffoldCommands.length > 0) {
    failures.push(
      `agent used unsupported scaffold command(s): ${wrongScaffoldCommands.join(" | ")}`,
    );
  }

  return { commands, failures, usedCreateProject, usedDeployProject };
}

function buildPostDeployToolCriteria(
  runtimeAssertions: { failures: string[] },
  options: { deployProjectProvidedAppUrl?: boolean } = {},
) {
  const listAppsFailure = runtimeAssertions.failures.find((failure) =>
    failure.includes("list_apps"),
  );
  const previewFailure = runtimeAssertions.failures.find((failure) =>
    failure.includes("preview"),
  );
  // deploy_project returns the live app URL directly, so a successful deploy_project
  // whose result carried the app URL is equivalent evidence to calling list_apps.
  const listAppsPassed =
    !listAppsFailure || options.deployProjectProvidedAppUrl === true;

  return [
    passFailCriterion({
      id: "called_list_apps",
      label: "Agent called list_apps after deploy (or deploy_project returned the app URL)",
      passed: listAppsPassed,
      reason: listAppsPassed ? undefined : listAppsFailure,
      details: {
        failures: runtimeAssertions.failures,
        deployProjectProvidedAppUrl: options.deployProjectProvidedAppUrl === true,
      },
    }),
    passFailCriterion({
      id: "called_set_preview",
      label: "Latest deployed app was opened in preview",
      passed: !previewFailure || options.deployProjectProvidedAppUrl === true,
      reason: options.deployProjectProvidedAppUrl === true ? undefined : previewFailure,
      details: {
        failures: runtimeAssertions.failures,
        deployProjectProvidedAppUrl: options.deployProjectProvidedAppUrl === true,
      },
    }),
  ];
}

function inspectCollectedSource(
  appDir: string,
  sourceFiles: SourceFile[],
): SourceInspection {
  const textByBasename = new Map(
    sourceFiles.map((file) => [relativeToAppDir(appDir, file.path), file.text]),
  );
  const packageJson = parseJsonObject(textByBasename.get("package.json"));
  const scripts = asRecord(packageJson.scripts) ?? {};
  const dependencies = asRecord(packageJson.dependencies) ?? {};
  const devDependencies = asRecord(packageJson.devDependencies) ?? {};
  const componentsJson = parseJsonObject(textByBasename.get("components.json"));
  const wrangler = textByBasename.get("wrangler.jsonc") ?? "";
  const activeWrangler = stripComments(wrangler).toLowerCase();
  const activeSourceText = sourceFiles
    .map((file) => stripComments(file.text))
    .join("\n")
    .toLowerCase();
  const taskTerms = [
    "matching",
    "match",
    "memory",
    "leaderboard",
    "score",
    "space",
    "planet",
    "star",
    "stars",
    "rocket",
    "galaxy",
    "card",
    "tile",
  ];
  const taskFiles = sourceFiles.filter((file) =>
    containsAny(searchableSourceText(file.text), taskTerms),
  );
  const taskSourceText = taskFiles
    .map((file) => searchableSourceText(file.text))
    .join("\n");

  const signalTerms = {
    matchingGame: [
      "matching",
      "match",
      "memory",
      "card",
      "cards",
      "tile",
      "tiles",
      "flip",
      "flipped",
      "matched",
      "shuffle",
    ],
    leaderboard: ["leaderboard", "score", "high score", "best score"],
    credentials: [
      "credential",
      "credentials",
      "username",
      "player",
      "players",
      "player name",
      "email",
      "password",
      // Name-entry vocabulary: a leaderboard "credential" is often just a display
      // name (e.g. "Enter your name", placeholder "Your callsign...").
      "callsign",
      "nickname",
      "gamertag",
      "initials",
      "your name",
      "enter a name",
    ],
    spaceTheme: [
      "space",
      "planet",
      "planets",
      "star",
      "stars",
      "galaxy",
      "rocket",
      "astronaut",
      "nebula",
      "orbit",
      "cosmic",
      "asteroid",
      "moon",
      "comet",
    ],
  };
  const signalHits = Object.fromEntries(
    Object.entries(signalTerms).map(([name, terms]) => [
      name,
      hitsFor(taskSourceText, terms),
    ]),
  );

  const persistenceFiles = sourceFiles
    .filter((file) => {
      const text = searchableSourceText(file.text);
      return (
        containsAny(text, [
          // "durable object" is what searchableSourceText makes of DurableObject;
          // keep the joined form for sources that already spell it lowercase.
          "durable object",
          "durableobject",
          "storage.sql",
          "ctx.storage.sql",
          "sql.exec",
          "create table",
        ]) &&
        containsAny(text, ["score", "leaderboard", "player", "credential", "user"])
      );
    })
    .map((file) => relativeToAppDir(appDir, file.path));

  const failures: string[] = [];
  const deployScript = asString(scripts.deploy);
  if (!dependencies["react-router"] || !dependencies.react || !dependencies["react-dom"]) {
    failures.push("package.json is missing React/React Router scaffold dependencies");
  }
  // The DO-backed create_project scaffold builds with @react-router/dev + esbuild
  // (no @cloudflare/vite-plugin) and deploys through deploy_project.
  if (!devDependencies["@react-router/dev"] || !devDependencies.wrangler) {
    failures.push("package.json is missing React Router/Wrangler dev dependencies");
  }
  if (
    componentsJson["$schema"] !== "https://ui.shadcn.com/schema.json" ||
    componentsJson.tsx !== true ||
    componentsJson.iconLibrary !== "lucide" ||
    !asRecord(componentsJson.tailwind)
  ) {
    failures.push("components.json does not look like a shadcn/ui configuration");
  }
  if (!activeWrangler.includes('"main": "./workers/app.ts"')) {
    failures.push("wrangler.jsonc does not point at the create-worker Worker entrypoint");
  }
  if (!activeWrangler.includes('"assets"') || !activeWrangler.includes('"binding": "assets"')) {
    failures.push("wrangler.jsonc is missing the create-worker static assets binding");
  }
  if (!activeSourceText.includes("@react-router/dev/routes")) {
    failures.push("app source is missing React Router route configuration");
  }
  if (
    !activeWrangler.includes('"durable_objects"') ||
    !activeWrangler.includes('"new_sqlite_classes"') ||
    persistenceFiles.length === 0
  ) {
    failures.push("source does not show leaderboard persistence with Durable Objects + SQLite");
  }
  if (signalHits.matchingGame.length < 4) {
    failures.push("source does not show enough matching-game mechanics");
  }
  if (signalHits.leaderboard.length < 2) {
    failures.push("source does not show leaderboard/high-score behavior");
  }
  // A single vocabulary hit is enough when the source also shows concrete text-input
  // + submit markup (a genuine name-entry flow may only say e.g. "username" once).
  // An app with no entry flow at all still fails: zero hits, or no form markup.
  const hasEntryFormMarkup =
    /\b(input|textarea)\b/i.test(taskSourceText) &&
    /\b(form|onsubmit|submit|button)\b/i.test(taskSourceText);
  if (
    signalHits.credentials.length < 1 ||
    (signalHits.credentials.length < 2 && !hasEntryFormMarkup) ||
    !/\b(input|form|action|method=["']post|onsubmit|submit)\b/i.test(taskSourceText)
  ) {
    failures.push("source does not show a credential/name entry flow for high scores");
  }
  if (signalHits.spaceTheme.length < 3) {
    failures.push("source does not show a clear space theme");
  }

  return {
    appDir,
    checkedFiles: sourceFiles.map((file) => relativeToAppDir(appDir, file.path)),
    sourceFiles: sourceFiles.map((file) => ({
      path: relativeToAppDir(appDir, file.path),
      size: file.size,
    })),
    taskFiles: taskFiles.map((file) => relativeToAppDir(appDir, file.path)),
    packageName: asString(packageJson.name),
    deployScript,
    signalHits,
    persistenceFiles,
    failures,
  };
}

// DO-backed (create_project) project files live in WorkspaceFilesystemDO, not in the
// sandbox container filesystem, so read them through ProjectFilesystemClient instead of
// the project runtime fs API.
async function collectDoProjectSourceFiles(
  fsEnv: WorkspaceFilesystemEnv,
  projectId: string,
): Promise<SourceFile[]> {
  const client = new ProjectFilesystemClient(fsEnv, projectId);
  const listing = await client.listFiles("/", { recursive: true, limit: 2000 });
  if (!listing.success) return [];

  const sourceExtension = /\.(?:tsx?|jsx?|css|json|jsonc)$/i;
  const excluded =
    /(?:^|\/)(node_modules|\.wrangler|\.react-router|dist|build|public|coverage)(?:\/|$)|bun\.lock$/;
  const sourceFiles: SourceFile[] = [];
  for (const entry of listing.files) {
    if (entry.type !== "file") continue;
    const filePath = entry.absolutePath || `/${entry.relativePath ?? entry.name}`;
    if (excluded.test(filePath) || !sourceExtension.test(filePath)) continue;
    const read = await client.readFile(filePath);
    if (!read.success || read.isBinary || typeof read.content !== "string") continue;
    sourceFiles.push({ path: filePath, text: read.content, size: read.content.length });
  }
  return sourceFiles.sort((a, b) => a.path.localeCompare(b.path));
}

async function inspectDoBackedProjectSource(
  fsEnv: WorkspaceFilesystemEnv,
  projectId: string,
): Promise<SourceInspection> {
  try {
    const sourceFiles = await collectDoProjectSourceFiles(fsEnv, projectId);
    const hasPackageJson = sourceFiles.some(
      (file) => relativeToAppDir("/", file.path) === "package.json",
    );
    if (!hasPackageJson) {
      return {
        checkedFiles: sourceFiles.map((file) => file.path),
        sourceFiles: sourceFiles.map((file) => ({ path: file.path, size: file.size })),
        signalHits: {},
        persistenceFiles: [],
        failures: ["could not read DO-backed project source with a package.json"],
      };
    }
    return inspectCollectedSource("/", sourceFiles);
  } catch (error) {
    return {
      checkedFiles: [],
      sourceFiles: [],
      signalHits: {},
      persistenceFiles: [],
      failures: ["DO-backed source inspection failed"],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function missingProjectSourceInspection(): SourceInspection {
  return {
    checkedFiles: [],
    sourceFiles: [],
    signalHits: {},
    persistenceFiles: [],
    failures: ["agent did not create a project for source inspection"],
  };
}

// Freshly deployed apps can 5xx for a few seconds after session end while DO
// migrations/dispatch routing propagate; the same URL settles shortly after. Retry
// with backoff so deployed_app_live and important_pages_load_without_server_error
// test steady-state behavior, not the propagation window — but still fail hard if
// the app keeps 5xxing (or erroring) after all attempts.
const SMOKE_FETCH_ATTEMPTS = 4;
const SMOKE_FETCH_BACKOFF_MS = [3_000, 8_000, 15_000];

async function smokeFetchRoot(app: EvalDeployedApp | undefined): Promise<PageSmoke> {
  if (!app) {
    return {
      errorStrings: [],
      error: "No deployed app URL was captured.",
    };
  }
  let last: PageSmoke = {
    url: app.url,
    errorStrings: [],
    error: "smoke fetch did not run",
  };
  for (let attempt = 1; attempt <= SMOKE_FETCH_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, SMOKE_FETCH_BACKOFF_MS[attempt - 2]),
      );
    }
    try {
      const response = await fetch(app.url, { redirect: "follow" });
      const body = await response.text();
      const lower = body.toLowerCase();
      const errorStrings = [
        "oops",
        "application error",
        "internal server error",
        "cannot get",
        "exception",
      ].filter((term) => lower.includes(term));
      last = {
        url: app.url,
        status: response.status,
        bodyLength: body.length,
        errorStrings,
        attempts: attempt,
      };
      // Only 5xx responses are treated as (possibly) transient; anything else is
      // the app's steady-state answer.
      if (response.status < 500) return last;
    } catch (error) {
      last = {
        url: app.url,
        errorStrings: [],
        error: error instanceof Error ? error.message : String(error),
        attempts: attempt,
      };
    }
  }
  return last;
}

function sourceInspectionScore(inspection: SourceInspection): number {
  const signalHitCount = Object.values(inspection.signalHits).reduce(
    (total, hits) => total + hits.length,
    0,
  );
  return (
    (inspection.appDir ? 20 : 0) +
    inspection.sourceFiles.length +
    signalHitCount +
    (inspection.deployScript ? 5 : 0) +
    (inspection.persistenceFiles.length > 0 ? 5 : 0) -
    inspection.failures.length * 25
  );
}

async function inspectCreatedProjectSources(
  fsEnv: WorkspaceFilesystemEnv,
  projects: WorkspaceProject[],
): Promise<{
  selectedProject?: WorkspaceProject;
  sourceInspection: SourceInspection;
  sourceInspectionCandidates: SourceInspectionCandidate[];
}> {
  const inspected = await Promise.all(
    projects.map(async (project) => {
      const inspection = await inspectDoBackedProjectSource(fsEnv, project.id);
      return {
        project,
        inspection,
        score: sourceInspectionScore(inspection),
      };
    }),
  );
  const selected = inspected.sort((a, b) => b.score - a.score)[0];

  return {
    selectedProject: selected?.project,
    sourceInspection: selected?.inspection ?? missingProjectSourceInspection(),
    sourceInspectionCandidates: inspected.map(({ project, inspection, score }) => ({
      project: projectMetadata(project),
      score,
      appDir: inspection.appDir,
      packageName: inspection.packageName,
      deployScript: inspection.deployScript,
      sourceFileCount: inspection.sourceFiles.length,
      failures: inspection.failures,
    })),
  };
}

function completedRuntimeItem(item: RuntimeItem): Record<string, unknown> {
  return {
    type: "runtime_event",
    event: {
      method: "item/completed",
      params: { item },
    },
  };
}

describe("space matching game runtime assertion extraction", () => {
  it("does not treat bare tool-name mentions as tool calls", () => {
    expect(jsExecCodeMentionsTool('const next = "list_apps";', "list_apps")).toBe(false);
    expect(jsExecCodeMentionsTool("list_apps;", "list_apps")).toBe(false);
    expect(jsExecCodeMentionsTool("await tools.list_apps({});", "list_apps")).toBe(true);
    expect(jsExecCodeMentionsTool('await callTool("set_preview", {});', "set_preview")).toBe(true);
  });

  it("accepts the top-level create_project plus js_exec deploy path", () => {
    const code = `
      await tools.read({ location: "workspace", path: "developing-software/SKILL.md" });
      await tools.deploy_project({ project: "space-matching-game" });
      await tools.set_preview({ app_name: "space-matching-game" });
    `;
    const runtimeAssertions = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "create_project",
          arguments: { name: "space-matching-game", description: "Space game" },
          result: { content: [{ type: "text", text: "created" }] },
        }),
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          arguments: { code },
          result: { content: [{ type: "text", text: '{ "success": true, "url": "https://space-matching-game.evals.camelai.app" }' }] },
        }),
      ],
    });

    expect(runtimeAssertions.failures).toEqual([]);
    expect(runtimeAssertions.commands).toEqual([]);
  });

  it("detects unsupported scaffold commands inside js_exec", () => {
    const runtimeAssertions = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          arguments: {
            code: `
              await tools.read({ location: "workspace", path: "developing-software/SKILL.md" });
              await vm.exec({ project: "space", command: "npm create cloudflare@latest space" });
              await vm.exec({ project: "space", command: "bun run deploy" });
              await tools.list_apps({});
              await tools.set_preview({ app_name: "space" });
            `,
          },
          result: { content: [{ type: "text", text: "done" }] },
        }),
      ],
    });

    expect(runtimeAssertions.failures).toContain(
      "agent did not run the create-worker scaffold command",
    );
    expect(runtimeAssertions.failures).toContain(
      "agent used unsupported scaffold command(s): npm create cloudflare@latest space",
    );
  });

  it("accepts the DO-backed create_project + deploy_project path routed through js_exec", () => {
    const code = `
      await tools.read({ location: "workspace", path: "developing-software/SKILL.md" });
      await tools.write({ location: "project", project: "space-matching-game", path: "/app/routes/home.tsx", content: "..." });
      const deployed = await tools.deploy_project({ project: "space-matching-game" });
      await tools.set_preview({ app_name: "space-matching-game" });
    `;
    const runtimeAssertions = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "create_project",
          arguments: { name: "space-matching-game", description: "Space game" },
          result: { content: [{ type: "text", text: "created" }] },
        }),
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          arguments: { code },
          result: {
            content: [{
              type: "text",
              text: 'deployed: { "success": true, "url": "https://space-matching-game.evals.camelai.app" }',
            }],
          },
        }),
      ],
    });

    expect(runtimeAssertions.usedCreateProject).toBe(true);
    expect(runtimeAssertions.usedDeployProject).toBe(true);
    expect(runtimeAssertions.failures).toEqual([]);
  });

  it("detects top-level create_project and js_exec deploy_project calls", () => {
    const runtimeAssertions = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "create_project",
          arguments: { name: "space-matching-game", description: "game" },
          result: { content: [{ type: "text", text: "created" }] },
        }),
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          arguments: { code: 'await tools.read({ path: "developing-software/SKILL.md" }); await tools.deploy_project({ project: "space-matching-game" }); await tools.set_preview({ app_name: "space-matching-game" });' },
          result: {
            content: [{
              type: "text",
              text: '{ "success": true, "appUrl": "https://space-matching-game.evals.camelai.app" }',
            }],
          },
        }),
      ],
    });

    expect(runtimeAssertions.usedCreateProject).toBe(true);
    expect(runtimeAssertions.usedDeployProject).toBe(true);
    expect(runtimeAssertions.failures).not.toContain(
      "agent did not run the create-worker scaffold command",
    );
    expect(runtimeAssertions.failures).not.toContain("agent did not run bun run deploy");
    expect(runtimeAssertions.failures).not.toContain(
      "agent did not call list_apps after deploy",
    );
  });

  it("still flags missing list_apps when deploy_project failed or returned no URL", () => {
    const failedDeploy = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          status: "failed",
          arguments: { code: 'await tools.deploy_project({ project: "space-matching-game" });' },
          result: {
            content: [{ type: "text", text: "build failed: https://space-matching-game.evals.camelai.app was not deployed" }],
          },
        }),
      ],
    });
    expect(failedDeploy.usedDeployProject).toBe(true);
    expect(failedDeploy.failures).toContain("agent did not call list_apps after deploy");

    const urlLessDeploy = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          arguments: { code: 'await tools.deploy_project({ project: "space-matching-game" });' },
          result: { content: [{ type: "text", text: '{ "success": false, "stage": "build" }' }] },
        }),
      ],
    });
    expect(urlLessDeploy.usedDeployProject).toBe(true);
    expect(urlLessDeploy.failures).toContain("agent did not call list_apps after deploy");

    // deploy_project reports build/deploy failures as *completed* items with a
    // { success: false, ... } envelope rather than throwing; a docs/log URL inside
    // that failure summary must not count as app-URL evidence.
    const completedFailureEnvelope = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          status: "completed",
          arguments: { code: 'await tools.deploy_project({ project: "space-matching-game" });' },
          result: {
            content: [{
              type: "text",
              text: '{ "success": false, "stage": "deploy", "errorSummary": "worker startup failed, see https://developers.cloudflare.com/workers/observability/logs/" }',
            }],
          },
        }),
      ],
    });
    expect(completedFailureEnvelope.usedDeployProject).toBe(true);
    expect(completedFailureEnvelope.failures).toContain(
      "agent did not call list_apps after deploy",
    );
  });

  it("ignores incidental URLs in js_exec output around a failed deploy_project", () => {
    const code = `
      await tools.read({ location: "workspace", path: "developing-software/SKILL.md" });
      await tools.create_project({ name: "space-matching-game", description: "game" });
      const deployed = await tools.deploy_project({ project: "space-matching-game" });
      console.log(deployed);
    `;
    const runtimeAssertions = evaluateRuntimeAssertions({
      events: [
        completedRuntimeItem({
          type: "dynamicToolCall",
          tool: "js_exec",
          arguments: { code },
          result: {
            content: [{
              type: "text",
              // A docs URL outside any JSON object, plus a URL inside a *failed*
              // deploy envelope — neither may stand in for a delivered app URL.
              text: [
                "see https://developers.cloudflare.com/durable-objects/ for docs",
                '{ "success": false, "stage": "deploy", "errorSummary": "worker startup failed, logs: https://dash.cloudflare.com/logs" }',
              ].join("\n"),
            }],
          },
        }),
      ],
    });

    expect(runtimeAssertions.usedDeployProject).toBe(true);
    expect(runtimeAssertions.failures).toContain(
      "agent did not call list_apps after deploy",
    );
  });

  it("passes called_list_apps when deploy_project returned the app URL", () => {
    const criteria = buildPostDeployToolCriteria(
      {
        failures: [
          "agent did not call list_apps after deploy",
          "agent did not preview the deployed app",
        ],
      },
      { deployProjectProvidedAppUrl: true },
    );

    expect(criteria).toMatchObject([
      { id: "called_list_apps", status: "passed" },
      {
        id: "called_set_preview",
        status: "passed",
      },
    ]);
  });

  function doScaffoldFixtureFiles(homeTsxText: string): SourceFile[] {
    return [
      {
        path: "/package.json",
        text: JSON.stringify({
          name: "space-matching-game",
          scripts: { deploy: "wrangler deploy" },
          dependencies: {
            react: "^19.2.0",
            "react-dom": "^19.2.0",
            "react-router": "^7.16.0",
          },
          devDependencies: {
            "@react-router/dev": "^7.16.0",
            wrangler: "^4.97.0",
          },
        }),
        size: 1,
      },
      {
        path: "/components.json",
        text: JSON.stringify({
          $schema: "https://ui.shadcn.com/schema.json",
          tsx: true,
          iconLibrary: "lucide",
          tailwind: { css: "app/app.css" },
        }),
        size: 1,
      },
      {
        path: "/wrangler.jsonc",
        text: JSON.stringify({
          name: "space-matching-game",
          main: "./workers/app.ts",
          assets: { directory: "./public/", binding: "ASSETS" },
          durable_objects: {
            bindings: [{ name: "LEADERBOARD_DO", class_name: "LeaderboardDO" }],
          },
          migrations: [{ tag: "v1", new_sqlite_classes: ["LeaderboardDO"] }],
        }, null, 2),
        size: 1,
      },
      {
        path: "/app/routes.ts",
        text: 'import { index, type RouteConfig } from "@react-router/dev/routes";',
        size: 1,
      },
      {
        path: "/app/routes/home.tsx",
        text: homeTsxText,
        size: 1,
      },
      {
        path: "/workers/app.ts",
        text: [
          'import { DurableObject } from "cloudflare:workers";',
          "export class LeaderboardDO extends DurableObject {",
          "  init() { this.ctx.storage.sql.exec(\"CREATE TABLE IF NOT EXISTS scores (name TEXT, score INTEGER)\"); }",
          "}",
        ].join("\n"),
        size: 1,
      },
    ];
  }

  it("accepts the DO-backed scaffold shape in path-aware source inspection", () => {
    const sourceFiles = doScaffoldFixtureFiles([
      'const title = "Space memory matching game: match planet, star, and rocket cards";',
      "const cards = shuffle(planets); let flipped = []; let matched = [];",
      "function match(card) {}",
      '<form onSubmit={submit}><input name="username" placeholder="player name" /></form>',
      "const leaderboard = topScores; const score = moves;",
    ].join("\n"));

    const inspection = inspectCollectedSource("/", sourceFiles, "do");

    expect(inspection.failures).toEqual([]);
    expect(inspection.checkedFiles).toContain("package.json");
    expect(inspection.persistenceFiles).toContain("workers/app.ts");
  });

  it("accepts a plain name-entry leaderboard flow as a credential flow", () => {
    // Observed in a live run: "Enter your name for the leaderboard" with a
    // placeholder of "Your callsign..." and username state was a genuine entry
    // flow but scored only one hit from the old credentials vocabulary.
    const sourceFiles = doScaffoldFixtureFiles([
      'const title = "Space memory matching game: match planet, star, and rocket cards";',
      "const cards = shuffle(planets); let flipped = []; let matched = [];",
      "function match(card) {}",
      '<form onSubmit={saveScore}><input value={entered} placeholder="Your callsign..." /><button type="submit">Save</button></form>',
      "const leaderboard = topScores; const score = moves;",
    ].join("\n"));

    const inspection = inspectCollectedSource("/", sourceFiles, "do");

    // Exactly one vocabulary hit ("callsign"), accepted because the source also
    // shows concrete text-input + submit markup.
    expect(inspection.signalHits.credentials).toEqual(["callsign"]);
    expect(inspection.failures).not.toContain(
      "source does not show a credential/name entry flow for high scores",
    );
  });

  // Verbatim agent-written workers/app.ts from run eval-20260702-081333Z-6c9ef776,
  // where a genuine DO+SQLite leaderboard scored persistenceFiles=[] because every
  // relevant concept was spelled as a compound identifier (LeaderboardDO, addScore,
  // getLeaderboard, time_seconds) that hasTerm's word boundaries never match.
  const ARTIFACT_WORKERS_APP_TS = [
    "import { DurableObject } from \"cloudflare:workers\";",
    "import { createRequestHandler } from \"react-router\";",
    "",
    "declare module \"react-router\" {",
    "  export interface AppLoadContext {",
    "    cloudflare: {",
    "      env: Env;",
    "      ctx: ExecutionContext;",
    "    };",
    "  }",
    "}",
    "",
    "const requestHandler = createRequestHandler(",
    "  () => import(\"virtual:react-router/server-build\"),",
    "  import.meta.env.MODE",
    ");",
    "",
    "export default {",
    "  async fetch(request, env, ctx) {",
    "    return requestHandler(request, {",
    "      cloudflare: { env, ctx },",
    "    });",
    "  },",
    "} satisfies ExportedHandler<Env>;",
    "",
    "export { LocalDataProxyService } from \"@cloudflare/codemode\";",
    "export { LocalConnectionsService } from \"@cloudflare/codemode\";",
    "export { LocalCamelAiService } from \"@cloudflare/codemode\";",
    "",
    "export class LeaderboardDO extends DurableObject<Env> {",
    "  sql = this.ctx.storage.sql;",
    "",
    "  constructor(ctx: DurableObjectState, env: Env) {",
    "    super(ctx, env);",
    "    this.sql.exec(`",
    "      CREATE TABLE IF NOT EXISTS scores (",
    "        id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "        username TEXT NOT NULL,",
    "        time_seconds INTEGER NOT NULL,",
    "        moves INTEGER NOT NULL,",
    "        difficulty TEXT NOT NULL DEFAULT 'medium',",
    "        created_at INTEGER DEFAULT (unixepoch())",
    "      )",
    "    `);",
    "  }",
    "",
    "  async addScore(username: string, timeSeconds: number, moves: number, difficulty: string) {",
    "    this.sql.exec(",
    "      \"INSERT INTO scores (username, time_seconds, moves, difficulty) VALUES (?, ?, ?, ?)\",",
    "      username,",
    "      timeSeconds,",
    "      moves,",
    "      difficulty",
    "    );",
    "    return { ok: true };",
    "  }",
    "",
    "  async getLeaderboard(difficulty: string = \"all\", limit: number = 20) {",
    "    if (difficulty === \"all\") {",
    "      return this.sql.exec(",
    "        \"SELECT id, username, time_seconds, moves, difficulty, created_at FROM scores ORDER BY time_seconds ASC, moves ASC LIMIT ?\",",
    "        limit",
    "      ).toArray();",
    "    }",
    "    return this.sql.exec(",
    "      \"SELECT id, username, time_seconds, moves, difficulty, created_at FROM scores WHERE difficulty = ? ORDER BY time_seconds ASC, moves ASC LIMIT ?\",",
    "      difficulty,",
    "      limit",
    "    ).toArray();",
    "  }",
    "}",
  ].join("\n") + "\n";

  const ARTIFACT_WRANGLER_JSONC = `${JSON.stringify({
    name: "space-match",
    main: "./workers/app.ts",
    compatibility_date: "2024-12-01",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: "./public/", binding: "ASSETS" },
    durable_objects: {
      bindings: [{ name: "LEADERBOARD", class_name: "LeaderboardDO" }],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["LeaderboardDO"] }],
  }, null, 2)}\n`;

  it("reads DO-backed sources verbatim and detects compound-identifier persistence", async () => {
    const projectId = `sm-src-inspect-repro-${crypto.randomUUID().slice(0, 8)}`;
    const fsEnv = testEnv as unknown as WorkspaceFilesystemEnv;
    const client = new ProjectFilesystemClient(fsEnv, projectId);
    const writeApp = await client.writeFile("/workers/app.ts", ARTIFACT_WORKERS_APP_TS);
    const writeWrangler = await client.writeFile("/wrangler.jsonc", ARTIFACT_WRANGLER_JSONC);
    expect(writeApp.success).toBe(true);
    expect(writeWrangler.success).toBe(true);

    const sourceFiles = await collectDoProjectSourceFiles(fsEnv, projectId);
    const workersApp = sourceFiles.find((file) => file.path === "/workers/app.ts");
    // The DO read path returns the exact written bytes — this rules out truncation,
    // base64/binary misdetection, and path-normalization theories for the live miss.
    expect(workersApp?.text).toBe(ARTIFACT_WORKERS_APP_TS);
    expect(workersApp?.size).toBe(ARTIFACT_WORKERS_APP_TS.length);

    const inspection = inspectCollectedSource("/", sourceFiles, "do");
    expect(inspection.taskFiles).toContain("workers/app.ts");
    expect(inspection.persistenceFiles).toContain("workers/app.ts");
    expect(inspection.failures).not.toContain(
      "source does not show leaderboard persistence with Durable Objects + SQLite",
    );
  });

  it("still fails the credential criterion when there is no entry flow", () => {
    const sourceFiles = doScaffoldFixtureFiles([
      'const title = "Space memory matching game: match planet, star, and rocket cards";',
      "const cards = shuffle(planets); let flipped = []; let matched = [];",
      "function match(card) {}",
      "const leaderboard = topScores; const score = moves;",
    ].join("\n"));

    const inspection = inspectCollectedSource("/", sourceFiles, "do");

    expect(inspection.failures).toContain(
      "source does not show a credential/name entry flow for high scores",
    );
  });

  it("keeps post-deploy tool failures in pass/fail criteria", () => {
    const criteria = buildPostDeployToolCriteria({
      failures: [
        "agent did not call list_apps after deploy",
        "agent did not preview the deployed app",
      ],
    });

    expect(criteria).toMatchObject([
      {
        id: "called_list_apps",
        status: "failed",
        reason: "agent did not call list_apps after deploy",
      },
      {
        id: "called_set_preview",
        status: "failed",
        reason: "agent did not preview the deployed app",
      },
    ]);
  });
});

describe("space matching game deploy agent eval", () => {
  maybeIt(
    "asks the agent to create and deploy a persistent space matching game",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `space-game-eval-${suffix}@example.com`,
        "password123",
        "Space Game Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Space Game Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Space matching game eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const initialProjects = await workspaceFs.listProjectsForMigrationReset();
      if (initialProjects.length > 0) {
        const projectCreation = buildProjectCreationInspection(
          initialProjects,
          initialProjects,
        );
        const evaluation = buildEvalCriteriaSummary({
          passFail: [
            passFailCriterion({
              id: "agent_session_completed",
              label: "Agent session completed",
              passed: false,
              reason: "Agent session did not run because the workspace was not empty.",
            }),
            passFailCriterion({
              id: "agent_created_project",
              label: "Agent created a project",
              passed: false,
              reason: projectCreation.failures.join("; "),
              details: projectCreation,
            }),
          ],
          scorecard: [
            scoreCriterion({
              id: "previewed_latest_app",
              label: "Previewed the latest deployed app",
              points: 0,
              maxPoints: 5,
              reason: "Agent session did not run.",
            }),
            scoreCriterion({
              id: "agent_efficiency",
              label: "Agent efficiency / signal",
              points: 0,
              maxPoints: 4,
              reason: "Agent session did not run.",
            }),
          ],
        });
        const payload = {
          status: "harness_error",
          evaluation,
          model: testEnv.EVAL_MODEL,
          projectCreation,
          sourceInspection: missingProjectSourceInspection(),
        };
        emitEvalTranscript(payload);
        assertPassFailCriteria(evaluation);
        return;
      }

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const appsBefore = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Space Game Eval",
        userEmail: `space-game-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "Create a web app that is a space themed matching game with a leaderboard where users can enter their name with their high score.",
          "The deployed app must expose a leaderboard API: GET /api/leaderboard returns JSON { entries: [{ name, score }, ...] } and POST /api/leaderboard accepts JSON { name, score } and persists the entry so it survives across requests.",
          "Deploys go through the platform deploy_project tool, which already has Cloudflare access, so do not ask for login or Cloudflare credentials.",
        ].join(" "),
      });
      const finalProjects = await workspaceFs.listProjectsForMigrationReset();
      const newProjects = diffNewProjects(initialProjects, finalProjects);
      const {
        selectedProject,
        sourceInspection,
        sourceInspectionCandidates,
      } = await inspectCreatedProjectSources(
        testEnv as unknown as WorkspaceFilesystemEnv,
        newProjects,
      );
      const projectCreation = buildProjectCreationInspection(
        initialProjects,
        finalProjects,
        selectedProject,
      );
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 20,
          maxBadToolCalls: 3,
        }),
      );
      const runtimeAssertions = evaluateRuntimeAssertions(result);
      const appsAfter = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      let deployedApp: EvalDeployedApp | undefined;
      let deployedAppError: string | undefined;
      try {
        deployedApp = assertDeployedApp(result, { hostSuffix: ".evals.camelai.app" });
      } catch (error) {
        deployedAppError = error instanceof Error ? error.message : String(error);
      }
      const rootSmoke = await smokeFetchRoot(deployedApp);
      const leaderboardRoundtrip = {
        postStatus: undefined as number | undefined,
        postJson: undefined as unknown,
        postAttempts: 0,
        getStatus: undefined as number | undefined,
        entries: [] as unknown[],
        failures: [] as string[],
      };
      if (!deployedApp) {
        leaderboardRoundtrip.failures.push("no deployed app was captured");
      } else {
        try {
          // A newly deployed DO class can briefly return a 5xx while its script
          // and migration propagate. Retry this eval-only, idempotent fixture
          // write with the same distinctive payload before grading the app.
          for (let attempt = 0; attempt < 5; attempt += 1) {
            leaderboardRoundtrip.postAttempts = attempt + 1;
            const post = await fetchJsonWithRetry(
              new URL("/api/leaderboard", deployedApp.url).toString(),
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: "EvalPilot", score: 4200 }),
              },
            );
            leaderboardRoundtrip.postStatus = post.status;
            leaderboardRoundtrip.postJson = post.json;
            if (post.status >= 200 && post.status < 300) break;
            if (attempt < 4) {
              await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
            }
          }
          if (
            leaderboardRoundtrip.postStatus === undefined ||
            leaderboardRoundtrip.postStatus < 200 ||
            leaderboardRoundtrip.postStatus >= 300
          ) {
            leaderboardRoundtrip.failures.push(
              `POST returned HTTP ${leaderboardRoundtrip.postStatus ?? "unknown"}`,
            );
          }
          const get = await fetchJsonWithRetry(
            new URL("/api/leaderboard", deployedApp.url).toString(),
          );
          leaderboardRoundtrip.getStatus = get.status;
          const entries = Array.isArray(asRecord(get.json)?.entries)
            ? asRecord(get.json)!.entries as unknown[]
            : [];
          leaderboardRoundtrip.entries = entries;
          if (get.status !== 200) leaderboardRoundtrip.failures.push(`GET returned HTTP ${get.status}`);
          const persisted = entries.some((entry) => {
            const record = asRecord(entry);
            return record?.name === "EvalPilot" && record.score === 4200;
          });
          if (!persisted) leaderboardRoundtrip.failures.push("GET did not return EvalPilot score 4200");
        } catch (error) {
          leaderboardRoundtrip.failures.push(
            `leaderboard round-trip failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const gameRichnessSignals = [
        (sourceInspection.signalHits.matchingGame?.length ?? 0) >= 4,
        (sourceInspection.signalHits.leaderboard?.length ?? 0) >= 2,
        (sourceInspection.signalHits.credentials?.length ?? 0) >= 1,
        (sourceInspection.signalHits.spaceTheme?.length ?? 0) >= 3,
        sourceInspection.persistenceFiles.length > 0,
        sourceInspection.sourceFiles.length >= 3,
      ];
      const gameRichnessPoints = gameRichnessSignals.filter(Boolean).length;
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const latestPreviewScore = scoreLatestPreview(result.events);
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "agent_created_project",
            label: "Agent created a project",
            passed: projectCreation.failures.length === 0,
            reason: projectCreation.failures.length
              ? projectCreation.failures.join("; ")
              : undefined,
            details: projectCreation,
          }),
          passFailCriterion({
            id: "workspace_app_created",
            label: "Workspace app was created",
            passed: appsAfter === appsBefore + 1,
            reason:
              appsAfter === appsBefore + 1
                ? undefined
                : `Expected app count to increase by one; before=${appsBefore}, after=${appsAfter}.`,
            details: { appsBefore, appsAfter },
          }),
          passFailCriterion({
            id: "eval_app_url_deployed",
            label: "A real eval app URL was deployed",
            passed: Boolean(deployedApp),
            reason: deployedApp ? undefined : deployedAppError,
            details: { deployedApp },
          }),
          passFailCriterion({
            id: "game_page_loads",
            label: "Game page loads without an explicit server error",
            passed:
              rootSmoke.status === 200 &&
              (rootSmoke.bodyLength ?? 0) > 0 &&
              rootSmoke.errorStrings.length === 0,
            reason:
              rootSmoke.status === 200 &&
              (rootSmoke.bodyLength ?? 0) > 0 &&
              rootSmoke.errorStrings.length === 0
                ? undefined
                : rootSmoke.errorStrings.length
                  ? `Root body contained error marker(s): ${rootSmoke.errorStrings.join(", ")}`
                  : rootSmoke.error ??
                    `Root fetch returned HTTP ${rootSmoke.status ?? "unknown"} with body length ${rootSmoke.bodyLength ?? 0}.`,
            details: rootSmoke,
          }),
          passFailCriterion({
            id: "leaderboard_roundtrip_correct",
            label: "Leaderboard POST persists and GET returns the submitted score",
            passed: leaderboardRoundtrip.failures.length === 0,
            reason: leaderboardRoundtrip.failures.length
              ? leaderboardRoundtrip.failures.join("; ")
              : undefined,
            details: leaderboardRoundtrip,
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          latestPreviewScore,
          scoreCriterion({
            id: "game_source_richness",
            label: "Source shows game, leaderboard, theme, and persistence richness",
            points: gameRichnessPoints,
            maxPoints: 6,
            reason: `${gameRichnessPoints}/6 source richness signals passed.`,
            details: { gameRichnessSignals, sourceInspection },
          }),
          scoreCriterion({
            id: "avoided_legacy_paths",
            label: "Avoided legacy scaffold/deploy paths",
            points: legacyFailures.length === 0 ? 2 : 0,
            maxPoints: 2,
            reason: legacyFailures.length ? legacyFailures.join("; ") : undefined,
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 20, maxBadToolCalls: 3, points: 4 },
              { maxAssistantTurns: 30, maxBadToolCalls: 6, points: 3 },
              { maxAssistantTurns: 40, maxBadToolCalls: 12, points: 2 },
              { maxAssistantTurns: 50, maxBadToolCalls: 24, points: 1 },
            ],
          }),
        ],
      });

      const payload = {
        status: result.status,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        deployedApps: result.deployedApps,
        projectCreation,
        runtimeAssertions,
        legacyFailures,
        sourceInspection,
        sourceInspectionCandidates,
        livePageSmoke: rootSmoke,
        leaderboardRoundtrip,
        result: result.result,
        events: result.events,
        messages: result.messages,
      };
      emitEvalTranscript(payload);
      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 120_000,
  );
});
