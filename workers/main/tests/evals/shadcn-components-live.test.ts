import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildHarnessIntegrityCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
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
import {
  asRecord,
  asString,
  collectRuntimeEvidence,
  legacyDeployPathEvidence,
  succeededWithTool,
  usedTool,
} from "./project-eval-helpers";
import { ProjectFilesystemClient } from "../../src/workspace-filesystem-do";
import type {
  WorkspaceFilesystemDO,
  WorkspaceProject,
} from "../../src/workspace-filesystem-do";
import { runRuntimeEval } from "./runtime-eval";

type ShadcnComponentsEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
};

type ProjectSourceInspection = {
  readError?: string;
  componentFiles: Record<string, { exists: boolean; size: number; shadcnLike: boolean }>;
  requiredComponentFilesPresent: boolean;
  homeRead: { exists: boolean; size: number };
  homeUsesRequiredComponents: boolean;
  homeHasRequiredProductContent: boolean;
  componentsJsonValid: boolean;
  packageJsonValid: boolean;
  richnessPoints: number;
  richnessDetails: Record<string, boolean>;
};

type RuntimeItem = Record<string, unknown>;

const testEnv = env as unknown as ShadcnComponentsEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 540_000);

const PROJECT_NAME = "shadcn-install-lab";
const REQUIRED_COMPONENTS = ["accordion", "tabs", "progress"] as const;
const REQUIRED_COMPONENT_PATHS = REQUIRED_COMPONENTS.map(
  (component) => `/app/components/ui/${component}.tsx`,
);
const HOME_PATH = "/app/routes/home.tsx";

