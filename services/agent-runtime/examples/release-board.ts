import { AgentRuntime, schema, tool } from "../clients/typescript.ts";

// Your existing TypeScript app owns this state. The agent never imports it.
const issues = [
  { id: "APP-41", title: "Checkout retry duplicates receipts", severity: "high", owner: "Payments", status: "open" },
  { id: "APP-42", title: "Search loses keyboard focus", severity: "medium", owner: "Web", status: "open" },
  { id: "APP-43", title: "CSV export missing timezone", severity: "high", owner: "Data", status: "resolved" },
];
let releaseNote = "";

const runtime = new AgentRuntime({ url: process.env.AGENT_URL });
const agent = await runtime.createAgent({
  tools: {
    list_issues: tool({
      description: "Read the release board, including severity, owner and status.",
      input: schema.Object({}, { additionalProperties: false }),
      execute: () => issues,
    }),
    save_release_note: tool({
      description: "Replace the local release readiness note. No publishing or external messages.",
      input: schema.Object({ note: schema.String({ maxLength: 4000 }) }, { additionalProperties: false }),
      execute: ({ note }) => {
        releaseNote = note; // note is inferred as string from the schema.
        return { saved: true, note: releaseNote };
      },
    }),
  },
  onEvent(event) {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      for (const part of event.message.content) if (part.type === "text") console.log(part.text);
    }
  },
});
try {
  console.log(`\nTypeScript release board → hosted agent PID ${(await agent.status()).pid}`);
  const promptIndex = process.argv.indexOf("--prompt");
  const result = promptIndex >= 0
    ? await agent.prompt(process.argv[promptIndex + 1] ?? "Inspect the release board and save a concise go/no-go release note with unresolved blockers and owners.")
    : await agent.execute(`
        const issues = await tools.list_issues({});
        const blockers = issues.filter(issue => issue.severity === "high" && issue.status !== "resolved");
        const note = blockers.length ? "HOLD release: " + blockers.map(issue => issue.id + " — " + issue.title + " (" + issue.owner + ")").join("; ") : "Ready to ship";
        return await tools.save_release_note({note});
      `);
  if (result.error) throw new Error(result.error);
  console.log(JSON.stringify({ agentResult: result, localReleaseNote: releaseNote }, null, 2));
} finally {
  await agent.destroy();
}
