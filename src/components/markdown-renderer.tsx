'use client';

import {
  Fragment,
  Children,
  cloneElement,
  isValidElement,
  memo,
  useMemo,
  useState,
  useCallback,
  useLayoutEffect,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import type { Options as RehypeSanitizeSchema } from 'rehype-sanitize';
import type { PluggableList } from 'unified';
import { cn } from '@/lib/utils';
import { Check, Copy, ImageOff } from 'lucide-react';
import { codeToHtml, SHIKI_DEFAULT_THEMES, SUPPORTED_LANGUAGES } from '@/lib/shiki-config.client';
import { MentionChip } from '@/components/at-mention-menu/mention-chip';
import {
  parseMentions,
  type AnnotatedMentionRef,
  type MentionMatch,
} from '@/lib/mentions';
import type { AtMentionEntity } from '@/types';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  variant?: 'default' | 'user';
  allowInlineHtml?: boolean;
  workspaceId?: string;
  mentionSlugMap?: Map<string, AtMentionEntity>;
  annotatedMentions?: ReadonlyArray<AnnotatedMentionRef>;
}

const PROVIDER_CITATION_REGEX = /cite[^]+/g;
// Notebook markdown follows Jupyter's "markdown plus safe HTML" behavior. The
// sanitizer runs over the full markdown tree, so keep the default safe schema
// for standard markdown output and add the inline tags needed by notebooks.
const NOTEBOOK_HTML_SCHEMA: RehypeSanitizeSchema = {
  ...defaultSchema,
  tagNames: Array.from(new Set([...(defaultSchema.tagNames ?? []), 'mark', 'sub', 'sup', 'br'])),
};

const NOTEBOOK_HTML_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  [rehypeSanitize, NOTEBOOK_HTML_SCHEMA],
];

type SourcePositionedNode = {
  position?: {
    start?: {
      offset?: number;
    };
  };
};

function isMarkdownHeadingNode(
  node: unknown,
  sourceContent: string,
  level: 1 | 2 | 3 | 4
): boolean {
  const offset = (node as SourcePositionedNode | undefined)?.position?.start?.offset;
  if (typeof offset !== 'number') return true;

  const marker = '#'.repeat(level);
  const sourceAtNode = sourceContent.slice(offset, offset + level + 5);
  return new RegExp(`^ {0,3}${marker}(?:\\s|$)`).test(sourceAtNode);
}

export function normalizeProviderCitationMarkers(content: string): string {
  if (!content.includes('cite')) {
    return content;
  }

  // Some model transports leak raw web-search citation markers into visible text
  // without the structured metadata needed to render real links. Strip the
  // markers so users do not see broken token artifacts like citeturn1search0.
  return content.replace(PROVIDER_CITATION_REGEX, '');
}

function replaceWorkspaceIdPlaceholder(value: string | undefined, workspaceId?: string): string | undefined {
  if (!value || !workspaceId) return value;
  return value
    .replaceAll('${WORKSPACE_ID}', workspaceId)
    .replaceAll('$%7BWORKSPACE_ID%7D', encodeURIComponent(workspaceId))
    .replaceAll('$%7bWORKSPACE_ID%7d', encodeURIComponent(workspaceId))
    .replaceAll('%24%7BWORKSPACE_ID%7D', encodeURIComponent(workspaceId))
    .replaceAll('%24%7bWORKSPACE_ID%7d', encodeURIComponent(workspaceId));
}

function replaceWorkspaceIdInChildren(children: ReactNode, workspaceId?: string): ReactNode {
  if (!workspaceId) return children;
  if (typeof children === 'string') {
    return replaceWorkspaceIdPlaceholder(children, workspaceId);
  }
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <Fragment key={index}>{replaceWorkspaceIdInChildren(child, workspaceId)}</Fragment>
    ));
  }
  if (isValidElement(children)) {
    const child = children as ReactElement<{ children?: ReactNode }>;
    if (child.props.children !== undefined) {
      return cloneElement(
        child,
        undefined,
        replaceWorkspaceIdInChildren(child.props.children, workspaceId),
      );
    }
  }
  return children;
}

// Inline code component - simple styled span
function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded-md bg-muted font-mono text-[0.875em]">
      {children}
    </code>
  );
}

