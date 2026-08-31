import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const lifecycle = read("workers/main/src/chat-thread/runtime-lifecycle.ts");
const store = read("workers/main/src/chat-thread/durable-turn-store.ts");
const driver = read("workers/main/src/chat-thread/durable-turn-driver.ts");
const controller = read(
  "workers/main/src/chat-thread/chat-runtime-controller.ts",
);
const runner = read("workers/main/src/chat-thread/bounded-turn-runner.ts");
const adapter = read("workers/main/src/chat-thread/pi-turn-adapter.ts");
const checkpoint = read("workers/main/src/chat-thread/turn-checkpoint.ts");
const legacy = read("workers/main/src/chat-thread/legacy-session-migration.ts");
const bounds = read("src/lib/chat-runtime-bounds.ts");
const client = read("src/lib/chat-runtime-client.ts");
const chatUi = read("src/components/Chat.tsx");
const mainWorker = read("workers/main/src/index.ts");
const transportHeaders = read(
  "workers/main/src/chat-thread/transport-headers.ts",
);
const model = read("plans/chat-runtime-correctness/formal/ChatLifecycle.tla");
const strongConfig = read(
  "plans/chat-runtime-correctness/formal/ChatLifecycle.cfg",
);
const ciConfigs = Object.fromEntries(
  ["A", "B", "C", "D"].map((name) => [
    name,
    read(`plans/chat-runtime-correctness/formal/ChatLifecycle${name}.cfg`),
  ]),
);
const ciWorkflow = read(".github/workflows/ci.yml");

const coarseActions = [
  "DurablyAdmit",
  "StartSelectedTurn",
  "BeginEffect",
  "CompleteTurn",
  "FailTurn",
  "ExpireOperation",
  "ReconcileCrashedTurn",
];

const migrationActions = [
  "BeginLegacyMigration",
  "RetryLegacyMigration",
  "CompleteLegacyMigration",
  "FailLegacyMigration",
];

const durableActions = [
  "DurablyAdmit",
  ...migrationActions,
  "StartSelectedTurn",
  "StartNextInference",
  "CheckpointProviderBatch",
  "CheckpointProviderFinal",
  "BeginEffect",
  "RecordToolResult",
  "RecoverFromCheckpoint",
  "CompleteTurn",
  "FailTurn",
  "ExpireOperation",
  "ReconcileCrashedTurn",
];

const invariantNames = [
  "TypeOK",
  "TransportConsistency",
  "MigrationConsistency",
  "AdmissionConsistency",
  "QueueConsistency",
  "OwnershipConsistency",
  "BatchConsistency",
  "RecoveryAndContextConsistency",
  "FiniteBounds",
];

const propertyNames = [
  "TransportPendingEventuallyDecides",
  "MigrationPendingEventuallyTerminates",
  "SeenEventuallyTerminal",
  "ActiveEventuallyReleased",
  "SafeCrashEventuallyRecoversOrTerminates",
  "AbortEventuallyPerformed",
  "AdmissionLedgerNeverShrinks",
  "MigrationDecisionImmutable",
  "TerminalOutcomeImmutable",
];

function fail(message) {
  throw new Error(`Chat runtime conformance: ${message}`);
}

function expect(source, pattern, message) {
  if (!pattern.test(source)) fail(message);
}

function reject(source, pattern, message) {
  if (pattern.test(source)) fail(message);
}

function expectText(source, value, message) {
  if (!source.includes(value)) fail(message);
}

function beforeText(source, first, second, message) {
  const left = source.indexOf(first);
  const right = source.indexOf(second);
  if (left < 0 || right < 0 || left >= right) fail(message);
}

function before(source, first, second, message) {
  const left = source.search(first);
  const right = source.search(second);
  if (left < 0 || right < 0 || left >= right) fail(message);
}

function between(source, start, end, label) {
  const from = source.search(start);
  if (from < 0) fail(`cannot locate start of ${label}`);
  const rest = source.slice(from);
  const relativeEnd = rest.search(end);
  if (relativeEnd < 0) fail(`cannot locate end of ${label}`);
  return rest.slice(0, relativeEnd);
}

