import {
  lookupPricingOrNull,
  type ModelPricing,
} from "../../../../../src/lib/usage-pricing";
import { usageInteger, usageText } from "../usage";

export const MICRO_USD_PER_USD = 1_000_000;
export const MAX_USER_LLM_LIMITS = 10;
export const MIN_LIMIT_WINDOW_MS = 60_000;
export const MAX_LIMIT_WINDOW_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export type UsageKind =
  | "llm"
  | "image"
  | "audio"
  | "capability"
  | "unknown";

export type UsageSurface =
  | "agent"
  | "subagent"
  | "compaction"
  | "virtual_ai"
  | "auxiliary"
  | "capability"
  | "unknown";

export type UsageCostSource =
  | "provider_reported"
  | "org_override"
  | "builtin_pricing"
  | "legacy_estimate"
  | "unpriced";

export interface UserLlmUsageLimitInput {
  window_hours: number;
  limit_usd: number;
  label?: string | null;
}

export interface UserLlmUsageLimit {
  window_hours: number;
  limit_usd: number;
  label: string | null;
}

export interface UserLlmUsageLimitStatus extends UserLlmUsageLimit {
  spent_usd: number;
  remaining_usd: number;
  unpriced_requests: number;
  exceeded: boolean;
  retry_at_ms: number | null;
}

export type UserLlmUsageAccessReason =
  | "no_limits"
  | "within_limits"
  | "limit_exceeded"
  | "pricing_unavailable";

export interface UserLlmUsageAccessResult {
  allowed: boolean;
  reason: UserLlmUsageAccessReason;
  evaluated_at_ms: number;
  blocking_limit: UserLlmUsageLimitStatus | null;
  limits: UserLlmUsageLimitStatus[];
}

export interface CheckUserLlmUsageAccessInput {
  user_id: string;
  provider: string;
  model: string;
  now_ms?: number;
}

export interface LlmModelPricingInput {
  provider: string;
  model: string;
  input_usd_per_million: number;
  output_usd_per_million: number;
  cache_creation_usd_per_million?: number;
  cache_read_usd_per_million?: number;
}

export interface LlmModelPricing extends LlmModelPricingInput {
  cache_creation_usd_per_million: number;
  cache_read_usd_per_million: number;
}

export interface LlmPricingResponse {
  org_id: string;
  prices: LlmModelPricing[];
  unpriced_models: Array<{
    provider: string;
    model: string;
    last_seen_at_ms: number;
  }>;
}

export interface UsageAggregateQuery {
  from?: number | null;
  to?: number | null;
  chargeable_only?: boolean | number | null;
  user_id?: string | null;
  provider?: string | null;
  model?: string | null;
  usage_kind?: UsageKind | null;
  usage_surface?: UsageSurface | null;
}

export interface UsageAggregateResult {
  org_id: string;
  total_cost_usd: number;
  metered_cost_usd: number;
  unpriced_requests: number;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_input_tokens: number;
  total_cache_read_input_tokens: number;
}

export interface UserLlmUsageReportQuery {
  from: number;
  to: number;
  limit?: number | null;
  cursor?: string | null;
  user_id?: string | null;
  now_ms?: number | null;
}

export interface UserLlmUsageTotals {
  requests: number;
  spend_usd: number;
  unpriced_requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface UserLlmUsageModelTotals extends UserLlmUsageTotals {
  provider: string;
  model: string;
}

export interface UserLlmUsageSubject {
  user_id: string | null;
  membership_status: "current" | "former" | "unattributed";
  totals: UserLlmUsageTotals;
  models: UserLlmUsageModelTotals[];
  limit_status: Pick<
    UserLlmUsageAccessResult,
    "allowed" | "reason" | "blocking_limit" | "limits"
  >;
}

export interface UserLlmUsageReport {
  org_id: string;
  from_ms: number;
  to_ms: number;
  evaluated_at_ms: number;
  users: UserLlmUsageSubject[];
  count: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface StrictUsageCostInput {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  reported_cost_usd?: number | null;
  upstream_inference_cost_usd?: number | null;
}

export interface StrictUsageCostResult {
  meteredCostMicrousd: number | null;
  costSource: UsageCostSource;
}

export class UsageControlsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageControlsValidationError";
  }
}

export interface UsageControlsContext {
  sql: SqlStorage;
  orgId(): string;
  isCurrentMember(userId: string): boolean;
  transactionSync<T>(callback: () => T): T;
}

interface LimitRow extends Record<string, SqlStorageValue> {
  user_id: string;
  window_ms: number;
  limit_microusd: number;
  label: string | null;
}

