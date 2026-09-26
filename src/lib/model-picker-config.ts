import type {
  LlmModel,
  ModelPickerModelConfig,
  OrgModelPickerConfig,
  WorkspaceModelPickerConfig,
} from "../types";
import {
  resolveStoredLlmModel,
} from "./llm-provider-config";

export interface EffectiveModelPickerConfig extends OrgModelPickerConfig {
  source: "org" | "workspace";
}

export interface ModelIdEntry {
  id: LlmModel;
}

function parseMaybeJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeModelRows(raw: unknown): ModelPickerModelConfig[] {
  if (!Array.isArray(raw)) return [];

  const now = Date.now();
  const seen = new Set<LlmModel>();
  const rows: ModelPickerModelConfig[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id = resolveStoredLlmModel(record.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const addedAt =
      typeof record.added_at === "number" && Number.isFinite(record.added_at)
        ? record.added_at
        : now;
    rows.push({ id, added_at: addedAt });
  }

  return rows;
}

function normalizeDefaultModel(raw: unknown): LlmModel | null {
  return resolveStoredLlmModel(raw);
}

export function defaultOrgModelPickerConfig(..._unused: unknown[]): OrgModelPickerConfig {
  return {
    use_platform_defaults: true,
    default_model: null,
    models: [],
  };
}

export function defaultWorkspaceModelPickerConfig(): WorkspaceModelPickerConfig {
  return {
    use_org_defaults: true,
    use_platform_defaults: true,
    models: [],
    default_model: null,
  };
}

export function parseOrgModelPickerConfig(
  raw: unknown,
  _orgProvider?: unknown,
  _options?: unknown,
): OrgModelPickerConfig {
  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return defaultOrgModelPickerConfig();
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.use_platform_defaults !== "boolean") {
    return defaultOrgModelPickerConfig();
  }
  if (!Array.isArray(record.models)) {
    return defaultOrgModelPickerConfig();
  }

  const usePlatformDefaults = record.use_platform_defaults !== false;
  const models = normalizeModelRows(record.models);
  return {
    use_platform_defaults: usePlatformDefaults,
    models,
    default_model: normalizeDefaultModel(record.default_model),
  };
}

export function parseWorkspaceModelPickerConfig(
  raw: unknown,
): WorkspaceModelPickerConfig {
  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return defaultWorkspaceModelPickerConfig();
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.use_platform_defaults !== "boolean") {
    return {
      ...defaultWorkspaceModelPickerConfig(),
      use_org_defaults: record.use_org_defaults !== false,
    };
  }
  const usePlatformDefaults = record.use_platform_defaults !== false;
  const models = normalizeModelRows(record.models);
  return {
    use_org_defaults: record.use_org_defaults !== false,
    use_platform_defaults: usePlatformDefaults,
    models,
    default_model: normalizeDefaultModel(record.default_model),
  };
}

export function resolveEffectivePickerConfig(
  org: OrgModelPickerConfig,
  workspace: WorkspaceModelPickerConfig | null | undefined,
): EffectiveModelPickerConfig {
  if (!workspace || workspace.use_org_defaults) {
    return {
      ...org,
      default_model:
        org.use_platform_defaults === false ? org.default_model : null,
      source: "org",
    };
  }

  return {
    use_platform_defaults: workspace.use_platform_defaults,
    models: workspace.models,
    default_model:
      workspace.use_platform_defaults === false
        ? workspace.default_model
        : null,
    source: "workspace",
  };
}

export function resolveDefaultModelForChat(args: {
  effectiveDefaultModel: LlmModel | null;
  visibleCatalog: ReadonlyArray<ModelIdEntry>;
  recentModel?: LlmModel | null;
  fallbackModel?: LlmModel | null;
}): LlmModel | null {
  const visibleIds = new Set(args.visibleCatalog.map((entry) => entry.id));

  if (
    args.effectiveDefaultModel &&
    visibleIds.has(args.effectiveDefaultModel)
  ) {
    return args.effectiveDefaultModel;
  }

  if (args.recentModel && visibleIds.has(args.recentModel)) {
    return args.recentModel;
  }

  if (args.fallbackModel && visibleIds.has(args.fallbackModel)) {
    return args.fallbackModel;
  }

  return args.visibleCatalog[0]?.id ?? null;
}
