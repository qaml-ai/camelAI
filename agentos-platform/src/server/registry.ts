import { setup as agentOsSetup } from "@rivet-dev/agentos";
import { setup as rivetSetup } from "rivetkit";
import { chatThreadAgentOs } from "./actors/chat-thread-agentos.ts";
import { chatThread } from "./actors/chat-thread.ts";
import { org } from "./actors/org.ts";
import { workspace } from "./actors/workspace.ts";

// agentOS currently carries RivetKit 2.3.9 while this app uses 2.3.10. Their
// setup functions are runtime-compatible, but Registry's private type identity
// differs across those package instances.
const setup: typeof rivetSetup =
  process.env.AGENT_RUNTIME === "agentos"
    ? (agentOsSetup as unknown as typeof rivetSetup)
    : rivetSetup;

export const registry = setup({
  use: { chatThread, chatThreadAgentOs, org, workspace },
  envoy: { version: Number(process.env.RIVET_ENVOY_VERSION ?? "1") },
});

export type AppRegistry = typeof registry;
