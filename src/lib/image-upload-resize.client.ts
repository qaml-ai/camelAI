import { getFileExtension } from '@/components/chat-file-preview/file-type-utils';

/**
 * CamelRun v2's per-image model request byte limit is 3.75 MiB (3,932,160 bytes)
 * so base64 stays within Anthropic's 5 MiB cap. Target slightly below that so
 * uploaded images never trip the limit and upload quickly.
 */
export const CLIENT_IMAGE_TARGET_BYTES = 3_500_000;

const RESIZABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

const RESIZABLE_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
]);

const RESIZE_MAX_SIDES = [2000, 1568, 1280, 1024, 768] as const;
const RESIZE_QUALITIES = [0.85, 0.75, 0.65, 0.55] as const;

export interface DecodedImageSource {
  width: number;
  height: number;
  source: CanvasImageSource;
  cleanup: () => void;
}

export interface OptimizeImageForUploadOptions {
  targetBytes?: number;
  decodeImage?: (file: File) => Promise<DecodedImageSource>;
  encodeCanvas?: (
    source: CanvasImageSource,
    width: number,
    height: number,
    mimeType: string,
    quality: number,
  ) => Promise<Blob | null>;
}

export interface OptimizeImageForUploadResult {
  file: File;
  resized: boolean;
}

export function shouldOptimizeUploadedImage(
  file: Pick<File, 'name' | 'type' | 'size'>,
  targetBytes = CLIENT_IMAGE_TARGET_BYTES,
): boolean {
  if (file.size <= targetBytes) return false;

  const normalizedType = file.type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (normalizedType === 'image/svg+xml') return false;
  if (normalizedType && RESIZABLE_IMAGE_TYPES.has(normalizedType)) {
    return true;
  }

  if (!normalizedType || normalizedType === 'application/octet-stream') {
    return RESIZABLE_IMAGE_EXTENSIONS.has(getFileExtension(file.name));
  }

  return false;
}

export function replaceImageFilenameExtension(filename: string, nextExtension: string): string {
  const ext = nextExtension.startsWith('.') ? nextExtension : `.${nextExtension}`;
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) {
    return `${filename}${ext}`;
  }
  return `${filename.slice(0, lastDot)}${ext}`;
}

export function fitImageDimensions(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide || longest <= 0) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function defaultDecodeImage(file: File): Promise<DecodedImageSource> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      cleanup: () => {
        bitmap.close();
      },
    };
  }

  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Image decoding is unavailable in this environment');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Failed to decode image'));
      element.src = objectUrl;
    });
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      source: img,
      cleanup: () => {
        URL.revokeObjectURL(objectUrl);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function defaultEncodeCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
  mimeType: string,
  quality: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context && typeof canvas.convertToBlob === 'function') {
      if (mimeType === 'image/jpeg') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(source, 0, 0, width, height);
      return await canvas.convertToBlob({ type: mimeType, quality });
    }
  }

  if (typeof document === 'undefined') {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  if (mimeType === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(source, 0, 0, width, height);

  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

/**
 * Downscales and compresses oversized raster images client-side before upload
 * so screenshots (like multi-megabyte iPhone PNGs) stay comfortably under the
 * model request image limit while preserving readability and aspect ratio.
 *
 * Always falls back to the original file if decoding or canvas encoding fails.
 */
export async function optimizeImageForUpload(
  file: File,
  options: OptimizeImageForUploadOptions = {},
): Promise<OptimizeImageForUploadResult> {
  const targetBytes = options.targetBytes ?? CLIENT_IMAGE_TARGET_BYTES;
  if (!shouldOptimizeUploadedImage(file, targetBytes)) {
    return { file, resized: false };
  }

  const decodeImage = options.decodeImage ?? defaultDecodeImage;
  const encodeCanvas = options.encodeCanvas ?? defaultEncodeCanvas;

  let decoded: DecodedImageSource | null = null;
  try {
    decoded = await decodeImage(file);
    if (decoded.width <= 0 || decoded.height <= 0) {
      return { file, resized: false };
    }

    let smallestBlob: Blob | null = null;

    for (const maxSide of RESIZE_MAX_SIDES) {
      const { width, height } = fitImageDimensions(decoded.width, decoded.height, maxSide);
      for (const quality of RESIZE_QUALITIES) {
        const blob = await encodeCanvas(decoded.source, width, height, 'image/jpeg', quality);
        if (!blob || blob.size <= 0) continue;

        if (!smallestBlob || blob.size < smallestBlob.size) {
          smallestBlob = blob;
        }

        if (blob.size <= targetBytes) {
          const optimizedName = replaceImageFilenameExtension(file.name, '.jpg');
          const optimizedFile = new File([blob], optimizedName, {
            type: 'image/jpeg',
            lastModified: file.lastModified,
          });
          return { file: optimizedFile, resized: true };
        }
      }
    }

    if (smallestBlob && smallestBlob.size < file.size) {
      const optimizedName = replaceImageFilenameExtension(file.name, '.jpg');
      const optimizedFile = new File([smallestBlob], optimizedName, {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      });
      return { file: optimizedFile, resized: true };
    }

    return { file, resized: false };
  } catch (error) {
    console.warn('[upload] client-side image optimization failed; uploading original file', error);
    return { file, resized: false };
  } finally {
    decoded?.cleanup();
  }
}
