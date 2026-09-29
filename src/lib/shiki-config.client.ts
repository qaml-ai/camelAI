import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  shell: () => import('shiki/langs/shellscript.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
};

export const SUPPORTED_LANGUAGES = new Set(Object.keys(LANG_LOADERS));

export const SHIKI_DEFAULT_THEMES = {
  light: 'github-light' as const,
  dark: 'github-dark' as const,
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs'),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

const langLoadPromises = new Map<string, Promise<void>>();

async function ensureLangLoaded(highlighter: HighlighterCore, lang: string) {
  if (highlighter.getLoadedLanguages().includes(lang)) return;
  const loader = LANG_LOADERS[lang];
  if (!loader) return;
  let pending = langLoadPromises.get(lang);
  if (!pending) {
    pending = loader().then(async (mod) => {
      await highlighter.loadLanguage(mod as Parameters<HighlighterCore['loadLanguage']>[0]);
    });
    langLoadPromises.set(lang, pending);
  }
  await pending;
}

export async function codeToHtml(
  code: string,
  options: {
    lang: string;
    themes: typeof SHIKI_DEFAULT_THEMES;
    defaultColor: false;
  },
): Promise<string> {
  const highlighter = await getHighlighter();
  await ensureLangLoaded(highlighter, options.lang);
  return highlighter.codeToHtml(code, {
    lang: options.lang,
    themes: options.themes,
    defaultColor: options.defaultColor,
  });
}
