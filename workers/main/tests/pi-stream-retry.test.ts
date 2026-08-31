import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createPiProviderStreamErrorMessage,
  isBedrockRegionUnavailableError,
  streamPiModelWithTransientRetry,
} from "../src/chat-thread/pi-stream-retry";

const model = {
  id: "openai.gpt-5.6-terra",
  provider: "custom",
  api: "openai-responses",
  baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
} as any;

function errorStream(message: string, usage?: Partial<ReturnType<typeof createPiProviderStreamErrorMessage>["usage"]>) {
  const stream = createAssistantMessageEventStream();
  const error = createPiProviderStreamErrorMessage(model, message, "error");
  error.usage = {
    ...error.usage,
    ...usage,
    cost: { ...error.usage.cost, ...usage?.cost },
  };
  stream.push({
    type: "error",
    reason: "error",
    error,
  });
  stream.end();
  return stream;
}

function successStream(usage?: Partial<ReturnType<typeof createPiProviderStreamErrorMessage>["usage"]>) {
  const stream = createAssistantMessageEventStream();
  const message = createPiProviderStreamErrorMessage(model, "", "error");
  message.stopReason = "stop";
  delete message.errorMessage;
  message.usage = {
    ...message.usage,
    ...usage,
    cost: { ...message.usage.cost, ...usage?.cost },
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
}

describe("Pi provider stream regional retry", () => {
  it("retries a Bedrock model-not-found error before forwarding output", async () => {
    const createStream = vi
      .fn()
      .mockImplementationOnce(() =>
        errorStream(
          '404 {"error":{"type":"not_found_error","message":"The model does not exist"}}',
        ),
      )
      .mockImplementationOnce(successStream);
    const onRetry = vi.fn();
    const output = streamPiModelWithTransientRetry(
      model,
      {},
      createStream,
      vi.fn(),
      {
        isRetryableError: isBedrockRegionUnavailableError,
        onRetry,
      },
    );

    const events = [];
    for await (const event of output) events.push(event);

    expect(createStream).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  it("does not retry an authentication error", async () => {
    const createStream = vi.fn(() => errorStream("401 authentication_error"));
    const output = streamPiModelWithTransientRetry(
      model,
      {},
      createStream,
      vi.fn(),
      { isRetryableError: isBedrockRegionUnavailableError },
    );

    const events = [];
    for await (const event of output) events.push(event);

    expect(createStream).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });

  it("merges hidden failed-attempt usage into the one logical completion", async () => {
    const createStream = vi
      .fn()
      .mockImplementationOnce(() => errorStream("network connection lost", {
        input: 100,
        cacheRead: 40,
        totalTokens: 140,
        cost: { input: 0.1, output: 0, cacheRead: 0.02, cacheWrite: 0, total: 0.12 },
      }))
      .mockImplementationOnce(() => successStream({
        input: 20,
        output: 5,
        totalTokens: 25,
        cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      }));
    const output = streamPiModelWithTransientRetry(model, {}, createStream, vi.fn());

    const events = [];
    for await (const event of output) events.push(event);

    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    const done = events.find((event) => event.type === "done");
    expect(done?.message.usage).toMatchObject({
      input: 120,
      output: 5,
      cacheRead: 40,
      totalTokens: 165,
    });
    expect(done?.message.usage.cost.input).toBeCloseTo(0.12);
    expect(done?.message.usage.cost.output).toBeCloseTo(0.01);
    expect(done?.message.usage.cost.cacheRead).toBeCloseTo(0.02);
    expect(done?.message.usage.cost.total).toBeCloseTo(0.15);
  });

  it("preserves hidden usage when a later attempt throws", async () => {
    const createStream = vi
      .fn()
      .mockImplementationOnce(() => errorStream("network connection lost", {
        input: 100,
        cacheRead: 40,
        totalTokens: 140,
      }))
      .mockImplementationOnce(() => {
        throw new Error("401 authentication_error");
      });
    const output = streamPiModelWithTransientRetry(model, {}, createStream, vi.fn());

    const events = [];
    for await (const event of output) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { usage: { input: 100, cacheRead: 40, totalTokens: 140 } },
    });
  });

  it("preserves hidden failed-attempt usage when cancellation interrupts backoff", async () => {
    const controller = new AbortController();
    const output = streamPiModelWithTransientRetry(
      model,
      { signal: controller.signal },
      () => errorStream("network connection lost", {
        input: 100,
        cacheRead: 40,
        totalTokens: 140,
        cost: { input: 0.1, output: 0, cacheRead: 0.02, cacheWrite: 0, total: 0.12 },
      }),
      vi.fn(),
      { onRetry: () => controller.abort() },
    );

    const events = [];
    for await (const event of output) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      reason: "aborted",
      error: { usage: { input: 100, cacheRead: 40, totalTokens: 140, cost: { total: 0.12 } } },
    });
  });
});
