import { WorkerEntrypoint } from "cloudflare:workers";

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

const LEGACY_CONNECTION_INVOKE_METHOD = ["_", "_", "invoke"].join("");

function localUnavailable(): never {
	throw new Error(
		"CONNECTIONS is only available in apps deployed on camelAI; local dev has no connections service. Deploy the app to use workspace connections.",
	);
}

/**
 * Local CONNECTIONS placeholder used by the starter template.
 * Deploy pipeline rewrites this binding to the platform's internal ConnectionsService;
 * locally every call throws an error explaining that.
 */
export class LocalConnectionsService extends WorkerEntrypoint {
	async list(): Promise<ConnectionSummary[]> {
		return localUnavailable();
	}

	async get(_connection: string): Promise<ConnectionSummary> {
		return localUnavailable();
	}

	async tools(_connection: string): Promise<ConnectionToolSummary[]> {
		return localUnavailable();
	}

	async methods(): Promise<ConnectionMethodCatalogEntry[]> {
		return localUnavailable();
	}

	async find(_query: ConnectionFindQuery): Promise<ConnectionMethodCatalogEntry> {
		return localUnavailable();
	}

	test: WorkerEntrypoint["test"] & ((query: ConnectionFindQuery) => Promise<unknown>) = (async (
		_query: ConnectionFindQuery,
	) => localUnavailable()) as WorkerEntrypoint["test"] & ((query: ConnectionFindQuery) => Promise<unknown>);

	async invoke<T = unknown>(_invoke: ConnectionInvokeRequest): Promise<T> {
		return localUnavailable();
	}

	async [LEGACY_CONNECTION_INVOKE_METHOD](invoke: ConnectionInvokeRequest): Promise<unknown> {
		return this.invoke(invoke);
	}
}
