# Running outside camelAI

This directory contains the runtime, SDKs, QuickJS executor, local Studio, sample
applications and tests. Copy it into a new checkout without the rest of camelAI.
It has its own package manifest and no production imports into the parent app.
The old parent `packages/agent-core/code-mode-source.ts` now re-exports this
project's implementation, rather than the runtime importing camelAI code.

With Bun installed:

```sh
bun install
bun run typecheck
bun run test
bun run build
bun run demo
```

`bun run demo` exercises the sandbox without model credentials. To run the API,
set `AGENT_RUNTIME_TOKEN` to an operator secret and run `bun start`. Configure
`AGENT_PROVIDER`, `AGENT_MODEL`, and `AGENT_API_KEY` for actual model turns.
See the README for supported provider configuration and security limitations.

`bun run studio` builds and starts the local chat/trace UI. The sample Python
client needs the dependencies in `clients/python/requirements.txt`; install them
in a virtual environment and point `PYTHON` at that environment's executable.
Use `STUDIO_EXAMPLES=0 bun run studio` to run without sample applications.
`examples/run-application.ts` is the optional camelAI development launcher; it
requires the parent application and is not a standalone service entry point.

The package remains private and exports TypeScript source for Bun and bundlers;
it is not yet a published, compiled JavaScript npm release. The service can also
run under Node 22.21+ using `node --experimental-strip-types src/server.ts`.

## SDK environments

- `clients/typescript.ts` (package root export) uses Web APIs and is suitable for
  trusted servers, including Cloudflare Workers. Set `url` and `apiKey`
  explicitly. Its default receipt/cursor journal is in memory. Inject a durable
  `JournalStore` for restart-safe receipt recovery; `load` and `save` are async,
  and `save` must resolve only after the snapshot is committed.
- `clients/node.ts` (`/node` export) provides environment variable defaults and
  filesystem journals. It accepts `stateDirectory` or an explicit `journalStore`.
- Keep `SessionCredentials` in your application's secret storage and reconnect
  with `runtime.connectAgent(credentials, { tools, onEvent })`. Use one active
  SDK client per agent. Event handlers may return promises; the cursor advances
  only once a handler succeeds. The second callback argument is the request ID.

SDK portability does not make operator or agent-control tokens safe to expose in
an end-user browser. The built-in public chat surface is a separate access path.
