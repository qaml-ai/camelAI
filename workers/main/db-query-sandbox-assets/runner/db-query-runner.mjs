/**
 * db-query runner — shipped from the worker, executed once per query/export.
 *
 * This whole file is embedded in the worker and piped into `node
 * --input-type=module` over stdin by db-query-service.ts (a single stateless
 * exec — no file is written). It is NOT baked into the image, so changing how
 * we query is a worker-only change — no image rebuild. Only the runtime (node),
 * the drivers (pg/pg-cursor/mysql2/tedious/@dsnp/parquetjs/socks, baked at
 * /opt/db-query-runner/node_modules), and cloudflared live in the image.
 *
 * This runner is the full replacement for the retired Go data-proxy
 * (project-runtime-service cmd/data-proxy) and mirrors its contract:
 *   - engines: postgres, mysql, mssql
 *   - mode "read": the query runs inside a transaction that is ALWAYS rolled
 *     back (safety net when callers cannot guarantee read-only credentials);
 *     mode "modify": plain execution returning rowsAffected.
 *   - op "query": point query, result as one JSON line on stdout, response
 *     size capped (maxResponseBytes) instead of row-capped when rowLimit is
 *     null.
 *   - op "export": bulk read-only extract streamed as a Snappy-compressed
 *     Apache Parquet file written DIRECTLY to the workspace's warehouse R2
 *     prefix via the sandbox SDK's credential-less bucket mount (the worker
 *     mounts it before the exec; DB_EXPORT_PATH points inside it). No size
 *     cap; the same column-typing rules as the Go encoder (unambiguous
 *     ints/floats/bools native, everything else UTF8 for DuckDB to CAST).
 *
 * Two consumers, deliberately:
 *   1. Piped into `node --input-type=module` inside the container — the
 *      DB_QUERY_REQUEST env var selects query vs export dispatch.
 *   2. vitest (`tests/db-query-runner-guard.test.ts`) imports the pure
 *      guard/validate/typing functions below. Nothing runs there (no
 *      DB_QUERY_REQUEST env), and the DB drivers are imported *dynamically*
 *      inside the engine functions, so importing this module never resolves
 *      pg/mysql2/tedious.
 *
 * Inputs (env, set by db-query-service.ts on the exec — never baked):
 *   DB_QUERY_REQUEST                 JSON of the validated query request
 *   DB_EGRESS_RELAY_SOCKS_USERNAME   gost SOCKS auth (absent = direct dial)
 *   DB_EGRESS_RELAY_SOCKS_PASSWORD
 *   DB_RELAY_LOCAL_PORT              local port of the cloudflared access-tcp forwarder
 *   DB_EXPORT_PATH                   op "export": file path inside the mounted R2 prefix
 *
 * Transport: the hostname is resolved HERE and only a vetted public IP literal
 * is handed to the SOCKS relay (see the guard section); TLS to the database
 * still verifies against the original hostname via `servername`.
 */

// ===========================================================================
// Pure guard / validation (no imports — safe to import from tests)
// ===========================================================================

/** IPv4 ranges that must never be relay CONNECT targets. */
export const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private (includes the relay VM's Azure VNet)
  "100.64.0.0/10", // CGNAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, includes Azure IMDS 169.254.169.254
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved + broadcast
];

/** Hostnames/suffixes rejected before DNS resolution is even attempted. */
export const BLOCKED_HOSTNAME_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
];

