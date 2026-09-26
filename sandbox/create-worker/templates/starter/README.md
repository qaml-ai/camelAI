# camelAI Starter Template

Full-stack React app with SSR, Durable Objects, and SQLite. Built on React Router 7 and Cloudflare Workers.

## Architecture Default

Use React Router 7 in framework mode (successor to Remix): data reads in route `loader()`, mutations in `action()`, and forms/fetchers for server-driven updates. Prefer this over SPA-style client fetching patterns by default.

## Quick Start

```bash
bun dev          # Start dev server
bun run test     # Run tests
bun run build    # Build for production
bun run deploy   # Deploy to Cloudflare
```

## Project Structure

```
app/
  routes/           # React Router routes (loaders, actions, components)
  schemas/          # Zod schemas (shared between routes and DOs)
workers/
  app.ts            # Worker entry point (exports DOs)
  example-do.ts     # Example Durable Object with SQLite
  tests/            # Vitest tests for Durable Objects
wrangler.jsonc      # Cloudflare config (bindings, migrations)
vitest.config.ts    # Vitest config for Workers pool
```

## Key Patterns

### Accessing Cloudflare Bindings in Loaders/Actions

```typescript
export async function loader({ context }: Route.LoaderArgs) {
  // Access any binding via context.cloudflare.env
  const id = context.cloudflare.env.EXAMPLE_DO.idFromName("global");
  const stub = context.cloudflare.env.EXAMPLE_DO.get(id);

  // Call RPC methods directly (not fetch!)
  const data = await stub.listContacts();
  return { data };
}
```

### SQL Data Proxy Service Binding

The starter includes a `DATA_PROXY` service binding.

- Local dev: binding points to `LocalDataProxyService` (`workers/data-proxy.ts`), which returns an error for every query (there is no local database proxy)
- camelAI deploy: platform rewrites `DATA_PROXY` to its internal service binding

```typescript
export async function loader({ context }: Route.LoaderArgs) {
  const result = await context.cloudflare.env.DATA_PROXY.mysqlQuery({
    mode: "read",
    host: "db.example.com",
    user: "user",
    password: "pass",
    database: "analytics",
    query: "SELECT * FROM orders WHERE customer_id = ?",
    params: [123],
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return { rows: result.data.recordset ?? [] };
}
```

### Connections Service Binding

The starter includes a `CONNECTIONS` service binding for workspace connections. Local dev binds to `LocalConnectionsService`, which throws on every call (connections only work in deployed apps). camelAI deploys rewrite the binding to the internal `ConnectionsService`.

Use `CONNECTIONS.find()` for the shortest path to a connection, or `CONNECTIONS.methods()` to inspect all available aliases, method names, input schemas, and examples. Use `createConnections()` for method-style calls:

```typescript
import { createConnections } from "~/lib/connections";

export async function action({ context }: Route.ActionArgs) {
  const connections = createConnections(context.cloudflare.env);
  const stripe = await context.cloudflare.env.CONNECTIONS.find("stripe");
  const customers = await connections[stripe.alias].listCustomers({ limit: 10 });
  return { customers };
}
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

### Durable Object with SQLite

Note: this is NOT the D1 API — `SqlStorage` has no `.prepare()`, `.bind()`, `.all()`, `.first()`, or `.run()`. Pass parameters directly: `sql.exec("SELECT * FROM items WHERE id = ?", id)` and read the cursor with `.toArray()` / `.one()` / `.raw()`.

```typescript
export class MyDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Create tables (idempotent)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (...)`);
  }

  // RPC method - callable from routes
  async listItems() {
    return this.sql.exec("SELECT * FROM items").toArray();
  }
}
```

### Shared Zod Schemas

Put schemas in `app/schemas/` and import in both routes and DOs:

```typescript
// app/schemas/contact.ts
export const CreateContactSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

// In route action:
const result = CreateContactSchema.safeParse(formData);

// In DO: use the same types
async createContact(input: CreateContactInput) { ... }
```

### HydrateFallback for Loading States

```typescript
// Shows during initial hydration (SSR → client)
export function HydrateFallback() {
  return <div>Loading...</div>;
}
```

## Testing

```bash
bun run test  # Run tests with vitest
```

### Testing Durable Objects

Tests use `@cloudflare/vitest-pool-workers` for isolated DO testing:

The template disables `remoteBindings` in `vitest.config.ts` so tests run fully
locally in workerd. This avoids requiring Cloudflare preview API access for
bindings such as `AI`, which Wrangler otherwise treats as remote by default.

```typescript
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("MyDO", () => {
  it("creates and retrieves items", async () => {
    // Get a DO stub from env bindings
    const id = env.MY_DO.idFromName("test");
    const stub = env.MY_DO.get(id);

    // Call RPC methods directly
    await stub.createItem({ name: "Test" });
    const items = await stub.listItems();

    expect(items).toHaveLength(1);
  });
});
```

See `workers/tests/example-do.test.ts` for a complete example.

**Known limitation:** Tests expecting DO methods to throw exceptions may cause "Failed to pop isolated storage stack frame" errors. Test error handling in route actions instead.

## Adding a New Durable Object

1. Create the class in `workers/my-do.ts`
2. Export from `workers/app.ts`: `export { MyDO } from "./my-do"`
3. Add binding to `wrangler.jsonc`:
   ```jsonc
   "durable_objects": {
     "bindings": [{ "name": "MY_DO", "class_name": "MyDO" }]
   }
   ```
4. Add migration (increment tag):
   ```jsonc
   "migrations": [
     { "tag": "v1", "new_sqlite_classes": ["ExampleDO"] },
     { "tag": "v2", "new_sqlite_classes": ["MyDO"] }
   ]
   ```
5. `postinstall` runs `wrangler types` automatically; re-run `bun run cf-typegen` after binding changes to update `Env` types

## Adding shadcn/ui Components

Use `bunx` to run the shadcn CLI:

```bash
bunx --bun shadcn@latest add button card input --yes
```

Components install to `app/components/ui/`.