interface PricingRow extends Record<string, SqlStorageValue> {
  provider: string;
  model: string;
  input_microusd_per_million: number;
  output_microusd_per_million: number;
  cache_creation_microusd_per_million: number;
  cache_read_microusd_per_million: number;
}

interface LimitAggregateRow extends Record<string, SqlStorageValue> {
  user_id: string;
  window_ms: number;
  spent: number;
  unpriced: number;
}

interface LimitExpiryRow extends Record<string, SqlStorageValue> {
  user_id: string;
  window_ms: number;
  retry_at_ms: number;
}

const EMPTY_TOTALS: UserLlmUsageTotals = Object.freeze({
  requests: 0,
  spend_usd: 0,
  unpriced_requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

function finiteNonNegative(value: unknown, field: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new UsageControlsValidationError(`${field} must be a finite non-negative number`);
  }
  return numeric;
}

function hasAtMostSixDecimals(value: number): boolean {
  return isApproximatelyInteger(value * MICRO_USD_PER_USD);
}

function isApproximatelyInteger(value: number): boolean {
  const rounded = Math.round(value);
  const tolerance = Math.max(1e-6, Math.abs(value) * Number.EPSILON * 2);
  return Number.isSafeInteger(rounded) && Math.abs(value - rounded) <= tolerance;
}

export function usdToMicrousd(value: number, field = "USD value"): number {
  const numeric = finiteNonNegative(value, field);
  if (!hasAtMostSixDecimals(numeric)) {
    throw new UsageControlsValidationError(`${field} must have at most six decimal places`);
  }
  const micro = Math.round(numeric * MICRO_USD_PER_USD);
  if (!Number.isSafeInteger(micro)) {
    throw new UsageControlsValidationError(`${field} is too large`);
  }
  return micro;
}

export function microusdToUsd(value: number): number {
  return Number((Math.max(0, Number(value) || 0) / MICRO_USD_PER_USD).toFixed(6));
}

function normalizeUsageKind(value: unknown): UsageKind {
  return value === "llm" || value === "image" || value === "audio" ||
    value === "capability" ? value : "unknown";
}

function normalizeUsageSurface(value: unknown): UsageSurface {
  return value === "agent" || value === "subagent" || value === "compaction" ||
    value === "virtual_ai" || value === "auxiliary" || value === "capability"
    ? value
    : "unknown";
}

export { normalizeUsageKind, normalizeUsageSurface };

function pricingForInputTokens(pricing: ModelPricing, inputTokens: number): ModelPricing {
  return pricing.tiers
    ?.filter((tier) => inputTokens > tier.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? pricing;
}

function costFromBuiltin(input: StrictUsageCostInput, pricing: ModelPricing): number {
  const promptTokens = input.input_tokens + input.cache_creation_input_tokens + input.cache_read_input_tokens;
  const effective = pricingForInputTokens(pricing, promptTokens);
  return Math.round(MICRO_USD_PER_USD * (
    input.input_tokens * effective.inputPerToken +
    input.output_tokens * effective.outputPerToken +
    input.cache_creation_input_tokens * (effective.cacheCreationPerToken ?? 0) +
    input.cache_read_input_tokens * (effective.cacheReadPerToken ?? 0)
  ));
}

function costFromOverride(input: StrictUsageCostInput, pricing: PricingRow): number {
  const numerator =
    input.input_tokens * Number(pricing.input_microusd_per_million) +
    input.output_tokens * Number(pricing.output_microusd_per_million) +
    input.cache_creation_input_tokens * Number(pricing.cache_creation_microusd_per_million) +
    input.cache_read_input_tokens * Number(pricing.cache_read_microusd_per_million);
  return Math.round(numerator / 1_000_000);
}

export function resolveStrictUsageCost(
  context: Pick<UsageControlsContext, "sql">,
  raw: StrictUsageCostInput,
): StrictUsageCostResult {
  const input: StrictUsageCostInput = {
    ...raw,
    provider: usageText(raw.provider) || "unknown",
    model: usageText(raw.model) || "unknown",
    input_tokens: usageInteger(raw.input_tokens),
    output_tokens: usageInteger(raw.output_tokens),
    cache_creation_input_tokens: usageInteger(raw.cache_creation_input_tokens),
    cache_read_input_tokens: usageInteger(raw.cache_read_input_tokens),
  };
  const reported = [raw.reported_cost_usd, raw.upstream_inference_cost_usd]
    .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (reported !== undefined) {
    return {
      meteredCostMicrousd: Math.round(reported * MICRO_USD_PER_USD),
      costSource: "provider_reported",
    };
  }
  const override = context.sql.exec<PricingRow>(
    `SELECT provider, model, input_microusd_per_million,
            output_microusd_per_million, cache_creation_microusd_per_million,
            cache_read_microusd_per_million
       FROM llm_model_pricing_overrides
      WHERE provider = ? AND model = ?`,
    input.provider,
    input.model,
  ).toArray()[0];
  if (override) {
    return { meteredCostMicrousd: costFromOverride(input, override), costSource: "org_override" };
  }
  // Built-in catalog matching intentionally recognizes model families. Do not
  // apply those broad names to an operator's custom provider/model namespace:
  // an exact override (or provider-reported cost above) is required there.
  const provider = input.provider.toLowerCase();
  const model = input.model.toLowerCase();
  const builtinProviderCompatible =
    provider === "openrouter" ||
    provider === "requesty" ||
    provider === "compat" ||
    (provider === "openai" && model.includes("gpt")) ||
    (provider === "anthropic" && model.includes("claude")) ||
    (provider === "bedrock" && (model.includes("claude") || model.includes("gpt"))) ||
    ((provider === "google" || provider === "vertex") && model.includes("gemini"));
  const builtin = builtinProviderCompatible ? lookupPricingOrNull(input.model) : null;
  if (builtin) {
    return { meteredCostMicrousd: costFromBuiltin(input, builtin), costSource: "builtin_pricing" };
  }
  return { meteredCostMicrousd: null, costSource: "unpriced" };
}

function normalizeLimitInputs(inputs: UserLlmUsageLimitInput[]): Array<{
  windowMs: number;
  limitMicrousd: number;
  label: string | null;
}> {
  if (!Array.isArray(inputs) || inputs.length > MAX_USER_LLM_LIMITS) {
    throw new UsageControlsValidationError(`limits must contain at most ${MAX_USER_LLM_LIMITS} entries`);
  }
  const seen = new Set<number>();
  const result = inputs.map((input, index) => {
    const windowHours = finiteNonNegative(input.window_hours, `limits[${index}].window_hours`);
    const rawWindowMs = windowHours * 60 * 60 * 1000;
    const windowMs = Math.round(rawWindowMs);
    if (
      !isApproximatelyInteger(rawWindowMs) ||
      windowMs < MIN_LIMIT_WINDOW_MS ||
      windowMs > MAX_LIMIT_WINDOW_MS
    ) {
      throw new UsageControlsValidationError(`limits[${index}].window_hours must be between one minute and five years`);
    }
    if (seen.has(windowMs)) {
      throw new UsageControlsValidationError(`duplicate window_hours: ${windowHours}`);
    }
    seen.add(windowMs);
    const limitUsd = finiteNonNegative(input.limit_usd, `limits[${index}].limit_usd`);
    if (limitUsd > 1_000_000_000) {
      throw new UsageControlsValidationError(`limits[${index}].limit_usd exceeds 1000000000`);
    }
    return {
      windowMs,
      limitMicrousd: usdToMicrousd(limitUsd, `limits[${index}].limit_usd`),
      label: usageText(input.label) || null,
    };
  });
  return result.sort((a, b) => a.windowMs - b.windowMs);
}

function normalizePricingInputs(inputs: LlmModelPricingInput[]): Array<PricingRow> {
  if (!Array.isArray(inputs) || inputs.length > 500) {
    throw new UsageControlsValidationError("prices must contain at most 500 entries");
  }
  const seen = new Set<string>();
  return inputs.map((input, index) => {
    const provider = usageText(input.provider);
    const model = usageText(input.model);
    if (!provider || provider.length > 200 || !model || model.length > 200) {
      throw new UsageControlsValidationError(`prices[${index}] provider and model must be 1-200 trimmed characters`);
    }
    const key = `${provider}\0${model}`;
    if (seen.has(key)) throw new UsageControlsValidationError(`duplicate price for ${provider}/${model}`);
    seen.add(key);
    const rate = (value: unknown, field: string, required: boolean) => {
      if (!required && value === undefined) return 0;
      const numeric = finiteNonNegative(value, field);
      if (numeric > 1_000_000) throw new UsageControlsValidationError(`${field} exceeds 1000000`);
      return usdToMicrousd(numeric, field);
    };
    return {
      provider,
      model,
      input_microusd_per_million: rate(input.input_usd_per_million, `prices[${index}].input_usd_per_million`, true),
      output_microusd_per_million: rate(input.output_usd_per_million, `prices[${index}].output_usd_per_million`, true),
      cache_creation_microusd_per_million: rate(input.cache_creation_usd_per_million, `prices[${index}].cache_creation_usd_per_million`, false),
      cache_read_microusd_per_million: rate(input.cache_read_usd_per_million, `prices[${index}].cache_read_usd_per_million`, false),
    };
  }).sort((a, b) => {
    const providerOrder = a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0;
    if (providerOrder !== 0) return providerOrder;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
}

function limitDto(row: LimitRow): UserLlmUsageLimit {
  return {
    window_hours: Number(row.window_ms) / 3_600_000,
    limit_usd: microusdToUsd(Number(row.limit_microusd)),
    label: typeof row.label === "string" && row.label ? row.label : null,
  };
}

function pricingDto(row: PricingRow): LlmModelPricing {
  return {
    provider: String(row.provider),
    model: String(row.model),
    input_usd_per_million: microusdToUsd(Number(row.input_microusd_per_million)),
    output_usd_per_million: microusdToUsd(Number(row.output_microusd_per_million)),
    cache_creation_usd_per_million: microusdToUsd(Number(row.cache_creation_microusd_per_million)),
    cache_read_usd_per_million: microusdToUsd(Number(row.cache_read_microusd_per_million)),
  };
}

function encodeCursor(userId: string | null): string {
  const encoded = btoa(JSON.stringify({ v: 1, user_id: userId }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return encoded;
}

function decodeCursor(value: string): string | null {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as unknown;
    if (!parsed || typeof parsed !== "object" || (parsed as { v?: unknown }).v !== 1) throw new Error();
    const userId = (parsed as { user_id?: unknown }).user_id;
    if (userId !== null && (typeof userId !== "string" || !userId)) throw new Error();
    return userId;
  } catch {
    throw new UsageControlsValidationError("cursor is malformed");
  }
}

export function validateUserLlmUsageCursor(value: string): void {
  decodeCursor(value);
}

function totalsFromRow(row: Record<string, SqlStorageValue> | undefined): UserLlmUsageTotals {
  if (!row) return { ...EMPTY_TOTALS };
  return {
    requests: Number(row.requests ?? 0),
    spend_usd: microusdToUsd(Number(row.spend_microusd ?? 0)),
    unpriced_requests: Number(row.unpriced_requests ?? 0),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    cache_creation_input_tokens: Number(row.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: Number(row.cache_read_input_tokens ?? 0),
  };
}

export class OrgUsageControls {
  constructor(private readonly context: UsageControlsContext) {}

  getUserLimits(userId: string): UserLlmUsageLimit[] {
    return this.loadLimitRows(usageText(userId)).map(limitDto);
  }

  replaceUserLimits(userId: string, limits: UserLlmUsageLimitInput[], updatedBy: string): UserLlmUsageLimit[] {
    const normalizedUserId = usageText(userId);
    if (!normalizedUserId || !this.context.isCurrentMember(normalizedUserId)) {
      throw new UsageControlsValidationError("current organization member not found");
    }
    const normalized = normalizeLimitInputs(limits);
    const now = Date.now();
    this.context.transactionSync(() => {
      this.context.sql.exec("DELETE FROM user_llm_usage_limits WHERE user_id = ?", normalizedUserId);
      for (const row of normalized) {
        this.context.sql.exec(
          `INSERT INTO user_llm_usage_limits
             (user_id, window_ms, limit_microusd, label, created_at_ms, updated_at_ms, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          normalizedUserId, row.windowMs, row.limitMicrousd, row.label, now, now,
          usageText(updatedBy) || "admin_api_key",
        );
      }
    });
    return this.getUserLimits(normalizedUserId);
  }

  clearUserLimits(userId: string): void {
    this.context.sql.exec("DELETE FROM user_llm_usage_limits WHERE user_id = ?", usageText(userId));
  }

  getPricing(): LlmPricingResponse {
    const prices = this.context.sql.exec<PricingRow>(
      `SELECT provider, model, input_microusd_per_million, output_microusd_per_million,
              cache_creation_microusd_per_million, cache_read_microusd_per_million
         FROM llm_model_pricing_overrides ORDER BY provider COLLATE BINARY, model COLLATE BINARY`,
    ).toArray().map(pricingDto);
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const unpricedModels = this.context.sql.exec<{
      provider: string; model: string; last_seen_at_ms: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT provider, model, MAX(created_at_ms) AS last_seen_at_ms
         FROM usage_log
        WHERE usage_kind = 'llm' AND metered_cost_microusd IS NULL AND created_at_ms >= ?
        GROUP BY provider, model
        ORDER BY last_seen_at_ms DESC, provider COLLATE BINARY, model COLLATE BINARY
        LIMIT 100`,
      since,
    ).toArray().map((row) => ({
      provider: String(row.provider), model: String(row.model), last_seen_at_ms: Number(row.last_seen_at_ms),
    }));
    return { org_id: this.context.orgId(), prices, unpriced_models: unpricedModels };
  }

  replacePricing(inputs: LlmModelPricingInput[], updatedBy: string): LlmPricingResponse {
    const normalized = normalizePricingInputs(inputs);
    const now = Date.now();
    this.context.transactionSync(() => {
      this.context.sql.exec("DELETE FROM llm_model_pricing_overrides");
      for (const row of normalized) {
        this.context.sql.exec(
          `INSERT INTO llm_model_pricing_overrides
             (provider, model, input_microusd_per_million, output_microusd_per_million,
              cache_creation_microusd_per_million, cache_read_microusd_per_million,
              created_at_ms, updated_at_ms, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.provider, row.model, row.input_microusd_per_million,
          row.output_microusd_per_million, row.cache_creation_microusd_per_million,
          row.cache_read_microusd_per_million, now, now,
          usageText(updatedBy) || "admin_api_key",
        );
      }
    });
    return this.getPricing();
  }

  resolveStrictCost(input: StrictUsageCostInput): StrictUsageCostResult {
    return resolveStrictUsageCost(this.context, input);
  }

  checkAccess(input: CheckUserLlmUsageAccessInput): UserLlmUsageAccessResult {
    const userId = usageText(input.user_id);
    const now = usageInteger(input.now_ms) || Date.now();
    const status = this.limitStatusesForUsers(userId ? [userId] : [], now).get(userId) ??
      { allowed: true, reason: "no_limits" as const, evaluated_at_ms: now, blocking_limit: null, limits: [] };
    if (status.reason === "no_limits") return status;
    const requestedPricing = this.resolveStrictCost({
      provider: input.provider,
      model: input.model,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    if (requestedPricing.meteredCostMicrousd === null || status.reason === "pricing_unavailable") {
      return {
        allowed: false,
        reason: "pricing_unavailable",
        evaluated_at_ms: now,
        blocking_limit: status.reason === "pricing_unavailable"
          ? status.blocking_limit
          : status.limits[0] ?? null,
        limits: status.limits,
      };
    }
    return status;
  }

  getLimitStatus(userId: string, nowMs = Date.now()): UserLlmUsageAccessResult {
    const normalizedUserId = usageText(userId);
    const now = usageInteger(nowMs) || Date.now();
    return this.limitStatusesForUsers(normalizedUserId ? [normalizedUserId] : [], now)
      .get(normalizedUserId) ??
      { allowed: true, reason: "no_limits", evaluated_at_ms: now, blocking_limit: null, limits: [] };
  }

  getAggregate(query: UsageAggregateQuery = {}): UsageAggregateResult {
    const from = usageInteger(query.from);
    const to = usageInteger(query.to) || Date.now();
    if (!(to > from)) {
      throw new UsageControlsValidationError("to must be greater than from");
    }
    const { where, params } = this.filterWhere(query, from, to);
    const row = this.context.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
              COALESCE(SUM(metered_cost_microusd), 0) AS metered_cost_microusd,
              SUM(CASE WHEN usage_kind = 'llm' AND metered_cost_microusd IS NULL THEN 1 ELSE 0 END) AS unpriced_requests,
              COUNT(*) AS total_requests,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
              COALESCE(SUM(cache_creation_input_tokens), 0) AS total_cache_creation_input_tokens,
              COALESCE(SUM(cache_read_input_tokens), 0) AS total_cache_read_input_tokens
         FROM usage_log WHERE ${where.join(" AND ")}`,
      ...params,
    ).toArray()[0];
    return {
      org_id: this.context.orgId(),
      total_cost_usd: Number(row?.total_cost_usd ?? 0),
      metered_cost_usd: microusdToUsd(Number(row?.metered_cost_microusd ?? 0)),
      unpriced_requests: Number(row?.unpriced_requests ?? 0),
      total_requests: Number(row?.total_requests ?? 0),
      total_input_tokens: Number(row?.total_input_tokens ?? 0),
      total_output_tokens: Number(row?.total_output_tokens ?? 0),
      total_cache_creation_input_tokens: Number(row?.total_cache_creation_input_tokens ?? 0),
      total_cache_read_input_tokens: Number(row?.total_cache_read_input_tokens ?? 0),
    };
  }

  getUserReport(query: UserLlmUsageReportQuery): UserLlmUsageReport {
    const from = usageInteger(query.from);
    const to = usageInteger(query.to);
    if (!(to > from)) throw new UsageControlsValidationError("to must be greater than from");
    const limit = Math.min(1000, Math.max(1, usageInteger(query.limit) || 100));
    const requestedUserId = usageText(query.user_id);
    const cursorValue = query.cursor ? decodeCursor(query.cursor) : undefined;
    const subjects = this.subjectPage(from, to, limit + 1, requestedUserId || null, cursorValue);
    const pageSubjects = subjects.slice(0, limit);
    const hasMore = subjects.length > limit;
    const userIds = pageSubjects.filter((subject) => subject.userId !== null).map((subject) => subject.userId as string);
    const includeUnattributed = pageSubjects.some((subject) => subject.userId === null);
    const totals = this.reportTotals(from, to, userIds, includeUnattributed);
    const models = this.reportModels(from, to, userIds, includeUnattributed);
    const evaluatedAt = usageInteger(query.now_ms) || Date.now();
    const limitStatuses = this.limitStatusesForUsers(userIds, evaluatedAt);
    const users: UserLlmUsageSubject[] = pageSubjects.map((subject) => {
      const key = subject.userId ?? "";
      const access = subject.userId === null
        ? { allowed: true, reason: "no_limits" as const, blocking_limit: null, limits: [] }
        : limitStatuses.get(subject.userId) ??
          { allowed: true, reason: "no_limits" as const, blocking_limit: null, limits: [] };
      const status = {
        allowed: access.allowed,
        reason: access.reason,
        blocking_limit: access.blocking_limit,
        limits: access.limits,
      };
      return {
        user_id: subject.userId,
        membership_status: subject.status,
        totals: totals.get(key) ?? { ...EMPTY_TOTALS },
        models: models.get(key) ?? [],
        limit_status: status,
      };
    });
    const last = pageSubjects.at(-1)?.userId;
    return {
      org_id: this.context.orgId(), from_ms: from, to_ms: to, evaluated_at_ms: evaluatedAt,
      users, count: users.length, has_more: hasMore,
      next_cursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    };
  }

  private loadLimitRows(userId: string): LimitRow[] {
    if (!userId) return [];
    return this.context.sql.exec<LimitRow>(
      `SELECT user_id, window_ms, limit_microusd, label
         FROM user_llm_usage_limits WHERE user_id = ? ORDER BY window_ms`,
      userId,
    ).toArray();
  }

  private limitStatusesForUsers(userIds: string[], now: number): Map<string, UserLlmUsageAccessResult> {
    const normalizedUserIds = Array.from(new Set(userIds.map(usageText).filter(Boolean)));
    const results = new Map<string, UserLlmUsageAccessResult>(normalizedUserIds.map((userId) => [userId, {
      allowed: true,
      reason: "no_limits",
      evaluated_at_ms: now,
      blocking_limit: null,
      limits: [],
    }]));
    if (normalizedUserIds.length === 0) return results;

    const encodedUserIds = JSON.stringify(normalizedUserIds);
    const limits = this.context.sql.exec<LimitRow>(
      `SELECT user_id, window_ms, limit_microusd, label
         FROM user_llm_usage_limits
        WHERE user_id IN (SELECT value FROM json_each(?))
        ORDER BY user_id COLLATE BINARY, window_ms`,
      encodedUserIds,
    ).toArray();
    if (limits.length === 0) return results;

    const aggregates = this.context.sql.exec<LimitAggregateRow>(
      `SELECT limits.user_id, limits.window_ms,
              COALESCE(SUM(usage.metered_cost_microusd), 0) AS spent,
              COALESCE(SUM(CASE WHEN usage.id IS NOT NULL AND usage.metered_cost_microusd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced
         FROM user_llm_usage_limits AS limits
         LEFT JOIN usage_log AS usage
           ON usage.user_id = limits.user_id
          AND usage.usage_kind = 'llm'
          AND usage.created_at_ms >= ? - limits.window_ms
          AND usage.created_at_ms < ?
        WHERE limits.user_id IN (SELECT value FROM json_each(?))
        GROUP BY limits.user_id, limits.window_ms`,
      now, now, encodedUserIds,
    ).toArray();
    const aggregatesByLimit = new Map(aggregates.map((row) => [
      `${row.user_id}\0${row.window_ms}`,
      { spent: Number(row.spent ?? 0), unpriced: Number(row.unpriced ?? 0) },
    ]));
    const statusesByUser = new Map<string, UserLlmUsageLimitStatus[]>();
    const statusByLimit = new Map<string, UserLlmUsageLimitStatus>();
    const blocked: Array<{
      user_id: string;
      window_ms: number;
      spent_microusd: number;
      limit_microusd: number;
    }> = [];
    for (const row of limits) {
      const key = `${row.user_id}\0${row.window_ms}`;
      const aggregate = aggregatesByLimit.get(key) ?? { spent: 0, unpriced: 0 };
      const limit = Number(row.limit_microusd);
      const status: UserLlmUsageLimitStatus = {
        ...limitDto(row),
        spent_usd: microusdToUsd(aggregate.spent),
        remaining_usd: microusdToUsd(Math.max(0, limit - aggregate.spent)),
        unpriced_requests: aggregate.unpriced,
        exceeded: aggregate.spent >= limit,
        retry_at_ms: null,
      };
      const list = statusesByUser.get(row.user_id) ?? [];
      list.push(status);
      statusesByUser.set(row.user_id, list);
      statusByLimit.set(key, status);
      if (status.exceeded && status.unpriced_requests === 0) {
        blocked.push({
          user_id: row.user_id,
          window_ms: Number(row.window_ms),
          spent_microusd: aggregate.spent,
          limit_microusd: limit,
        });
      }
    }

    if (blocked.length > 0) {
      const expiryRows = this.context.sql.exec<LimitExpiryRow>(
        `WITH blocked AS (
           SELECT json_extract(value, '$.user_id') AS user_id,
                  CAST(json_extract(value, '$.window_ms') AS INTEGER) AS window_ms,
                  CAST(json_extract(value, '$.spent_microusd') AS INTEGER) AS spent_microusd,
                  CAST(json_extract(value, '$.limit_microusd') AS INTEGER) AS limit_microusd
             FROM json_each(?)
         ), expiry_candidates AS (
           SELECT blocked.user_id, blocked.window_ms, blocked.spent_microusd,
                  blocked.limit_microusd, usage.created_at_ms,
                  SUM(usage.metered_cost_microusd) OVER (
                    PARTITION BY blocked.user_id, blocked.window_ms
                    ORDER BY usage.created_at_ms, usage.id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS expired_microusd
             FROM blocked
             JOIN usage_log AS usage
               ON usage.user_id = blocked.user_id
              AND usage.usage_kind = 'llm'
              AND usage.metered_cost_microusd IS NOT NULL
              AND usage.created_at_ms >= ? - blocked.window_ms
              AND usage.created_at_ms < ?
         )
         SELECT user_id, window_ms, MIN(created_at_ms + window_ms + 1) AS retry_at_ms
           FROM expiry_candidates
          WHERE spent_microusd - expired_microusd < limit_microusd
          GROUP BY user_id, window_ms`,
        JSON.stringify(blocked), now, now,
      ).toArray();
      for (const row of expiryRows) {
        const key = `${row.user_id}\0${row.window_ms}`;
        const status = statusByLimit.get(key);
        if (status) status.retry_at_ms = Number(row.retry_at_ms);
      }
    }

    for (const userId of normalizedUserIds) {
      const statuses = statusesByUser.get(userId) ?? [];
      if (statuses.length === 0) continue;
      const unpriced = statuses.find((status) => status.unpriced_requests > 0) ?? null;
      const exceeded = statuses
        .filter((status) => status.exceeded)
        .reduce<UserLlmUsageLimitStatus | null>((blocking, candidate) => {
          if (!blocking) return candidate;
          // A null retry means configuration must change (for example a zero
          // cap with no rows to age out), so it dominates any finite expiry.
          if (blocking.retry_at_ms === null) return blocking;
          if (candidate.retry_at_ms === null) return candidate;
          return candidate.retry_at_ms > blocking.retry_at_ms ? candidate : blocking;
        }, null);
      results.set(userId, {
        allowed: !unpriced && !exceeded,
        reason: unpriced ? "pricing_unavailable" : exceeded ? "limit_exceeded" : "within_limits",
        evaluated_at_ms: now,
        blocking_limit: unpriced ?? exceeded,
        limits: statuses,
      });
    }
    return results;
  }

  private filterWhere(query: UsageAggregateQuery, from: number, to: number): { where: string[]; params: Array<string | number> } {
    const where = ["created_at_ms >= ?", "created_at_ms < ?"];
    const params: Array<string | number> = [from, to];
    const exact: Array<[string, unknown]> = [
      ["user_id", query.user_id], ["provider", query.provider], ["model", query.model],
      ["usage_kind", query.usage_kind], ["usage_surface", query.usage_surface],
    ];
    for (const [column, value] of exact) {
      if (typeof value === "string") { where.push(`${column} = ?`); params.push(value.trim()); }
    }
    if (query.chargeable_only === true || query.chargeable_only === 1) where.push("credit_chargeable = 1");
    return { where, params };
  }

  private subjectPage(from: number, to: number, limit: number, requestedUserId: string | null, cursor: string | null | undefined): Array<{ userId: string | null; status: "current" | "former" | "unattributed" }> {
    const rows = this.context.sql.exec<{ user_id: string; current_member: number } & Record<string, SqlStorageValue>>(
      `WITH subjects(user_id) AS (
         SELECT user_id FROM members
         UNION
         SELECT DISTINCT user_id FROM usage_log
          WHERE usage_kind = 'llm' AND created_at_ms >= ? AND created_at_ms < ?
       )
       SELECT subjects.user_id, CASE WHEN members.user_id IS NULL THEN 0 ELSE 1 END AS current_member
         FROM subjects LEFT JOIN members ON members.user_id = subjects.user_id
        WHERE (? = '' OR subjects.user_id = ?)
          AND (${cursor === undefined ? "1 = 1" : cursor === null ? "subjects.user_id != ''" : "subjects.user_id > ?"})
        ORDER BY CASE WHEN subjects.user_id = '' THEN 0 ELSE 1 END, subjects.user_id COLLATE BINARY
        LIMIT ?`,
      from, to, requestedUserId ?? "", requestedUserId ?? "",
      ...(cursor !== undefined && cursor !== null ? [cursor] : []), limit,
    ).toArray();
    return rows.map((row) => ({
      userId: row.user_id === "" ? null : String(row.user_id),
      status: row.user_id === "" ? "unattributed" : Number(row.current_member) === 1 ? "current" : "former",
    }));
  }

  private reportTotals(from: number, to: number, userIds: string[], unattributed: boolean): Map<string, UserLlmUsageTotals> {
    const clauses: string[] = [];
    const params: Array<string | number> = [from, to];
    if (userIds.length) { clauses.push("user_id IN (SELECT value FROM json_each(?))"); params.push(JSON.stringify(userIds)); }
    if (unattributed) clauses.push("user_id = ''");
    if (!clauses.length) return new Map();
    const rows = this.context.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT user_id, COUNT(*) AS requests, COALESCE(SUM(metered_cost_microusd), 0) AS spend_microusd,
              SUM(CASE WHEN metered_cost_microusd IS NULL THEN 1 ELSE 0 END) AS unpriced_requests,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
              COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens
         FROM usage_log WHERE usage_kind = 'llm' AND created_at_ms >= ? AND created_at_ms < ?
          AND (${clauses.join(" OR ")}) GROUP BY user_id`, ...params,
    ).toArray();
    return new Map(rows.map((row) => [String(row.user_id ?? ""), totalsFromRow(row)]));
  }

  private reportModels(from: number, to: number, userIds: string[], unattributed: boolean): Map<string, UserLlmUsageModelTotals[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [from, to];
    if (userIds.length) { clauses.push("user_id IN (SELECT value FROM json_each(?))"); params.push(JSON.stringify(userIds)); }
    if (unattributed) clauses.push("user_id = ''");
    if (!clauses.length) return new Map();
    const rows = this.context.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT user_id, provider, model, COUNT(*) AS requests,
              COALESCE(SUM(metered_cost_microusd), 0) AS spend_microusd,
              SUM(CASE WHEN metered_cost_microusd IS NULL THEN 1 ELSE 0 END) AS unpriced_requests,
              COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
              COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens
         FROM usage_log WHERE usage_kind = 'llm' AND created_at_ms >= ? AND created_at_ms < ?
          AND (${clauses.join(" OR ")}) GROUP BY user_id, provider, model
          ORDER BY user_id COLLATE BINARY, provider COLLATE BINARY, model COLLATE BINARY`, ...params,
    ).toArray();
    const result = new Map<string, UserLlmUsageModelTotals[]>();
    for (const row of rows) {
      const key = String(row.user_id ?? "");
      const list = result.get(key) ?? [];
      list.push({ provider: String(row.provider), model: String(row.model), ...totalsFromRow(row) });
      result.set(key, list);
    }
    return result;
  }
}