// Code block component with syntax highlighting and copy button
function CodeBlockPre({
  children,
  isStreaming = false,
}: {
  children?: React.ReactNode;
  isStreaming?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);

  // Extract code content and language from the child code element
  // react-markdown renders: <pre><code className="language-xxx">...</code></pre>
  let codeString = '';
  let language = '';

  if (children && typeof children === 'object' && 'props' in (children as React.ReactElement)) {
    const codeElement = children as React.ReactElement<{ children?: React.ReactNode; className?: string }>;
    codeString = String(codeElement.props.children || '').replace(/\n$/, '');
    const match = /language-(\w+)/.exec(codeElement.props.className || '');
    language = match ? match[1] : '';
  }

  useLayoutEffect(() => {
    let isActive = true;

    if (!codeString || isStreaming) {
      setHighlightedCode(null);
      return () => {
        isActive = false;
      };
    }

    const lang = language && SUPPORTED_LANGUAGES.has(language)
      ? language
      : 'text';
    codeToHtml(codeString, {
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
  }, [codeString, language, isStreaming]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [codeString]);

  return (
    <div className="group/code relative my-4">
      {language && (
        <div className="absolute top-0 left-0 px-3 py-1 text-xs text-muted-foreground font-mono bg-muted/50 rounded-tl-lg rounded-br-lg z-10">
          {language}
        </div>
      )}
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-muted/80 hover:bg-muted opacity-0 group-hover/code:opacity-100 transition-opacity z-10"
        aria-label="Copy code"
      >
        {copied ? (
          <Check className="size-4 text-green-500" />
        ) : (
          <Copy className="size-4 text-muted-foreground" />
        )}
      </button>
      {highlightedCode ? (
        <div
          className="shiki-wrapper overflow-x-auto rounded-lg text-sm [&_pre]:!bg-muted/50 [&_pre]:p-4 [&_pre]:pt-8 [&_pre]:min-w-max"
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      ) : (
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-4 pt-8 text-sm font-mono">
          <code>{codeString}</code>
        </pre>
      )}
    </div>
  );
}

// react-markdown leaf text inside these elements should stay literal — never
// transform `@slug` inside inline code or code blocks.
function isOpaqueElement(element: ReactElement): boolean {
  const t = (element as ReactElement & { type: unknown }).type;
  if (t === InlineCode || t === CodeBlockPre) return true;
  if (typeof t === 'string') return t === 'code' || t === 'pre';
  return false;
}

function buildAnnotatedIdsBySlug(
  annotatedMentions: ReadonlyArray<AnnotatedMentionRef> | undefined,
): Map<string, Array<string | null>> {
  const idsBySlug = new Map<string, Array<string | null>>();
  for (const mention of annotatedMentions ?? []) {
    const ids = idsBySlug.get(mention.slug) ?? [];
    ids.push(mention.id);
    idsBySlug.set(mention.slug, ids);
  }
  return idsBySlug;
}

const NO_ANNOTATION = Symbol('no mention annotation');

class MentionAnnotationCursor {
  private readonly annotatedIdsBySlug: ReadonlyMap<string, ReadonlyArray<string | null>>;
  private readonly offsetsBySlug = new Map<string, number>();

  constructor(annotatedIdsBySlug: ReadonlyMap<string, ReadonlyArray<string | null>>) {
    this.annotatedIdsBySlug = annotatedIdsBySlug;
  }

  next(slug: string): string | null | typeof NO_ANNOTATION {
    const ids = this.annotatedIdsBySlug.get(slug);
    const offset = this.offsetsBySlug.get(slug) ?? 0;
    if (!ids || offset >= ids.length) {
      return NO_ANNOTATION;
    }
    this.offsetsBySlug.set(slug, offset + 1);
    return ids[offset]!;
  }
}

function resolveMentionChipTarget(
  match: MentionMatch<AtMentionEntity>,
  annotatedId: string | null | typeof NO_ANNOTATION,
): AtMentionEntity | null {
  const currentTarget = match.target;

  if (annotatedId === NO_ANNOTATION) {
    return currentTarget;
  }

  if (currentTarget && annotatedId === currentTarget.id) {
    return currentTarget;
  }

  return null;
}

function replaceMentionsInText(
  text: string,
  slugMap: Map<string, AtMentionEntity>,
  annotationCursor: MentionAnnotationCursor,
  keyPrefix: string,
): ReactNode[] {
  // Render chips for live slugs and for slugs whose stripped annotation proves
  // they were once real mentions. Random unknown `@words` stay as plain text.
  const matches = parseMentions(text, slugMap);
  if (matches.length === 0) return [text];

  const out: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const annotatedId = annotationCursor.next(m.slug);
    if (m.target === null && annotatedId === NO_ANNOTATION) {
      continue;
    }

    if (m.index > cursor) {
      out.push(text.slice(cursor, m.index));
    }
    out.push(
      <MentionChip
        key={`${keyPrefix}-m${i}`}
        slug={m.slug}
        target={resolveMentionChipTarget(m, annotatedId)}
      />,
    );
    cursor = m.index + m.length;
  }
  if (cursor < text.length) {
    out.push(text.slice(cursor));
  }
  return out;
}

function withMentionChips(
  children: ReactNode,
  slugMap: Map<string, AtMentionEntity>,
  annotationCursor: MentionAnnotationCursor,
  keyPrefix = 'mc',
): ReactNode {
  if (typeof children === 'string') {
    const parts = replaceMentionsInText(
      children,
      slugMap,
      annotationCursor,
      keyPrefix,
    );
    if (parts.length === 1 && parts[0] === children) return children;
    return parts.map((part, i) => (
      <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>
    ));
  }
  if (Array.isArray(children)) {
    return Children.map(children, (child, i) =>
      withMentionChips(child, slugMap, annotationCursor, `${keyPrefix}-${i}`),
    );
  }
  if (isValidElement(children)) {
    if (isOpaqueElement(children)) return children;
    const c = children as ReactElement<{ children?: ReactNode }>;
    if (c.props && c.props.children !== undefined) {
      return cloneElement(
        c,
        undefined,
        withMentionChips(c.props.children, slugMap, annotationCursor, keyPrefix),
      );
    }
    return children;
  }
  return children;
}

// Custom components for react-markdown
const createComponents = (
  variant: 'default' | 'user',
  sourceContent: string,
  isStreaming: boolean,
  workspaceId?: string,
  mentionSlugMap?: Map<string, AtMentionEntity>,
  annotatedMentions?: ReadonlyArray<AnnotatedMentionRef>,
): Components => {
  const annotatedIdsBySlug = buildAnnotatedIdsBySlug(annotatedMentions);
  const canRenderMentions = Boolean(mentionSlugMap || annotatedIdsBySlug.size);
  const slugMap = mentionSlugMap ?? new Map<string, AtMentionEntity>();
  const annotationCursor = new MentionAnnotationCursor(annotatedIdsBySlug);
  const wrap = (children: ReactNode, keyPrefix: string) =>
    canRenderMentions
      ? withMentionChips(children, slugMap, annotationCursor, keyPrefix)
      : children;
  const markdownHeadingProps = (node: unknown, level: 1 | 2 | 3 | 4) =>
    isMarkdownHeadingNode(node, sourceContent, level)
      ? { 'data-markdown-heading': 'true' }
      : {};
  return ({
  // Paragraphs
  p: ({ children }) => (
    <p className="mb-4 last:mb-0 leading-relaxed">{wrap(children, 'p')}</p>
  ),

  // Headings
  h1: ({ children, node }) => (
    <h1
      {...markdownHeadingProps(node, 1)}
      className="text-2xl font-bold mt-6 mb-4 first:mt-0"
    >
      {wrap(children, 'h1')}
    </h1>
  ),
  h2: ({ children, node }) => (
    <h2
      {...markdownHeadingProps(node, 2)}
      className="text-xl font-bold mt-6 mb-3 first:mt-0"
    >
      {wrap(children, 'h2')}
    </h2>
  ),
  h3: ({ children, node }) => (
    <h3
      {...markdownHeadingProps(node, 3)}
      className="text-lg font-semibold mt-5 mb-2 first:mt-0"
    >
      {wrap(children, 'h3')}
    </h3>
  ),
  h4: ({ children, node }) => (
    <h4
      {...markdownHeadingProps(node, 4)}
      className="text-base font-semibold mt-4 mb-2 first:mt-0"
    >
      {wrap(children, 'h4')}
    </h4>
  ),

  // Inline code - simple styled span
  code: InlineCode as Components['code'],

  // Code blocks - pre wraps code, handles syntax highlighting and copy
  pre: ({ children }) => <CodeBlockPre isStreaming={isStreaming}>{children}</CodeBlockPre>,

  // Links
  a: ({ href, children }) => {
    const resolvedHref = replaceWorkspaceIdPlaceholder(href, workspaceId);
    // Internal API links (workspace outputs) should not open in new tab
    const isInternal = resolvedHref?.startsWith('/api/');

    return (
      <a
        href={resolvedHref}
        target={isInternal ? undefined : '_blank'}
        rel={isInternal ? undefined : 'noopener noreferrer'}
        className={cn(
          'underline underline-offset-2 hover:no-underline',
          variant === 'user' ? 'text-primary-foreground/90' : 'text-primary'
        )}
      >
        {wrap(replaceWorkspaceIdInChildren(children, workspaceId), 'a')}
      </a>
    );
  },

  // Lists
  ul: ({ children }) => (
    <ul className="list-disc list-outside ml-6 mb-4 space-y-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-outside ml-6 mb-4 space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{wrap(children, 'li')}</li>,

  // Blockquotes
  blockquote: ({ children }) => (
    <blockquote
      className={cn(
        'border-l-4 pl-4 my-4 italic',
        variant === 'user'
          ? 'border-primary-foreground/30 text-primary-foreground/80'
          : 'border-border text-muted-foreground'
      )}
    >
      {wrap(children, 'bq')}
    </blockquote>
  ),

  // Tables
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="min-w-full border-collapse border border-border">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-muted/50">{children}</thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr className="border-b border-border">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2 text-left font-semibold border-r border-border last:border-r-0">
      {wrap(children, 'th')}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 border-r border-border last:border-r-0">
      {wrap(children, 'td')}
    </td>
  ),

  // Horizontal rule
  hr: () => <hr className="my-6 border-border" />,

  // Strong and emphasis
  strong: ({ children }) => <strong className="font-semibold">{wrap(children, 'strong')}</strong>,
  em: ({ children }) => <em className="italic">{wrap(children, 'em')}</em>,

  // Strikethrough
  del: ({ children }) => <del className="line-through">{wrap(children, 'del')}</del>,

  // Safe opt-in inline HTML used by notebook markdown cells and outputs.
  mark: ({ children }) => (
    <mark className="rounded bg-yellow-200/70 px-0.5 text-yellow-950 dark:bg-yellow-300/30 dark:text-yellow-50">
      {wrap(children, 'mark')}
    </mark>
  ),
  sub: ({ children }) => <sub>{wrap(children, 'sub')}</sub>,
  sup: ({ children }) => <sup>{wrap(children, 'sup')}</sup>,
  br: () => <br />,

  // Images
  img: ({ src, alt }) => {
    const resolvedSrc = replaceWorkspaceIdPlaceholder(src, workspaceId);
    return <MarkdownImage key={resolvedSrc} src={resolvedSrc} alt={alt} />;
  },
});
};

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [hasError, setHasError] = useState(false);

  if (!src || hasError) {
    return (
      <span
        role="img"
        aria-label={alt || 'Image unavailable'}
        className="inline-flex max-w-full items-center gap-2 my-4 px-3 py-2 rounded-lg border border-border bg-muted/40 text-xs text-muted-foreground"
      >
        <ImageOff className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{alt || 'Image unavailable'}</span>
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt || ''}
      loading="lazy"
      decoding="async"
      onError={() => setHasError(true)}
      className="max-w-full h-auto rounded-lg my-4"
    />
  );
}