function parseIpv4(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  let value = 0;
  for (let index = 1; index <= 4; index += 1) {
    const group = match[index];
    // Reject leading-zero octets ("012", "0177"): we read them as decimal, but
    // resolvers/SOCKS commonly read them as OCTAL (012 → 10, 0177 → 127), so a
    // padded literal could vet as public here yet dial a private/loopback host.
    // Refusing them (→ "not an IP" → blocked) closes that SSRF-guard bypass.
    if (group.length > 1 && group[0] === "0") return null;
    const octet = Number(group);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4InCidr(value, cidr) {
  const [base, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const baseValue = parseIpv4(base);
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

/**
 * Expand an IPv6 string into an array of eight 16-bit words, or null if it
 * does not parse. Handles `::` compression and a trailing embedded IPv4
 * (`::ffff:192.0.2.1`).
 */
export function parseIpv6(text) {
  let body = text;
  // Zone index (fe80::1%eth0) — strip; the zone never changes range class.
  const zone = body.indexOf("%");
  if (zone !== -1) body = body.slice(0, zone);
  if (body.includes(":::")) return null;

  // Embedded IPv4 tail.
  let tailWords = [];
  const lastColon = body.lastIndexOf(":");
  if (lastColon !== -1 && body.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(body.slice(lastColon + 1));
    if (v4 === null) return null;
    tailWords = [Math.floor(v4 / 65536), v4 % 65536];
    body = body.slice(0, lastColon + 1); // keep the colon: "::ffff:" stays valid
  }

  const doubleIndex = body.indexOf("::");
  if (doubleIndex !== body.lastIndexOf("::")) return null;

  const parseGroups = (part) => {
    if (part === "") return [];
    const groups = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  let words;
  if (doubleIndex === -1) {
    const groups = parseGroups(body);
    if (!groups) return null;
    words = [...groups, ...tailWords];
    if (words.length !== 8) return null;
  } else {
    const head = parseGroups(body.slice(0, doubleIndex));
    const tail = parseGroups(body.slice(doubleIndex + 2).replace(/:$/, ""));
    if (!head || !tail) return null;
    const filled = [...tail, ...tailWords];
    if (head.length + filled.length > 7) return null;
    words = [...head, ...Array.from({ length: 8 - head.length - filled.length }, () => 0), ...filled];
  }
  return words;
}

function blockedIpv6Reason(words) {
  const isAllZero = words.every((word) => word === 0);
  if (isAllZero) return "unspecified address";
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return "loopback address";
  // v4-mapped / v4-compatible (::ffff:a.b.c.d and ::a.b.c.d): apply IPv4 policy.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0xffff || words[5] === 0)) {
    const v4 = words[6] * 65536 + words[7];
    const blocked = BLOCKED_IPV4_CIDRS.find((cidr) => ipv4InCidr(v4, cidr));
    if (blocked) return `maps to blocked IPv4 range ${blocked}`;
    return words[5] === 0xffff ? null : "IPv4-compatible IPv6 address";
  }
  const top = words[0];
  if ((top & 0xfe00) === 0xfc00) return "unique-local range fc00::/7";
  if ((top & 0xffc0) === 0xfe80) return "link-local range fe80::/10";
  if ((top & 0xff00) === 0xff00) return "multicast range ff00::/8";
  if (top === 0x2001 && words[1] === 0x0db8) return "documentation range 2001:db8::/32";
  return null;
}

/**
 * Why `address` may not be a relay CONNECT target, or null if it is a public
 * unicast IP. Non-IP input is rejected (the runner resolves names first).
 */
export function blockedAddressReason(address) {
  if (typeof address !== "string" || !address.trim()) return "empty address";
  const text = address.trim();
  const v4 = parseIpv4(text);
  if (v4 !== null) {
    const blocked = BLOCKED_IPV4_CIDRS.find((cidr) => ipv4InCidr(v4, cidr));
    return blocked ? `blocked IPv4 range ${blocked}` : null;
  }
  if (text.includes(":")) {
    const words = parseIpv6(text);
    if (!words) return "unparseable IPv6 address";
    return blockedIpv6Reason(words);
  }
  return "not an IP address";
}

/** True when `address` is a public unicast IP the relay may CONNECT to. */
export function isPublicIpAddress(address) {
  return blockedAddressReason(address) === null;
}

/** Throws (with the range that matched) unless the address is public. */
export function assertPublicAddress(address) {
  const reason = blockedAddressReason(address);
  if (reason) {
    throw new Error(`Refusing to relay to ${address}: ${reason}`);
  }
}

/**
 * Why `hostname` must not even be resolved, or null if resolution may
 * proceed. Pre-resolution backstop; the resolved IPs still go through
 * assertPublicAddress.
 */
export function blockedHostnameReason(hostname) {
  if (typeof hostname !== "string" || !hostname.trim()) return "empty hostname";
  const name = hostname.trim().toLowerCase().replace(/\.$/, "");
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (suffix.startsWith(".") ? name.endsWith(suffix) : name === suffix) {
      return `hostname matches blocked suffix "${suffix}"`;
    }
  }
  if (name === "metadata.google.internal" || name === "metadata") return "metadata hostname";
  return null;
}

export const SUPPORTED_ENGINES = ["postgres", "mysql", "mssql"];
export const QUERY_MODES = ["read", "modify"];
export const DEFAULT_ROW_LIMIT = 1_000;
export const MAX_ROW_LIMIT = 10_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
// "prefer" (mysql semantics): try TLS, fall back to plaintext when the server
// doesn't support it — the parity mode for go-sql-driver's default "preferred".
const SSL_MODES = ["disable", "require", "verify-ca", "verify-full", "prefer"];

function fail(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

/**
 * Validate and normalize a query/export request. Throws Error{status:400}
 * with a caller-safe message on any shape problem. The worker validates too,
 * but this stays the authoritative gate since it runs next to the actual dial.
 */
export function validateQueryRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("request body must be an object");
  const { engine, target, sql } = body;
  if (!SUPPORTED_ENGINES.includes(engine)) fail(`engine must be one of: ${SUPPORTED_ENGINES.join(", ")}`);
  const op = body.op ?? "query";
  if (op !== "query" && op !== "export") fail('op must be "query" or "export"');
  const mode = body.mode ?? "read";
  if (!QUERY_MODES.includes(mode)) fail(`mode must be one of: ${QUERY_MODES.join(", ")}`);
  if (op === "export" && mode !== "read") fail("export is always read-only");
  if (typeof sql !== "string" || !sql.trim()) fail("sql must be a non-empty string");
  if (!target || typeof target !== "object" || Array.isArray(target)) fail("target must be an object");
  if (typeof target.host !== "string" || !target.host.trim()) fail("target.host must be a non-empty string");
  const port = target.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("target.port must be an integer in 1-65535");
  if (typeof target.user !== "string" || !target.user) fail("target.user must be a non-empty string");
  if (typeof target.password !== "string") fail("target.password must be a string");
  // mysql allows connecting without selecting a database (Go parity); the
  // other engines require one (the worker compat layer supplies the legacy
  // defaults: postgres → "postgres", mssql → "master").
  if (typeof target.database !== "string" || (!target.database && engine !== "mysql")) {
    fail("target.database must be a non-empty string");
  }
  const sslMode = target.sslMode ?? "require";
  if (!SSL_MODES.includes(sslMode)) fail(`target.sslMode must be one of: ${SSL_MODES.join(", ")}`);
  if (target.charset !== undefined && (typeof target.charset !== "string" || !/^[a-zA-Z0-9_]+$/.test(target.charset))) {
    fail("target.charset must be an identifier string");
  }

  // rowLimit: undefined → default; null → uncapped (the byte cap below still
  // bounds the response). Only meaningful for op "query" in read mode.
  let rowLimit = body.rowLimit === undefined ? DEFAULT_ROW_LIMIT : body.rowLimit;
  if (rowLimit !== null && (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > MAX_ROW_LIMIT)) {
    fail(`rowLimit must be null (uncapped) or an integer in 1-${MAX_ROW_LIMIT}`);
  }
  const timeoutMs = body.timeoutMs ?? (op === "export" ? MAX_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    fail(`timeoutMs must be an integer in 1000-${MAX_TIMEOUT_MS}`);
  }
  const maxResponseBytes = body.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_MAX_RESPONSE_BYTES) {
    fail(`maxResponseBytes must be an integer in 1-${MAX_MAX_RESPONSE_BYTES}`);
  }

  // Params: positional array for postgres/mysql, named map for mssql (legacy
  // data-proxy contract).
  let params;
  if (engine === "mssql") {
    const raw = body.params ?? {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("params must be an object of named parameters for mssql");
    params = {};
    for (const [key, value] of Object.entries(raw)) {
      const name = String(key).trim().replace(/^@/, "");
      if (!name) continue;
      params[name] = value;
    }
  } else {
    params = body.params ?? [];
    if (!Array.isArray(params)) fail("params must be an array");
  }

  return {
    op,
    engine,
    mode,
    sql,
    params,
    rowLimit,
    timeoutMs,
    maxResponseBytes,
    target: {
      host: target.host.trim(),
      port,
      user: target.user,
      password: target.password,
      database: target.database,
      sslMode,
      charset: target.charset,
    },
  };
}

// ===========================================================================
// Parquet column typing (pure — mirrors the Go encoder's rules)
// ===========================================================================
//
// Only promote to a native numeric/bool type when the driver's column type is
// unambiguous; everything else — DECIMAL/NUMERIC/MONEY (precision), BIT
// (ambiguous across engines), dates/timestamps/uuid/json/blob — is stored as
// a UTF8 string for DuckDB to CAST as needed.

export const PARQUET_KIND = { STRING: "UTF8", INT64: "INT64", DOUBLE: "DOUBLE", BOOL: "BOOLEAN" };

/** Postgres type OID → parquet kind (pg's field.dataTypeID). */
export function parquetKindForPostgres(dataTypeID) {
  switch (dataTypeID) {
    case 21: // int2
    case 23: // int4
    case 20: // int8
    case 26: // oid
      return PARQUET_KIND.INT64;
    case 700: // float4
    case 701: // float8
      return PARQUET_KIND.DOUBLE;
    case 16: // bool
      return PARQUET_KIND.BOOL;
    default: // numeric(1700), text, timestamps, json, uuid, bytea, ...
      return PARQUET_KIND.STRING;
  }
}

/** MySQL column type code + flags → parquet kind (mysql2's field.type/flags). */
export function parquetKindForMysql(type, flags) {
  const UNSIGNED = 32;
  switch (type) {
    case 8: // LONGLONG (BIGINT) — unsigned can exceed int64; keep as string.
      return (flags & UNSIGNED) !== 0 ? PARQUET_KIND.STRING : PARQUET_KIND.INT64;
    case 1: // TINY
    case 2: // SHORT
    case 3: // LONG
    case 9: // INT24
    case 13: // YEAR
      return PARQUET_KIND.INT64;
    case 4: // FLOAT
    case 5: // DOUBLE
      return PARQUET_KIND.DOUBLE;
    default: // DECIMAL(0/246), BIT(16), dates, strings, blobs, json, ...
      return PARQUET_KIND.STRING;
  }
}

/** tedious column metadata type name → parquet kind. */
export function parquetKindForMssql(typeName) {
  switch (String(typeName ?? "")) {
    case "Int":
    case "IntN":
    case "BigInt":
    case "SmallInt":
    case "TinyInt":
      return PARQUET_KIND.INT64;
    case "Float":
    case "FloatN":
    case "Real":
      return PARQUET_KIND.DOUBLE;
    default: // Bit (Go parity: BIT stays string), Decimal, Money, dates, ...
      return PARQUET_KIND.STRING;
  }
}

/** Coerce a driver value to the parquet kind (Go toInt64/toFloat64/toStringValue parity). */
export function parquetValueFor(kind, raw) {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case PARQUET_KIND.INT64: {
      if (typeof raw === "bigint") return raw;
      if (typeof raw === "number") return Math.trunc(raw);
      if (typeof raw === "boolean") return raw ? 1 : 0;
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      try {
        return BigInt(text.trim());
      } catch {
        const parsed = Number.parseFloat(text);
        if (Number.isFinite(parsed)) return Math.trunc(parsed);
        throw new Error(`export: cannot convert ${typeof raw} to int64`);
      }
    }
    case PARQUET_KIND.DOUBLE: {
      const parsed = typeof raw === "number" ? raw : Number.parseFloat(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
      if (!Number.isFinite(parsed) && typeof raw !== "number") throw new Error(`export: cannot convert ${typeof raw} to float64`);
      return parsed;
    }
    case PARQUET_KIND.BOOL: {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number" || typeof raw === "bigint") return raw !== 0 && raw !== 0n;
      const text = (Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)).trim().toLowerCase();
      if (["1", "true", "t", "yes", "y"].includes(text)) return true;
      if (["0", "false", "f", "no", "n", ""].includes(text)) return false;
      throw new Error(`export: cannot convert ${typeof raw} to bool`);
    }
    default: {
      if (Buffer.isBuffer(raw)) return raw.toString("utf8");
      if (raw instanceof Date) return raw.toISOString();
      if (typeof raw === "object") return JSON.stringify(raw);
      return String(raw);
    }
  }
}

// ===========================================================================
// Query execution (dynamic driver imports — only pulled in when dispatched)
// ===========================================================================

/** null when host is not an IP literal; the literal when it is public. Throws when blocked. */
function assertPublicOrNull(host) {
  if (!/^[0-9.]+$/.test(host) && !host.includes(":")) return null;
  assertPublicAddress(host);
  return host;
}

/**
 * Resolve + vet the target host, then open a TCP socket to it. The SSRF guard
 * runs in BOTH modes; only the transport differs:
 *   - relay mode (relay != null): SOCKS-CONNECT through the static-IP egress
 *     relay, so the database sees the VM's IP.
 *   - direct mode (relay == null): dial the vetted IP straight from the
 *     container, so the database sees whatever IP the Cloudflare container
 *     uses. This is the opt-out when no relay is configured.
 * Either way the returned socket is a plain TCP stream; the driver negotiates
 * TLS over it (verified against the original hostname via `servername`).
 */
async function openSocket(target, timeoutMs, relay) {
  // Non-literal specifiers: the drivers are baked in the container, not deps of
  // this repo, so the worker/test bundler must NOT try to statically resolve
  // them. Node resolves them at runtime against /opt/db-query-runner.
  const { lookup } = await import("node:dns/promises");

  const hostnameProblem = blockedHostnameReason(target.host);
  if (hostnameProblem) {
    throw Object.assign(new Error(`Refusing target host "${target.host}": ${hostnameProblem}`), { status: 400 });
  }
  // Relay mode egresses from the VM's static IPv4 (SANDBOX_OUTBOUND_IP) — the
  // address customers allowlist. An IPv6 target would leave via the VM's v6 /
  // default egress instead (or fail on a v4-only VM), silently breaking that
  // contract, so on the relay path we resolve/accept ONLY IPv4. Direct mode has
  // no static-IP contract, so it keeps dual-stack resolution.
  const ipv4Only = relay !== null;
  let address = assertPublicOrNull(target.host);
  if (address !== null && ipv4Only && address.includes(":")) {
    throw Object.assign(
      new Error(`Refusing IPv6 target "${target.host}": the static-IP relay egresses IPv4 only`),
      { status: 400 },
    );
  }
  if (address === null) {
    const resolved = await lookup(target.host, { family: ipv4Only ? 4 : 0 });
    address = resolved.address;
    assertPublicAddress(address);
  }

  if (relay) {
    const { SocksClient } = await import(String("socks"));
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: "127.0.0.1",
        port: relay.localPort,
        type: 5,
        userId: relay.socksUsername,
        password: relay.socksPassword,
      },
      command: "connect",
      destination: { host: address, port: target.port },
      timeout: Math.min(timeoutMs, 20_000),
    });
    socket.setNoDelay(true);
    return socket;
  }

  // Direct mode: no relay configured — dial the vetted IP from the container.
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port: target.port });
    const onError = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(Math.min(timeoutMs, 20_000), () => onError(new Error(`Connect to ${target.host}:${target.port} timed out`)));
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.setTimeout(0);
      socket.removeListener("error", onError);
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}