function bracedBody(source, marker, label) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) fail(`cannot locate ${label}`);
  const open = source.indexOf("{", markerIndex + marker.length);
  if (open < 0) fail(`cannot locate body of ${label}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  fail(`unterminated body of ${label}`);
}

function tlaOperator(name) {
  const start = new RegExp(`^${name}(?:\\([^\\n]*\\))?\\s*==`, "m");
  const match = start.exec(model);
  if (!match) fail(`TLA+ operator ${name} is missing`);
  const tail = model.slice(match.index + match[0].length);
  const next = /^\w+(?:\([^\n]*\))?\s*==/m.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}

function quotedTypes(source) {
  return new Set(
    [...source.matchAll(/type:\s*"([A-Za-z]+)"/g)].map((m) => m[1]),
  );
}

function quotedUnion(source) {
  return new Set([...source.matchAll(/\|\s*"([A-Za-z]+)"/g)].map((m) => m[1]));
}

function assertExact(actual, expected, label) {
  const missing = expected.filter((item) => !actual.has(item));
  const extra = [...actual].filter((item) => !expected.includes(item));
  if (missing.length || extra.length) {
    fail(
      `${label} differs (missing: ${missing.join(", ") || "none"}; ` +
        `extra: ${extra.join(", ") || "none"})`,
    );
  }
}

function configSection(source, heading, nextHeading) {
  const start = source.indexOf(`${heading}\n`);
  if (start < 0) fail(`TLC config is missing ${heading}`);
  const bodyStart = start + heading.length + 1;
  const end = nextHeading
    ? source.indexOf(`\n${nextHeading}\n`, bodyStart)
    : source.length;
  if (end < 0) fail(`TLC config is missing ${nextHeading}`);
  return source
    .slice(bodyStart, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// The pure reducer is deliberately a coarse projection. Check it exactly as a
// seven-action set instead of pretending it duplicates checkpoint/migration JSON.
const eventUnion = between(
  lifecycle,
  /export type RuntimeLifecycleEvent\s*=/,
  /export type RuntimeLifecycleResult\s*=/,
  "RuntimeLifecycleEvent",
);
assertExact(quotedTypes(eventUnion), coarseActions, "coarse reducer event set");
const reducer = bracedBody(
  lifecycle,
  "export function transitionRuntimeLifecycle(",
  "transitionRuntimeLifecycle",
);
assertExact(
  new Set([...reducer.matchAll(/case\s+"([A-Za-z]+)"\s*:/g)].map((m) => m[1])),
  coarseActions,
  "coarse reducer case set",
);

// The store/outbox is the complete implementation action authority.
const outbox = between(
  store,
  /export interface ChatOutboxEvent\s*\{/,
  /export type StoreRejection\s*=/,
  "ChatOutboxEvent",
);
assertExact(quotedUnion(outbox), durableActions, "durable outbox action set");
for (const action of durableActions) {
  if (!new RegExp(`^${action}(?:\\([^\\n]*\\))?\\s*==`, "m").test(model)) {
    fail(`TLA+ durable action ${action} is missing`);
  }
}
const migrationEventUnion = between(
  legacy,
  /private appendMigrationEvent\(/,
  /now:\s*number/,
  "legacy migration event union",
);
assertExact(
  quotedUnion(migrationEventUnion),
  migrationActions,
  "legacy migration event set",
);

// The replacement model itself must remain smaller than the 641-line model it
// superseded and must not regrow the deleted runtime-startup/retry axis.
if (model.split(/\r?\n/).length - 1 >= 641) {
  fail("TLA+ model is not smaller than the superseded 641-line model");
}
reject(
  model,
  /\bruntimeAttempts\b|\bstartupRemaining\b|RuntimeStartup|RuntimeBecameReady/,
  "TLA+ contains the removed runtime startup/retry axis",
);

// Every CI instance checks the complete property surface. The split constants
// make dedupe/thread_full, two-row FIFO, two-call batches, and queue_bound
// independently reachable instead of hiding them in one explosive product.
const allConfigs = { strong: strongConfig, ...ciConfigs };
for (const [name, config] of Object.entries(allConfigs)) {
  assertExact(
    new Set(configSection(config, "INVARIANTS", "PROPERTIES")),
    invariantNames,
    `${name} TLC invariant set`,
  );
  assertExact(
    new Set(configSection(config, "PROPERTIES")),
    propertyNames,
    `${name} TLC property set`,
  );
  reject(config, /^SYMMETRY\b/m, `${name} TLC config must not use symmetry`);
}

const commonCiConstants = [
  "TransportDeadline = 1",
  "MigrationDeadline = 2",
  "TurnDeadline = 2",
  "ProviderDeadline = 1",
  "ToolDeadline = 1",
];
const matrixConstants = {
  A: [
    "MessageIds = {m1, m2}",
    "CallIds = {c1}",
    "AdmissionLimit = 1",
    "QueueLimit = 1",
    "QueueByteLimit = 1",
    "ToolLimit = 1",
    "CheckpointLimit = 4",
  ],
  B: [
    "MessageIds = {m1, m2}",
    "CallIds = {c1}",
    "AdmissionLimit = 2",
    "QueueLimit = 2",
    "QueueByteLimit = 2",
    "ToolLimit = 1",
    "CheckpointLimit = 4",
  ],
  C: [
    "MessageIds = {m1}",
    "CallIds = {c1, c2}",
    "AdmissionLimit = 1",
    "QueueLimit = 1",
    "QueueByteLimit = 1",
    "ToolLimit = 2",
    "CheckpointLimit = 6",
  ],
  D: [
    "MessageIds = {m1, m2}",
    "CallIds = {c1}",
    "AdmissionLimit = 2",
    "QueueLimit = 1",
    "QueueByteLimit = 1",
    "ToolLimit = 1",
    "CheckpointLimit = 4",
  ],
};
for (const [name, constants] of Object.entries(matrixConstants)) {
  for (const declaration of [...commonCiConstants, ...constants]) {
    expectText(
      ciConfigs[name],
      `  ${declaration}`,
      `CI config ${name} drifted at ${declaration}`,
    );
  }
}

for (const name of Object.keys(ciConfigs)) {
  expectText(
    ciWorkflow,
    `- config: ${name}`,
    `CI matrix is missing config ${name}`,
  );
}
expect(
  ciWorkflow,
  /timeout-minutes:\s*60\b/,
  "CI job timeout must stay bounded",
);
expect(
  ciWorkflow,
  /timeout[\s\S]*50m/,
  "TLC process timeout must stay bounded",
);
expect(ciWorkflow, /java -Xmx4g\b/, "CI TLC heap must stay bounded");
expect(ciWorkflow, /-workers 2\b/, "CI TLC worker count must stay bounded");
expect(
  ciWorkflow,
  /-lncheck final\b/,
  "CI must perform final liveness checking",
);
expect(
  ciWorkflow,
  /-metadir "\$tlc_state_dir"/,
  "CI needs a disposable metadir",
);

// Transport either flushes first bytes or reaches its explicit timeout. The
// flush is independent because it preserves every lifecycle variable.
const flush = tlaOperator("FlushTransport");
expect(flush, /transport\s*=\s*"pending"/, "SSE flush must start pending");
expect(flush, /transportRemaining\s*>\s*0/, "SSE flush must be time-bounded");
expect(flush, /transport'\s*=\s*"open"/, "SSE flush must open transport");
expect(flush, /firstByteSent'\s*=\s*TRUE/, "SSE flush must emit first bytes");
expect(
  flush,
  /UNCHANGED\s+LifecycleVars/,
  "SSE flush must preserve lifecycle state",
);
const transportTimeout = tlaOperator("TimeoutTransport");
expect(
  transportTimeout,
  /transportRemaining\s*=\s*0/,
  "transport needs a timeout edge",
);
expect(
  transportTimeout,
  /transport'\s*=\s*"closed"/,
  "transport timeout must close",
);

// Admission is FIFO, bounded, permanent-idempotent, and preceded by an alarm.
const post = tlaOperator("ClientPost");
expect(post, /alarmArmed'\s*=\s*TRUE/, "client post must pre-arm an alarm");
const admit = tlaOperator("DurablyAdmit");
expect(
  admit,
  /m\s*\\in\s*MessageIds\s*\\\s*seen/,
  "admission must reject seen ids",
);
expect(
  admit,
  /Cardinality\(seen\)\s*<\s*AdmissionLimit/,
  "admission cap is missing",
);
expect(admit, /Len\(queue\)\s*<\s*QueueLimit/, "queue slot bound is missing");
expect(
  admit,
  /QueueBytes\(queue\)[\s\S]*QueueByteLimit/,
  "queue byte bound is missing",
);
expect(
  admit,
  /queue'\s*=\s*Append\(queue,\s*m\)/,
  "admission must append FIFO",
);
expect(admit, /TurnDeadline/, "admission must set one absolute turn deadline");
expect(
  tlaOperator("RejectThreadFull"),
  /Cardinality\(seen\)\s*=\s*AdmissionLimit/,
  "thread_full edge is missing",
);
const prune = tlaOperator("PrunePayload");
expect(
  prune,
  /retainedPayload'\s*=\s*retainedPayload\s*\\\s*\{m\}/,
  "prune must scrub payload only",
);
expect(
  prune,
  /UNCHANGED[\s\S]*seen/,
  "prune must retain idempotency tombstones",
);

// JIT migration: admitted-only, no transport dependency, one retry, one fixed
// deadline, fresh fences, terminal marker, and claim blocking until terminal.
const beginMigration = tlaOperator("BeginLegacyMigration");
expect(
  beginMigration,
  /seen\s*#\s*\{\}/,
  "legacy read must follow durable admission",
);
expect(
  beginMigration,
  /migrationState\s*=\s*"unseen"/,
  "migration must begin unseen",
);
expect(
  beginMigration,
  /migrationAttempts'\s*=\s*1/,
  "migration attempt one is missing",
);
expect(
  beginMigration,
  /MigrationToken\(1\)/,
  "migration attempt one needs a fence",
);
expect(
  beginMigration,
  /migrationRemaining'\s*=\s*MigrationDeadline/,
  "migration deadline must be fixed once",
);
expect(
  beginMigration,
  /UNCHANGED[\s\S]*TransportVars/,
  "migration must not own transport",
);
const retryMigration = tlaOperator("RetryLegacyMigration");
expect(
  retryMigration,
  /migrationAttempts\s*=\s*1/,
  "migration retry must follow attempt one",
);
expect(
  retryMigration,
  /migrationAttempts'\s*=\s*2/,
  "migration must allow only attempt two",
);
expect(
  retryMigration,
  /MigrationToken\(2\)/,
  "migration retry needs a fresh fence",
);
expect(
  retryMigration,
  /UNCHANGED[\s\S]*migrationRemaining/,
  "retry must preserve the absolute deadline",
);
for (const action of ["CompleteLegacyMigration", "FailLegacyMigration"]) {
  const body = tlaOperator(action);
  expect(
    body,
    /migrationState\s*=\s*"pending"/,
    `${action} must leave pending`,
  );
  expect(
    body,
    /migrationToken'\s*=\s*NoToken/,
    `${action} must release its token`,
  );
}
const start = tlaOperator("StartSelectedTurn");
expect(
  start,
  /migrationState\s*\\in\s*\{"complete",\s*"failed"\}/,
  "claim must wait for migration terminal",
);
expect(start, /Head\(queue\)/, "turn selection must claim the FIFO head");
expect(
  start,
  /Token\(m,\s*1\)/,
  "initial claim needs its deterministic fresh fence",
);

// Whole ordered provider batches, sequential effect latches, exact results,
// and the single safe checkpoint recovery.
const inference = tlaOperator("StartNextInference");
expect(
  inference,
  /phase\s*=\s*"batch"\s*\/\\\s*BatchClosed/,
  "inference must require a closed preceding batch",
);
expect(
  inference,
  /providerCallsUsed'\s*=\s*providerCallsUsed\s*\+\s*1/,
  "provider dispatch counter must commit first",
);
const batch = tlaOperator("CheckpointProviderBatch");
expect(
  batch,
  /calls\s*\\in\s*BatchOrders/,
  "provider batches must preserve every finite order",
);
expect(
  batch,
  /SeqToSet\(calls\)\s*\\cap\s*usedCalls\s*=\s*\{\}/,
  "tool-call ids must be turn-unique",
);
expect(
  batch,
  /batchCalls'\s*=\s*calls/,
  "provider batch must checkpoint atomically",
);
const beginEffect = tlaOperator("BeginEffect");
expect(
  beginEffect,
  /t\s*=\s*activeToken/,
  "BeginEffect must use the active fence",
);
expect(
  beginEffect,
  /batchCalls\[NextCallIndex\]/,
  "tools must begin in provider order",
);
expect(
  beginEffect,
  /begunCalls'\s*=\s*begunCalls\s*\\cup\s*\{c\}/,
  "BeginEffect must latch exactly one call",
);
const result = tlaOperator("RecordToolResult");
expect(
  result,
  /c\s*\\in\s*begunCalls\s*\\\s*resultCalls/,
  "result must match one unresolved latch",
);
expect(
  result,
  /resultCalls'\s*=\s*resultCalls\s*\\cup\s*\{c\}/,
  "result must terminalize exactly once",
);
const recover = tlaOperator("RecoverFromCheckpoint");
expect(
  recover,
  /RecoveryEligible\(m\)/,
  "recovery eligibility guard is missing",
);
expect(recover, /Token\(m,\s*2\)/, "recovery needs a fresh attempt fence");
expect(recover, /recoveryCount'[\s\S]*=\s*1/, "recovery must be single-shot");
expect(
  recover,
  /UNCHANGED[\s\S]*LedgerVars[\s\S]*providerCallsUsed[\s\S]*checkpointBytes/,
  "recovery must preserve deadline, counters, and checkpoint",
);
expect(
  tlaOperator("ReconcileCrashedTurn"),
  /~RecoveryEligible\(active\)/,
  "unsafe/exhausted crash must terminalize",
);
const late = tlaOperator("ObserveLateToken");
expect(late, /t\s*#\s*activeToken/, "late result must carry a stale token");
expect(
  late,
  /UNCHANGED[\s\S]*LedgerVars/,
  "late result must not mutate turn status",
);
expect(
  model,
  /WF_vars\(Tick\)[\s\S]*WF_vars\(ExpireOperation\)/,
  "time and expiry must be fair",
);
reject(
  model,
  /WF_vars\((?:CheckpointProvider|RecordToolResult|CompleteTurn|FailTurn)/,
  "provider/tool success must not be assumed fair",
);

// TypeScript bounds and storage fences.
expect(
  bounds,
  /admissionsPerThread:\s*4_096\b/,
  "permanent admission ledger cap is missing",
);
expect(
  bounds,
  /contextMessages:\s*64\b/,
  "model-context message bound drifted",
);
reject(
  bounds,
  /\bcontextTurns\s*:/,
  "obsolete turn-count context bound remains",
);
expect(
  bounds,
  /sseWriterBytes:\s*5\s*\*\s*1024\s*\*\s*1024/,
  "SSE frame bound drifted",
);
expect(
  bounds,
  /sseWriterQueueBytes:\s*5\s*\*\s*1024\s*\*\s*1024\s*\+\s*4\s*\*\s*1024/,
  "SSE writer queue bound drifted",
);
expect(
  bounds,
  /sseDoBytes:\s*40\s*\*\s*1024\s*\*\s*1024/,
  "aggregate SSE bound drifted",
);
expect(
  bounds,
  /frameBytes:\s*5\s*\*\s*1024\s*\*\s*1024/,
  "client frame bound drifted",
);
expect(
  bounds,
  /attemptsPerTurn:\s*2\b/,
  "one initial plus one recovery is required",
);
expect(bounds, /recoveryAttempts:\s*1\b/, "exactly one recovery is required");
expect(bounds, /alarmTurnsPerInvocation:\s*1\b/, "one alarm may own one turn");
expect(
  bounds,
  /legacyMigrationDeadlineMs:\s*30_000\b/,
  "migration deadline bound drifted",
);
expect(
  bounds,
  /legacyMigrationRetryMs:\s*1_000\b/,
  "migration retry-wake bound drifted",
);
expect(
  bounds,
  /legacyMigrationAttempts:\s*2\b/,
  "migration attempt bound drifted",
);
expect(
  bounds,
  /legacyMigrationPageRows:\s*32\b/,
  "migration page bound drifted",
);
expect(
  bounds,
  /legacyMigrationScanRows:\s*128\s*\*\s*\(32\s*\+\s*3\)/,
  "migration scan bound drifted",
);

expect(
  store,
  /client_message_id TEXT NOT NULL UNIQUE/,
  "client message id must be unique",
);
expect(
  store,
  /chat_turns_v2_one_running[\s\S]*WHERE status = 'running'/,
  "store must enforce one running row",
);
expect(
  store,
  /UPDATE chat_turns_v2 SET retained = 0/,
  "pruning must create payload tombstones",
);
reject(
  store,
  /DELETE FROM chat_turns_v2/,
  "turn rows must remain as permanent admission tombstones",
);
const admitMethod = bracedBody(store, "  admit(", "DurableChatTurnStore.admit");
before(
  admitMethod,
  /const duplicate\s*=\s*this\.find/,
  /admissionCount/,
  "duplicate check must precede lifetime admission cap",
);
expect(
  admitMethod,
  /SELECT COUNT\(\*\) AS count FROM chat_turns_v2/,
  "admission cap must include scrubbed tombstones",
);
expect(admitMethod, /"thread_full"/, "store must expose thread_full");
expect(store, /ORDER BY created_at, rowid LIMIT 1/, "store claim must be FIFO");
expect(
  store,
  /attempt_count < \?[\s\S]*terminal_deadline_at > \? RETURNING \*/,
  "claim must be attempt- and time-fenced",
);
expect(
  store,
  /status = 'running' AND attempt_token = \?[\s\S]*lease_expires_at > \?[\s\S]*terminal_deadline_at > \?/,
  "checkpoint/terminal writes need token and time fences",
);

const checkpointMutation = bracedBody(
  store,
  "private mutateCheckpoint(",
  "mutateCheckpoint",
);
expect(
  checkpointMutation,
  /parseTurnCheckpoint/,
  "every checkpoint mutation must validate durable state",
);
expect(
  checkpointMutation,
  /lease_expires_at > \?[\s\S]*terminal_deadline_at > \?/,
  "checkpoint mutation must be time-fenced in SQL",
);
expect(
  store,
  /checkpoint\.providerInFlight = true/,
  "StartNextInference must durably mark provider in flight",
);
expect(
  store,
  /checkpoint\.batches\.push\(batch\)/,
  "whole provider batch must append atomically",
);
expect(
  store,
  /firstPending\.effectStarted = true/,
  "BeginEffect must persist a per-call latch",
);
expect(
  store,
  /call\.result = result/,
  "RecordToolResult must persist one matching result",
);
expect(
  store,
  /checkpoint\.providerInFlight[\s\S]*!checkpointClosed\(checkpoint\)[\s\S]*checkpoint\.final !== output/,
  "terminal success must match a closed final checkpoint",
);
expect(
  store,
  /checkpointUncertain\(checkpoint\)/,
  "uncertain checkpoint must block recovery",
);
expect(
  store,
  /recovery_count = recovery_count \+ 1[\s\S]*recovery_count < \?[\s\S]*terminal_deadline_at > \?/,
  "recovery must retain a single count and original deadline fence",
);

// Controller first-byte and admission ordering.
const events = bracedBody(
  controller,
  "private events(",
  "ChatRuntimeController.events",
);
before(
  events,
  /writer\.comment\(\)/,
  /this\.getScope/,
  "first SSE bytes must precede scope/storage work",
);
reject(
  events,
  /LegacySessionMigrator|runAfterAdmission/,
  "transport attach must never start legacy migration",
);
const messages = bracedBody(
  controller,
  "private async messages(",
  "ChatRuntimeController.messages",
);
before(
  messages,
  /storage\.setAlarm\(now\)/,
  /store\.admit\(/,
  "alarm must be durable before row admission",
);
expect(
  controller,
  /encoder\.encode\(`data: \$\{JSON\.stringify\(value\)\}\\n\\n`\)\.byteLength/,
  "SSE cap must measure escaped wire bytes",
);
expect(
  controller,
  /function fitNewestMessages\(/,
  "oversized snapshots need dynamic wire fitting",
);
expect(
  controller,
  /const newestTurnId = selected\.at\(-1\)\?\.turnId/,
  "snapshot fitting must identify the newest turn",
);
expect(
  controller,
  /fitNewestMessages\(payload, messages\)/,
  "snapshot fitting must truncate only after dropping old turns",
);
expect(
  controller,
  /chunk\.byteLength > remaining/,
  "SSE enqueue must honor exact remaining queue bytes",
);
expect(
  controller,
  /reservedSseBytes \+ CHAT_RUNTIME_BOUNDS\.sseWriterQueueBytes[\s\S]*CHAT_RUNTIME_BOUNDS\.sseDoBytes/,
  "SSE attach must reserve aggregate queue capacity",
);
expect(
  controller,
  /highWaterMark: CHAT_RUNTIME_BOUNDS\.sseWriterQueueBytes/,
  "SSE stream must use the declared queue bound",
);
expect(
  store,
  /let bytes = 2; \/\/ Canonical JSON array brackets\./,
  "snapshot bytes must include array framing",
);
expect(
  store,
  /newest\.length \+ index > 0 \? 1 : 0/,
  "snapshot bytes must include message separators",
);
reject(
  client,
  /result\.value\.byteLength > this\.options\.maxFrameBytes/,
  "network chunks must not be mistaken for SSE frames",
);
expect(
  client,
  /sseDecodeSliceBytes/,
  "coalesced SSE chunks need bounded incremental decoding",
);

// The shared Worker composition root is part of the counted runtime surface.
// Pin all three V2 endpoints, their auth deadline, authorization ordering, and
// the terminal fallthrough for every retired /agents route.
const routeTable = between(
  mainWorker,
  /const routes: Route\[\] = \[/,
  /\/\/ =============================================================================\n\/\/ React Router Handler/,
  "main Worker route table",
);
const eventsPath = String.raw`path: /^\/agents\/chat-thread\/([^/]+)\/v2\/events$/`;
const callsPath = String.raw`path: /^\/agents\/chat-thread\/([^/]+)\/v2\/(?:messages|controls)$/`;
const retiredAgentsPath = String.raw`path: /^\/agents\//`;
expectText(routeTable, eventsPath, "V2 events route is missing");
expectText(
  routeTable,
  'handler: (context) => handleChatTransportRequest(context, "sse")',
  "V2 events must use the SSE authorization operation",
);
expectText(routeTable, callsPath, "V2 messages/controls routes are missing");
expectText(
  routeTable,
  'handler: (context) => handleChatTransportRequest(context, "call")',
  "V2 messages/controls must use the call authorization operation",
);
expectText(
  routeTable,
  retiredAgentsPath,
  "retired /agents routes need an explicit fallthrough",
);
expectText(
  routeTable,
  'handler: async () => text("Not Found", 404)',
  "retired /agents routes must terminate as 404",
);
beforeText(
  routeTable,
  eventsPath,
  callsPath,
  "V2 events must precede V2 call dispatch",
);
beforeText(
  routeTable,
  callsPath,
  retiredAgentsPath,
  "retired /agents fallthrough must follow every V2 route",
);

expect(
  bounds,
  /transportAuthMs:\s*8_000\b/,
  "transport authorization deadline drifted",
);
const authDeadline = bracedBody(
  mainWorker,
  "function boundChatTransportAuthorization<T>(task: Promise<T>): Promise<T>",
  "boundChatTransportAuthorization",
);
expect(
  authDeadline,
  /setTimeout\([\s\S]*CHAT_RUNTIME_BOUNDS\.transportAuthMs/,
  "transport authorization must use the central deadline",
);
expect(
  authDeadline,
  /Promise\.race\(\[task, deadline\]\)/,
  "transport authorization must race its deadline",
);
expect(
  authDeadline,
  /\.finally\(\(\) => clearTimeout\(timer\)\)/,
  "transport authorization must release its timer",
);

const authorizeTransport = between(
  mainWorker,
  /async function authorizeChatTransportRequest\(/,
  /async function handleChatTransportRequest\(/,
  "chat transport authorization",
);
before(
  authorizeTransport,
  /stripReservedTransportHeaders\(headers\)/,
  /headers\.set\("X-Chiridion-User-Id"/,
  "reserved headers must be stripped before verified identity is attached",
);
for (const header of [
  "X-Chiridion-User-Id",
  "X-Chiridion-User-Name",
  "X-Chiridion-User-Email",
  "X-Chiridion-Auth-Degraded",
]) {
  expectText(
    authorizeTransport,
    `headers.delete("${header}")`,
    `client-controlled ${header} must be stripped`,
  );
}
expect(
  transportHeaders,
  /RESERVED_HEADER_PREFIXES\s*=\s*\["x-partykit-",\s*"x-cf-agents-"\]/,
  "framework-reserved transport prefixes drifted",
);
expect(
  authorizeTransport,
  /url\.searchParams\.set\("threadId", fullAccess\.threadId\)[\s\S]*url\.searchParams\.set\("workspaceId", fullAccess\.workspaceId\)[\s\S]*url\.searchParams\.set\("orgId", fullAccess\.orgId\)/,
  "forwarded scope must come from authorization",
);

const transportDispatch = between(
  mainWorker,
  /async function handleChatTransportRequest\(/,
  /export default \{/,
  "chat transport dispatch",
);
before(
  transportDispatch,
  /await authorizeChatTransportRequest\(/,
  /getThreadStub\(env, threadId\)\.fetch\(authorized\)/,
  "authorization must finish before the Durable Object fetch",
);
expect(
  transportDispatch,
  /if \(authorized instanceof Response\) return authorized/,
  "authorization denial must not reach the Durable Object",
);
reject(
  transportDispatch,
  /getThreadStub\(env, threadId\)\.fetch\(req\)/,
  "the Durable Object must receive only the rewritten authorized request",
);

// The counted shared UI integration must keep all user actions on V2. Counting
// Chat.tsx prevents this glue from becoming an unmeasured replacement runtime;
// these checks prevent it from silently switching back to a retired hook.
expect(
  chatUi,
  /const chatRuntime = useChatRuntime<ChatAgentState>\(/,
  "Chat must own one V2 runtime hook",
);
expect(
  chatUi,
  /chatRuntime\s*\.sendMessage<SendMessageResult>\(/,
  "Chat admissions must use the bounded V2 POST client",
);
for (const control of ["stop", "answer_question", "connection_setup"]) {
  expect(
    chatUi,
    new RegExp(`chatRuntime\\.control\\("${control}"`),
    `Chat control ${control} is not wired to V2`,
  );
}
reject(
  chatUi,
  /usePiChatStream|useSseAgent|SseAgentClient|useAgentChat/,
  "Chat contains a retired transport/runtime hook",
);

// Runner is checkpoint-driven and executes a batch sequentially.
expect(
  runner,
  /recoveryAttempts !== 1[\s\S]*attemptsPerTurn !== 2/,
  "runner recovery cardinality drifted",
);
expect(
  runner,
  /messages:\s*CHAT_RUNTIME_BOUNDS\.contextMessages/,
  "runner must apply the message-count context bound",
);
expect(
  runner,
  /checkpoint\.providerInFlight \|\| checkpointUncertain\(checkpoint\)/,
  "runner must reject unsafe recovery checkpoints",
);
const runLoop = between(
  runner,
  /return async \(\{/,
  /\n\s*\};\n\}/,
  "bounded runner loop",
);
before(
  runLoop,
  /await beginEffect\(call\.id\)/,
  /adapter\.callTool\(/,
  "every tool must latch before invocation",
);
before(
  runLoop,
  /await recordToolResult\(result\)/,
  /continue;/,
  "each call result must checkpoint before advancing",
);
before(
  runLoop,
  /await startNextInference\(\)/,
  /adapter\.callProvider\(/,
  "provider dispatch must checkpoint before invocation",
);
before(
  runLoop,
  /await checkpointProviderFinal\(output\)/,
  /return output/,
  "final response must checkpoint before success",
);
expect(
  runner,
  /tool_timeout[\s\S]*toolDeadlineMs/,
  "tool calls need a child deadline",
);
expect(
  runner,
  /provider_timeout[\s\S]*providerDeadlineMs/,
  "provider calls need a child deadline",
);

// Driver may recover a foreign first token once, terminalizes before isolate
// abort, and never loops over turns in one alarm invocation.
const runAlarm = bracedBody(
  driver,
  "private async runAlarm()",
  "DurableTurnDriver.runAlarm",
);
expect(
  runAlarm,
  /active\.attemptToken === this\.ownedAttemptToken/,
  "cold wake must identify its own token",
);
expect(
  runAlarm,
  /recoverFromCheckpoint/,
  "cold wake must attempt safe checkpoint recovery",
);
before(
  runAlarm,
  /await this\.setAlarm\(now\)/,
  /store\.claim\(/,
  "alarm must be pre-armed before claim",
);
reject(
  runAlarm,
  /\b(?:while|for)\s*\(/,
  "one alarm invocation must not loop over turns",
);
const execute = bracedBody(
  driver,
  "private async execute(",
  "DurableTurnDriver.execute",
);
expect(
  execute,
  /startNextInference:[\s\S]*checkpointProviderBatch:[\s\S]*checkpointProviderFinal:[\s\S]*beginEffect:[\s\S]*recordToolResult:/,
  "driver must expose every fenced checkpoint action",
);
before(
  execute,
  /await this\.setAlarm\(this\.now\(\)\)/,
  /store\.complete\(/,
  "next alarm must precede success commit",
);
before(
  execute,
  /this\.publish\(\)/,
  /await this\.armNext\(terminal\)/,
  "terminal publication must precede next ownership",
);
before(
  execute,
  /await this\.armNext\(terminal\)/,
  /this\.options\.ctx\.abort\(/,
  "terminal state and next alarm must precede isolate abort",
);
expect(
  execute,
  /tool_timeout" \|\| error\.code === "provider_timeout"/,
  "uncancellable provider/tool timeout must evict isolate",
);

// Provider context is a separate model-only projection, never browser display.
const modelContext = bracedBody(
  store,
  "  *readModelContext(",
  "DurableChatTurnStore.readModelContext",
);
expect(
  modelContext,
  /SELECT user_content, assistant_final FROM chat_turns_v2/,
  "model context must select model content explicitly",
);
expect(
  modelContext,
  /retained = 1 AND status = 'completed' AND id <> \?/,
  "model context must be retained, settled, and exclude the active turn",
);
reject(
  modelContext,
  /user_display/,
  "UI display text must not enter model context",
);
expect(
  adapter,
  /store\.readModelContext\(turn\.id\)/,
  "provider adapter must consume the model-only projection",
);
reject(
  adapter,
  /latestSnapshot\(\)\.messages/,
  "provider adapter must not reuse the browser snapshot",
);

// Migration implementation bounds, terminal fences, and read-only source.
expect(
  legacy,
  /export type LegacyMigrationState = "unseen" \| "pending" \| "complete" \| "failed"/,
  "legacy marker state drifted",
);
const runMigration = bracedBody(
  legacy,
  "async runAfterAdmission(",
  "LegacySessionMigrator.runAfterAdmission",
);
expect(
  runMigration,
  /const hasAdmittedWork\s*=\s*this\.hasAdmittedV2Turn\(now\)/,
  "legacy read must check for admitted V2 work",
);
before(
  runMigration,
  /if \(!hasAdmittedWork\)/,
  /this\.scanLegacy\(/,
  "legacy read must require admitted V2 work",
);
before(
  runMigration,
  /existing\?\.state === "complete"/,
  /this\.scanLegacy\(/,
  "terminal marker must fence every later legacy read",
);
const claimMigration = bracedBody(
  legacy,
  "private claimAttempt(",
  "LegacySessionMigrator.claimAttempt",
);
expect(
  claimMigration,
  /now \+ CHAT_RUNTIME_BOUNDS\.legacyMigrationDeadlineMs/,
  "first attempt must set one absolute deadline",
);
expect(
  claimMigration,
  /attempt_count = attempt_count \+ 1[\s\S]*attempt_token = \?/,
  "retry must mint a new fenced token",
);
expect(
  claimMigration,
  /attempt_count < \? AND deadline_at > \?/,
  "retry must retain attempt and deadline fences",
);
reject(
  claimMigration,
  /SET[\s\S]{0,120}deadline_at\s*=/,
  "retry must not renew migration deadline",
);
const scanLegacy = bracedBody(
  legacy,
  "private async scanLegacy(",
  "LegacySessionMigrator.scanLegacy",
);
expect(
  scanLegacy,
  /this\.assertAttemptOwned\(attemptToken, deadlineAt\)/,
  "legacy source selection must be fenced by the current token and deadline",
);
const readLegacyRows = bracedBody(
  legacy,
  "private async readNewestRows(",
  "LegacySessionMigrator.readNewestRows",
);
const legacyPageLoop = between(
  readLegacyRows,
  /while\s*\(/,
  /return newest\.reverse\(\)/,
  "bounded legacy page loop",
);
before(
  legacyPageLoop,
  /this\.assertAttemptOwned\(attemptToken, deadlineAt\)/,
  /let metadata:/,
  "every legacy page read must begin behind an ownership fence",
);
expect(
  readLegacyRows,
  /await yieldToTransport\(\)/,
  "bounded legacy paging must yield between pages",
);
const commitMigration = bracedBody(
  legacy,
  "private commit(",
  "LegacySessionMigrator.commit",
);
before(
  commitMigration,
  /marker\.attempt_token !== token[\s\S]*now >= Number\(marker\.deadline_at\)/,
  /INSERT INTO chat_turns_v2/,
  "legacy import must validate token and deadline before inserting history",
);
expect(
  commitMigration,
  /state = 'pending' AND attempt_token = \?/,
  "legacy terminal marker must be SQL-fenced by the current token",
);
expect(
  legacy,
  /legacyMigrationPageRows/,
  "legacy scan must use its page bound",
);
expect(
  legacy,
  /legacyMigrationScanRows/,
  "legacy scan must use its total-row bound",
);
expect(legacy, /historyTurns/, "legacy import must use the shared turn bound");
expect(legacy, /historyBytes/, "legacy import must use the shared byte bound");
expect(
  legacy,
  /function hasCompleteAiChatChronology\(/,
  "legacy ordering needs an explicit completeness guard",
);
expect(
  legacy,
  /key = 'metadata_v1' AND value = 1[\s\S]*cf_ai_chat_agent_messages_chronology/,
  "chronology ordering must require both marker and index",
);
expect(
  legacy,
  /table === AI_CHAT_TABLE && hasCompleteAiChatChronology\(this\.sql\)/,
  "ai-chat paging must consult the chronology completeness guard",
);
expect(
  legacy,
  /WHERE rowid < \? ORDER BY rowid DESC LIMIT \?/,
  "incomplete chronology must fall back to indexed rowid paging",
);
reject(
  legacy,
  /(?:UPDATE|DELETE FROM|INSERT INTO)\s+\$\{?(?:PI_TABLE|AI_CHAT_TABLE|PI_COMPACTION_TABLE)/,
  "legacy source tables must remain read-only",
);
const blocksClaim = bracedBody(
  legacy,
  "export function legacyMigrationBlocksClaim(",
  "legacyMigrationBlocksClaim",
);
expect(
  blocksClaim,
  /marker\.state === "pending"/,
  "pending migration must block claim",
);
expect(
  blocksClaim,
  /status IN \('queued','running'\)/,
  "unseen admitted work must block claim",
);
if (!/legacyMigrationBlocksClaim|claimBlocked/.test(store + driver)) {
  fail("turn claim is not wired to the migration terminal guard");
}

// Exact result matching and uncertainty are validated at checkpoint parse time.
expect(
  checkpoint,
  /ids\.has\(item\.id\)/,
  "checkpoint must reject duplicate call ids",
);
expect(
  checkpoint,
  /item\.result\.callId !== item\.id/,
  "checkpoint result must match its call id",
);
expect(
  checkpoint,
  /effectStarted && call\.result === null/,
  "checkpoint must identify uncertain effects",
);
expect(
  checkpoint,
  /Only the latest provider batch may be open/,
  "only one provider batch may remain open",
);

console.log(
  `Chat runtime conformance OK (${durableActions.length} exact durable actions; ` +
    `${Object.keys(ciConfigs).length} full-property CI configs; coarse reducer projection, ` +
    "migration, FIFO, checkpoint recovery, batch closure, and time/token fences checked).",
);
