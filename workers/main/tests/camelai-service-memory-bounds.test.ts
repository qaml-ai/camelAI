import { describe, expect, it, vi } from "vitest";

import {
  CAMELAI_MOUNTED_AUDIO_MAX_BYTES,
  CamelAiService,
} from "../src/camelai-service";

type MountedAudioReader = {
  readMountedAudioObject(
    this: { env: { R2_BUCKET: { get(key: string): Promise<unknown> } }; ctx: { props: { orgId: string; workspaceId: string } } },
    path: string,
  ): Promise<ArrayBuffer>;
};

const readMountedAudioObject = (
  CamelAiService.prototype as unknown as MountedAudioReader
).readMountedAudioObject;

function serviceWith(object: unknown) {
  return {
    env: { R2_BUCKET: { get: vi.fn(async () => object) } },
    ctx: { props: { orgId: "org-memory", workspaceId: "workspace-memory" } },
  };
}

describe("CamelAiService mounted-audio memory bounds", () => {
  it("cancels an oversized R2 body before materializing it", async () => {
    const cancel = vi.fn(async () => undefined);
    const arrayBuffer = vi.fn();
    const service = serviceWith({
      size: CAMELAI_MOUNTED_AUDIO_MAX_BYTES + 1,
      body: { cancel },
      arrayBuffer,
    });

    await expect(
      readMountedAudioObject.call(service, "uploads/large.wav"),
    ).rejects.toThrow(`${CAMELAI_MOUNTED_AUDIO_MAX_BYTES} byte whole-buffer limit`);
    expect(cancel).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects an R2 object whose bytes change after admission", async () => {
    const service = serviceWith({
      size: 3,
      body: { cancel: vi.fn() },
      arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3, 4]).buffer),
    });

    await expect(
      readMountedAudioObject.call(service, "outputs/audio.wav"),
    ).rejects.toThrow("Mounted audio size changed while it was read");
  });
});
