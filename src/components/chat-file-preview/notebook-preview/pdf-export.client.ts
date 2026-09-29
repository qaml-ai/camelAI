'use client';

import { createElement } from 'react';
import {
  blobToDataUrl,
  type PdfImageAsset,
  renderPlotlyPngForPdf,
  renderVegaLitePngForPdf,
  triggerBlobDownload,
} from './chart-runtime';
import { NotebookPdfDocument, type NotebookPdfRenderableBlock } from './pdf-document';
import { extractMarkdownImageUrls, type PdfMarkdownImageAssets } from './pdf-markdown';
import {
  buildNotebookReportExportModel,
  type NotebookReportExportBlock,
} from './report-export-model';
import type { NotebookFile } from './types';

const EXPORT_TIMEOUT_MS = 30_000;
const CHART_RENDER_TIMEOUT_MS = 5_000;
const IMAGE_FETCH_TIMEOUT_MS = 5_000;

const CHART_FAILURE_COPY = 'Chart could not be rendered for PDF export.';
const GENERIC_HTML_FALLBACK_COPY = 'This interactive HTML output is not included in PDF export.';
const IMAGE_FAILURE_COPY = 'Image could not be rendered for PDF export.';

let pdfFontsRegistered = false;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Notebook PDF export was aborted.');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw getAbortError(signal);
  }
}

function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: T | Error) => void, value: T | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    const timeoutId = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      finish(reject as (value: T | Error) => void, error);
    }, ms);

    operation(controller.signal).then(
      (value) => finish(resolve as (value: T | Error) => void, value),
      (error) => finish(
        reject as (value: T | Error) => void,
        error instanceof Error ? error : new Error(String(error))
      )
    );
  });
}

function toPdfFilename(filename: string): string {
  if (/\.ipynb$/i.test(filename)) {
    return filename.replace(/\.ipynb$/i, '.pdf');
  }
  return `${filename}.pdf`;
}

function resolvePdfFontSrc(path: string): string {
  if (typeof window === 'undefined') {
    return path;
  }
  return new URL(path, window.location.origin).toString();
}

function registerPdfFonts(font: typeof import('@react-pdf/renderer').Font): void {
  if (pdfFontsRegistered) return;

  // react-pdf resolves fonts by family + weight + style and throws if an
  // italic face is requested without a registered variant.
  font.register({
    family: 'Figtree',
    fonts: [
      { src: resolvePdfFontSrc('/fonts/Figtree-Regular.ttf'), fontWeight: 400, fontStyle: 'normal' },
      { src: resolvePdfFontSrc('/fonts/Figtree-Regular.ttf'), fontWeight: 400, fontStyle: 'italic' },
      { src: resolvePdfFontSrc('/fonts/Figtree-Bold.ttf'), fontWeight: 700, fontStyle: 'normal' },
      { src: resolvePdfFontSrc('/fonts/Figtree-Bold.ttf'), fontWeight: 700, fontStyle: 'italic' },
    ],
  });
  font.register({
    family: 'Source Serif 4',
    fonts: [{ src: resolvePdfFontSrc('/fonts/SourceSerif4-Regular.ttf'), fontWeight: 400 }],
  });
  font.register({
    family: 'Geist Mono',
    fonts: [
      { src: resolvePdfFontSrc('/fonts/GeistMono-Regular.ttf'), fontWeight: 400 },
      { src: resolvePdfFontSrc('/fonts/GeistMono-Bold.ttf'), fontWeight: 700 },
    ],
  });

  pdfFontsRegistered = true;
}

async function normalizeImageSrcForPdf(src: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (src.startsWith('data:')) {
    return src;
  }

  const response = await withTimeout(
    fetch(src, { signal }),
    IMAGE_FETCH_TIMEOUT_MS,
    'Image fetch timed out during PDF export.'
  );
  if (!response.ok) {
    throw new Error(`Image fetch failed with status ${response.status}.`);
  }

  const blob = await response.blob();
  return await blobToDataUrl(blob);
}

async function getImageDimensions(
  src: string,
  signal?: AbortSignal
): Promise<{ width: number; height: number }> {
  throwIfAborted(signal);
  const image = new Image();
  return await withTimeout(
    new Promise<{ width: number; height: number }>((resolve, reject) => {
      const handleAbort = () => {
        cleanup();
        reject(getAbortError(signal as AbortSignal));
      };
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        signal?.removeEventListener('abort', handleAbort);
      };
      image.onload = () => {
        cleanup();
        resolve({
          width: image.naturalWidth || 1200,
          height: image.naturalHeight || 800,
        });
      };
      image.onerror = () => {
        cleanup();
        reject(new Error('Image dimensions could not be read.'));
      };
      signal?.addEventListener('abort', handleAbort, { once: true });
      throwIfAborted(signal);
      image.src = src;
    }),
    IMAGE_FETCH_TIMEOUT_MS,
    'Image load timed out during PDF export.'
  );
}

