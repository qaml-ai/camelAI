const INLINE_IMAGE_MAX_BASE64_CHARS = Math.floor(4.5 * 1024 * 1024);
const IMAGE_TYPE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PreparedInlineImage {
  data: string;
  mimeType: string;
  base64Chars: number;
  usedImagesBinding: boolean;
  optimizedForInlineView: boolean;
  maxInlineDimension?: number;
}

export function inlineImageMaxBase64Chars(): number {
  return INLINE_IMAGE_MAX_BASE64_CHARS;
}

export function normalizeImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

export function getSupportedImageMimeTypeFromContentType(contentType: unknown): string | null {
  if (typeof contentType !== "string") return null;
  const normalized = normalizeImageMimeType(contentType.split(";")[0] ?? "");
  return isSupportedImageMimeType(normalized) ? normalized : null;
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(normalizeImageMimeType(mimeType));
}

export function base64EncodeImageBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bytesStartWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function bytesStartWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    (((bytes[offset + 1] ?? 0) << 16) >>> 0) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 16 &&
    readUint32BE(bytes, PNG_SIGNATURE.length) === 13 &&
    bytesStartWithAscii(bytes, 12, "IHDR")
  );
}

function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const chunkLength = readUint32BE(bytes, offset);
    const chunkTypeOffset = offset + 4;
    if (bytesStartWithAscii(bytes, chunkTypeOffset, "acTL")) return true;
    if (bytesStartWithAscii(bytes, chunkTypeOffset, "IDAT")) return false;
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > bytes.length) return false;
    offset = nextOffset;
  }
  return false;
}

export type ImageMimeTypeDetection =
  | { kind: "supported"; mimeType: string }
  | { kind: "unsupported"; mimeType: string; reason: string }
  | { kind: "unknown" };

export function detectImageMimeType(bytes: Uint8Array): ImageMimeTypeDetection {
  const sample = bytes.subarray(0, Math.min(bytes.length, IMAGE_TYPE_SNIFF_BYTES));
  if (bytesStartWith(sample, [0xff, 0xd8, 0xff])) {
    return sample[3] === 0xf7
      ? { kind: "unsupported", mimeType: "image/jpeg", reason: "jpeg-ls" }
      : { kind: "supported", mimeType: "image/jpeg" };
  }
  if (bytesStartWith(sample, PNG_SIGNATURE)) {
    if (!isPng(sample)) return { kind: "unsupported", mimeType: "image/png", reason: "invalid-png" };
    return isAnimatedPng(sample)
      ? { kind: "unsupported", mimeType: "image/png", reason: "animated-png" }
      : { kind: "supported", mimeType: "image/png" };
  }
  if (bytesStartWithAscii(sample, 0, "GIF")) return { kind: "supported", mimeType: "image/gif" };
  if (bytesStartWithAscii(sample, 0, "RIFF") && bytesStartWithAscii(sample, 8, "WEBP")) {
    return { kind: "supported", mimeType: "image/webp" };
  }
  return { kind: "unknown" };
}

export function detectSupportedImageMimeType(bytes: Uint8Array): string | null {
  const detection = detectImageMimeType(bytes);
  return detection.kind === "supported" ? detection.mimeType : null;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function readStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}

