import { describe, expect, it } from "vitest";
import {
  isModelVisibleForChatRuntime,
  resolveAgentFallbackOptimisticModel,
  resolveSelectedThreadModel,
  shouldIgnoreOlderThreadModelUpdate,
  shouldIgnoreStaleThreadModelResult,
} from "@/components/Chat";
import type { ModelCatalogEntry } from "@/lib/model-catalog";

const visibleCatalog = [
  { id: "deepseek-v4-auto" },
  { id: "sonnet" },
] as ModelCatalogEntry[];

describe("new-chat selected model", () => {
  it("never exposes camelCode in the self-host chat runtime", () => {
    expect(
      isModelVisibleForChatRuntime("deepseek-v4-auto", "selfhost"),
    ).toBe(false);
    expect(isModelVisibleForChatRuntime("sonnet", "selfhost")).toBe(true);
    expect(
      isModelVisibleForChatRuntime("deepseek-v4-auto", "camel_free"),
    ).toBe(true);
  });

  it("holds a recent Agent-state fallback over a stale loader model", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    expect(
      resolveAgentFallbackOptimisticModel({
        threadId: "thread_123",
        model: "deepseek-v4-auto",
        notice: {
          id: "fallback_123",
          fromModel: "gemini-3-flash-preview",
          toModel: "deepseek-v4-auto",
          reason: "hosted_credits_exhausted",
          createdAt: now - 1_000,
        },
        now,
      }),
    ).toEqual({ threadId: "thread_123", model: "deepseek-v4-auto" });
  });

  it("ignores a stale model-update result after an authoritative fallback", () => {
    expect(
      shouldIgnoreStaleThreadModelResult({
        threadId: "thread_123",
        nextModel: "gemini-3-flash-preview",
        optimistic: {
          threadId: "thread_123",
          model: "deepseek-v4-auto",
        },
      }),
    ).toBe(true);
    expect(
      shouldIgnoreStaleThreadModelResult({
        threadId: "thread_123",
        nextModel: "deepseek-v4-auto",
        optimistic: {
          threadId: "thread_123",
          model: "deepseek-v4-auto",
        },
      }),
    ).toBe(false);
  });

  it("orders conflicting model updates behind the authoritative fallback", () => {
    const authoritative = {
      threadId: "thread_123",
      model: "deepseek-v4-auto" as const,
      updatedAt: 200,
    };
    expect(
      shouldIgnoreOlderThreadModelUpdate({
        threadId: "thread_123",
        nextModel: "gemini-3-flash-preview",
        nextUpdatedAt: 100,
        authoritative,
      }),
    ).toBe(true);
    expect(
      shouldIgnoreOlderThreadModelUpdate({
        threadId: "thread_123",
        nextModel: "gemini-3-flash-preview",
        nextUpdatedAt: 300,
        authoritative,
      }),
    ).toBe(false);
  });

  it("keeps the loader-selected camelCode model instead of the platform default", () => {
    expect(
      resolveSelectedThreadModel({
        threadModel: "deepseek-v4-auto",
        allowedThreadModels: ["deepseek-v4-auto", "sonnet"],
        llmProvider: null,
        availableThreadModels: visibleCatalog,
        effectivePickerDefaultModel: null,
        hasEffectivePickerDefault: false,
      }),
    ).toBe("deepseek-v4-auto");
  });

  it("still honors an available recent model when billing did not force camelCode", () => {
    expect(
      resolveSelectedThreadModel({
        threadModel: "sonnet",
        allowedThreadModels: ["deepseek-v4-auto", "sonnet"],
        llmProvider: null,
        availableThreadModels: visibleCatalog,
        effectivePickerDefaultModel: null,
        hasEffectivePickerDefault: false,
        recentModel: "deepseek-v4-auto",
      }),
    ).toBe("deepseek-v4-auto");
  });
});