function tlsOptions(target) {
  switch (target.sslMode) {
    case "disable":
      return undefined;
    case "verify-full":
      // Socket was dialed by IP; verify the cert against the original hostname.
      return { servername: target.host, rejectUnauthorized: true };
    case "verify-ca":
      // Chain verification without hostname verification (lib/pq parity).
      return { servername: target.host, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    default: // "require", and the TLS attempt of "prefer"
      return { servername: target.host, rejectUnauthorized: false };
  }
}

function normalizeReadResult(rows, fields, rowLimit) {
  const truncated = rowLimit !== null && rows.length > rowLimit;
  return {
    rows: truncated ? rows.slice(0, rowLimit) : rows,
    fields: (fields ?? []).map((field) => ({ name: field.name })),
    rowCount: rows.length,
    truncated,
  };
}

function modifyResult(affected) {
  return { rows: [], fields: [], rowCount: 0, truncated: false, rowsAffected: [affected ?? 0] };
}

// --- postgres ---------------------------------------------------------------

async function connectPostgres(socket, request) {
  const pg = (await import(String("pg"))).default;
  const client = new pg.Client({
    host: request.target.host,
    port: request.target.port,
    user: request.target.user,
    password: request.target.password,
    database: request.target.database,
    ssl: tlsOptions(request.target),
    stream: () => socket,
    connectionTimeoutMillis: request.timeoutMs,
    query_timeout: request.timeoutMs,
  });
  await client.connect();
  return client;
}

async function runPostgresQuery(socket, request) {
  const client = await connectPostgres(socket, request);
  try {
    if (request.mode === "modify") {
      const result = await client.query({ text: request.sql, values: request.params });
      return modifyResult(result.rowCount ?? 0);
    }
    // Read mode runs inside a transaction that is always rolled back.
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      const result = await client.query({ text: request.sql, values: request.params });
      return normalizeReadResult(result.rows ?? [], result.fields, request.rowLimit);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    client.end().catch(() => socket.destroy());
  }
}

// --- mysql -------------------------------------------------------------------

/**
 * Start a read-only transaction, falling back to a plain transaction when the
 * server doesn't support START TRANSACTION READ ONLY (Go beginReadTransaction
 * parity) — either way the transaction is always rolled back.
 */
async function beginMysqlReadTransaction(query) {
  try {
    await query("START TRANSACTION READ ONLY");
  } catch {
    await query("START TRANSACTION");
  }
}

async function connectMysql(socket, request, plaintext = false) {
  const mysql = (await import(String("mysql2/promise"))).default;
  return mysql.createConnection({
    stream: socket,
    host: request.target.host,
    port: request.target.port,
    user: request.target.user,
    password: request.target.password,
    database: request.target.database || undefined,
    ssl: plaintext || request.target.sslMode === "disable" ? undefined : tlsOptions(request.target),
    charset: request.target.charset,
    connectTimeout: request.timeoutMs,
  });
}

/** True when the error means "server has no TLS" and sslMode prefer should retry plaintext. */
function mysqlTlsUnsupported(error) {
  const message = String(error?.message ?? "");
  return error?.code === "HANDSHAKE_NO_SSL_SUPPORT" || /does not support secure connection|SSL is required but the server/i.test(message);
}

async function runMysqlQuery(socket, request, relay) {
  let connection;
  try {
    connection = await connectMysql(socket, request);
  } catch (error) {
    // "prefer": try TLS first, fall back to plaintext when the server lacks it
    // (go-sql-driver "preferred" parity). Needs a fresh socket — the first one
    // was consumed by the failed handshake.
    if (request.target.sslMode !== "prefer" || !mysqlTlsUnsupported(error)) throw error;
    socket = await openSocket(request.target, request.timeoutMs, relay);
    connection = await connectMysql(socket, request, true /* plaintext */);
  }
  try {
    if (request.mode === "modify") {
      const [result] = await connection.query({ sql: request.sql, values: request.params, timeout: request.timeoutMs });
      return modifyResult(Number(result?.affectedRows ?? 0));
    }
    await beginMysqlReadTransaction((sql) => connection.query(sql));
    try {
      const [rows, fields] = await connection.query({ sql: request.sql, values: request.params, timeout: request.timeoutMs });
      const rowArray = Array.isArray(rows) ? rows : [];
      return normalizeReadResult(rowArray, fields, request.rowLimit);
    } finally {
      await connection.query("ROLLBACK").catch(() => {});
    }
  } finally {
    connection.end().catch(() => socket.destroy());
  }
}

// --- mssql (tedious) ----------------------------------------------------------

async function connectMssql(socket, request) {
  const { Connection } = (await import(String("tedious"))).default;
  const target = request.target;
  // encrypt/trust mapping: sslMode disable → no TLS; require → TLS without
  // verification (trustServerCertificate, the legacy default); verify-full →
  // full verification against the original hostname.
  const encrypt = target.sslMode !== "disable";
  const trustServerCertificate = target.sslMode !== "verify-full" && target.sslMode !== "verify-ca";
  const connection = new Connection({
    server: target.host, // used as TLS servername; never dialed (custom connector below)
    authentication: { type: "default", options: { userName: target.user, password: target.password } },
    options: {
      port: target.port,
      database: target.database,
      encrypt,
      trustServerCertificate,
      connector: async () => socket,
      connectTimeout: request.timeoutMs,
      requestTimeout: request.timeoutMs,
      rowCollectionOnRequestCompletion: false,
      useColumnNames: false,
      validateBulkLoadParameters: true,
    },
  });
  await new Promise((resolve, reject) => {
    connection.connect((error) => (error ? reject(error) : resolve()));
  });
  return connection;
}

function mssqlParamType(TYPES, value) {
  if (value === null || value === undefined) return TYPES.NVarChar;
  switch (typeof value) {
    case "boolean":
      return TYPES.Bit;
    case "bigint":
      return TYPES.BigInt;
    case "number":
      if (!Number.isInteger(value)) return TYPES.Float;
      return Math.abs(value) <= 2_147_483_647 ? TYPES.Int : TYPES.BigInt;
    default:
      return value instanceof Date ? TYPES.DateTimeOffset : TYPES.NVarChar;
  }
}

/**
 * Execute one statement on a tedious connection, collecting only the FIRST
 * result set (Go readSQLRecordset parity — later sets are drained and
 * dropped). Callbacks receive the tedious `request` so streaming consumers
 * can request.pause()/resume() for backpressure.
 */
async function mssqlExecute(connection, sql, params, { onColumns, onRow }) {
  const { Request, TYPES } = (await import(String("tedious"))).default;
  return await new Promise((resolve, reject) => {
    let resultSetIndex = 0;
    const request = new Request(sql, (error, rowCount) => {
      if (error) reject(error);
      else resolve(rowCount ?? 0);
    });
    for (const [name, value] of Object.entries(params ?? {})) {
      request.addParameter(name, mssqlParamType(TYPES, value), value);
    }
    request.on("columnMetadata", (columns) => {
      resultSetIndex += 1;
      if (onColumns) onColumns(columns, resultSetIndex, request);
    });
    request.on("row", (columns) => {
      if (onRow) onRow(columns, resultSetIndex, request);
    });
    connection.execSql(request);
  });
}

/** tedious row (array of column objects) → plain record, last duplicate wins. */
function mssqlRowToRecord(columns) {
  const row = {};
  for (const column of columns) {
    row[column.metadata.colName] = column.value;
  }
  return row;
}

function mssqlTransaction(connection, method) {
  return new Promise((resolve, reject) => {
    connection[method]((error) => (error ? reject(error) : resolve()));
  });
}

async function runMssqlQuery(socket, request) {
  const connection = await connectMssql(socket, request);
  try {
    if (request.mode === "modify") {
      const rowCount = await mssqlExecute(connection, request.sql, request.params, {});
      return modifyResult(rowCount);
    }
    // Read mode runs inside a transaction that is always rolled back (mssql
    // has no read-only transactions — Go fell back to a plain one).
    await mssqlTransaction(connection, "beginTransaction");
    try {
      const rows = [];
      let fields = [];
      await mssqlExecute(connection, request.sql, request.params, {
        onColumns: (columns, setIndex) => {
          if (setIndex === 1) fields = columns.map((column) => ({ name: column.colName }));
        },
        onRow: (columns, setIndex) => {
          if (setIndex === 1) rows.push(mssqlRowToRecord(columns));
        },
      });
      return normalizeReadResult(rows, fields, request.rowLimit);
    } finally {
      await mssqlTransaction(connection, "rollbackTransaction").catch(() => {});
    }
  } finally {
    connection.close();
  }
}

// --- shared runner ------------------------------------------------------------

/** JSON.stringify replacer: keep bigints and binary columns transportable. */
function jsonSafe(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

async function runQuery(request, relay) {
  const socket = await openSocket(request.target, request.timeoutMs, relay);
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`Query timed out after ${request.timeoutMs}ms`), { status: 504, code: "ETIMEOUT" }));
    }, request.timeoutMs);
  });
  try {
    const run =
      request.engine === "postgres"
        ? runPostgresQuery(socket, request)
        : request.engine === "mysql"
          ? runMysqlQuery(socket, request, relay)
          : runMssqlQuery(socket, request);
    return await Promise.race([run, deadline]);
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function relayFromEnv() {
  // Relay is optional: with SOCKS creds we tunnel through the static-IP relay;
  // without them we dial the database directly from the container's own IP.
  return process.env.DB_EGRESS_RELAY_SOCKS_USERNAME
    ? {
        localPort: Number(process.env.DB_RELAY_LOCAL_PORT || 11080),
        socksUsername: process.env.DB_EGRESS_RELAY_SOCKS_USERNAME,
        socksPassword: process.env.DB_EGRESS_RELAY_SOCKS_PASSWORD || "",
      }
    : null;
}

function errorPayload(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: typeof error?.code === "string" ? error.code : undefined,
    // mysql2 exposes errno, tedious exposes number — either is the legacy
    // data-proxy "number" field.
    number:
      typeof error?.number === "number"
        ? error.number
        : typeof error?.errno === "number"
          ? error.errno
          : undefined,
    status: typeof error?.status === "number" ? error.status : undefined,
  };
}

