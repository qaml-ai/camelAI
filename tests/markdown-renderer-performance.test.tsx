import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';

vi.mock('@/lib/shiki-config.client', () => ({
  codeToHtml: vi.fn(() => new Promise<string>(() => {})),
  SHIKI_DEFAULT_THEMES: {
    light: 'github-light',
    dark: 'github-dark',
  },
  SUPPORTED_LANGUAGES: new Set(['bash', 'json', 'text', 'ts', 'tsx']),
}));

import { MarkdownRenderer } from '@/components/markdown-renderer';
import { codeToHtml } from '@/lib/shiki-config.client';
import type { AtMentionConnection, Integration } from '@/types';

const codeToHtmlMock = vi.mocked(codeToHtml);

function integration(fields: Pick<Integration, 'id' | 'integration_type' | 'name'>): AtMentionConnection {
  return {
    kind: 'connection',
    category: 'databases',
    auth_method: 'api_key',
    config: {},
    created_by: 'user',
    created_at: 0,
    updated_at: 0,
    has_credentials: true,
    ...fields,
  };
}

function buildMixedMarkdownSection(index: number): string {
  return [
    `## Section ${index}`,
    '',
    `Paragraph ${index} with **bold**, _italic_, inline \`code_${index}\`, @database, and [a link](https://example.com/${index}).`,
    '',
    `- Bullet ${index}.1`,
    `- Bullet ${index}.2`,
    `  - Nested bullet ${index}.2.a`,
    '',
    `1. Ordered ${index}.1`,
    `2. Ordered ${index}.2`,
    '',
    `> Important quoted note ${index}`,
    '',
    '| Name | Value |',
    '| --- | ---: |',
    `| alpha-${index} | ${index} |`,
    `| beta-${index} | ${index * 2} |`,
    '',
    `![Chart ${index}](https://example.com/chart-${index}.png)`,
    '',
    '```tsx',
    `export function Example${index}() {`,
    `  return <button data-index="${index}">Run ${index}</button>;`,
    '}',
    '```',
    '',
    '```json',
    JSON.stringify({ section: index, status: 'ok' }, null, 2),
    '```',
    '',
  ].join('\n');
}

function buildLargeMixedMarkdown(sectionCount: number): string {
  return [
    '# Streaming and render performance fixture',
    '',
    ...Array.from({ length: sectionCount }, (_, index) =>
      buildMixedMarkdownSection(index),
    ),
  ].join('\n');
}

function elementCount(container: HTMLElement): number {
  return container.querySelectorAll('*').length;
}

afterEach(() => {
  codeToHtmlMock.mockClear();
});