async function buildPdfImageAsset(src: string, signal?: AbortSignal): Promise<PdfImageAsset> {
  const normalizedSrc = await normalizeImageSrcForPdf(src, signal);
  throwIfAborted(signal);
  const dimensions = await getImageDimensions(normalizedSrc, signal);
  return {
    src: normalizedSrc,
    ...dimensions,
  };
}

async function buildMarkdownImageAssets(
  markdown: string,
  signal?: AbortSignal
): Promise<PdfMarkdownImageAssets | undefined> {
  const urls = extractMarkdownImageUrls(markdown);
  if (urls.length === 0) {
    return undefined;
  }

  const imageAssets: PdfMarkdownImageAssets = {};
  const entries = await Promise.all(urls.map(async (url) => {
    throwIfAborted(signal);
    try {
      return [url, await buildPdfImageAsset(url, signal)] as const;
    } catch (error) {
      if (signal?.aborted) {
        throw getAbortError(signal);
      }
      console.error('Notebook PDF markdown image export failed:', error);
      return [url, null] as const;
    }
  }));
  for (const [url, asset] of entries) {
    imageAssets[url] = asset;
  }

  return imageAssets;
}

async function preparePdfBlock(
  block: NotebookReportExportBlock,
  signal?: AbortSignal
): Promise<NotebookPdfRenderableBlock | null> {
  switch (block.kind) {
    case 'markdown':
      return {
        ...block,
        imageAssets: await buildMarkdownImageAssets(block.markdown, signal),
      };
    case 'table':
      return block;
    case 'text':
      return block;
    case 'error':
      return block;
    case 'html':
      return {
        id: block.id,
        kind: 'callout',
        tone: 'muted',
        text: GENERIC_HTML_FALLBACK_COPY,
        title: block.title,
      };
    case 'image':
      try {
        const asset = await buildPdfImageAsset(block.src, signal);
        throwIfAborted(signal);
        return {
          id: block.id,
          kind: 'figure',
          title: block.title,
          asset,
        };
      } catch (error) {
        if (signal?.aborted) {
          throw getAbortError(signal);
        }
        console.error('Notebook PDF image export failed:', error);
        return {
          id: block.id,
          kind: 'callout',
          tone: 'muted',
          text: IMAGE_FAILURE_COPY,
          title: block.title,
        };
      }
    case 'chart':
      try {
        const asset = await withTimeout(
          block.chartKind === 'plotly'
            ? renderPlotlyPngForPdf(block.spec)
            : renderVegaLitePngForPdf(block.spec),
          CHART_RENDER_TIMEOUT_MS,
          'Chart render timed out during PDF export.'
        );
        throwIfAborted(signal);
        return {
          id: block.id,
          kind: 'figure',
          title: block.title,
          asset,
        };
      } catch (error) {
        if (signal?.aborted) {
          throw getAbortError(signal);
        }
        console.error('Notebook PDF chart export failed:', error);
        return {
          id: block.id,
          kind: 'callout',
          tone: 'muted',
          text: CHART_FAILURE_COPY,
          title: block.title,
        };
      }
  }
}

export async function prepareNotebookPdfBlocks(
  blocks: NotebookReportExportBlock[],
  signal?: AbortSignal
): Promise<NotebookPdfRenderableBlock[]> {
  const prepared = await Promise.all(blocks.map((block) => {
    throwIfAborted(signal);
    return preparePdfBlock(block, signal);
  }));

  return prepared.filter((block): block is NotebookPdfRenderableBlock => Boolean(block));
}

export async function exportNotebookReportAsPdf(options: {
  notebook: NotebookFile;
  filename: string;
}): Promise<void> {
  if (typeof document === 'undefined') {
    throw new Error('Notebook PDF export is only available in the browser.');
  }

  await withAbortTimeout(
    async (signal) => {
      const reactPdfModule = await import('@react-pdf/renderer');
      throwIfAborted(signal);
      registerPdfFonts(reactPdfModule.Font);
      const model = buildNotebookReportExportModel(options.notebook);
      const blocks = await prepareNotebookPdfBlocks(model.blocks, signal);
      throwIfAborted(signal);
      const pdfTitle = model.header.title ?? options.filename.replace(/\.ipynb$/i, '');
      // `react-pdf` expects a renderer-specific document element here, and
      // `createElement` is the narrowest cast surface for that handoff.
      const documentElement = createElement(NotebookPdfDocument, {
        model,
        blocks,
        pdfTitle,
      }) as unknown as Parameters<typeof reactPdfModule.pdf>[0];

      const blob = await reactPdfModule.pdf(documentElement).toBlob();
      throwIfAborted(signal);
      triggerBlobDownload(blob, toPdfFilename(options.filename));
    },
    EXPORT_TIMEOUT_MS,
    'Notebook PDF export timed out. Please try again.'
  );
}