async function main() {
  let payload;
  try {
    const request = validateQueryRequest(JSON.parse(process.env.DB_QUERY_REQUEST));
    const started = Date.now();
    const query = await runQuery(request, relayFromEnv());
    payload = JSON.stringify({ ok: true, ...query, durationMs: Date.now() - started }, jsonSafe);
    if (Buffer.byteLength(payload) > request.maxResponseBytes) {
      const size = Buffer.byteLength(payload);
      payload = JSON.stringify({
        ok: false,
        error: { message: `Query response too large (${size} bytes > limit ${request.maxResponseBytes} bytes)`, status: 413 },
      });
    }
  } catch (error) {
    payload = JSON.stringify({ ok: false, error: errorPayload(error) }, jsonSafe);
  }
  // The single line of stdout IS the result the worker parses; keep it clean.
  process.stdout.write(payload);
}

// ===========================================================================
// Export: stream a Parquet extract straight into the mounted R2 prefix
// ===========================================================================
//
// The worker mounts the workspace's warehouse R2 prefix into the container
// (sandbox SDK credential-less bucket mount) and execs this runner with
// op:"export" + DB_EXPORT_PATH pointing inside the mount. Rows stream from
// the database into a Snappy Parquet file at that path — s3fs persists it to
// R2 on close, so nothing is buffered in (or streamed through) the Worker.
// On any failure the partial file is unlinked so a truncated extract is never
// staged; the worker additionally HEAD-verifies the object after success.