describe('MarkdownRenderer performance guards', () => {
  it('renders large streaming markdown through the markdown path', () => {
    const content = buildLargeMixedMarkdown(30);
    const mentionSlugMap = new Map([
      ['database', integration({ id: 'database-1', integration_type: 'postgres', name: 'Database' })],
    ]);
    const { container, rerender } = render(
      createElement(MarkdownRenderer, {
        content,
        isStreaming: true,
        mentionSlugMap,
      }),
    );

    expect(codeToHtmlMock).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', {
      level: 1,
      name: 'Streaming and render performance fixture',
    })).toBeInTheDocument();
    expect(container.querySelectorAll('h2')).toHaveLength(30);
    expect(container.querySelectorAll('ul').length).toBeGreaterThanOrEqual(30);
    expect(container.querySelectorAll('ol')).toHaveLength(30);
    expect(container.querySelectorAll('table')).toHaveLength(30);
    expect(container.querySelectorAll('blockquote')).toHaveLength(30);
    expect(container.querySelectorAll('img')).toHaveLength(30);
    expect(container.querySelectorAll('pre')).toHaveLength(60);
    expect(screen.getAllByText('@database')).toHaveLength(30);
    expect(container).toHaveTextContent('export function Example29');
    const initialElementCount = elementCount(container);
    expect(initialElementCount).toBeGreaterThan(1);

    const root = container.firstElementChild;
    rerender(
      createElement(MarkdownRenderer, {
        content,
        isStreaming: true,
        mentionSlugMap,
      }),
    );

    expect(container.firstElementChild).toBe(root);
    expect(codeToHtmlMock).not.toHaveBeenCalled();
    expect(elementCount(container)).toBe(initialElementCount);
  });

  it('renders completed mixed markdown with the expected rich structure', async () => {
    const content = buildLargeMixedMarkdown(3);
    const { container } = render(
      createElement(MarkdownRenderer, {
        content,
        mentionSlugMap: new Map([
          ['database', integration({ id: 'database-1', integration_type: 'postgres', name: 'Database' })],
        ]),
      }),
    );

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Streaming and render performance fixture',
    );
    expect(container.querySelectorAll('h2')).toHaveLength(3);
    expect(container.querySelectorAll('ul').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll('ol')).toHaveLength(3);
    expect(container.querySelectorAll('table')).toHaveLength(3);
    expect(container.querySelectorAll('blockquote')).toHaveLength(3);
    expect(container.querySelectorAll('img')).toHaveLength(3);
    expect(screen.getAllByText('@database')).toHaveLength(3);

    await waitFor(() => {
      expect(codeToHtmlMock).toHaveBeenCalledTimes(6);
    });
  });

  it.each([
    ['headings', '# Title\n\n## Details\n\nBody text.', 'h1,h2'],
    ['lists', '- One\n- Two\n  - Nested\n\n1. First\n2. Second', 'ul,ol'],
    ['tables', '| A | B |\n| --- | ---: |\n| x | 1 |', 'table'],
    ['quotes', '> Quoted\n>\n> - with a list', 'blockquote'],
    ['code fences', '```bash\necho hello\n```', 'pre,code'],
    ['images and links', '[Open](https://example.com)\n\n![Alt](https://example.com/a.png)', 'a,img'],
    ['mentions', 'Use @database for this query.', 'span'],
  ])('renders completed %s content without exploding the DOM', async (_name, snippet, selector) => {
    const repeatedSnippet = Array.from({ length: 8 }, () => snippet).join('\n\n');
    const { container } = render(
      createElement(MarkdownRenderer, {
        content: repeatedSnippet,
        mentionSlugMap: new Map([
          ['database', integration({ id: 'database-1', integration_type: 'postgres', name: 'Database' })],
        ]),
      }),
    );

    expect(container.querySelector(selector)).toBeInTheDocument();
    expect(elementCount(container)).toBeLessThan(350);

    if (snippet.includes('```')) {
      await waitFor(() => {
        expect(codeToHtmlMock).toHaveBeenCalled();
      });
    }
  });

  it.each([
    ['headings', '# Title\n\n## Details\n\nBody text.', 'h1,h2'],
    ['lists', '- One\n- Two\n  - Nested\n\n1. First\n2. Second', 'ul,ol'],
    ['tables', '| A | B |\n| --- | ---: |\n| x | 1 |', 'table'],
    ['quotes', '> Quoted\n>\n> - with a list', 'blockquote'],
    ['code fences', '```bash\necho hello\n```', 'pre,code'],
    ['images and links', '[Open](https://example.com)\n\n![Alt](https://example.com/a.png)', 'a,img'],
    ['mentions', 'Use @database for this query.', 'span'],
  ])('renders streaming %s content through the markdown parser path', (_name, snippet, selector) => {
    const repeatedSnippet = Array.from({ length: 25 }, () => snippet).join('\n\n');
    const { container } = render(
      createElement(MarkdownRenderer, {
        content: repeatedSnippet,
        isStreaming: true,
        mentionSlugMap: new Map([
          ['database', integration({ id: 'database-1', integration_type: 'postgres', name: 'Database' })],
        ]),
      }),
    );

    expect(container.querySelector(selector)).toBeInTheDocument();
    expect(elementCount(container)).toBeGreaterThan(1);
    expect(codeToHtmlMock).not.toHaveBeenCalled();
  });
});
