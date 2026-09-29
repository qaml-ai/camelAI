import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import {
	ANY_KEY,
	RELAY_NAME,
	createRelayQueue,
	createRelayServer,
	relayKeyFromAuthorization,
} from "../scripts/lib/eval-runtime-relay.mjs";
import { evalDefinitionBody, parseEnvFile } from "../scripts/lib/eval-runtime.mjs";

function token(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `Bearer ${part({ alg: "EdDSA" })}.${part(claims)}.c2ln`;
}

describe("eval relay routing", () => {
	it("routes a runtime identity token by its org", () => {
		expect(relayKeyFromAuthorization(token({ ctx: { org: "org_1", thread: "t" } }))).toBe("org_1");
		expect(relayKeyFromAuthorization(token({ sub: "agent" }))).toBe(ANY_KEY);
		expect(relayKeyFromAuthorization("Bearer not-a-jwt")).toBe(ANY_KEY);
		expect(relayKeyFromAuthorization(undefined)).toBe(ANY_KEY);
	});

	it("hands a request only to its org's poller, and one for no org to any", async () => {
		const queue = createRelayQueue();
		const other = queue.next("org_2", 50);
		const own = queue.next("org_1", 1_000);
		const answered = queue.submit("org_1", { id: "r1", method: "POST", url: "http://relay/mcp/agent", headers: {}, body: null });
		expect(await own).toMatchObject({ id: "r1", key: "org_1" });
		expect(await other).toBeNull();
		expect(queue.respond("r1", { status: 200, headers: {}, body: null })).toBe(true);
		expect(await answered).toEqual({ status: 200, headers: {}, body: null });
		expect(queue.respond("r1", { status: 200 })).toBe(false);

		const any = queue.submit(ANY_KEY, { id: "r2", method: "POST", url: "http://relay/mcp/agent", headers: {}, body: null });
		expect(await queue.next("org_3", 1_000)).toMatchObject({ id: "r2" });
		queue.respond("r2", { status: 202 });
		expect(await any).toEqual({ status: 202 });
	});

	it("never hands a request to a poller that went away, and requeues one it missed", async () => {
		const queue = createRelayQueue();
		const gone = new AbortController();
		const left = queue.next("org_1", 1_000, { signal: gone.signal });
		gone.abort();
		expect(await left).toBeNull();
		const answered = queue.submit("org_1", { id: "r1", method: "POST", url: "u", headers: {}, body: null });
		expect(queue.stats()).toMatchObject({ pending: 1, pollers: 0 });
		const taken = await queue.next("org_1", 10);
		// Its poller disconnected before the request was written: back to the queue, first.
		queue.requeue(taken);
		expect(await queue.next("org_1", 10)).toMatchObject({ id: "r1" });
		queue.respond("r1", { status: 200 });
		expect(await answered).toEqual({ status: 200 });
	});

	it("queues a request until its org polls, and drops one abandoned", async () => {
		const queue = createRelayQueue();
		void queue.submit("org_1", { id: "late", method: "POST", url: "u", headers: {}, body: null });
		void queue.submit("org_1", { id: "gone", method: "POST", url: "u", headers: {}, body: null });
		queue.abandon("gone");
		expect(queue.stats()).toMatchObject({ pending: 1, inFlight: 1 });
		expect(await queue.next("org_1", 10)).toMatchObject({ id: "late" });
		expect(await queue.next("org_1", 10)).toBeNull();
	});
});

describe("eval relay server", () => {
	it("carries a runtime request to the polling eval and its answer back", async () => {
		const { server } = createRelayServer({ pollWaitMs: 2_000, noPollerMs: 2_000 });
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const health = await (await fetch(`${base}/__eval_tunnel/health`)).json();
			expect(health).toMatchObject({ ok: true, relay: RELAY_NAME });

			// Nobody serves the org: refused, not held.
			const refused = await fetch(`${base}/mcp/agent`, { method: "POST", body: "{}" });
			expect(refused.status).toBe(503);

			const auth = token({ ctx: { org: "org_9" } });
			const poll = fetch(`${base}/__eval_tunnel/next?key=org_9&waitMs=2000`);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const call = fetch(`${base}/mcp/agent?x=1`, {
				method: "POST",
				headers: { authorization: auth, "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			});
			const relayed = await (await poll).json() as {
				id: string;
				url: string;
				body: string;
				headers: Record<string, string>;
			};
			expect(relayed).toMatchObject({ method: "POST", key: "org_9" });
			// As the runtime addressed it: the worker checks the token's audience against it.
			expect(relayed.url).toBe(`${base}/mcp/agent?x=1`);
			expect(JSON.parse(Buffer.from(relayed.body, "base64").toString("utf8"))).toMatchObject({ method: "tools/list" });
			expect(relayed.headers.authorization).toBe(auth);

			const answer = await fetch(`${base}/__eval_tunnel/respond/${relayed.id}`, {
				method: "POST",
				body: JSON.stringify({
					status: 200,
					headers: { "content-type": "application/json" },
					body: Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}').toString("base64"),
				}),
			});
			expect(answer.status).toBe(200);
			const response = await call;
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe("application/json");
			expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

describe("eval runtime setup", () => {
	it("defines camelai-thread as the deployed tenants do, with its tools at the relay", () => {
		expect(evalDefinitionBody("http://host.docker.internal:18791")).toEqual({
			name: "camelai-thread",
			model: "openrouter/anthropic/claude-sonnet-5:nitro",
			builtins: ["web_fetch", "web_search", "ask_user"],
			fileTools: false,
			mcpServers: [{
				name: "camel",
				url: "http://host.docker.internal:18791/mcp/agent",
				auth: { type: "runtime" },
				exposure: "both",
				timeoutMs: 1_200_000,
			}],
		});
	});

	it("reads the runtime's .env", () => {
		expect(parseEnvFile("# comment\nAGENT_TENANT=chiridion-eval\n  AGENT_BROWSER_URL=\nbad line\n")).toEqual({
			AGENT_TENANT: "chiridion-eval",
			AGENT_BROWSER_URL: "",
		});
	});
});
