import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const triggerBlobDownload = vi.fn();
const renderPlotlyPngForPdf = vi.fn();
const renderVegaLitePngForPdf = vi.fn();
const blobToDataUrl = vi.fn(async () => 'data:image/png;base64,rendered-image');
const pdfToBlob = vi.fn(async () => new Blob(['pdf'], { type: 'application/pdf' }));
const fontRegister = vi.fn();

vi.mock('@/components/chat-file-preview/notebook-preview/chart-runtime', () => ({
  blobToDataUrl,
  renderPlotlyPngForPdf,
  renderVegaLitePngForPdf,
  triggerBlobDownload,
}));

vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return {
    ...actual,
    Font: {
      ...actual.Font,
      register: fontRegister,
    },
    pdf: () => ({
      toBlob: pdfToBlob,
    }),
  };
});

describe('pdf export', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPlotlyPngForPdf.mockResolvedValue({
      src: 'data:image/png;base64,chart',
      width: 1200,
      height: 800,
    });
    renderVegaLitePngForPdf.mockResolvedValue({
      src: 'data:image/png;base64,chart',
      width: 1200,
      height: 800,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to a placeholder block when chart rendering fails', async () => {
    renderPlotlyPngForPdf.mockRejectedValueOnce(new Error('chart failed'));

    const { prepareNotebookPdfBlocks } = await import(
      '@/components/chat-file-preview/notebook-preview/pdf-export.client'
    );

    const blocks = await prepareNotebookPdfBlocks([
      {
        id: 'chart-1',
        kind: 'chart',
        chartKind: 'plotly',
        spec: { data: [] },
        title: 'Output 1',
      },
    ]);

    expect(blocks).toEqual([
      {
        id: 'chart-1',
        kind: 'callout',
        tone: 'muted',
        text: 'Chart could not be rendered for PDF export.',
        title: 'Output 1',
      },
    ]);
  });

  it('exports a notebook PDF with a .pdf filename', async () => {
    const { exportNotebookReportAsPdf } = await import(
      '@/components/chat-file-preview/notebook-preview/pdf-export.client'
    );

    await exportNotebookReportAsPdf({
      filename: 'analysis.ipynb',
      notebook: {
        cells: [
          {
            cell_type: 'markdown',
            source: '# Analysis\n\n## Summary\nAll good.',
          },
        ],
      },
    });

    expect(pdfToBlob).toHaveBeenCalledTimes(1);
    expect(triggerBlobDownload).toHaveBeenCalledTimes(1);
    expect(triggerBlobDownload.mock.calls[0][1]).toBe('analysis.pdf');
    expect(fontRegister).toHaveBeenCalledTimes(3);
    expect(fontRegister).toHaveBeenNthCalledWith(1, {
      family: 'Figtree',
      fonts: [
        { src: 'http://localhost:3000/fonts/Figtree-Regular.ttf', fontWeight: 400, fontStyle: 'normal' },
        { src: 'http://localhost:3000/fonts/Figtree-Regular.ttf', fontWeight: 400, fontStyle: 'italic' },
        { src: 'http://localhost:3000/fonts/Figtree-Bold.ttf', fontWeight: 700, fontStyle: 'normal' },
        { src: 'http://localhost:3000/fonts/Figtree-Bold.ttf', fontWeight: 700, fontStyle: 'italic' },
      ],
    });
  });

  it('registers PDF fonts once across repeated exports', async () => {
    const { exportNotebookReportAsPdf } = await import(
      '@/components/chat-file-preview/notebook-preview/pdf-export.client'
    );

    const notebook = {
      cells: [
        {
          cell_type: 'markdown' as const,
          source: '# Analysis\n\n## Summary\nAll good.',
        },
      ],
    };

    await exportNotebookReportAsPdf({
      filename: 'analysis.ipynb',
      notebook,
    });
    await exportNotebookReportAsPdf({
      filename: 'analysis-2.ipynb',
      notebook,
    });

    expect(fontRegister).toHaveBeenCalledTimes(3);
  });

  it('falls back when markdown image preparation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

    const { exportNotebookReportAsPdf } = await import(
      '@/components/chat-file-preview/notebook-preview/pdf-export.client'
    );

    await exportNotebookReportAsPdf({
      filename: 'analysis.ipynb',
      notebook: {
        cells: [
          {
            cell_type: 'markdown',
            source: '![Chart](https://example.com/chart.png)',
          },
        ],
      },
    });

    expect(pdfToBlob).toHaveBeenCalledTimes(1);
    expect(triggerBlobDownload).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      'Notebook PDF markdown image export failed:',
      expect.any(Error)
    );
  });

  it('does not trigger a late download after export timeout', async () => {
    vi.useFakeTimers();

    const pendingBlob = {
      resolve: null as ((value: Blob) => void) | null,
    };
    pdfToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          pendingBlob.resolve = resolve;
        })
    );

    const { exportNotebookReportAsPdf } = await import(
      '@/components/chat-file-preview/notebook-preview/pdf-export.client'
    );

    const exportPromise = exportNotebookReportAsPdf({
      filename: 'analysis.ipynb',
      notebook: {
        cells: [
          {
            cell_type: 'markdown',
            source: '# Analysis',
          },
        ],
      },
    });
    const exportExpectation = expect(exportPromise).rejects.toThrow(
      'Notebook PDF export timed out. Please try again.'
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await exportExpectation;
    expect(triggerBlobDownload).not.toHaveBeenCalled();

    const lateResolve = pendingBlob.resolve;
    if (typeof lateResolve === 'function') {
      lateResolve(new Blob(['late'], { type: 'application/pdf' }));
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(triggerBlobDownload).not.toHaveBeenCalled();
  });
});
