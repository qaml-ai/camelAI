# Template Quick Reference

This file is for you (the agent) to quickly understand the project structure.

## Framework Overview

This is a **React Router 7** fullstack application (the successor to Remix) with **SSR enabled** running on Cloudflare Workers.

**Key architecture principles:**
- **Business logic belongs on the backend** - Use loaders and actions for data fetching and mutations, not client-side fetches
- **Use separate routes** - Each distinct page/feature should have its own route file in `app/routes/`
- **Loaders run on the server** - Fetch data in `loader()` functions, which run before rendering
- **Actions handle mutations** - Form submissions and data changes go through `action()` functions
- **Components are for UI** - Keep React components focused on rendering, not business logic
- **Default to framework mode patterns** - Prefer `<Form>`/`useFetcher` + revalidation and avoid SPA-style `useEffect` data loading unless explicitly required

```typescript
// Example route with loader (server) and component (client)
export async function loader({ context }: Route.LoaderArgs) {
  // Runs on server - access Cloudflare bindings, databases, etc.
  const data = await context.cloudflare.env.MY_DO.get(...).getData();
  return { data };
}

export async function action({ request, context }: Route.ActionArgs) {
  // Handles form submissions on server
  const formData = await request.formData();
  await context.cloudflare.env.MY_DO.get(...).saveData(formData);
  return { success: true };
}

export default function MyPage() {
  const { data } = useLoaderData<typeof loader>();  // Type-safe!
  return <div>{/* Render data */}</div>;
}
```

## Streaming with React Suspense (Recommended)

Use streaming when a loader has both critical and non-critical data, especially if the non-critical part may take a while. This keeps initial SSR fast and unblocks the UI earlier.

React Router supports Suspense streaming by returning promises from loaders/actions.

### 1. Return a promise from the loader

Return non-critical data as a promise (do not `await` it), and await only critical data needed for first paint.

```typescript
import type { Route } from "./+types/my-route";

export async function loader({}: Route.LoaderArgs) {
  // Not awaited on purpose: streamed later
  const nonCriticalData = new Promise<string>((res) =>
    setTimeout(() => res("non-critical"), 5000),
  );

  const criticalData = await new Promise<string>((res) =>
    setTimeout(() => res("critical"), 300),
  );

  // Must return an object with keys (not a single bare promise)
  return { nonCriticalData, criticalData };
}
```

### 2. Render fallback + resolved UI (React 19)

Use `React.Suspense` with `React.use()` in a child component to render fallback UI while non-critical data resolves.

```tsx
import * as React from "react";
import type { Route } from "./+types/my-route";

function NonCriticalUI({ p }: { p: Promise<string> }) {
  const value = React.use(p);
  return <h3>Non-critical value: {value}</h3>;
}

export default function MyComponent({ loaderData }: Route.ComponentProps) {
  const { criticalData, nonCriticalData } = loaderData;

  return (
    <div>
      <h1>Streaming example</h1>
      <h2>Critical data value: {criticalData}</h2>

      <React.Suspense fallback={<div>Loading...</div>}>
        <NonCriticalUI p={nonCriticalData} />
      </React.Suspense>
    </div>
  );
}
```

## Key Files

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Cloudflare config - bindings, migrations, secrets |
| `workers/app.ts` | Worker entry point - exports Durable Objects |
| `workers/example-do.ts` | Example Durable Object with SQLite |
| `workers/data-proxy.ts` | Local `DATA_PROXY` service shim (virtualized on deploy) |
| `workers/chat.ts` | Pre-configured AI chat agent (commented out) |
| `workers/chat-sessions.ts` | Session index DO for chat history sidebar |
| `workers/camelai-service.ts` | `CAMELAI` service binding (`generateImage`; virtualized on deploy) |
| `workers/camelai-ai.ts` | Image helper implementation used by the local shim |
| `app/routes/` | React Router routes with loaders/actions |
| `app/schemas/` | Zod schemas shared between routes and DOs |

## Commands

```bash
bun dev                    # Local development
bun run deploy             # Deploy to Cloudflare
bun run test               # Run Vitest tests
bunx --bun shadcn@latest add <name> --yes  # Add UI components
```

## Common Data Libraries

The starter template includes these packages in `package.json` for data-driven applications:

- `recharts` - Chart components for dashboards/visualizations
- `@tanstack/react-table` - Headless data table engine (sorting/filtering/pagination)
- `date-fns` - Date parsing/formatting/utilities
- `papaparse` - CSV parsing/export utilities
- `lodash-es` - General data manipulation helpers

These are installed when you run `bun install`. Add additional packages as needed with `bun add <package>`.

## Enabling Features

