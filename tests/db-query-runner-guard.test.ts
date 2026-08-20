import { Readable } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import {
  blockedAddressReason,
  blockedHostnameReason,
  isPublicIpAddress,
  assertPublicAddress,
  validateQueryRequest,
  parquetKindForPostgres,
  parquetKindForMysql,
  parquetKindForMssql,
  parquetValueFor,
  streamMysqlRows,
  DEFAULT_ROW_LIMIT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  PARQUET_KIND,
} from '../workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs';

describe('MySQL export streaming', () => {
  it('uses the Readable stream to apply backpressure and drains every row', async () => {
    const stream = new Readable({ objectMode: true, read() {} });
    const query = { stream: vi.fn(() => stream) };
    const raw = { query: vi.fn(() => query) };
    const appended: unknown[] = [];
    const sink = {
      start: vi.fn(async () => {}),
      append: vi.fn(async (row: unknown) => {
        appended.push(row);
      }),
    };
    const request = { sql: 'SELECT 1', params: undefined, timeoutMs: 120_000 };

    const running = streamMysqlRows(raw, request, sink);
    queueMicrotask(() => {
      stream.emit('fields', [{ name: 'smoke_value', type: 3, flags: 0 }]);
      stream.push({ smoke_value: 1 });
      stream.push({ smoke_value: 2 });
      stream.push(null);
    });

    await expect(running).resolves.toBeUndefined();
    expect(query.stream).toHaveBeenCalledWith({ objectMode: true, highWaterMark: 16 });
    expect(sink.start).toHaveBeenCalledTimes(1);
    expect(appended).toEqual([{ smoke_value: 1 }, { smoke_value: 2 }]);
  });
});

// The runner's client-side SSRF guard is the primary destination filter for
// the static-IP db egress relay (the VM-side gost bypass list is the same
// policy as defense in depth) — so these are security tests, not shape tests.

describe('blockedAddressReason — IPv4', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '52.10.0.4', // public cloud IP
    '172.32.0.1', // just past 172.16/12
    '100.128.0.1', // just past CGNAT 100.64/10
    '9.255.255.255', // just before 10/8
    '11.0.0.1', // just after 10/8
    '198.17.255.255', // just before benchmarking 198.18/15
    '223.255.255.255', // just before multicast
  ])('allows public %s', (address) => {
    expect(blockedAddressReason(address)).toBeNull();
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it.each([
    ['10.0.0.1', '10.0.0.0/8'],
    ['10.255.255.255', '10.0.0.0/8'],
    ['127.0.0.1', '127.0.0.0/8'],
    ['169.254.169.254', '169.254.0.0/16'], // Azure/AWS IMDS
    ['169.254.0.1', '169.254.0.0/16'],
    ['192.168.1.50', '192.168.0.0/16'],
    ['172.16.0.1', '172.16.0.0/12'],
    ['172.31.255.254', '172.16.0.0/12'],
    ['100.64.0.1', '100.64.0.0/10'],
    ['100.127.255.255', '100.64.0.0/10'],
    ['0.0.0.0', '0.0.0.0/8'],
    ['192.0.2.10', '192.0.2.0/24'],
    ['198.18.0.1', '198.18.0.0/15'],
    ['198.19.255.255', '198.18.0.0/15'],
    ['203.0.113.7', '203.0.113.0/24'],
    ['224.0.0.1', '224.0.0.0/4'],
    ['239.255.255.255', '224.0.0.0/4'],
    ['240.0.0.1', '240.0.0.0/4'],
    ['255.255.255.255', '240.0.0.0/4'],
  ])('blocks %s (%s)', (address, range) => {
    expect(blockedAddressReason(address)).toContain(range);
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['1.2.3', '1.2.3.4.5', '256.1.1.1', '10.0.0.-1', 'db.example.com', ''])(
    'rejects non-IP input %j',
    (input) => {
      expect(blockedAddressReason(input)).not.toBeNull();
    },
  );

  it.each([
    '012.0.0.1', // octal 012 → 10.0.0.1 (private) in many resolvers
    '0177.0.0.1', // octal 0177 → 127.0.0.1 (loopback)
    '08.8.8.8', // leading zero, even if the value is "public" decimal
    '8.8.8.08',
  ])('rejects zero-padded octets %j (octal-vs-decimal SSRF bypass)', (input) => {
    // Must NOT vet as public: the guard reads decimal, resolvers read octal, so
    // a padded literal could dial a private host while passing the check.
    expect(isPublicIpAddress(input)).toBe(false);
    expect(blockedAddressReason(input)).not.toBeNull();
  });
});

describe('blockedAddressReason — IPv6', () => {
  it.each(['2600:1f14::1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (address) => {
    expect(blockedAddressReason(address)).toBeNull();
  });

  it.each([
    '::1', // loopback
    '::', // unspecified
    'fe80::1', // link-local
    'fe80::1%eth0', // link-local with zone
    'fc00::1', // ULA
    'fd12:3456:789a::1', // ULA
    'ff02::1', // multicast
    '2001:db8::1', // documentation
    '::ffff:127.0.0.1', // v4-mapped loopback
    '::ffff:169.254.169.254', // v4-mapped IMDS
    '::ffff:10.0.0.5', // v4-mapped private
    '::10.0.0.5', // v4-compatible private
  ])('blocks %s', (address) => {
    expect(blockedAddressReason(address)).not.toBeNull();
  });

  it.each([':::', '1:2:3:4:5:6:7:8:9', '::ffff:999.0.0.1', 'g::1'])('rejects unparseable %j', (input) => {
    expect(blockedAddressReason(input)).not.toBeNull();
  });
});

describe('assertPublicAddress', () => {
  it('throws with the blocked range in the message', () => {
    expect(() => assertPublicAddress('169.254.169.254')).toThrow(/169\.254\.0\.0\/16/);
  });

  it('passes public addresses through', () => {
    expect(() => assertPublicAddress('8.8.8.8')).not.toThrow();
  });
});

describe('blockedHostnameReason', () => {
  it.each(['db.example.com', 'my-db.abc123.us-east-1.rds.amazonaws.com'])('allows %s', (name) => {
    expect(blockedHostnameReason(name)).toBeNull();
  });

  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.', // trailing dot
    'foo.localhost',
    'db.local',
    'runtime.internal',
    'connections.internal',
    'metadata.google.internal',
    'metadata',
    '',
  ])('blocks %j', (name) => {
    expect(blockedHostnameReason(name)).not.toBeNull();
  });
});

