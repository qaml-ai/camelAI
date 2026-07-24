import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import { buildWorkspaceScopedR2Key } from "../../../../src/lib/workspace-r2-paths";
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
import type { ChatThreadDO } from "../../src/chat-thread-do";

// End-to-end eval for handing the user a generated FILE.
//
// This is the failure that cost a real user six hours. Asked to turn uploaded
// tender documents into a spreadsheet, the agent produced a valid .xlsx inside
// the analysis sandbox and then had no way to deliver it: there was no writable
// outputs mount, so it tried shutil to an unmounted path, tried base64 through
// the text-only write tool (which corrupts binaries), and finally deployed an
// entire Cloudflare Worker whose only job was serving one spreadsheet. The user
// saw an unrelated app in their preview pane and a download link that 404'd.
//
// The eval asserts the OUTCOME, not the route: a real, non-empty, correctly
// shaped file has to land in workspace outputs where the user can download it.
// How the agent gets it there is its business.
//
// LOCAL RUNS NEED FUSE. Delivery goes through the container's s3fs /outputs
// mount, and Miniflare does not pass /dev/fuse into the eval container, so both
// /outputs AND the long-standing /uploads mount fail locally with
// "S3FS mount failed: fuse: device not found". A local failure of the two
// delivery criteria therefore means the sandbox could not mount, NOT that the
// agent misbehaved — check the run log for that message before believing the
// verdict. Run against a real deploy to exercise this end to end.
type OutputFileEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as OutputFileEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 300_000);

/** A .xlsx is a ZIP: every real one starts with the local file header "PK\x03\x04". */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function isXlsxBytes(bytes: Uint8Array): boolean {
  if (bytes.length < ZIP_MAGIC.length) return false;
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

describe("output file delivery agent eval", () => {
  maybeIt(
    "delivers a generated spreadsheet to workspace outputs",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `output-file-eval-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Output File Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Output File Eval ${suffix}`,
        userId,
      );

      // Seed a small input the agent has to actually read and aggregate, so a
      // delivered file that ignores the data cannot pass.
      const csv = [
        "item,plant,hours,rate",
        "dam construction,long reach excavator,102,145.50",
        "peat reprofiling,low ground pressure dumper,144,88.25",
        "bunding,long reach excavator,60,145.50",
      ].join("\n");
      await testEnv.R2_BUCKET.put(
        buildWorkspaceScopedR2Key(org.id, defaultWorkspaceId, "user-uploads/plant-costs.csv"),
        csv,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Output file delivery eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Output File Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "I've uploaded plant-costs.csv. Work out the total cost per item (hours x rate)",
          "and export it to an Excel file I can download. Give me the download link when it's ready.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 12,
          maxBadToolCalls: 2,
        }),
      );

      // The actual contract: something downloadable exists under this
      // workspace's outputs prefix.
      const outputsPrefix = buildWorkspaceScopedR2Key(
        org.id,
        defaultWorkspaceId,
        "user-outputs/",
      );
      const listed = await testEnv.R2_BUCKET.list({ prefix: outputsPrefix });
      const spreadsheets = listed.objects.filter((object) =>
        /\.(xlsx|xls|csv)$/i.test(object.key),
      );

      let deliveredBytes: Uint8Array | null = null;
      let deliveredKey: string | null = null;
      for (const object of spreadsheets) {
        const body = await testEnv.R2_BUCKET.get(object.key);
        if (!body) continue;
        const bytes = new Uint8Array(await body.arrayBuffer());
        if (bytes.length > 0) {
          deliveredBytes = bytes;
          deliveredKey = object.key;
          break;
        }
      }

      const deliveredFile = deliveredBytes !== null;
      const nonEmpty = (deliveredBytes?.length ?? 0) > 0;
      // Only enforce the ZIP signature for .xlsx — a CSV fallback is a
      // legitimate way to answer "export to Excel" and is still downloadable.
      const wellFormed = deliveredKey?.toLowerCase().endsWith(".xlsx")
        ? isXlsxBytes(deliveredBytes as Uint8Array)
        : nonEmpty;

      // Deploying an app purely to serve a file is the pathological workaround
      // this mount exists to remove.
      const deployedAnApp = (signal.toolCallsByName?.deploy_project ?? 0) > 0;

      const answerText = JSON.stringify(result.messages);
      // 102*145.50 = 14841, 144*88.25 = 12708, 60*145.50 = 8730.
      const citedATotal = /14[,.]?841|12[,.]?708|8[,.]?730/.test(answerText);

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "delivered_output_file",
            label: "A downloadable file landed in workspace outputs",
            passed: deliveredFile,
            reason: deliveredFile
              ? undefined
              : "No .xlsx/.xls/.csv object was written under the workspace outputs prefix.",
            details: {
              outputsPrefix,
              objectKeys: listed.objects.map((object) => object.key).slice(0, 20),
            },
          }),
          passFailCriterion({
            id: "output_file_well_formed",
            label: "The delivered file is non-empty and correctly formed",
            passed: wellFormed,
            reason: wellFormed
              ? undefined
              : "Delivered file was empty or not a valid xlsx (missing PK zip signature) — the signature of a binary corrupted by a text-only write.",
            details: { deliveredKey, byteLength: deliveredBytes?.length ?? 0 },
          }),
          passFailCriterion({
            id: "no_worker_to_serve_a_file",
            label: "Did not deploy an app just to hand over a file",
            passed: !deployedAnApp,
            reason: deployedAnApp
              ? "Agent deployed a project; delivering a file should not require publishing an app."
              : undefined,
            details: { toolCallsByName: signal.toolCallsByName },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 8, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 12, maxBadToolCalls: 1, points: 3 },
              { maxAssistantTurns: 20, maxBadToolCalls: 3, points: 2 },
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
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          deliveredKey,
          byteLength: deliveredBytes?.length ?? 0,
          wellFormed,
          deployedAnApp,
          citedATotal,
          outputKeys: listed.objects.map((object) => object.key).slice(0, 20),
          failures: [
            ...(deliveredFile ? [] : ["no file delivered to workspace outputs"]),
            ...(wellFormed ? [] : ["delivered file was empty or malformed"]),
            ...(deployedAnApp ? ["deployed an app to serve a file"] : []),
          ],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
