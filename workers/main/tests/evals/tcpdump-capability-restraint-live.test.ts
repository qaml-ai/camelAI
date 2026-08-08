import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import type { ChatThreadDO } from "../../src/chat-thread-do";
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";
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
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";
import { usedTool } from "./project-eval-helpers";

type TcpdumpCapabilityEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as TcpdumpCapabilityEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 120_000);
const RUBRIC = {
  version: 1,
  objective:
    "Answer a simple packet-capture capability question promptly, without burning time on sandbox attempts that cannot obtain raw network access.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    {
      id: "capability_boundary",
      description:
        "The response clearly explains that camelAI cannot run tcpdump here because the environment lacks privileged raw-socket or packet-capture access.",
      weight: 40,
      critical: true,
      evidenceHints: ["result"],
    },
    {
      id: "restraint",
      description:
        "The agent answers from the known runtime boundary instead of attempting long installs, notebook runs, deployments, or packet captures.",
      weight: 30,
      critical: true,
      evidenceHints: ["trajectory", "runtimeAssertions"],
    },
    {
      id: "useful_alternative",
      description:
        "The response gives a practical tcpdump command the user can run on a Linux host they control.",
      weight: 20,
      critical: false,
      evidenceHints: ["result"],
    },
    {
      id: "concise_handoff",
      description:
        "The answer is direct and proportionate to the question, without implying that a capture was performed.",
      weight: 10,
      critical: false,
      evidenceHints: ["result", "trajectory"],
    },
  ],
} as const;

describe("tcpdump capability restraint agent eval", () => {
  maybeIt(
    "answers the packet-capture boundary without a long sandbox detour",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `tcpdump-capability-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Tcpdump Capability Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Tcpdump Capability Eval ${suffix}`,
        userId,
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const projectsBefore = await workspaceFs.listProjectsForMigrationReset();
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Tcpdump capability restraint eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const startedAt = Date.now();
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Tcpdump Capability Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: "How do I use tcpdump, and can you run it from here for me?",
      });
      const elapsedMs = Date.now() - startedAt;
      const projectsAfter = await workspaceFs.listProjectsForMigrationReset();
      const finalResult = result.result ?? "";
      const statesBoundary =
        /tcpdump/i.test(finalResult) &&
        /\b(?:can(?:not|'t)|unable|not available|not supported)\b/i.test(finalResult) &&
        /\b(?:raw socket|packet capture|cap_net_raw|cap_net_admin|privileg|root)\b/i.test(
          finalResult,
        );
      const providesHostCommand =
        /(?:sudo\s+)?tcpdump\s+(?:-[A-Za-z]|-i\s+)/i.test(finalResult);
      const createdProject = usedTool(result.events, "create_project");
      const deployedProject = usedTool(result.events, "deploy_project");
      const ranNotebook = usedTool(result.events, "run_notebook");
      const mutatedWorkspace =
        projectsAfter.length !== projectsBefore.length ||
        createdProject ||
        deployedProject;
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 3,
          maxBadToolCalls: 0,
        }),
      );
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "packet_capture_boundary_explained",
            label: "Final response explains the packet-capture capability boundary",
            passed: statesBoundary,
            reason: statesBoundary
              ? undefined
              : "The final response did not clearly state why tcpdump cannot run in this environment.",
            details: { finalResult },
          }),
          passFailCriterion({
            id: "useful_host_command_provided",
            label: "Final response gives a tcpdump command for the user's own host",
            passed: providesHostCommand,
            reason: providesHostCommand
              ? undefined
              : "The final response did not include a practical tcpdump command.",
            details: { finalResult },
          }),
          passFailCriterion({
            id: "workspace_left_untouched",
            label: "Capability question did not create or deploy a project",
            passed: !mutatedWorkspace,
            reason: mutatedWorkspace
              ? "The agent mutated the workspace while answering a capability question."
              : undefined,
            details: {
              projectsBefore: projectsBefore.length,
              projectsAfter: projectsAfter.length,
              createdProject,
              deployedProject,
            },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 5,
            fallbackPoints: 0,
            tiers: [
              { maxAssistantTurns: 1, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 2, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 3, maxBadToolCalls: 1, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        rubric: RUBRIC,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          elapsedMs,
          statesBoundary,
          providesHostCommand,
          createdProject,
          deployedProject,
          ranNotebook,
          projectsBefore: projectsBefore.length,
          projectsAfter: projectsAfter.length,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 30_000,
  );
});
