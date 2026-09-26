import { describe, expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

import {
  OpenAiRequestError,
  openAiRequestToPiContext,
  piEventsToOpenAiSse,
  reasoningDetails,
} from "../src/agent-runtime/openai-bridge";

const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, reasoning: 2, totalTokens: 135, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
  return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude", usage, stopReason, timestamp: 1 };
}

async function* replay(events: AssistantMessageEvent[]) {
  for (const event of events) yield event;
}

async function frames(stream: ReadableStream<Uint8Array>) {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter(Boolean).map((frame) => frame.replace(/^data: /, "")).map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

describe("openAiRequestToPiContext", () => {
  it("maps system, user (text and images), assistant tool calls and tool results", () => {
    const context = openAiRequestToPiContext({
      model: "chiridion",
      messages: [
        { role: "system", content: "You are camelAI." },
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "camel__read", arguments: "{\"path\":\"a\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file body" },
      ],
      tools: [{ type: "function", function: { name: "camel__read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    });
    expect(context.systemPrompt).toBe("You are camelAI.");
    expect(context.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "AAAA" }] });
    expect(context.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "checking" }, { type: "toolCall", id: "call_1", name: "camel__read", arguments: { path: "a" } }],
      stopReason: "toolUse",
    });
    expect(context.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call_1", toolName: "camel__read", content: [{ type: "text", text: "file body" }] });
    expect(context.tools).toEqual([{ name: "camel__read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }]);
  });

  it("refuses remote image URLs and unknown roles", () => {
    expect(() => openAiRequestToPiContext({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] }))
      .toThrow(OpenAiRequestError);
    expect(() => openAiRequestToPiContext({ messages: [{ role: "function", content: "x" }] })).toThrow(OpenAiRequestError);
  });

  it("restores thinking signatures that went out as reasoning_details", () => {
    const final = assistant([
      { type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
      { type: "text", text: "ok" },
      { type: "toolCall", id: "call_1", name: "t", arguments: {}, thoughtSignature: "gem-1" },
      { type: "toolCall", id: "call_2", name: "t", arguments: {} },
    ]);
    const details = reasoningDetails(final);
    expect(details).toHaveLength(1);
    // What Pi's openai-completions client sends back on the next request.
    const context = openAiRequestToPiContext({
      messages: [{
        role: "assistant",
        content: "ok",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "t", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "t", arguments: "{}" } },
        ],
        reasoning_details: details,
      }],
    });
    expect(context.messages[0]).toMatchObject({
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig-1" },
        { type: "text", text: "ok" },
        { type: "toolCall", id: "call_1", thoughtSignature: "gem-1" },
        { type: "toolCall", id: "call_2" },
      ],
    });
  });
});

describe("piEventsToOpenAiSse", () => {
  it("streams text, reasoning and tool calls, then signatures, finish reason and usage", async () => {
    const toolCall = { type: "toolCall" as const, id: "call_1", name: "camel__ls", arguments: {} };
    const final = assistant([{ type: "thinking", thinking: "hm", thinkingSignature: "sig" }, { type: "text", text: "Hi" }, toolCall]);
    const partial = assistant([{ type: "thinking", thinking: "" }, { type: "text", text: "" }, toolCall]);
    let recorded: AssistantMessage | null = null;
    const output = await frames(piEventsToOpenAiSse(replay([
      { type: "start", partial },
      { type: "thinking_delta", contentIndex: 0, delta: "hm", partial },
      { type: "text_delta", contentIndex: 1, delta: "Hi", partial },
      { type: "toolcall_start", contentIndex: 2, partial },
      { type: "toolcall_delta", contentIndex: 2, delta: "{}", partial },
      { type: "done", reason: "toolUse", message: final },
    ]), { id: "chatcmpl-1", model: "m", onFinal: (message) => { recorded = message; } }));
    const deltas = output.filter((frame) => frame !== "[DONE]").map((frame) => frame.choices?.[0]?.delta);
    expect(deltas).toContainEqual({ reasoning_content: "hm" });
    expect(deltas).toContainEqual({ content: "Hi" });
    expect(deltas).toContainEqual({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "camel__ls", arguments: "" } }] });
    expect(deltas).toContainEqual({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] });
    expect(deltas.find((delta) => delta?.reasoning_details)?.reasoning_details).toHaveLength(1);
    const last = output[output.length - 2];
    expect(last.choices[0].finish_reason).toBe("tool_calls");
    expect(last.usage).toEqual({
      prompt_tokens: 130, completion_tokens: 5, total_tokens: 135,
      prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    expect(output[output.length - 1]).toBe("[DONE]");
    expect(recorded).toBe(final);
  });

  it("ends a failed response with an error frame", async () => {
    const failed = { ...assistant([], "error"), errorMessage: "overloaded" };
    const output = await frames(piEventsToOpenAiSse(replay([{ type: "error", reason: "error", error: failed }]), { id: "x", model: "m" }));
    expect(output).toContainEqual({ error: { message: "overloaded", type: "provider_error" } });
  });
});
