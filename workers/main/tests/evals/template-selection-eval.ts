import type { ProjectScaffoldTemplate } from "../../src/project-scaffold";
import {
  ProjectFilesystemClient,
  type WorkspaceFilesystemDO,
} from "../../src/workspace-filesystem-do";
import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import { configureEvalModel, type EvalModelEnv } from "./model-config";
import {
  collectRuntimeEvidence,
  readSkillWithTool,
  toolCallReferences,
  usedTool,
} from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

export type TemplateSelectionEvalEnv = TestEnv &
  EvalModelEnv &
  EvalSignalEnv & {
    WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
    RUN_AGENT_EVALS?: string;
  };

export type TemplateSelectionEvalConfig = {
  template: ProjectScaffoldTemplate;
  projectPrefix: string;
  title: string;
  prompt: string;
  markerPath: string;
  markerText: string;
};

export async function runTemplateSelectionEval(
  testEnv: TemplateSelectionEvalEnv,
  config: TemplateSelectionEvalConfig,
  timeoutMs: number,
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const projectName = `${config.projectPrefix}-${suffix}`;
  const email = `${config.projectPrefix}-${suffix}@example.com`;
  const { userId } = await createUser(
    testEnv,
    email,
    "password123",
    "Template Selection Eval",
  );
  const { org, defaultWorkspaceId } = await createOrg(
    testEnv,
    `Template Selection ${config.template} ${suffix}`,
    userId,
  );

  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  await configureEvalModel(testEnv, orgStub, userId);
  const thread = await orgStub.createThread(
    defaultWorkspaceId,
    config.title,
    userId,
    undefined,
    testEnv.EVAL_MODEL,
  );
  const message = [
    `Create a new project named exactly "${projectName}" with a concise description.`,
    config.prompt,
    "Choose the most suitable available project starter based on the product intent; do not ask me to choose one.",
    "Only create the project and inspect enough of its initial files to confirm the starter. Do not edit files, build, deploy, or install dependencies.",
    "Reply with the project name and the starter you selected.",
  ].join(" ");
  const result = await runRuntimeEval(testEnv, {
    threadId: thread.id,
    workspaceId: defaultWorkspaceId,
    orgId: org.id,
    userId,
    userName: "Template Selection Eval",
    userEmail: email,
    messageSource: "eval",
    timeoutMs,
    message,
  });

  const workspaceFs = testEnv.WORKSPACE_FS.get(
    testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
  );
  const projects = await workspaceFs.listProjectsForMigrationReset();
  const project = projects.find((candidate) => candidate.name === projectName);
  const markerRead = project
    ? await new ProjectFilesystemClient(testEnv, project.id).readFile(
        config.markerPath,
      )
    : { success: false, error: "Project was not created." };
  const markerContent = markerRead.content ?? "";
  const scaffoldMatches =
    markerRead.success && markerContent.includes(config.markerText);
  const usedCreateProject = usedTool(result.events, "create_project");
  const readDevelopingSoftwareSkill = toolCallReferences(
    result.events,
    "read",
    "developing-software/SKILL.md",
  ) || readSkillWithTool(result.events, "developing-software");
  const referencedExpectedTemplate = toolCallReferences(
    result.events,
    "create_project",
    config.template,
  );
  // Omitting `template` is the documented way to select the default CRUD starter.
  // The marker inspection proves that omission did not accidentally select another scaffold.
  const selectedExpectedTemplate =
    config.template === "crud"
      ? usedCreateProject && scaffoldMatches
      : referencedExpectedTemplate && scaffoldMatches;
  const usedDeploy = usedTool(result.events, "deploy_project");
  const signal = evaluateAgentEvalSignal(
    result,
    getEvalSignalThresholds(testEnv, {
      maxAssistantTurns: 4,
      maxBadToolCalls: 0,
    }),
  );
  const runtimeAssertions = {
    expectedTemplate: config.template,
    usedCreateProject,
    readDevelopingSoftwareSkill,
    referencedExpectedTemplate,
    scaffoldMatches,
    usedDeploy,
    evidence: collectRuntimeEvidence(result.events),
  };
  const evaluation = buildEvalCriteriaSummary({
    passFail: [
      buildSessionCompletedCriterion(result),
      passFailCriterion({
        id: "project_created_do_backed",
        label: "Agent created the requested DO-backed project",
        passed: project?.backend === "do-r2" && usedCreateProject,
        reason: project
          ? `Project backend was ${project.backend ?? "unknown"}; create_project used: ${usedCreateProject}.`
          : `No project named ${projectName} was created.`,
        details: { project },
      }),
      passFailCriterion({
        id: "read_developing_software_skill",
        label: "Agent read the developing-software skill before scaffolding",
        passed: readDevelopingSoftwareSkill,
        reason: readDevelopingSoftwareSkill
          ? undefined
          : "No successful read of developing-software/SKILL.md was observed.",
      }),
      passFailCriterion({
        id: "selected_expected_template",
        label: `Agent selected the ${config.template} starter`,
        passed: selectedExpectedTemplate,
        reason: selectedExpectedTemplate
          ? undefined
          : `create_project did not select ${config.template} with a matching scaffold.`,
        details: runtimeAssertions,
      }),
      passFailCriterion({
        id: "avoided_unrequested_build_deploy",
        label: "Agent stopped after scaffold creation and inspection",
        passed: !usedDeploy,
        reason:
          usedDeploy
            ? "Agent deployed despite the prompt asking only for scaffold selection."
            : undefined,
        details: { usedDeploy },
      }),
      buildNoAssistantErrorCriterion(result),
      buildRuntimeEventsCriterion(result),
      buildResultEventCriterion(result),
    ],
    scorecard: [
      scoreCriterion({
        id: "template_selection_evidence",
        label:
          "Template selection is explicit and matches the materialized scaffold",
        points: selectedExpectedTemplate ? 2 : scaffoldMatches ? 1 : 0,
        maxPoints: 2,
        reason: `Argument matched: ${referencedExpectedTemplate}; scaffold matched: ${scaffoldMatches}.`,
      }),
      scoreSignalEfficiency(signal, {
        maxPoints: 3,
        fallbackPoints: 0,
        tiers: [
          { maxAssistantTurns: 3, maxBadToolCalls: 0, points: 3 },
          { maxAssistantTurns: 4, maxBadToolCalls: 0, points: 2 },
          { maxAssistantTurns: 6, maxBadToolCalls: 1, points: 1 },
        ],
      }),
    ],
  });

  return {
    evaluation,
    transcript: {
      status: result.status,
      evaluation,
      error: result.error,
      model: testEnv.EVAL_MODEL,
      signal,
      result: result.result,
      events: result.events,
      messages: result.messages,
      prompt: { message, expectedTemplate: config.template },
      projectCreation: { projectName, project },
      fileInspection: {
        path: config.markerPath,
        success: markerRead.success,
        expectedMarker: config.markerText,
        markerFound: scaffoldMatches,
        error: markerRead.error,
      },
      runtimeAssertions,
    },
  };
}
