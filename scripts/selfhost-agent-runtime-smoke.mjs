#!/usr/bin/env node
/**
 * CI smoke for runtime auth, startup provisioning and restart idempotency.
 * Only run against a FRESH runtime: provisioning from throwaway state would
 * rotate a live install's webhook signing secret.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_AGENT_RUNTIME_PORT,
  SELFHOST_AGENT_RUNTIME_IMAGE,
  SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE,
  inspectSelfhostAgentRuntime,
  provisionSelfhostAgentRuntime,
  readAgentRuntimeState,
  threadDefinitionId,
  waitForAgentRuntime,
} from "./selfhost-agent-runtime.mjs";
import { readSelfhostEnv } from "./selfhost-common.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runtimeGet(url, route, token) {
  try {
    return await fetch(`${url}${route}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`GET ${route}: runtime request failed or timed out`);
  }
}

async function main() {
  const env = await readSelfhostEnv(true);
  if (process.argv.includes("--pinned")) {
    assert(
      env.SELFHOST_AGENT_RUNTIME_IMAGE === SELFHOST_AGENT_RUNTIME_IMAGE,
      `--pinned: .env.selfhost runs ${env.SELFHOST_AGENT_RUNTIME_IMAGE}, not the pinned ${SELFHOST_AGENT_RUNTIME_IMAGE}`,
    );
    assert(
      env.SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE === SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE,
      `--pinned: .env.selfhost runs ${env.SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE}, not the pinned ${SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE}`,
    );
  }

  const url = `http://127.0.0.1:${env.SELFHOST_AGENT_RUNTIME_PORT || DEFAULT_AGENT_RUNTIME_PORT}`;
  await waitForAgentRuntime({ url, timeoutMs: 60_000 });

  const unauthorized = await runtimeGet(url, "/v1/me", `art_${randomBytes(32).toString("base64url")}`);
  await unauthorized.body?.cancel();
  assert(unauthorized.status === 401, `GET /v1/me with an invalid operator token must return HTTP 401, got HTTP ${unauthorized.status}`);
  const me = await runtimeGet(url, "/v1/me", env.AGENT_RUNTIME_API_TOKEN);
  assert(me.status === 200, `GET /v1/me with AGENT_RUNTIME_API_TOKEN must return HTTP 200, got HTTP ${me.status}`);
  const { tenant } = await me.json();
  assert(tenant === env.AGENT_RUNTIME_TENANT, `AGENT_RUNTIME_API_TOKEN is tenant ${tenant}'s, not ${env.AGENT_RUNTIME_TENANT}'s`);

  const definitionId = threadDefinitionId(env.AGENT_RUNTIME_TENANT);
  const freshOnly = "This CI smoke only runs on a fresh runtime; provisioning from throwaway state would rotate a live install's webhook signing secret.";
  const definition = await runtimeGet(url, `/v1/definitions/${definitionId}`, env.AGENT_RUNTIME_API_TOKEN);
  await definition.body?.cancel();
  assert(definition.status === 404, `${freshOnly} Expected no thread definition (HTTP 404), got HTTP ${definition.status}.`);
  const beforeWebhooks = await runtimeGet(url, "/v1/webhooks", env.AGENT_RUNTIME_API_TOKEN);
  assert(beforeWebhooks.status === 200, `GET /v1/webhooks must return HTTP 200, got HTTP ${beforeWebhooks.status}. ${freshOnly}`);
  const beforeEndpoints = await beforeWebhooks.json();
  assert(Array.isArray(beforeEndpoints) && beforeEndpoints.length === 0, `${freshOnly} Expected an empty webhooks array.`);

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "camelai-runtime-smoke-"));
  try {
    const options = {
      env: {
        ...env,
        AGENT_RUNTIME_URL: url,
        SELFHOST_WORKERD_SOCKET: `${env.SELFHOST_BIND_ADDRESS || "127.0.0.1"}:${env.SELFHOST_APP_PORT || "3001"}`,
      },
      stateDir,
      waitTimeoutMs: 60_000,
    };
    // The app is not listening yet; the definition's MCP listing fails softly.
    const first = await provisionSelfhostAgentRuntime(options);
    assert(first !== null, "First runtime provisioning returned no result");
    assert(first.fresh === true, "First runtime provisioning must succeed without cached state");
    assert(first.definitionId === definitionId, "First runtime provisioning returned an unexpected thread definition id");
    assert(typeof first.webhookSecret === "string" && first.webhookSecret.startsWith("whsec_"), "First runtime provisioning returned no webhook signing secret");
    const firstState = await readAgentRuntimeState(stateDir);
    assert(firstState?.webhookId && firstState.definitionRevision != null, "First runtime provisioning must persist the webhook id and definition revision");

    const second = await provisionSelfhostAgentRuntime(options);
    assert(second !== null, "Second runtime provisioning returned no result");
    assert(second.fresh === true, "Second runtime provisioning must succeed without falling back to cached state");
    assert(second.definitionId === first.definitionId, "Restart provisioning changed the thread definition id");
    assert(second.webhookSecret === first.webhookSecret, "Restart provisioning rotated the webhook signing secret");
    const secondState = await readAgentRuntimeState(stateDir);
    assert(secondState?.webhookId === firstState.webhookId, "Restart provisioning changed the webhook id");
    assert(secondState?.definitionRevision === firstState.definitionRevision, "An unchanged thread definition must not create a new revision");

    const afterWebhooks = await runtimeGet(url, "/v1/webhooks", env.AGENT_RUNTIME_API_TOKEN);
    assert(afterWebhooks.status === 200, `GET /v1/webhooks after provisioning must return HTTP 200, got HTTP ${afterWebhooks.status}`);
    const afterEndpoints = await afterWebhooks.json();
    assert(Array.isArray(afterEndpoints) && afterEndpoints.length === 1, "Provisioning twice must leave exactly one webhook endpoint");
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }

  const inspection = await inspectSelfhostAgentRuntime({ env });
  for (const finding of inspection.findings) {
    console.log(`${finding.level}: ${finding.message}`);
  }
  assert(inspection.listening === true, "Runtime inspection could not reach the agent runtime");
  assert(inspection.findings.every((finding) => finding.level === "pass"), "Runtime inspection reported a warning or failure");
  console.log(`agent runtime ${env.SELFHOST_AGENT_RUNTIME_IMAGE} healthy at ${url}; tenant ${env.AGENT_RUNTIME_TENANT} provisioned twice, idempotently`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