// Rows buffered per Parquet row group; bounds memory on huge exports (the Go
// encoder used 50k — we use less headroom on a standard-1 container).
const PARQUET_ROW_GROUP_SIZE = 10_000;

/**
 * Parquet sink for one export: schema fixed on start(fields), rows appended
 * as they stream, footer written on close(). The query deadline races
 * start/append (DB time); close() runs after — the s3fs flush of a large file
 * must not count against the database timeout (the exec timeout still bounds
 * it).
 */
async function createParquetSink(path) {
  const parquet = (await import(String("@dsnp/parquetjs"))).default;
  const fs = await import("node:fs/promises");
  let writer = null;
  let fields = [];
  let rowCount = 0;
  return {
    async start(exportFields) {
      fields = exportFields;
      if (fields.length === 0) {
        // A statement with no result-set metadata cannot become a typed
        // Parquet file — fail loudly instead of staging an unreadable object.
        throw Object.assign(new Error("export query returned no result set"), { status: 400 });
      }
      const schemaFields = {};
      for (const field of fields) {
        schemaFields[field.name] = { type: field.kind, optional: true, compression: "SNAPPY" };
      }
      writer = await parquet.ParquetWriter.openFile(new parquet.ParquetSchema(schemaFields), path);
      writer.setRowGroupSize(PARQUET_ROW_GROUP_SIZE);
    },
    async append(record) {
      const row = {};
      for (const field of fields) {
        const value = parquetValueFor(field.kind, record[field.name]);
        if (value !== null) row[field.name] = value;
      }
      await writer.appendRow(row);
      rowCount += 1;
    },
    async close() {
      if (!writer) throw Object.assign(new Error("export query returned no result set"), { status: 400 });
      await writer.close(); // footer + s3fs upload of the staged file
      const stat = await fs.stat(path);
      return { rowCount, bytes: stat.size };
    },
    async abort() {
      await fs.unlink(path).catch(() => {});
    },
  };
}