function cellText(value: string | undefined): string {
  return value ?? "";
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    return asRecord(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
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

function collectToolArgumentCommands(events: Array<Record<string, unknown>>): string[] {
  return collectRuntimeItems(events)
    .map((item) => asString(asRecord(item.arguments)?.command) ?? "")
    .filter(Boolean);
}

function commandOrCodeMentionsBuild(value: string): boolean {
  return /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:build|typecheck)\b/i.test(value);
}

function commandOrCodeMentionsShadcnAdd(value: string): boolean {
  return /\b(?:bunx|npx|pnpm|npm|yarn)\b[\s\S]{0,160}\bshadcn(?:@latest)?\b[\s\S]{0,160}\badd\b/i
    .test(value) ||
    /\bshadcn(?:@latest)?\b[\s\S]{0,80}\badd\b/i.test(value);
}

function componentFileLooksShadcn(component: string, text: string): boolean {
  const primitive = `${component[0]?.toUpperCase() ?? ""}${component.slice(1)}Primitive`;
  return text.includes("cn(") &&
    (text.includes("radix-ui") || text.includes("@radix-ui/")) &&
    text.includes(primitive);
}

async function inspectProjectSource(
  project: WorkspaceProject | undefined,
): Promise<ProjectSourceInspection> {
  if (!project) {
    return {
      readError: "project was not created",
      componentFiles: Object.fromEntries(REQUIRED_COMPONENTS.map((component) => [
        component,
        { exists: false, size: 0, shadcnLike: false },
      ])),
      requiredComponentFilesPresent: false,
      homeRead: { exists: false, size: 0 },
      homeUsesRequiredComponents: false,
      homeHasRequiredProductContent: false,
      componentsJsonValid: false,
      packageJsonValid: false,
      richnessPoints: 0,
      richnessDetails: {
        componentFilesPresent: false,
        componentFilesLookShadcn: false,
        homeUsesComponents: false,
        homeHasLabContent: false,
        scaffoldConfigIntact: false,
      },
    };
  }

  const fs = new ProjectFilesystemClient(testEnv, project.id);
  const reads = await Promise.all(
    [
      ...REQUIRED_COMPONENT_PATHS,
      HOME_PATH,
      "/components.json",
      "/package.json",
    ].map(async (path) => ({ path, response: await fs.readFile(path) })),
  );
  const contentByPath = new Map(
    reads.map(({ path, response }) => [path, response.success ? cellText(response.content) : undefined]),
  );
  const componentFiles = Object.fromEntries(
    REQUIRED_COMPONENTS.map((component) => {
      const path = `/app/components/ui/${component}.tsx`;
      const text = contentByPath.get(path);
      return [
        component,
        {
          exists: typeof text === "string",
          size: text?.length ?? 0,
          shadcnLike: typeof text === "string" && componentFileLooksShadcn(component, text),
        },
      ];
    }),
  );
  const home = contentByPath.get(HOME_PATH) ?? "";
  const componentsJson = parseJsonObject(contentByPath.get("/components.json"));
  const packageJson = parseJsonObject(contentByPath.get("/package.json"));
  const requiredComponentFilesPresent = Object.values(componentFiles).every((file) => file.exists);
  const componentFilesLookShadcn = Object.values(componentFiles).every((file) => file.shadcnLike);
  const homeUsesRequiredComponents = [
    "Accordion",
    "AccordionItem",
    "Tabs",
    "TabsList",
    "TabsTrigger",
    "Progress",
  ].every((term) => home.includes(term));
  const homeHasRequiredProductContent = [
    "Feature Readiness Lab",
    "Plan",
    "Build",
    "Launch",
  ].every((term) => home.includes(term));
  const componentsJsonValid = componentsJson["$schema"] === "https://ui.shadcn.com/schema.json" &&
    asRecord(componentsJson.aliases)?.ui === "~/components/ui";
  const packageJsonValid = typeof packageJson.name === "string" &&
    asRecord(packageJson.scripts)?.build === "react-router build && node ./scripts/build-manifest.mjs";
  const richnessDetails = {
    componentFilesPresent: requiredComponentFilesPresent,
    componentFilesLookShadcn,
    homeUsesComponents: homeUsesRequiredComponents,
    homeHasLabContent: homeHasRequiredProductContent,
    scaffoldConfigIntact: componentsJsonValid && packageJsonValid,
  };
  const richnessPoints = Object.values(richnessDetails).filter(Boolean).length;
  return {
    componentFiles,
    requiredComponentFilesPresent,
    homeRead: { exists: home.length > 0, size: home.length },
    homeUsesRequiredComponents,
    homeHasRequiredProductContent,
    componentsJsonValid,
    packageJsonValid,
    richnessPoints,
    richnessDetails,
  };
}

describe("shadcn components agent eval", () => {
  maybeIt(
    "asks the agent to create a project and add shadcn components",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `shadcn-eval-${suffix}@example.com`,
        "password123",
        "Shadcn Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Shadcn Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Shadcn components eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Shadcn Eval",
        userEmail: `shadcn-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Create a new DO-backed React Router app project named exactly "${PROJECT_NAME}" using create_project with a concise description.`,
          "Add these shadcn/ui components that are not in the default scaffold: accordion, tabs, and progress. Use add_shadcn_component, not shell package-manager commands or custom replacements.",
          "Replace the home page with a compact Feature Readiness Lab that uses Tabs for Plan/Build/Launch, Accordion for implementation notes, and Progress for readiness status.",
          "Validate the project with the platform build or an equivalent project build/typecheck command.",
          "Do not deploy the app and do not use legacy VM shell commands.",
          "Reply with how you added the shadcn components and the validation result.",
        ].join(" "),
      });

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const projects = await workspaceFs.listProjectsForMigrationReset();
      const project = projects.find((candidate) => candidate.name === PROJECT_NAME);
      const sourceInspection = await inspectProjectSource(project);
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 12,
          maxBadToolCalls: 2,
        }),
      );
      const evidence = collectRuntimeEvidence(result.events);
      const toolArgumentCommands = collectToolArgumentCommands(result.events);
      const commandAndCodeEvidence = [
        ...evidence.commands,
        ...evidence.jsExecCodeBlocks,
        ...toolArgumentCommands,
      ];
      const runtimeAssertions = {
        usedCreateProject: usedTool(result.events, "create_project", [
          /\bPROJECTS\s*\.\s*create\s*\(/i,
        ]),
        usedAddShadcnComponent: usedTool(result.events, "add_shadcn_component"),
        usedAnalysisExec: usedTool(result.events, "analysis_exec"),
        usedDeployProject: usedTool(result.events, "deploy_project"),
        legacyFailures: legacyDeployPathEvidence(result.events),
        usedShadcnAddCommand: commandAndCodeEvidence.some(commandOrCodeMentionsShadcnAdd),
        usedBuildOrTypecheckCommand: commandAndCodeEvidence.some(commandOrCodeMentionsBuild),
        succeededAddShadcnComponent: succeededWithTool(result.events, "add_shadcn_component"),
        evidence,
        toolArgumentCommands,
      };
      const finalMentionsMethodAndValidation = /shadcn|accordion|tabs|progress/i.test(result.result ?? "") &&
        /build|typecheck|validat|success|passed/i.test(result.result ?? "");
      // "Validated" must mean validation SUCCEEDED. Command-text evidence is
      // satisfied by a build that failed, so require an analysis_exec/js_exec
      // that both mentions a build and succeeded.
      const succeededBuildCommand =
        (succeededWithTool(result.events, "analysis_exec") ||
          succeededWithTool(result.events, "js_exec")) &&
        runtimeAssertions.usedBuildOrTypecheckCommand;
      const validatedProject = succeededBuildCommand;

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "project_created_do_backed",
            label: "Agent created a DO-backed React Router project",
            passed: project?.backend === "do-r2" && runtimeAssertions.usedCreateProject,
            reason: project
              ? `Project backend was ${project.backend}, create_project=${runtimeAssertions.usedCreateProject}`
              : `No project named ${PROJECT_NAME} was created.`,
            details: { project, runtimeAssertions },
          }),
          passFailCriterion({
            id: "installed_required_component_files",
            label: "Required shadcn component files exist",
            passed: sourceInspection.requiredComponentFilesPresent,
            reason: sourceInspection.requiredComponentFilesPresent
              ? undefined
              : "One or more required files under /app/components/ui were missing.",
            details: sourceInspection.componentFiles,
          }),
          passFailCriterion({
            id: "home_uses_new_components",
            label: "Home page uses the new components",
            passed:
              sourceInspection.homeUsesRequiredComponents &&
              sourceInspection.homeHasRequiredProductContent,
            reason:
              sourceInspection.homeUsesRequiredComponents && sourceInspection.homeHasRequiredProductContent
                ? undefined
                : `usesComponents=${sourceInspection.homeUsesRequiredComponents}, hasProductContent=${sourceInspection.homeHasRequiredProductContent}`,
            details: sourceInspection,
          }),
          passFailCriterion({
            id: "used_add_shadcn_component_tool",
            label: "Agent used add_shadcn_component",
            passed: runtimeAssertions.usedAddShadcnComponent,
            reason: runtimeAssertions.usedAddShadcnComponent
              ? undefined
              : "No add_shadcn_component tool call was found.",
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "validated_without_deploy_or_legacy_vm",
            label: "Agent validated without deploy or legacy VM shell",
            passed:
              validatedProject &&
              !runtimeAssertions.usedDeployProject &&
              runtimeAssertions.legacyFailures.length === 0,
            reason:
              validatedProject &&
              !runtimeAssertions.usedDeployProject &&
              runtimeAssertions.legacyFailures.length === 0
                ? undefined
                : [
                    validatedProject ? "" : "no successful build/typecheck command evidence",
                    runtimeAssertions.usedDeployProject ? "used deploy_project" : "",
                    ...runtimeAssertions.legacyFailures,
                  ].filter(Boolean).join("; "),
            details: runtimeAssertions,
          }),
          buildHarnessIntegrityCriterion(signal),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "source_quality",
            label: "Source quality",
            points: sourceInspection.richnessPoints,
            maxPoints: 5,
            reason: `${sourceInspection.richnessPoints}/5 source quality heuristics passed.`,
            details: sourceInspection.richnessDetails,
          }),
          scoreCriterion({
            id: "shadcn_workflow_quality",
            label: "shadcn workflow quality",
            points:
              (runtimeAssertions.usedAddShadcnComponent ? 3 : 0) +
              (!runtimeAssertions.usedShadcnAddCommand ? 1 : 0) +
              (validatedProject ? 1 : 0),
            maxPoints: 5,
            reason: `addShadcnComponent=${runtimeAssertions.usedAddShadcnComponent}, shadcnCommand=${runtimeAssertions.usedShadcnAddCommand}, analysisExec=${runtimeAssertions.usedAnalysisExec}, validated=${validatedProject}`,
            details: runtimeAssertions,
          }),
          scoreCriterion({
            id: "reply_mentions_method_and_validation",
            label: "Final reply mentions component method and validation result",
            points: finalMentionsMethodAndValidation ? 1 : 0,
            maxPoints: 1,
            reason: finalMentionsMethodAndValidation
              ? undefined
              : "Final result did not mention both shadcn/component work and validation.",
            details: { result: result.result },
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 8, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 12, maxBadToolCalls: 2, points: 3 },
              { maxAssistantTurns: 18, maxBadToolCalls: 4, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        project,
        runtimeAssertions,
        sourceInspection,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
