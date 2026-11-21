import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_IMAGE_TARGET_BYTES,
  fitImageDimensions,
  optimizeImageForUpload,
  replaceImageFilenameExtension,
  shouldOptimizeUploadedImage,
} from '@/lib/image-upload-resize.client';

describe('image-upload-resize.client', () => {
  describe('shouldOptimizeUploadedImage', () => {
    it('triggers only for oversized raster images and never for small images, SVGs, or documents', () => {
      const over = CLIENT_IMAGE_TARGET_BYTES + 1;
      expect(shouldOptimizeUploadedImage({ name: 'IMG_3083.png', type: 'image/png', size: over })).toBe(true);
      expect(shouldOptimizeUploadedImage({ name: 'photo.jpg', type: 'image/jpeg', size: over })).toBe(true);
      expect(shouldOptimizeUploadedImage({ name: 'shot.webp', type: 'image/webp', size: over })).toBe(true);
      expect(shouldOptimizeUploadedImage({ name: 'IMG_3083.png', type: '', size: over })).toBe(true);
      expect(shouldOptimizeUploadedImage({ name: 'IMG_3083.png', type: 'application/octet-stream', size: over })).toBe(true);

      expect(shouldOptimizeUploadedImage({ name: 'small.png', type: 'image/png', size: CLIENT_IMAGE_TARGET_BYTES })).toBe(false);
      expect(shouldOptimizeUploadedImage({ name: 'diagram.svg', type: 'image/svg+xml', size: over })).toBe(false);
      expect(shouldOptimizeUploadedImage({ name: 'report.pdf', type: 'application/pdf', size: over })).toBe(false);
      expect(shouldOptimizeUploadedImage({ name: 'data.csv', type: 'text/csv', size: over })).toBe(false);
    });
  });

  describe('fitImageDimensions', () => {
    it('scales proportionally down to maxSide and never upscales', () => {
      expect(fitImageDimensions(1290, 2796, 2000)).toEqual({ width: 923, height: 2000 });
      expect(fitImageDimensions(4032, 3024, 1568)).toEqual({ width: 1568, height: 1176 });
      expect(fitImageDimensions(800, 600, 2000)).toEqual({ width: 800, height: 600 });
    });
  });

  describe('replaceImageFilenameExtension', () => {
    it('replaces existing extensions and appends when missing', () => {
      expect(replaceImageFilenameExtension('IMG_3083.png', '.jpg')).toBe('IMG_3083.jpg');
      expect(replaceImageFilenameExtension('my.screenshot.PNG', 'jpg')).toBe('my.screenshot.jpg');
      expect(replaceImageFilenameExtension('screenshot', '.jpg')).toBe('screenshot.jpg');
    });
  });

  describe('optimizeImageForUpload', () => {
    it('returns small images untouched without decoding', async () => {
      const decodeImage = vi.fn();
      const file = new File([new Uint8Array(1024)], 'small.png', { type: 'image/png' });

      const result = await optimizeImageForUpload(file, { decodeImage });

      expect(result).toEqual({ file, resized: false });
      expect(decodeImage).not.toHaveBeenCalled();
    });

    it('downscales and converts oversized PNG screenshots to JPEG under the target size', async () => {
      const cleanup = vi.fn();
      const decodeImage = vi.fn(async () => ({
        width: 1290,
        height: 2796,
        source: {} as CanvasImageSource,
        cleanup,
      }));
      const encodeCanvas = vi.fn(async (_source, width, height, mimeType, quality) => {
        expect(width).toBe(923);
        expect(height).toBe(2000);
        expect(mimeType).toBe('image/jpeg');
        expect(quality).toBe(0.85);
        return new Blob([new Uint8Array(250_000)], { type: 'image/jpeg' });
      });

      const original = new File([new Uint8Array(6_000_000)], 'IMG_3083.png', {
        type: 'image/png',
        lastModified: 1_700_000_000_000,
      });

      const result = await optimizeImageForUpload(original, { decodeImage, encodeCanvas });

      expect(result.resized).toBe(true);
      expect(result.file.name).toBe('IMG_3083.jpg');
      expect(result.file.type).toBe('image/jpeg');
      expect(result.file.size).toBe(250_000);
      expect(result.file.lastModified).toBe(1_700_000_000_000);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('steps down quality and max dimensions until the encoded image fits the target budget', async () => {
      const cleanup = vi.fn();
      const calls: Array<{ width: number; height: number; quality: number }> = [];
      const decodeImage = vi.fn(async () => ({
        width: 4000,
        height: 3000,
        source: {} as CanvasImageSource,
        cleanup,
      }));
      const encodeCanvas = vi.fn(async (_source, width, height, _mimeType, quality) => {
        calls.push({ width, height, quality });
        if (width <= 1568 && quality <= 0.75) {
          return new Blob([new Uint8Array(180_000)], { type: 'image/jpeg' });
        }
        return new Blob([new Uint8Array(4_500_000)], { type: 'image/jpeg' });
      });

      const original = new File([new Uint8Array(8_000_000)], 'huge.png', { type: 'image/png' });
      const result = await optimizeImageForUpload(original, {
        targetBytes: 3_500_000,
        decodeImage,
        encodeCanvas,
      });

      expect(result.resized).toBe(true);
      expect(result.file.size).toBe(180_000);
      expect(result.file.name).toBe('huge.jpg');
      expect(calls).toEqual([
        { width: 2000, height: 1500, quality: 0.85 },
        { width: 2000, height: 1500, quality: 0.75 },
        { width: 2000, height: 1500, quality: 0.65 },
        { width: 2000, height: 1500, quality: 0.55 },
        { width: 1568, height: 1176, quality: 0.85 },
        { width: 1568, height: 1176, quality: 0.75 },
      ]);
      expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('falls back to the original file if decoding fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const decodeImage = vi.fn(async () => {
        throw new Error('Unsupported format');
      });
      const original = new File([new Uint8Array(5_000_000)], 'broken.png', { type: 'image/png' });

      const result = await optimizeImageForUpload(original, { decodeImage });

      expect(result).toEqual({ file: original, resized: false });
      warnSpy.mockRestore();
    });
  });
});
