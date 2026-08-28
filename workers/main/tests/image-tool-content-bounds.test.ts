import { describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  inlineImageMaxBase64Chars,
  prepareInlineImageFromStream,
  readImageSniffBytesAndReplayStream,
  readStreamBytes,
} from "../src/image-tool-content";

describe("bounded stream reads", () => {
  it("cancels as soon as a stream crosses its byte limit", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8));
      },
      cancel,
    });

    await expect(readStreamBytes(stream, 15)).rejects.toThrow(
      "Stream exceeds 15 byte limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("returns a stream exactly at the byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });

    expect(await readStreamBytes(stream, 3)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("terminates a byte stream that never makes progress", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array());
      },
      cancel,
    });

    await expect(readStreamBytes(stream, 10)).rejects.toThrow(
      "Stream exceeds chunk limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.streamReadChunks + 2);
  });

  it("terminates image sniffing that never makes progress", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array());
      },
      cancel,
    });

    await expect(readImageSniffBytesAndReplayStream(stream)).rejects.toThrow(
      "Stream exceeds chunk limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels every failed image candidate before opening its retry stream", async () => {
    const cancelled: number[] = [];
    const retrySawPriorCancellation: boolean[] = [];
    let nextCandidate = 1;
    const candidateStream = (id: number) => new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.push(id);
      },
    });
    const images = {
      input: vi.fn(() => {
        throw new Error("transform rejected before consuming input");
      }),
    };

    await expect(prepareInlineImageFromStream(
      candidateStream(0),
      "image/png",
      images as never,
      {
        createRetryStream: async () => {
          retrySawPriorCancellation.push(cancelled.length === nextCandidate);
          return candidateStream(nextCandidate++);
        },
      },
    )).resolves.toBeNull();

    expect(images.input).toHaveBeenCalledTimes(12);
    expect(cancelled).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(retrySawPriorCancellation).toHaveLength(11);
    expect(retrySawPriorCancellation.every(Boolean)).toBe(true);
  });

  it("rejects one oversized base64 chunk before decoding a second string", async () => {
    const outputCancel = vi.fn();
    const output = vi.fn(async () => ({
      contentType: () => "image/png",
      image: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array(inlineImageMaxBase64Chars() + 1).fill(65),
          );
        },
        cancel: outputCancel,
      }),
    }));
    const images = {
      input: () => ({ transform: () => ({ output }), output }),
    };

    await expect(prepareInlineImageFromStream(
      new ReadableStream<Uint8Array>(),
      "image/png",
      images as never,
    )).resolves.toBeNull();
    expect(outputCancel).toHaveBeenCalledOnce();
  });
});
