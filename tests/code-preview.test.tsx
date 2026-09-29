import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourcePreview } from '@/components/chat-file-preview/code-preview';
import { FilePreviewContent } from '@/components/chat-file-preview/file-preview-content';

const codeToHtmlMock = vi.hoisted(() =>
  vi.fn(() => new Promise<string>(() => {}))
);

vi.mock('@/lib/shiki-config.client', () => ({
  codeToHtml: codeToHtmlMock,
  SHIKI_DEFAULT_THEMES: {
    light: 'github-light',
    dark: 'github-dark',
  },
  SUPPORTED_LANGUAGES: new Set(['javascript', 'markdown']),
}));

function mockFetchText(text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(text),
    })
  );
}

function createJsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
  };
}

describe('SourcePreview', () => {
  beforeEach(() => {
    codeToHtmlMock.mockReset();
    codeToHtmlMock.mockImplementation(() => new Promise<string>(() => {}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders line-numbered fallback content before highlighting resolves', () => {
    const { container } = render(
      <SourcePreview
        code={'const value = 1;\n\nconsole.log(value);'}
        filename="example.js"
        layout="panel"
        truncated={false}
        totalLines={3}
      />
    );

    const lines = container.querySelectorAll('.source-preview-lines .line');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent('const value = 1;');
    expect(lines[1]?.textContent).toBe('\u00a0');
    expect(lines[2]).toHaveTextContent('console.log(value);');
  });

  it('renders Shiki-like highlighted HTML with source line elements', async () => {
    codeToHtmlMock.mockResolvedValueOnce(
      '<pre class="shiki"><code><span class="line">line 1</span>\n<span class="line">line 2</span></code></pre>'
    );

    const { container } = render(
      <SourcePreview
        code={'line 1\nline 2'}
        filename="README.md"
        layout="panel"
        truncated={false}
        totalLines={2}
        languageOverride="markdown"
      />
    );

    await waitFor(() => {
      const highlightedPre = container.querySelector('.source-preview-lines .shiki');
      expect(highlightedPre).not.toBeNull();
    });

    const lines = container.querySelectorAll('.source-preview-lines .line');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent('line 1');
    expect(lines[1]).toHaveTextContent('line 2');
  });

  it('uses text highlighting fallback for plain text filenames', async () => {
    const { container } = render(
      <SourcePreview
        code={'first line\nsecond line'}
        filename="notes.txt"
        layout="panel"
        truncated={false}
        totalLines={2}
      />
    );

    const lines = container.querySelectorAll('.source-preview-lines .line');
    expect(lines).toHaveLength(2);

    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalledWith(
        'first line\nsecond line',
        expect.objectContaining({ lang: 'text' })
      );
    });
  });

  it('skips Shiki highlighting for very large source previews', () => {
    const code = Array.from({ length: 5001 }, (_, index) => `line ${index + 1}`).join('\n');

    const { container } = render(
      <SourcePreview
        code={code}
        filename="large.js"
        layout="panel"
        truncated={false}
        totalLines={5001}
      />
    );

    expect(codeToHtmlMock).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.source-preview-lines .line')).toHaveLength(0);
    expect(container.querySelector('.source-preview-plain')).not.toBeNull();
    expect(container).toHaveTextContent('line 5001');
  });

  it('copies the complete source from the large plain fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });
    const code = Array.from({ length: 5001 }, (_, index) => `line ${index + 1}`).join('\n');

    render(
      <SourcePreview
        code={code}
        filename="large.js"
        layout="panel"
        truncated={false}
        totalLines={5001}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy source' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(code);
    });
  });

  it('renders plain text file previews through SourcePreview', async () => {
    const originalFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('hello\nfrom txt'),
      }),
    });

    try {
      const { container } = render(
        <FilePreviewContent
          filename="notes.txt"
          previewUrl="/preview/notes.txt"
          contentType="text/plain"
          layout="panel"
        />
      );

      await waitFor(() => {
        const lines = container.querySelectorAll('.source-preview-lines .line');
        expect(lines).toHaveLength(2);
      });
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    }
  });

  it('loads the full file on demand when text preview URLs are provided', async () => {
    let resolveFull: (value: unknown) => void = () => {};
    const fullResponse = new Promise((resolve) => {
      resolveFull = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          text: 'line 1\nline 2',
          truncated: true,
          totalLines: null,
          maxLines: 2,
          size: 2048,
        })
      )
      .mockReturnValueOnce(fullResponse);
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <FilePreviewContent
        filename="notes.txt"
        previewUrl="/preview/notes.txt"
        fileTextPreviewUrl="/preview/text?mode=initial"
        fileFullTextPreviewUrl="/preview/text?mode=full"
        contentType="text/plain"
        layout="panel"
      />
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/preview/text?mode=initial',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(screen.getByText('Showing first 2 lines.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Show all lines/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Loading/ })).toBeDisabled();
    });

    resolveFull(
      createJsonResponse({
        text: 'line 1\nline 2\nline 3',
        truncated: false,
        totalLines: 3,
        maxLines: 2,
        size: 2048,
      })
    );

    await waitFor(() => {
      expect(container).toHaveTextContent('line 3');
      expect(screen.queryByRole('button', { name: /Show all lines/ })).not.toBeInTheDocument();
    });
  });

  it('keeps the truncated preview visible and allows retry after full-load failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          text: 'line 1\nline 2',
          truncated: true,
          totalLines: 3,
          maxLines: 2,
        })
      )
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce(
        createJsonResponse({
          text: 'line 1\nline 2\nline 3',
          truncated: false,
          totalLines: 3,
          maxLines: 2,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <FilePreviewContent
        filename="notes.txt"
        previewUrl="/preview/notes.txt"
        fileTextPreviewUrl="/preview/text?mode=initial"
        fileFullTextPreviewUrl="/preview/text?mode=full"
        contentType="text/plain"
        layout="panel"
      />
    );

    await screen.findByRole('button', { name: /Show all lines/ });
    fireEvent.click(screen.getByRole('button', { name: /Show all lines/ }));

    await waitFor(() => {
      expect(screen.getByText("Couldn't load the full file.")).toBeInTheDocument();
      expect(container).toHaveTextContent('line 2');
      expect(container).not.toHaveTextContent('line 3');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(container).toHaveTextContent('line 3');
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });
  });

  it('shows a non-retryable download path when full preview is too large', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          text: 'line 1\nline 2',
          truncated: true,
          totalLines: null,
          maxLines: 2,
        })
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: vi.fn().mockResolvedValue({
          error: 'File is too large to preview in full',
          code: 'FULL_PREVIEW_TOO_LARGE',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FilePreviewContent
        filename="large.txt"
        previewUrl="/preview/large.txt"
        fileTextPreviewUrl="/preview/text?mode=initial"
        fileFullTextPreviewUrl="/preview/text?mode=full"
        contentType="text/plain"
        layout="panel"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /Show all lines/ }));

    await waitFor(() => {
      expect(screen.getByText('Too large to show in full.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
        'href',
        '/preview/large.txt'
      );
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });
  });

  it('does not apply horizontal-scroll-only classes to the source wrapper', () => {
    const { container } = render(
      <SourcePreview
        code="https://example.com/a/really/long/url/that/should/wrap/in/source/preview"
        filename="README.md"
        layout="panel"
        truncated={false}
        totalLines={1}
        languageOverride="markdown"
      />
    );

    const sourceWrapper = container.querySelector('.source-preview-lines');
    expect(sourceWrapper).not.toBeNull();
    expect(sourceWrapper?.className).not.toContain('overflow-x-auto');
    expect(sourceWrapper?.className).not.toContain('min-w-max');
  });

  it('renders HTML previews in an immediate script sandbox without fetching source', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <FilePreviewContent
        filename="index.html"
        previewUrl="/preview/index.html"
        contentType="text/html"
        layout="panel"
      />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute('src', '/preview/index.html');
    expect(iframe).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-modals allow-popups allow-downloads'
    );
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe?.className).not.toContain('rounded-md');
    expect(iframe?.className).not.toContain('border');
    expect(iframe?.parentElement?.parentElement?.className).toContain('overflow-hidden');
    expect(iframe?.parentElement?.parentElement?.className).not.toContain('p-3');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders HTML source mode through SourcePreview', async () => {
    mockFetchText('<!doctype html><h1>Hello</h1>');

    const { container } = render(
      <FilePreviewContent
        filename="index.html"
        previewUrl="/preview/index.html"
        contentType="text/html"
        layout="panel"
        fileViewMode="source"
      />
    );

    await waitFor(() => {
      expect(container.querySelector('.source-preview-lines')).not.toBeNull();
    });
  });

  it('fetches HTML source again when the preview URL version changes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('<h1>Version 0</h1>'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('<h1>Version 1</h1>'),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { container, rerender } = render(
      <FilePreviewContent
        filename="versioned.html"
        previewUrl="/preview/versioned.html?v=0"
        contentType="text/html"
        layout="panel"
        fileViewMode="source"
      />
    );

    await waitFor(() => {
      expect(container).toHaveTextContent('Version 0');
    });

    rerender(
      <FilePreviewContent
        filename="versioned.html"
        previewUrl="/preview/versioned.html?v=1"
        contentType="text/html"
        layout="panel"
        fileViewMode="source"
      />
    );

    await waitFor(() => {
      expect(container).toHaveTextContent('Version 1');
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/preview/versioned.html?v=0');
    expect(fetchMock.mock.calls[1][0]).toBe('/preview/versioned.html?v=1');
  });

  it('revalidates cached HTML source when the same preview URL remounts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('<h1>Cached version</h1>'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue('<h1>Fresh version</h1>'),
      });
    vi.stubGlobal('fetch', fetchMock);

    const preview = (
      <FilePreviewContent
        filename="revalidated.html"
        previewUrl="/preview/revalidated.html"
        contentType="text/html"
        layout="panel"
        fileViewMode="source"
      />
    );
    const { container, unmount } = render(preview);

    await waitFor(() => {
      expect(container).toHaveTextContent('Cached version');
    });
    unmount();

    const { container: remountedContainer } = render(preview);

    await waitFor(() => {
      expect(remountedContainer).toHaveTextContent('Fresh version');
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/preview/revalidated.html');
    expect(fetchMock.mock.calls[1][0]).toBe('/preview/revalidated.html');
  });

  it('renders HTML preview mode through the iframe even when the URL changes', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { container, rerender } = render(
      <FilePreviewContent
        filename="index.html"
        previewUrl="/preview/index.html"
        contentType="text/html"
        layout="panel"
      />
    );

    expect(container.querySelector('iframe')).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-modals allow-popups allow-downloads'
    );

    rerender(
      <FilePreviewContent
        filename="index.html"
        previewUrl="/preview/other.html"
        contentType="text/html"
        layout="panel"
      />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).toHaveAttribute('src', '/preview/other.html');
    expect(iframe).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-modals allow-popups allow-downloads'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the existing not-found error only in HTML source mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn(),
      })
    );

    const { container } = render(
      <FilePreviewContent
        filename="missing.html"
        previewUrl="/preview/missing.html"
        contentType="text/html"
        layout="panel"
        fileViewMode="source"
      />
    );

    await waitFor(() => {
      expect(container).toHaveTextContent('This file no longer exists in the workspace.');
    });
  });

  it('delegates HTML preview-mode request errors to the iframe document', () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('should not fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <FilePreviewContent
        filename="missing.html"
        previewUrl="/preview/missing.html"
        contentType="text/html"
        layout="panel"
      />
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).toHaveAttribute('src', '/preview/missing.html');
    expect(container).not.toHaveTextContent('This file no longer exists in the workspace.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps SVG previews rendered as images by default', async () => {
    mockFetchText('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" /></svg>');

    const { container } = render(
      <FilePreviewContent
        filename="icon.svg"
        previewUrl="/preview/icon.svg"
        contentType="image/svg+xml"
        layout="panel"
      />
    );

    await waitFor(() => {
      const image = container.querySelector('img');
      expect(image).not.toBeNull();
      expect(image).toHaveAttribute('src', '/preview/icon.svg');
    });
  });

  it('renders SVG source mode through SourcePreview', async () => {
    mockFetchText('<svg viewBox="0 0 10 10"></svg>');

    const { container } = render(
      <FilePreviewContent
        filename="icon.svg"
        previewUrl="/preview/icon.svg"
        contentType="image/svg+xml"
        layout="panel"
        fileViewMode="source"
      />
    );

    await waitFor(() => {
      expect(container.querySelector('.source-preview-lines')).not.toBeNull();
    });
  });

  it('pretty-prints minified JSON in preview mode', async () => {
    mockFetchText('{"value":1,"nested":{"ok":true}}');

    const { container } = render(
      <FilePreviewContent
        filename="config.json"
        previewUrl="/preview/config.json"
        contentType="application/json"
        layout="panel"
      />
    );

    await waitFor(() => {
      const lines = container.querySelectorAll('.source-preview-lines .line');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[1]?.textContent).toBe('  "value": 1,');
    });
  });

  it('shows truncated JSON text-preview responses as raw source until full load', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          text: '{"value":1}',
          truncated: true,
          totalLines: null,
          maxLines: 1000,
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          text: '{"value":1,"nested":{"ok":true}}',
          truncated: false,
          totalLines: 1,
          maxLines: 1000,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <FilePreviewContent
        filename="config.json"
        previewUrl="/preview/config.json"
        fileTextPreviewUrl="/preview/text?mode=initial"
        fileFullTextPreviewUrl="/preview/text?mode=full"
        contentType="application/json"
        layout="panel"
      />
    );

    await waitFor(() => {
      const lines = container.querySelectorAll('.source-preview-lines .line');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveTextContent('{"value":1}');
    });

    fireEvent.click(screen.getByRole('button', { name: /Show all lines/ }));

    await waitFor(() => {
      const lines = container.querySelectorAll('.source-preview-lines .line');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines[1]?.textContent).toBe('  "value": 1,');
    });
  });

  it('preserves raw JSON in source mode', async () => {
    mockFetchText('{"value":1}');

    const { container } = render(
      <FilePreviewContent
        filename="config.json"
        previewUrl="/preview/config.json"
        contentType="application/json"
        layout="panel"
        fileViewMode="source"
      />
    );

    await waitFor(() => {
      const lines = container.querySelectorAll('.source-preview-lines .line');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toHaveTextContent('{"value":1}');
    });
  });

  it('falls back gracefully for invalid JSON', async () => {
    mockFetchText('{ bad');

    const { container, getByText } = render(
      <FilePreviewContent
        filename="config.json"
        previewUrl="/preview/config.json"
        contentType="application/json"
        layout="panel"
      />
    );

    await waitFor(() => {
      expect(getByText('Invalid JSON. Showing raw source.')).toBeInTheDocument();
      expect(container.querySelector('.source-preview-lines')).not.toBeNull();
    });
  });

  it('pretty-prints JSONL records line by line', async () => {
    mockFetchText('{"a":1}\n{"b":2}');

    const { container } = render(
      <FilePreviewContent
        filename="events.jsonl"
        previewUrl="/preview/events.jsonl"
        contentType="application/x-ndjson"
        layout="panel"
      />
    );

    await waitFor(() => {
      const lines = container.querySelectorAll('.source-preview-lines .line');
      expect(lines.length).toBeGreaterThan(4);
      expect(lines[1]?.textContent).toBe('  "a": 1');
      expect(lines[5]?.textContent).toBe('  "b": 2');
    });
  });

  it('renders CSV source mode through SourcePreview', async () => {
    mockFetchText('name,value\nA,1\nB,2');

    const { container } = render(
      <FilePreviewContent
        filename="data.csv"
        previewUrl="/preview/data.csv"
        contentType="text/csv"
        layout="panel"
        fileViewMode="source"
      />
    );

    await waitFor(() => {
      const lines = container.querySelectorAll('.source-preview-lines .line');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toHaveTextContent('name,value');
    });
  });
});
