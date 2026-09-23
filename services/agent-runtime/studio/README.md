# Local Agent Studio

A hands-on preview of an agent URL with chat, configuration, traces and run
reviews. Two applications expose ordinary SDK functions: a TypeScript release
board and a Python/SQLite cafe inventory planner. Each has its own agent process;
generated code runs in the existing QuickJS/WASM sandbox. No production services
or customer data are connected.

## Start

From the repository root:

```sh
bun install --frozen-lockfile
python3 -m venv .agent-runtime/python
.agent-runtime/python/bin/pip install -r services/agent-runtime/clients/python/requirements.txt
bun run agent:studio
```

The launcher detects `.agent-runtime/python/bin/python`; `PYTHON` can override it.

Open the **Developer** URL printed in the terminal. It unlocks the local inspector
with an HttpOnly cookie and removes the token from the address bar. The **Copy
chat link** button copies a URL without developer credentials. URLs only work on
this computer: the server binds to `127.0.0.1`, validates Host/Origin, and is not a
public hosting deployment. This is a trusted local demo, not multi-tenant auth.

- `/studio/agents`: registry of SDK-created agents grouped by type.
- `/a/:agentId`: end-user chat and voice only, with no developer navigation.
- `/studio/agents/:agentId/chat`: default developer view, with Chat / Runs / Configuration navigation.
- `/studio/agents/:agentId/runs`: developer run history, unlocked separately.
- `/studio/agents/:agentId/runs/:runId`: bookmarkable trace and review.
- `/studio/agents/:agentId/configuration`: system prompt and tool configuration.

Clicking an agent card or sidebar entry opens Studio Chat. **Share chat** copies
only the end-user URL. The shared page does not load the agent directory or show
admin links, even for a developer with an owner cookie. Developer code executions
are shown in Studio only; shared chat displays model conversation turns. The
agent directory, inspection APIs, and scripted examples require developer access.
Older `/application` links redirect to `/configuration`.

Both chat URLs use the same agent and conversation. This is still a loopback-only
prototype; publishing to real users requires hosting and agent access controls.

One agent is one persistent conversation; every prompt adds a run. `name`
identifies the instance, and `type` is a free-form grouping label supplied through
the SDK. There is no thread or agent-template layer. Renaming/regrouping preserves
the ID, URLs, and history. Existing demo links redirect to the canonical IDs.

Studio reads the operator-only runtime registry and request/event/tool journals.
It doesn't consume the application's SSE tool connection. New SDK clients appear
automatically, including clients that initiate runs outside the browser. Session
credentials are excluded from the registry. Public chat excludes tool schemas,
system prompts, raw traces, and diagnostic errors; local developer access is
required to inspect and review them.

The optional examples live in `../examples/studio-release.ts` and
`../examples/studio-inventory.py`. They register `September release` (type
`release-reviewer`) and `Downtown cafe` (type `inventory-planner`) through the same
SDK as any other application. Their tools/data are not owned by the dashboard.
Use `STUDIO_EXAMPLES=0 bun run agent:studio` to start without launching sample applications; existing agents remain listed.
The runtime URL is printed at startup and saved as `runtimeUrl` in `studio.json`;
the local `secrets.json` holds the server-side operator key for SDK provisioning.
See [SDK identity examples](../clients/README.md#agent-identity-and-studio).

## Live model or scripted example

`AGENT_API_KEY`, `AGENT_PROVIDER`, `AGENT_MODEL` and optional `AGENT_BASE_URL`
configure the model. The studio also recognizes `OPENROUTER_API_KEY`, defaulting
to `openrouter` / `anthropic/claude-sonnet-4.6`. Keys stay server-side. Live chat
makes billable inference requests to the selected provider.

Without a key, free-form chat is disabled and **Try scripted example** remains
available. Scripted mode uses fixed code with real sandbox execution and real
SDK tool calls; it is labeled separately and does not simulate model reasoning.

Try:

1. Release: “Are we ready to ship? Inspect the board and save a release note.”
2. Inspect the code and `save_release_note` result in **Runs & traces**.
3. “Mark APP-41 resolved, then update the release note.” Inspect the tool result in **Runs & traces**.
4. Open **Downtown cafe**: “Check stock and plan restocks for everything below target.”
5. Inspect the `plan_restock` results: 32 beans and 24 oat milk should be planned. No orders
   are placed. Add a review and reload the page.

## Voice

The microphone uses browser speech recognition to put an editable transcript in
the composer. Review it and press **Send**. The speaker button enables spoken
replies; Stop audio interrupts speech, and Stop cancels an active agent turn.
This is turn-based browser voice, not a full-duplex realtime voice service.
Recognition availability depends on the browser, microphone permission and its
speech service (which may process audio remotely). Unsupported browsers disable
the microphone and retain text chat. Try Chrome if the embedded browser's speech
service is unavailable. Actual microphone/audio quality requires a human check.

## Persistence and limits

`.agent-runtime/studio` stores local session credentials, model conversation
history, release data, SQLite inventory, completed run traces and reviews. The
runtime's existing 24-hour scoped session expiry still applies. Restarting with
the same directory resumes settled conversations; interrupted model turns may
require the runtime's existing manual reconciliation. This demo doesn't add
crash-safe continuation or extend expired credentials. Keep this directory
private; traces intentionally contain prompts and tool data.

The inspector retains 50 runs per agent, at most 300 trace entries per run, and
omits trace payloads above 100,000 characters. It is a local debugging surface,
not the service's production telemetry architecture. `STUDIO_DATA_DIR` selects a
separate demo workspace; `STUDIO_PORT` defaults to 8789. Runtime ports are chosen
automatically. Ctrl-C shuts down the tool workers, supervisor and agent processes.
The existing CLI demos remain available through `bun run agent:demo:clients`.

## Verification

```sh
PYTHON="$PWD/.agent-runtime/python/bin/python" bun run test:agent-studio
bun x tsc -p services/agent-runtime/studio/tsconfig.json
bun run test:agent-runtime
```

The studio smoke test uses a temporary workspace and no model credentials. It
checks both stacks' real tool execution, developer-only traces/reviews,
cross-origin rejection, discovery of an unrelated third SDK agent, rename/regroup,
and persistence across a full studio/runtime restart. The inspector polls the
local runtime every 500 ms. Runtime event replay is bounded; if Studio missed
earlier events, the trace reports a gap rather than claiming a complete trace.