function MarkdownRendererBase({
  content,
  className,
  isStreaming = false,
  variant = 'default',
  allowInlineHtml = false,
  workspaceId,
  mentionSlugMap,
  annotatedMentions,
}: MarkdownRendererProps) {
  // Process content for streaming - auto-close unclosed code fences
  const processedContent = useMemo(() => {
    const normalizedContent = normalizeProviderCitationMarkers(content);
    if (!isStreaming) return normalizedContent;

    // Count code fences to check if one is unclosed
    const fenceCount = (normalizedContent.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      // Unclosed fence - add a closing one for better preview
      return normalizedContent + '\n```';
    }
    return normalizedContent;
  }, [content, isStreaming]);

  const components = useMemo(
    () => createComponents(
      variant,
      processedContent,
      isStreaming,
      workspaceId,
      mentionSlugMap,
      annotatedMentions,
    ),
    [
      variant,
      processedContent,
      isStreaming,
      workspaceId,
      mentionSlugMap,
      annotatedMentions,
    ],
  );

  return (
    <div
      className={cn(
        'markdown-content',
        variant === 'user' && 'markdown-content-user',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={allowInlineHtml ? NOTEBOOK_HTML_REHYPE_PLUGINS : undefined}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}

// Memoize to prevent unnecessary re-renders during streaming
export const MarkdownRenderer = memo(MarkdownRendererBase, (prev, next) => {
  return (
    prev.content === next.content &&
    prev.className === next.className &&
    prev.isStreaming === next.isStreaming &&
    prev.variant === next.variant &&
    prev.allowInlineHtml === next.allowInlineHtml &&
    prev.workspaceId === next.workspaceId &&
    prev.mentionSlugMap === next.mentionSlugMap &&
    prev.annotatedMentions === next.annotatedMentions
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
