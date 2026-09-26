import { WorkerEntrypoint } from "cloudflare:workers";

export interface DataProxyServiceError {
	message: string;
	status?: number;
	code?: string;
	number?: number;
}

export type DataProxyServiceResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: DataProxyServiceError };

export type SqlQueryMode = "read" | "modify";

export interface MssqlQueryRequest {
	mode: SqlQueryMode;
	server: string;
	port?: number;
	user: string;
	password: string;
	database?: string;
	query: string;
	params?: Record<string, unknown>;
	encrypt?: boolean;
	trustServerCertificate?: boolean;
}

export interface SqlQueryRequest {
	mode: SqlQueryMode;
	host: string;
	port?: number;
	user: string;
	password: string;
	database?: string;
	query: string;
	params?: unknown[];
}

export interface PostgresQueryRequest extends SqlQueryRequest {
	sslmode?: string;
}

export interface MysqlQueryRequest extends SqlQueryRequest {
	tls?: string;
	charset?: string;
}

export interface SqlQueryResponse {
	recordset?: Record<string, unknown>[];
	rowsAffected?: number[];
	error?: string;
	code?: string;
	number?: number;
}

const LOCAL_UNAVAILABLE_MESSAGE =
	"DATA_PROXY is only available in apps deployed on camelAI; local dev has no database proxy. Deploy the app to run SQL queries.";

function localUnavailable<T>(): DataProxyServiceResult<T> {
	return { ok: false, error: { message: LOCAL_UNAVAILABLE_MESSAGE, status: 501 } };
}

/**
 * Local DATA_PROXY placeholder used by the starter template.
 * Deploy pipeline rewrites this binding to the platform's internal DataProxyService;
 * locally every query returns an error explaining that.
 */
export class LocalDataProxyService extends WorkerEntrypoint {
	async mssqlQuery(_request: MssqlQueryRequest): Promise<DataProxyServiceResult<SqlQueryResponse>> {
		return localUnavailable();
	}

	async postgresQuery(_request: PostgresQueryRequest): Promise<DataProxyServiceResult<SqlQueryResponse>> {
		return localUnavailable();
	}

	async mysqlQuery(_request: MysqlQueryRequest): Promise<DataProxyServiceResult<SqlQueryResponse>> {
		return localUnavailable();
	}
}
