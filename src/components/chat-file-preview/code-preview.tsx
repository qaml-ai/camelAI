'use client';

import { useCallback, useLayoutEffect, useMemo, useState, type CSSProperties } from 'react';
import { Check, Copy } from 'lucide-react';
import { PREVIEW_INITIAL_MAX_LINES } from '@/lib/file-preview-limits';
import { codeToHtml, SHIKI_DEFAULT_THEMES, SUPPORTED_LANGUAGES } from '@/lib/shiki-config.client';
import { cn } from '@/lib/utils';
import { getShikiLanguage } from './file-type-utils';
import { PreviewTruncationFooter } from './preview-truncation-footer';

// These are client render limits for syntax highlighting, not server preview limits.
const HIGHLIGHT_MAX_LINES = 5_000;
const HIGHLIGHT_MAX_CHARS = 1_000_000;
const LINE_SPAN_RENDER_MAX_LINES = HIGHLIGHT_MAX_LINES;

export interface SourcePreviewProps {
  code: string;
  filename: string;
  layout: 'panel' | 'dialog';
  truncated: boolean;
  truncatedBy?: 'lines' | 'bytes';
  totalLines: number | null;
  maxLines?: number;
  languageOverride?: string | null;
  emptyMessage?: string;
  onLoadFull?: () => void;
  loadFullStatus?: 'idle' | 'loading' | 'error' | 'unavailable';
  canLoadFull?: boolean;
  sizeBytes?: number;
  downloadUrl?: string;
  downloadFilename?: string;
}

type CodePreviewProps = Omit<SourcePreviewProps, 'languageOverride' | 'emptyMessage'>;

function countLines(value: string): number {
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export function SourcePreview({
  code,
  filename,
  layout,
  truncated,
  truncatedBy,
  totalLines,
  maxLines = PREVIEW_INITIAL_MAX_LINES,
  languageOverride,
  emptyMessage = 'No preview content available.',
  onLoadFull,
  loadFullStatus = 'idle',
  canLoadFull = false,
  sizeBytes,
  downloadUrl,
  downloadFilename,
}: SourcePreviewProps) {
  const [copied, setCopied] = useState(false);
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);

  const language = useMemo(
    () => languageOverride ?? getShikiLanguage(filename),
    [filename, languageOverride]
  );
  const fallbackContent = code.length > 0 ? code : emptyMessage;
  const fallbackLineCount = useMemo(() => countLines(fallbackContent), [fallbackContent]);
  const shouldRenderLineSpans = fallbackLineCount <= LINE_SPAN_RENDER_MAX_LINES;
  const fallbackLines = useMemo(
    () => (shouldRenderLineSpans ? fallbackContent.split('\n') : []),
    [fallbackContent, shouldRenderLineSpans]
  );
  const lineNumberDigits = useMemo(() => {
    const lineCount = Math.max(totalLines ?? 0, fallbackLineCount, 1);
    return Math.max(String(lineCount).length, 2);
  }, [fallbackLineCount, totalLines]);
  const shouldHighlight = useMemo(
    () => shouldRenderLineSpans && code.length <= HIGHLIGHT_MAX_CHARS,
    [code.length, shouldRenderLineSpans]
  );
  const sourceStyle = useMemo(
    () => ({
      '--source-line-number-digits': String(lineNumberDigits),
    }) as CSSProperties,
    [lineNumberDigits]
  );

  useLayoutEffect(() => {
    let isActive = true;

    if (!code || !shouldHighlight) {
      setHighlightedCode(null);
      return () => {
        isActive = false;
      };
    }

    setHighlightedCode(null);
    const lang = language && SUPPORTED_LANGUAGES.has(language)
      ? language
      : 'text';

    codeToHtml(code, {
      lang,
      themes: SHIKI_DEFAULT_THEMES,
      defaultColor: false,
    })
      .then((html) => {
        if (isActive) setHighlightedCode(html);
      })
      .catch(() => {
        if (isActive) setHighlightedCode(null);
      });

    return () => {
      isActive = false;
    };
  }, [code, language, shouldHighlight]);

  const handleCopy = useCallback(async () => {
    if (!navigator?.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failures (permissions, unsupported contexts).
    }
  }, [code]);

  return (
    <div className={cn('group/code relative', layout === 'dialog' && 'max-h-[60vh] overflow-auto')}>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 rounded-md p-1 opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-muted"
        aria-label="Copy source"
      >
        {copied ? (
          <Check className="size-3.5 text-green-500" />
        ) : (
          <Copy className="size-3.5 text-muted-foreground" />
        )}
      </button>

      {highlightedCode ? (
        <div
          className="source-preview-lines font-mono text-xs leading-5 text-foreground [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:px-3 [&_pre]:py-4 [&_pre]:pr-10"
          style={sourceStyle}
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      ) : (
        <div
          className={cn(
            'source-preview-lines font-mono text-xs leading-5 [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:px-3 [&_pre]:py-4 [&_pre]:pr-10',
            !shouldRenderLineSpans && 'source-preview-plain',
            code ? 'text-foreground' : 'text-muted-foreground'
          )}
          style={sourceStyle}
        >
          <pre>
            {shouldRenderLineSpans ? (
              <code>
                {fallbackLines.map((line, index) => (
                  <span className="line" key={index}>
                    {line || '\u00a0'}
                  </span>
                ))}
              </code>
            ) : (
              <code>{fallbackContent}</code>
            )}
          </pre>
        </div>
      )}
      {truncated ? (
        <PreviewTruncationFooter
          shownLines={maxLines}
          totalLines={totalLines}
          truncatedBy={truncatedBy}
          canLoadFull={Boolean(canLoadFull && onLoadFull)}
          status={loadFullStatus}
          onLoadFull={() => onLoadFull?.()}
          sizeBytes={sizeBytes}
          downloadUrl={downloadUrl}
          downloadFilename={downloadFilename}
        />
      ) : null}
    </div>
  );
}

export function CodePreview(props: CodePreviewProps) {
  return <SourcePreview {...props} />;
}