### Durable Objects (for persistence)

1. Uncomment bindings and migrations in `wrangler.jsonc`
2. The `ExampleDO` is ready to use - just enable it

### R2 Object Storage (for files/blobs)

R2 buckets are available for storing files, images, and any unstructured data. You can use any bucket name — buckets are created automatically, no setup required.

1. Add `r2_buckets` to `wrangler.jsonc`:
```jsonc
"r2_buckets": [
  { "binding": "MY_BUCKET", "bucket_name": "myapp-uploads" }
]
```
2. Run `bun wrangler types` to update Env
3. Use in loaders/actions: `context.cloudflare.env.MY_BUCKET.put(key, data)`

Multiple buckets with any names are supported — just add more entries to the array. Use project-specific bucket names (e.g. `myapp-uploads` not just `uploads`) to avoid collisions with other projects.

### SQL Data Proxy (`DATA_PROXY`)

The template includes a `DATA_PROXY` service binding by default.

- Local dev: `DATA_PROXY` resolves to `LocalDataProxyService` in `workers/data-proxy.ts`, which returns an error for every query (there is no local database proxy)
- camelAI deploy: platform rewrites this binding to the internal `DataProxyService`

Example in a loader/action:

```typescript
const result = await context.cloudflare.env.DATA_PROXY.postgresQuery({
  mode: "read",
  host: "db.example.com",
  user: "user",
  password: "pass",
  database: "analytics",
  query: "SELECT * FROM users WHERE id = $1",
  params: [123],
});

if (!result.ok) throw new Error(result.error.message);
return { rows: result.data.recordset ?? [] };
```

### Connections Binding (`CONNECTIONS`)

The starter includes a `CONNECTIONS` service binding for workspace connections. Local dev binds to `LocalConnectionsService`, which throws on every call (connections only work in deployed apps). camelAI deploys rewrite the binding to the internal `ConnectionsService`.

Use `CONNECTIONS.find()` for the shortest path to a connection, or `CONNECTIONS.methods()` to inspect all available aliases, method names, input schemas, and examples. Use `createConnections()` for method-style calls:

```typescript
import { createConnections } from "~/lib/connections";

const connections = createConnections(context.cloudflare.env);
const stripe = await context.cloudflare.env.CONNECTIONS.find("stripe");
const customers = await connections[stripe.alias].listCustomers({ limit: 10 });
```

Database-style connections expose a normalized `query` method:

```typescript
const connections = createConnections(context.cloudflare.env);
const clickhouse = await context.cloudflare.env.CONNECTIONS.find("clickhouse");
const result = await connections[clickhouse.alias].query({ query: "SELECT 1 AS ok" });
```

Custom connections with type `other` expose a generic authenticated HTTP method
named `fetch`. Use it like normal `fetch(input, init)`:

```typescript
const custom = await context.cloudflare.env.CONNECTIONS.find({ type: "other" });

const response = await connections[custom.alias].fetch("/v1/items?limit=10", {
  method: "GET",
});
const result = await response.json();
```

Relative URLs are resolved against the connection `base_url`; camelAI applies the
stored auth settings automatically.

### Virtual AI Binding (`AI`)

You can use Cloudflare-style AI calls in user workers with a native AI binding:

```jsonc
"ai": { "binding": "AI" }
```

Then call it in loaders/actions with the Workers AI provider:

```typescript
import { createWorkersAI } from "workers-ai-provider";

const workersai = createWorkersAI({ binding: context.cloudflare.env.AI });

const result = await generateText({
  model: workersai("auto", {}),
  messages: [{ role: "user", content: "Hello!" }],
});
```

In camelAI deploys, this binding is virtualized and rewritten to an internal platform entrypoint through Cloudflare AI Gateway. Model routing is platform-controlled.

### CAMELAI binding (image generation)

The starter includes a `CAMELAI` service binding:

- Local dev: `LocalCamelAiService` in `workers/camelai-service.ts` (uses `env.AI.run("auto_image", ...)`)
- camelAI deploy: platform rewrites to internal `CamelAiService`

```typescript
const { imageDataUrl } = await context.cloudflare.env.CAMELAI.generateImage(
  "Flat vector robot mascot on a bright green background",
);
```

Do not use `workers-ai-provider` / `generateText()` with `auto_image` — images are dropped. Optional style reference: `generateImage({ prompt, referenceImageUrl })`.

### AI Chat Agent

The template has a complete AI chat setup with a history sidebar - just uncomment:

1. **wrangler.jsonc**: Uncomment `Chat` and `CHAT_SESSIONS` bindings + migrations
2. **workers/app.ts**: Uncomment `routeAgentRequest`, `Chat` export, `ChatSessionsDO` export, cookie logic (`ownerId`), and the cookie-aware `requestHandler` block (remove the plain `return requestHandler(...)` line)
3. **workers/app.ts**: Uncomment `ownerId` in the `AppLoadContext` type
4. **app/routes.ts**: Add `route("chat", "routes/chat.tsx")`

The chat includes a sidebar showing previous conversations, backed by `ChatSessionsDO` (an index DO that tracks sessions per anonymous user via a `chat-owner` cookie set in `workers/app.ts`). Each chat session is a separate `Chat` DO instance. Titles auto-update from the first user message.

**When adding tools to the chat agent:**
- **Always use codemode** (`createCodeTool` + `DynamicWorkerExecutor`) — it lets the LLM chain, branch, and parallelize tool calls in a single turn. Only skip codemode for a single trivially simple tool.
- **Add `outputSchema` to every tool** — generates real TypeScript types in codemode.
- **For structured output, use codemode return type conventions** — `Output.object()` does not work with the Workers AI provider when tools are present. Instead, define discriminated return types in your `createCodeTool` description. The LLM's generated code constructs typed objects directly.
- **Use `??` (not `||`) for defensive defaults** in tool execute functions — `||` silently replaces valid falsy values like `0`, `false`, or `""`.
- **Tool part rendering** — AI SDK v5+ uses `p.type === "tool-{name}"` (not `"tool-invocation"`), `p.state === "output-available"` (not `"result"`), and `p.output` (not `p.result`). See `chat.tsx` for the working pattern.

## Common Patterns

### Access Cloudflare Bindings

```typescript
export async function loader({ context }: Route.LoaderArgs) {
  const stub = context.cloudflare.env.MY_DO.get(
    context.cloudflare.env.MY_DO.idFromName("instance-id")
  );
  return await stub.myMethod();
}
```

### Add a New Durable Object

1. Create class in `workers/my-do.ts`
2. Export from `workers/app.ts`
3. Add binding to `wrangler.jsonc`
4. Add migration with incremented tag
5. Run `bun wrangler types` to update Env

## Design Defaults

Every project should ship with polished design fundamentals out of the box. When scaffolding or building any app, always include:

1. **Typography** - Before starting layout, choose at least two Google Fonts: a **display font** for headings and feature moments, and a **body font** for running text. The display font is a design asset — pick something that matches the project's personality (bold and expressive like Danfo or Fraunces for creative sites; refined like Instrument Serif or Space Grotesk for SaaS/tools). Carry the display font throughout the site, not just the hero. Use `--font` with `create-worker` for the body font, then add the display font via Google Fonts `@import` or `<link>` in `app/root.tsx` or `app/styles/globals.css`.

2. **Favicon** - Every app must have a favicon. Create or generate an SVG favicon that reflects the app's purpose and place it at `public/favicon.svg` (or `public/favicon.ico`). Reference it in the root `<head>` via a `<link rel="icon">` tag. A simple, recognizable icon is better than no icon.

3. **OpenGraph images** - Add OpenGraph meta tags (`og:title`, `og:description`, `og:image`) in the root route or layout so the app looks good when shared on social media, Slack, or messaging apps. Generate or create a `public/og-image.png` (recommended 1200x630px). Include `twitter:card` and `twitter:image` meta tags as well.

## Common Pitfalls

- **Durable Object SQLite is NOT the D1 API** — `ctx.storage.sql` has no `.prepare()`, `.bind()`, `.all()`, `.first()`, or `.run()`. Use `sql.exec("SELECT * FROM items WHERE id = ?", id)` with `.toArray()`/`.one()` on the returned cursor (see `workers/example-do.ts`). D1-style calls build cleanly and only crash at runtime after deploy; run `bun run typecheck` to catch this early.
- **Always pass a unique `name` to `useAgent`**: `useAgent({ agent: "Chat", name: sessionId })`. Without `name`, ALL users share the same DO instance ("default"), seeing each other's conversations. Every chat must have a unique session ID.
- **Generate session IDs in loaders**, not in component body (causes re-render issues). For persistence across refreshes, use `sessionStorage` on the client.
- **`useAgentChat` does NOT return `input`/`setInput`/`handleSubmit`** — these were removed in AI SDK v3. Manage your own input state with `useState("")` and send messages via `sendMessage({ role: "user", parts: [{ type: "text", text }] })`. Using the removed properties causes `"X is not a function"` errors.
- **Use MarkdownRenderer for AI output** - AI responses are markdown-formatted
- **Use `bunx --bun shadcn@latest add <name> --yes` in local shells** - not `npx shadcn` or `bun run shadcn`