async function exportPostgres(socket, request, sink) {
  const client = await connectPostgres(socket, request);
  const Cursor = (await import(String("pg-cursor"))).default;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    try {
      const cursor = client.query(new Cursor(request.sql, request.params));
      const read = (count) =>
        new Promise((resolve, reject) => {
          cursor.read(count, (error, rows, result) => (error ? reject(error) : resolve({ rows, result })));
        });
      let started = false;
      for (;;) {
        const { rows, result } = await read(1024);
        if (!started) {
          await sink.start(
            (result?.fields ?? []).map((field) => ({ name: field.name, kind: parquetKindForPostgres(field.dataTypeID) })),
          );
          started = true;
        }
        for (const record of rows) await sink.append(record);
        if (rows.length === 0) break;
      }
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    client.end().catch(() => socket.destroy());
  }
}

/**
 * Consume mysql2's supported Readable stream surface with bounded buffering.
 *
 * The old manual `query.on("result")` + `connection.pause()/resume()` loop can
 * lose its resume while another async sink operation is pending. The query
 * then remains paused until the outer 120s database deadline destroys its
 * socket (surfacing as the misleading `shutdown EINVAL`). mysql2's Readable
 * owns that backpressure state and resumes from `_read`, so use it directly.
 */
export async function streamMysqlRows(raw, request, sink) {
  const query = raw.query({
    sql: request.sql,
    values: request.params,
    timeout: request.timeoutMs,
  });
  const stream = query.stream({ objectMode: true, highWaterMark: 16 });
  let streamError;
  const rememberError = (error) => {
    streamError = error;
  };
  // Keep an error listener installed while sink.start awaits the mounted file;
  // the async iterator attaches its own listener only once iteration begins.
  stream.on("error", rememberError);
  try {
    const columns = await new Promise((resolve, reject) => {
      stream.once("fields", resolve);
      stream.once("error", reject);
      stream.once("end", () => reject(new Error("export query returned no result set")));
    });
    await sink.start(
      (columns ?? []).map((column) => ({
        name: column.name,
        kind: parquetKindForMysql(column.type ?? column.columnType, column.flags ?? 0),
      })),
    );
    if (streamError) throw streamError;
    for await (const record of stream) {
      await sink.append(record);
    }
  } finally {
    stream.off("error", rememberError);
  }
}

