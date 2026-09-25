import { WorkerEntrypoint } from "cloudflare:workers";

interface LocalConnectionsEnv {
	CAMELAI_CONNECTIONS_RPC_URL?: string;
	CONNECTIONS_RPC_URL?: string;
}

export interface ConnectionSummary {
	id: string;
	type: string;
	name: string;
	displayName: string;
	category: string;
	authMethod: string;
	hasCredentials: boolean;
	capabilities: string[];
	nativeMcp: unknown;
}

export interface ConnectionToolSummary {
	name: string;
	description?: string;
	inputSchema?: unknown;
	[key: string]: unknown;
}

export interface ConnectionMethodSummary {
	name: string;
	tool: string;
	description?: string;
	example?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
}

export interface ConnectionMethodCatalogEntry {
	alias: string;
	connection: ConnectionSummary;
	methods: ConnectionMethodSummary[];
	error?: {
		message: string;
		code?: unknown;
		data?: unknown;
	};
}

export type ConnectionFindQuery =
	| string
	| {
			id?: string;
			alias?: string;
			type?: string;
			name?: string;
	  };

export interface ConnectionInvokeRequest {
	connection: string;
	method?: string;
	input?: unknown;
}

type RpcResponse<T> = {
	ok?: boolean;
	result?: T;
	error?: {
		message?: unknown;
		code?: unknown;
		data?: unknown;
	};
};

const LEGACY_CONNECTION_INVOKE_METHOD = ["_", "_", "invoke"].join("");

function connectionsRpcUrl(env: LocalConnectionsEnv): string {
	const explicit = (env.CAMELAI_CONNECTIONS_RPC_URL ?? env.CONNECTIONS_RPC_URL ?? "").trim();
	if (explicit) return explicit.replace(/\/+$/, "");

	throw new Error("CAMELAI_CONNECTIONS_RPC_URL is not configured for local CONNECTIONS service");
}

async function callConnectionsRpc<T>(
	env: LocalConnectionsEnv,
	action: string,
	params: Record<string, unknown> = {},
): Promise<T> {
	const response = await fetch(connectionsRpcUrl(env), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ action, ...params }),
	});

	const body = await response.json().catch(() => null) as RpcResponse<T> | null;
	if (!response.ok || body?.ok === false || body?.error) {
		throw new Error(
			typeof body?.error?.message === "string"
				? body.error.message
				: `Connections RPC request failed (${response.status})`
		);
	}
	if (!body || !("result" in body)) {
		throw new Error("Connections RPC returned an empty response");
	}
	return body.result as T;
}

/**
 * Local CONNECTIONS shim used by the starter template.
 * It speaks the connections RPC protocol to `CAMELAI_CONNECTIONS_RPC_URL`.
 */
export class LocalConnectionsService extends WorkerEntrypoint<LocalConnectionsEnv> {
	async list(): Promise<ConnectionSummary[]> {
		return callConnectionsRpc<ConnectionSummary[]>(this.env, "list");
	}

	async get(connection: string): Promise<ConnectionSummary> {
		return callConnectionsRpc<ConnectionSummary>(this.env, "get", { connection });
	}

	async tools(connection: string): Promise<ConnectionToolSummary[]> {
		return callConnectionsRpc<ConnectionToolSummary[]>(this.env, "tools", { connection });
	}

	async methods(): Promise<ConnectionMethodCatalogEntry[]> {
		return callConnectionsRpc<ConnectionMethodCatalogEntry[]>(this.env, "methods");
	}

	async find(query: ConnectionFindQuery): Promise<ConnectionMethodCatalogEntry> {
		return callConnectionsRpc<ConnectionMethodCatalogEntry>(this.env, "find", { query });
	}

	test: WorkerEntrypoint<LocalConnectionsEnv>["test"] & ((query: ConnectionFindQuery) => Promise<unknown>) = ((
		query: ConnectionFindQuery,
	) => callConnectionsRpc<unknown>(this.env, "test", { query })) as WorkerEntrypoint<LocalConnectionsEnv>["test"] &
		((query: ConnectionFindQuery) => Promise<unknown>);

	async invoke<T = unknown>(invoke: ConnectionInvokeRequest): Promise<T> {
		return callConnectionsRpc<T>(this.env, "invoke", invoke as unknown as Record<string, unknown>);
	}

	async [LEGACY_CONNECTION_INVOKE_METHOD](invoke: ConnectionInvokeRequest): Promise<unknown> {
		return this.invoke(invoke);
	}
}