async function readStreamText(
  stream: ReadableStream<Uint8Array>,
  options: { maxChars?: number } = {},
): Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalChars = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      chunks.push(chunk);
      totalChars += chunk.length;
      if (options.maxChars !== undefined && totalChars > options.maxChars) {
        await reader.cancel("inline image output exceeded base64 limit");
        return null;
      }
    }
    const finalChunk = decoder.decode();
    if (finalChunk) {
      chunks.push(finalChunk);
      totalChars += finalChunk.length;
    }
    if (options.maxChars !== undefined && totalChars > options.maxChars) return null;
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function readImageSniffBytesAndReplayStream(
  source: ReadableStream<Uint8Array>,
): Promise<{ prefix: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < IMAGE_TYPE_SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const prefix = new Uint8Array(Math.min(total, IMAGE_TYPE_SNIFF_BYTES));
  let prefixOffset = 0;
  for (const chunk of chunks) {
    const copied = Math.min(chunk.byteLength, prefix.byteLength - prefixOffset);
    if (copied <= 0) break;
    prefix.set(chunk.subarray(0, copied), prefixOffset);
    prefixOffset += copied;
  }
  const replayChunks = chunks.slice();
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const replayChunk = replayChunks.shift();
        if (replayChunk) {
          controller.enqueue(replayChunk);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          releaseReader();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
  return { prefix, stream };
}

function preferredOutputFormat(mimeType: string): ImageOutputOptions["format"] {
  const normalized = normalizeImageMimeType(mimeType);
  if (normalized === "image/png" || normalized === "image/gif" || normalized === "image/webp") return normalized;
  return "image/jpeg";
}

async function outputImageFromStream(
  images: ImagesBinding,
  stream: ReadableStream<Uint8Array>,
  format: ImageOutputOptions["format"],
  options: { width?: number; height?: number; quality?: number } = {},
): Promise<{ data: string; mimeType: string }> {
  let transformer = images.input(stream);
  if (options.width && options.height) {
    transformer = transformer.transform({ width: options.width, height: options.height, fit: "scale-down" });
  }
  const result = await transformer.output({
    format,
    quality: options.quality,
    anim: false,
  });
  const data = await readStreamText(result.image({ encoding: "base64" }), {
    maxChars: INLINE_IMAGE_MAX_BASE64_CHARS,
  });
  if (data === null) throw new Error("Inline image output exceeded base64 limit");
  return {
    data,
    mimeType: normalizeImageMimeType(result.contentType() || format),
  };
}

async function outputImage(
  images: ImagesBinding,
  bytes: Uint8Array,
  format: ImageOutputOptions["format"],
  options: { width?: number; height?: number; quality?: number } = {},
): Promise<{ data: string; mimeType: string }> {
  return outputImageFromStream(images, streamFromBytes(bytes), format, options);
}

export async function prepareInlineImageFromStream(
  stream: ReadableStream<Uint8Array>,
  mimeType: string,
  images: ImagesBinding,
  options: { createRetryStream?: () => Promise<ReadableStream<Uint8Array>> } = {},
): Promise<PreparedInlineImage | null> {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  const format = preferredOutputFormat(normalizedMimeType);
  const candidates = [
    { maxDimension: 2000, quality: 80 },
    { maxDimension: 1500, quality: 80 },
    { maxDimension: 1125, quality: 70 },
    { maxDimension: 840, quality: 70 },
    { maxDimension: 630, quality: 60 },
    { maxDimension: 470, quality: 60 },
    { maxDimension: 350, quality: 50 },
    { maxDimension: 260, quality: 50 },
    { maxDimension: 195, quality: 40 },
    { maxDimension: 145, quality: 40 },
    { maxDimension: 108, quality: 40 },
    { maxDimension: 80, quality: 40 },
  ];
  for (const [index, candidate] of candidates.entries()) {
    if (index > 0 && !options.createRetryStream) return null;
    try {
      const candidateStream = index === 0 ? stream : await options.createRetryStream!();
      const transformed = await outputImageFromStream(images, candidateStream, format, {
        width: candidate.maxDimension,
        height: candidate.maxDimension,
        quality: candidate.quality,
      });
      if (transformed.data.length <= INLINE_IMAGE_MAX_BASE64_CHARS) {
        return {
          data: transformed.data,
          mimeType: transformed.mimeType,
          base64Chars: transformed.data.length,
          usedImagesBinding: true,
          optimizedForInlineView: true,
          maxInlineDimension: candidate.maxDimension,
        };
      }
    } catch {
      // Try the next smaller/cheaper candidate if a fresh source stream is available.
    }
  }
  return null;
}

export async function prepareInlineImageFromBytes(
  bytes: Uint8Array,
  mimeType: string,
  images: ImagesBinding,
): Promise<PreparedInlineImage | null> {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  const preferredFormat = preferredOutputFormat(normalizedMimeType);
  const maxDimensionSteps = [2000, 1500, 1125, 840, 630, 470, 350, 260, 195, 145, 108, 80];
  const qualitySteps = [80, 70, 60, 50, 40];
  const outputFormats: ImageOutputOptions["format"][] = [preferredFormat, "image/webp", "image/jpeg"];
  for (const maxDimension of maxDimensionSteps) {
    for (const format of outputFormats) {
      for (const quality of qualitySteps) {
        try {
          const transformed = await outputImage(images, bytes, format, {
            width: maxDimension,
            height: maxDimension,
            quality,
          });
          if (transformed.data.length <= INLINE_IMAGE_MAX_BASE64_CHARS) {
            return {
              data: transformed.data,
              mimeType: transformed.mimeType,
              base64Chars: transformed.data.length,
              usedImagesBinding: true,
              optimizedForInlineView: true,
              maxInlineDimension: maxDimension,
            };
          }
        } catch {
          // Try the next format/quality/size candidate.
        }
      }
    }
  }
  return null;
}