async function exportMysql(socket, request, relay, sink) {
  let connection;
  try {
    connection = await connectMysql(socket, request);
  } catch (error) {
    if (request.target.sslMode !== "prefer" || !mysqlTlsUnsupported(error)) throw error;
    socket = await openSocket(request.target, request.timeoutMs, relay);
    connection = await connectMysql(socket, request, true /* plaintext */);
  }
  // The promise wrapper is fine for the tx statements; row streaming uses the
  // underlying callback connection's Readable surface for backpressure.
  const raw = connection.connection;
  try {
    await beginMysqlReadTransaction((sql) => connection.query(sql));
    try {
      await streamMysqlRows(raw, request, sink);
    } finally {
      await connection.query("ROLLBACK").catch(() => {});
    }
  } finally {
    connection.end().catch(() => socket.destroy());
  }
}

async function exportMssql(socket, request, sink) {
  const connection = await connectMssql(socket, request);
  try {
    await mssqlTransaction(connection, "beginTransaction");
    try {
      let pending = Promise.resolve();
      await new Promise((resolve, reject) => {
        mssqlExecute(connection, request.sql, request.params, {
          onColumns: (columns, setIndex) => {
            if (setIndex !== 1) return;
            pending = pending.then(() =>
              sink.start(columns.map((column) => ({ name: column.colName, kind: parquetKindForMssql(column.type?.name) }))),
            );
          },
          onRow: (columns, setIndex, request) => {
            if (setIndex !== 1) return;
            // Backpressure lives on the tedious Request, not the connection.
            request.pause();
            pending = pending
              .then(() => sink.append(mssqlRowToRecord(columns)))
              .then(() => request.resume())
              .catch(reject);
          },
        }).then(resolve, reject);
      });
      await pending;
    } finally {
      await mssqlTransaction(connection, "rollbackTransaction").catch(() => {});
    }
  } finally {
    connection.close();
  }
}

