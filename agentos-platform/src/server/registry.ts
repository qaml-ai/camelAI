import { setup } from "rivetkit";
import { chatThread } from "./actors/chat-thread.ts";
import { org } from "./actors/org.ts";
import { workspace } from "./actors/workspace.ts";

export const registry = setup({
  use: { chatThread, org, workspace },
  envoy: { version: Number(process.env.RIVET_ENVOY_VERSION ?? "1") },
});

export type AppRegistry = typeof registry;
