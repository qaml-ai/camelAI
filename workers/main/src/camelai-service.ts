import { WorkerEntrypoint } from "cloudflare:workers";
import {
  executeVirtualAiRun,
  type AIVirtualBindingEnv,
  type AIVirtualBindingProps,
} from "./ai-virtual-binding.js";
import {
  generateImage,
  type GenerateImageOptions,
  type GenerateImageResult,
} from "./generate-image.js";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths.js";
import {
  transcribeAudioBase64,
  transcribeAudioBytes,
  type AudioTranscriptionResult,
} from "./audio-transcription.js";

export type CamelAiServiceProps = AIVirtualBindingProps;
export type TranscribeAudioInput =
  | string
  | {
      audio?: string;
      base64?: string;
      data?: string;
      path?: string;
    };

/**
 * Virtual service binding for camelAI helpers (image generation).
 *
 * User workers bind `CAMELAI` as a service; cf-api-proxy rewrites the starter
 * `LocalCamelAiService` entrypoint to this class with workspace/org props.
 */
export class CamelAiService extends WorkerEntrypoint<
  AIVirtualBindingEnv,
  CamelAiServiceProps
> {
  async generateImage(
    input: string | GenerateImageOptions,
  ): Promise<GenerateImageResult> {
    return generateImage(
      {
        run: (model, runInput) =>
          executeVirtualAiRun(
            {
              env: this.env,
              props: this.ctx.props,
              waitUntil: (promise) => this.ctx.waitUntil(promise),
            },
            model,
            runInput,
          ),
      },
      input,
    );
  }

  async transcribeAudio(
    input: TranscribeAudioInput,
  ): Promise<AudioTranscriptionResult> {
    const ai = this.env.AI;
    if (!ai) {
      throw new Error("Audio transcription is not configured");
    }

    const path = typeof input === "object" && input !== null
      ? input.path?.trim()
      : "";
    if (path) {
      const object = await this.readMountedAudioObject(path);
      return transcribeAudioBytes(ai, object);
    }

    const audio = typeof input === "string"
      ? input
      : input?.audio || input?.base64 || input?.data || "";
    return transcribeAudioBase64(ai, audio);
  }

  private async readMountedAudioObject(path: string): Promise<ArrayBuffer> {
    const bucket = this.env.R2_BUCKET;
    if (!bucket) {
      throw new Error("Workspace file storage is not configured");
    }
    const resolved = resolveMountedAudioPath(path);
    if (!resolved) {
      throw new Error(
        "path must start with uploads/ or outputs/",
      );
    }
    const object = await bucket.get(
      buildWorkspaceScopedR2Key(
        this.ctx.props.orgId,
        this.ctx.props.workspaceId,
        `${resolved.bucketDir}/${resolved.relativePath}`,
      ),
    );
    if (!object) {
      throw new Error(`Audio file not found: ${path}`);
    }
    return object.arrayBuffer();
  }
}

function resolveMountedAudioPath(path: string): {
  bucketDir: "user-uploads" | "user-outputs";
  relativePath: string;
} | null {
  const normalized = path.trim().replace(/\\/g, "/");
  const prefixes: Array<{
    prefix: string;
    bucketDir: "user-uploads" | "user-outputs";
  }> = [
    { prefix: "uploads/", bucketDir: "user-uploads" },
    { prefix: "outputs/", bucketDir: "user-outputs" },
  ];
  for (const { prefix, bucketDir } of prefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const relativePath = normalized.slice(prefix.length);
    if (
      !relativePath ||
      relativePath.startsWith("/") ||
      relativePath.split("/").some((part) => part === ".." || part === "")
    ) {
      return null;
    }
    return { bucketDir, relativePath };
  }
  return null;
}