async function runExport(request, relay) {
  const path = process.env.DB_EXPORT_PATH;
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..")) {
    throw Object.assign(new Error("DB_EXPORT_PATH missing or invalid"), { status: 400 });
  }
  const sink = await createParquetSink(path);
  const socket = await openSocket(request.target, request.timeoutMs, relay);
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`Export timed out after ${request.timeoutMs}ms`), { status: 504, code: "ETIMEOUT" }));
    }, request.timeoutMs);
  });
  try {
    const run =
      request.engine === "postgres"
        ? exportPostgres(socket, request, sink)
        : request.engine === "mysql"
          ? exportMysql(socket, request, relay, sink)
          : exportMssql(socket, request, sink);
    // The deadline bounds DATABASE time (connect + rows); the footer write +
    // s3fs flush in close() run after it, bounded by the worker's exec timeout.
    await Promise.race([run, deadline]);
    return await sink.close();
  } catch (error) {
    socket.destroy();
    await sink.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function exportMain() {
  // A driver crash surfacing as an unhandled EventEmitter error would bypass
  // the promise chain, kill node mid-write, and leave a partial file for the
  // worker's HEAD check to mistake for a successful export. Catch it at the
  // process level: unlink the artifact and keep the stdout JSON contract.
  const onFatal = (error) => {
    import("node:fs").then(({ unlinkSync }) => {
      try {
        if (process.env.DB_EXPORT_PATH) unlinkSync(process.env.DB_EXPORT_PATH);
      } catch {
        // Nothing staged yet.
      }
      process.stdout.write(JSON.stringify({ ok: false, error: errorPayload(error) }));
      process.exit(1);
    });
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  let payload;
  try {
    const request = validateQueryRequest(JSON.parse(process.env.DB_QUERY_REQUEST));
    const started = Date.now();
    const result = await runExport(request, relayFromEnv());
    payload = JSON.stringify({ ok: true, ...result, durationMs: Date.now() - started });
  } catch (error) {
    payload = JSON.stringify({ ok: false, error: errorPayload(error) });
  }
  // The single line of stdout IS the result the worker parses; keep it clean.
  process.stdout.write(payload);
}

// Only run as a script (DB_QUERY_REQUEST present); importing this module for
// its pure functions must have no side effects.
if (process.env.DB_QUERY_REQUEST) {
  let op = "query";
  try {
    op = JSON.parse(process.env.DB_QUERY_REQUEST)?.op ?? "query";
  } catch {
    // main() re-parses and reports the JSON error on stdout.
  }
  if (op === "export") exportMain();
  else main();
}
