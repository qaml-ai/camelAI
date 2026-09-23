/** Node/Bun convenience entry. The portable SDK itself imports no Node modules. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeDurableJson } from "../shared/durable-json.ts";
import { AgentRuntime as PortableAgentRuntime, type RuntimeOptions as PortableRuntimeOptions, type Journal, type JournalStore } from "./typescript.ts";
export * from "./typescript.ts";
export interface RuntimeOptions extends PortableRuntimeOptions { stateDirectory?: string }
export function fileJournalStore(directory: string): JournalStore {
  const root = resolve(directory);
  const path = (id: string) => {
    if (!/^client_[a-f0-9]{40}$/.test(id)) throw new Error("Invalid journal session id");
    return join(root, `${id}.json`);
  };
  return {
    async load(id) {
      try { return JSON.parse(await readFile(path(id), "utf8")) as Journal; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    async save(id, journal) { writeDurableJson(path(id), journal); },
  };
}
export class AgentRuntime extends PortableAgentRuntime {
  constructor(options: RuntimeOptions = {}) {
    super({ ...options, url: options.url ?? process.env.AGENT_URL,
      apiKey: options.apiKey ?? process.env.AGENT_RUNTIME_TOKEN,
      journalStore: options.journalStore ?? fileJournalStore(options.stateDirectory ?? process.env.AGENT_CLIENT_STATE_DIR ?? ".agent-runtime/client-sdk"),
    });
  }
}