describe('validateQueryRequest', () => {
  const validBody = () => ({
    engine: 'postgres',
    sql: 'SELECT 1',
    target: { host: 'db.example.com', port: 5432, user: 'u', password: 'p', database: 'd' },
  });

  it('normalizes a minimal valid request with defaults', () => {
    const request = validateQueryRequest(validBody());
    expect(request.engine).toBe('postgres');
    expect(request.op).toBe('query');
    expect(request.mode).toBe('read');
    expect(request.target.sslMode).toBe('require');
    expect(request.rowLimit).toBe(DEFAULT_ROW_LIMIT);
    expect(request.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(request.maxResponseBytes).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    expect(request.params).toEqual([]);
  });

  it('keeps explicit options', () => {
    const request = validateQueryRequest({
      ...validBody(),
      engine: 'mysql',
      mode: 'modify',
      params: [42],
      rowLimit: 5,
      timeoutMs: 2_000,
      maxResponseBytes: 1_000,
      target: { ...validBody().target, sslMode: 'verify-full', charset: 'utf8mb4' },
    });
    expect(request.engine).toBe('mysql');
    expect(request.mode).toBe('modify');
    expect(request.params).toEqual([42]);
    expect(request.rowLimit).toBe(5);
    expect(request.timeoutMs).toBe(2_000);
    expect(request.maxResponseBytes).toBe(1_000);
    expect(request.target.sslMode).toBe('verify-full');
    expect(request.target.charset).toBe('utf8mb4');
  });

  it('rowLimit null means uncapped (legacy data-proxy parity)', () => {
    expect(validateQueryRequest({ ...validBody(), rowLimit: null }).rowLimit).toBeNull();
  });

  it('mysql may omit the database; other engines may not', () => {
    const mysqlBody = { ...validBody(), engine: 'mysql', target: { ...validBody().target, database: '' } };
    expect(validateQueryRequest(mysqlBody).target.database).toBe('');
    expect(() => validateQueryRequest({ ...mysqlBody, engine: 'postgres' })).toThrow(/database/);
    expect(() => validateQueryRequest({ ...mysqlBody, engine: 'mssql', params: {} })).toThrow(/database/);
  });

  it('mssql takes named params and strips a leading @', () => {
    const request = validateQueryRequest({
      ...validBody(),
      engine: 'mssql',
      params: { '@id': 7, name: 'x' },
    });
    expect(request.params).toEqual({ id: 7, name: 'x' });
  });

  it('export op is read-only and defaults to the max timeout', () => {
    const request = validateQueryRequest({ ...validBody(), op: 'export' });
    expect(request.op).toBe('export');
    expect(request.timeoutMs).toBe(MAX_TIMEOUT_MS);
    expect(() => validateQueryRequest({ ...validBody(), op: 'export', mode: 'modify' })).toThrow(/read-only/);
  });

  it.each([
    [{ ...validBody(), engine: 'sqlite' }, /engine/],
    [{ ...validBody(), mode: 'delete' }, /mode/],
    [{ ...validBody(), op: 'stream' }, /op/],
    [{ ...validBody(), sql: '  ' }, /sql/],
    [{ ...validBody(), target: { ...validBody().target, port: 0 } }, /port/],
    [{ ...validBody(), target: { ...validBody().target, port: 70_000 } }, /port/],
    [{ ...validBody(), target: { ...validBody().target, host: '' } }, /host/],
    [{ ...validBody(), target: { ...validBody().target, sslMode: 'preferred' } }, /sslMode/],
    [{ ...validBody(), target: { ...validBody().target, charset: 'utf8mb4; DROP' } }, /charset/],
    [{ ...validBody(), rowLimit: 0 }, /rowLimit/],
    [{ ...validBody(), rowLimit: 10_001 }, /rowLimit/],
    [{ ...validBody(), timeoutMs: 1 }, /timeoutMs/],
    [{ ...validBody(), maxResponseBytes: 0 }, /maxResponseBytes/],
    [{ ...validBody(), params: 'not-an-array' }, /params/],
    [{ ...validBody(), engine: 'mssql', params: [1] }, /params/],
    [null, /object/],
    [[1, 2], /object/],
  ])('rejects invalid body %#', (body, pattern) => {
    expect(() => validateQueryRequest(body)).toThrow(pattern);
  });
});

describe('parquet column typing (Go encoder parity)', () => {
  it('postgres: unambiguous ints/floats/bool are native, everything else UTF8', () => {
    expect(parquetKindForPostgres(20)).toBe(PARQUET_KIND.INT64); // int8
    expect(parquetKindForPostgres(21)).toBe(PARQUET_KIND.INT64); // int2
    expect(parquetKindForPostgres(23)).toBe(PARQUET_KIND.INT64); // int4
    expect(parquetKindForPostgres(700)).toBe(PARQUET_KIND.DOUBLE);
    expect(parquetKindForPostgres(701)).toBe(PARQUET_KIND.DOUBLE);
    expect(parquetKindForPostgres(16)).toBe(PARQUET_KIND.BOOL);
    expect(parquetKindForPostgres(1700)).toBe(PARQUET_KIND.STRING); // numeric: precision
    expect(parquetKindForPostgres(1184)).toBe(PARQUET_KIND.STRING); // timestamptz
    expect(parquetKindForPostgres(2950)).toBe(PARQUET_KIND.STRING); // uuid
  });

  it('mysql: unsigned BIGINT stays a string (can exceed int64); BIT/DECIMAL stay strings', () => {
    const UNSIGNED = 32;
    expect(parquetKindForMysql(8, 0)).toBe(PARQUET_KIND.INT64); // signed bigint
    expect(parquetKindForMysql(8, UNSIGNED)).toBe(PARQUET_KIND.STRING); // unsigned bigint
    expect(parquetKindForMysql(1, 0)).toBe(PARQUET_KIND.INT64); // tinyint
    expect(parquetKindForMysql(3, 0)).toBe(PARQUET_KIND.INT64); // int
    expect(parquetKindForMysql(5, 0)).toBe(PARQUET_KIND.DOUBLE); // double
    expect(parquetKindForMysql(246, 0)).toBe(PARQUET_KIND.STRING); // newdecimal
    expect(parquetKindForMysql(16, 0)).toBe(PARQUET_KIND.STRING); // bit
    expect(parquetKindForMysql(253, 0)).toBe(PARQUET_KIND.STRING); // varchar
  });

  it('mssql: Int variants native, Bit/Decimal/Money stay strings', () => {
    expect(parquetKindForMssql('Int')).toBe(PARQUET_KIND.INT64);
    expect(parquetKindForMssql('IntN')).toBe(PARQUET_KIND.INT64);
    expect(parquetKindForMssql('BigInt')).toBe(PARQUET_KIND.INT64);
    expect(parquetKindForMssql('FloatN')).toBe(PARQUET_KIND.DOUBLE);
    expect(parquetKindForMssql('Bit')).toBe(PARQUET_KIND.STRING);
    expect(parquetKindForMssql('DecimalN')).toBe(PARQUET_KIND.STRING);
    expect(parquetKindForMssql(undefined)).toBe(PARQUET_KIND.STRING);
  });

  it('parquetValueFor coerces like the Go export encoder', () => {
    expect(parquetValueFor(PARQUET_KIND.INT64, '9007199254740993')).toBe(9007199254740993n); // pg int8 comes as string
    expect(parquetValueFor(PARQUET_KIND.INT64, 42)).toBe(42);
    expect(parquetValueFor(PARQUET_KIND.INT64, null)).toBeNull();
    expect(parquetValueFor(PARQUET_KIND.DOUBLE, '1.5')).toBe(1.5);
    expect(parquetValueFor(PARQUET_KIND.BOOL, 1)).toBe(true);
    expect(parquetValueFor(PARQUET_KIND.BOOL, 'f')).toBe(false);
    expect(parquetValueFor(PARQUET_KIND.STRING, new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(parquetValueFor(PARQUET_KIND.STRING, Buffer.from('bytes'))).toBe('bytes');
    expect(parquetValueFor(PARQUET_KIND.STRING, { a: 1 })).toBe('{"a":1}'); // json columns
    expect(parquetValueFor(PARQUET_KIND.STRING, true)).toBe('true');
  });
});
