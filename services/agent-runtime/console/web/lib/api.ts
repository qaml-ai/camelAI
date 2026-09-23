import { useCallback, useEffect, useState } from "react";

/** The console uses the same /v1 API as scripts; its session cookie authenticates it. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const response = await fetch(path, {
    method, credentials: "same-origin",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      // Required for any cookie-authenticated write; cross-site pages cannot send it.
      ...(method !== "GET" ? { "X-Agent-Runtime-Console": "1" } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let value: any = undefined;
  try { value = text ? JSON.parse(text) : undefined; } catch { value = text; }
  if (!response.ok) throw new ApiError(response.status, value?.error ?? `HTTP ${response.status}`);
  return value as T;
}

export function useApi<T>(path: string | undefined, intervalMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await api<T>(path)); setError(undefined); }
    catch (caught) { setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught))); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => {
    setLoading(!!path);
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs, path]);
  return { data, error, loading, reload };
}

export interface Me { tenant: string; via: "operator" | "token" | "console"; login?: string; canStoreKeys: boolean }
export interface KeyStatus { provider: string; source: "tenant" | "admin"; last4?: string; setAt?: number }
export interface Provider { id: string; models: number; apiKey: boolean; requires?: string; key: KeyStatus | null }
export interface Model {
  id: string; provider: string; modelId: string; name: string; api: string; reasoning: boolean; input: string[];
  contextWindow: number; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; available: boolean;
}
export interface AgentSummary { id: string; name: string; type: string; model: string; connected: boolean; running: boolean; expiresAt: number }
export interface RequestRecord {
  id: string; method: string; state: "running" | "completed"; startedAt?: number; endedAt?: number; prompt?: string;
  outcome?: { result?: unknown; error?: string; uncertain?: boolean };
}
export interface AgentDetail extends AgentSummary {
  tools: { name: string; description: string }[]; systemPrompt: string; requests: RequestRecord[];
  calls: { id: string; name: string; state: string; createdAt?: number; outcome?: { error?: string; uncertain?: boolean } }[];
}
export interface ApiToken { id: string; name: string; prefix: string; createdAt: number }
export interface Usage {
  since: number;
  totals: { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  days: { day: string; model: string; responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }[];
}

export const formatNumber = (value: number) => new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
export const formatCost = (value: number) => `$${value === 0 || value >= 1 ? value.toFixed(2) : value.toFixed(4)}`;
export const formatTime = (value?: number) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
