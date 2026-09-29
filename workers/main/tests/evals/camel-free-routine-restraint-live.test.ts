import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import {
  ProjectFilesystemClient,
  type WorkspaceFilesystemDO,
} from "../../src/workspace-filesystem-do";
import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import { getEvalTimeoutMs, type EvalModelEnv } from "./model-config";
import { usedTool } from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type RoutineRestraintEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as RoutineRestraintEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);
const CAMEL_FREE_MODEL = "deepseek-v4-auto";
const FIX_MARKER = "ROUTINE_PRIMARY_FIX";
const RUBRIC = {
  version: 1,
  objective: "Complete a tiny local code repair directly, correctly, and without unnecessary delegation.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    { id: "correct_repair", description: "The final file changes increment from subtraction to value + 1 and includes the requested marker comment.", weight: 50, critical: true, evidenceHints: ["runtimeAssertions.content", "trajectory"] },
    { id: "delegation_restraint", description: "The primary handles this routine local edit itself and does not call Oracle, Research, Agent, or Explore without cause.", weight: 25, critical: true, evidenceHints: ["trajectory", "runtimeAssertions"] },
    { id: "verification", description: "The primary reads or otherwise verifies the final file after the edit and leaves no contradictory implementation.", weight: 15, critical: false, evidenceHints: ["trajectory", "runtimeAssertions.fixed"] },
    { id: "completion_report", description: "The final response accurately and concisely reports the completed repair.", weight: 10, critical: false, evidenceHints: ["result"] },
  ],
} as const;

describe("Camel Free routine-work restraint eval", () => {
  maybeIt(
    "handles a small local fix without Oracle or Research",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const projectName = `routine-fix-${suffix}`;
      const email = `routine-restraint-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Routine Restraint Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Routine Restraint Eval ${suffix}`,
        userId,
        { billingPlan: "free" },
      );
      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        name: projectName,
        description: "Small local bug for delegation restraint coverage.",
        workspaceId: defaultWorkspaceId,
        backend: "do-r2",
      });
      const files = new ProjectFilesystemClient(testEnv, project.id);
      await files.writeFile(
        "/counter.ts",
        [
          "export function increment(value: number): number {",
          "  return value - 1;",
          "}",
          "",
        ].join("\n"),
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Camel Free routine restraint eval",
        userId,
        undefined,
        CAMEL_FREE_MODEL,
      );
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Routine Restraint Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `In the existing project "${projectName}", inspect /counter.ts and fix increment so it returns value + 1.`,
          `Add the comment // ${FIX_MARKER} immediately above the return, verify the file, and briefly report completion.`,
        ].join(" "),
      });

      const read = await files.readFile("/counter.ts");
      const content = read.content ?? "";
      const fixed = content.includes(FIX_MARKER) &&
        /return\s+value\s*\+\s*1\s*;/.test(content) &&
        !content.includes("value - 1");
      const calledOracle = usedTool(result.events, "Oracle");
      const calledResearch = usedTool(result.events, "Research");
      const delegatedGenericAgent = usedTool(result.events, "Agent") ||
        usedTool(result.events, "Explore");
      const primaryMutated = usedTool(result.events, "edit") ||
        usedTool(result.events, "write");
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 0,
        }),
      );
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "routine_fix_not_delegated",
            label: "Primary reserved Oracle, Research, Agent, and Explore for warranted work",
            passed: !calledOracle && !calledResearch && !delegatedGenericAgent,
            reason: !calledOracle && !calledResearch && !delegatedGenericAgent
              ? undefined
              : "The routine local fix was unnecessarily delegated.",
            details: { calledOracle, calledResearch, delegatedGenericAgent },
          }),
          passFailCriterion({
            id: "routine_fix_completed_by_primary",
            label: "Primary directly completed the small local repair",
            passed: primaryMutated && read.success && fixed,
            reason: primaryMutated && read.success && fixed
              ? undefined
              : read.error ?? "The primary did not complete the expected repair.",
            details: { primaryMutated, content },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 5,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 3, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 5, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 8, maxBadToolCalls: 1, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        rubric: RUBRIC,
        evaluation,
        error: result.error,
        model: CAMEL_FREE_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          calledOracle,
          calledResearch,
          delegatedGenericAgent,
          primaryMutated,
          fixed,
          content,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
