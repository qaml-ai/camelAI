import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import type { Browser, KeyInput, Page } from '@cloudflare/puppeteer';
import type { CodeModeToolsProps } from './code-mode-tools.js';
import type { OrgDO } from './auth.js';
import {
  bufferToImageDataUrl,
  installDispatchRequestInterception,
  screenshotClip,
  screenshotViewport,
  truncateError,
} from './app-screenshot-capture.js';
import {
  buildWorkspaceAppHostIndex,
  buildWorkspaceAppUrl,
  isWorkspaceAppHostname,
  type WorkspaceAppFetcherEnv,
  type WorkspaceAppHostIndex,
} from './workspace-app-fetcher.js';

export interface AppBrowserBindingEnv extends WorkspaceAppFetcherEnv {
  BROWSER?: Fetcher;
  ORG: DurableObjectNamespace<OrgDO>;
}

export type AppBrowserBindingProps = Pick<CodeModeToolsProps, 'orgId' | 'workspaceId'>;

export const BROWSER_SESSION_MAX_LIFETIME_MS = 300_000;
export const BROWSER_SESSION_NAVIGATION_TIMEOUT_MS = 30_000;
export const BROWSER_SESSION_DEFAULT_ACTION_TIMEOUT_MS = 10_000;
export const BROWSER_SESSION_MAX_ACTION_TIMEOUT_MS = 60_000;
export const BROWSER_SESSION_MAX_LOG_ENTRIES = 200;
export const BROWSER_SESSION_MAX_TEXT_CHARS = 30_000;

// Soft, account-wide cap on concurrently active Browser Rendering sessions,
// enforced at launch() as a cost safety net. Cloudflare's hard account cap is
// 120 and the paid tier includes 10 concurrent browsers; 20 blocks runaway
// usage an order of magnitude below the hard cap while leaving headroom above
// the included tier for legitimate concurrent testing. It is read from the
// platform's account-global live session list (puppeteer.sessions).
export const BROWSER_MAX_ACTIVE_SESSIONS = 20;

// Per-workspace cap, enforced alongside the account cap. Keeps one workspace
// from monopolizing the account budget (or a runaway js_exec loop from denying
// browser tests to every other workspace) while still allowing a handful of
// parallel tests. Counted from the OrgDO per-workspace registry, reconciled
// against the live session list so leaked sessions self-heal.
export const BROWSER_MAX_ACTIVE_SESSIONS_PER_WORKSPACE = 5;

export interface AppBrowserLaunchInput {
  scriptName: string;
  path?: string;
  width?: number;
  height?: number;
}

export interface AppBrowserActionOptions {
  timeoutMs?: number;
}

export interface BrowserConsoleEntry {
  type: string;
  text: string;
}

export interface BrowserRequestFailure {
  url: string;
  method: string;
  status?: number;
  error?: string;
}

export interface AppBrowserSessionLogs {
  console: BrowserConsoleEntry[];
  pageErrors: string[];
  requestFailures: BrowserRequestFailure[];
  truncated: boolean;
}

function clampActionTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return BROWSER_SESSION_DEFAULT_ACTION_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(timeoutMs), 100), BROWSER_SESSION_MAX_ACTION_TIMEOUT_MS);
}

function truncateText(value: string, maxLength: number): { text: string; truncated: boolean } {
  if (value.length <= maxLength) return { text: value, truncated: false };
  return { text: value.slice(0, maxLength), truncated: true };
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) ?? null;
  } catch {
    return String(value);
  }
}

function requireSelector(selector: unknown): string {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error('selector must be a non-empty string');
  }
  return selector;
}

/**
 * Throws if the account already has `cap` or more active Browser Rendering
 * sessions. `activeSessions` is the account-global live list from
 * `puppeteer.sessions` (a non-array is treated as zero). Pure so it can be
 * unit-tested without a live binding. Racy by nature — two simultaneous launches
 * can both observe the same count — which is acceptable for a cost safety net
 * well below the 120 hard cap.
 */
export function assertBrowserSessionCapacity(
  activeSessions: unknown,
  cap: number = BROWSER_MAX_ACTIVE_SESSIONS,
): number {
  const activeCount = Array.isArray(activeSessions) ? activeSessions.length : 0;
  if (activeCount >= cap) {
    throw new Error(
      `Too many browser sessions are active on this account (${activeCount}/${cap}). `
        + 'Wait for running tests to finish — sessions auto-close after 5 minutes — and try again.',
    );
  }
  return activeCount;
}

/**
 * Throws if this workspace already has `cap` or more active browser sessions.
 * `workspaceActiveCount` is the reconciled count from OrgDO.reconcileBrowserSessions.
 * Pure, and racy in the same benign way as the account-wide check.
 */
export function assertWorkspaceBrowserSessionCapacity(
  workspaceActiveCount: number,
  cap: number = BROWSER_MAX_ACTIVE_SESSIONS_PER_WORKSPACE,
): number {
  const count = Number.isFinite(workspaceActiveCount) ? workspaceActiveCount : 0;
  if (count >= cap) {
    throw new Error(
      `This workspace already has ${count}/${cap} browser sessions running. `
        + 'Close a session or wait for one to finish — sessions auto-close after 5 minutes — and try again.',
    );
  }
  return count;
}

export interface AppBrowserSessionInit {
  browser: Browser;
  page: Page;
  baseUrl: URL;
  hostIndex: WorkspaceAppHostIndex;
  logContext: Record<string, unknown>;
  remoteSessionId?: string | null;
  removeInterception?: () => void;
  maxLifetimeMs?: number;
  // Best-effort cleanup hook fired once when the session closes (any reason:
  // explicit close, lifetime expiry, or disposer). Used to drop the session
  // from the per-workspace registry. Failures are swallowed.
  onClose?: () => void | Promise<void>;
}

/**
 * Interactive browser session over Cloudflare Browser Rendering, scoped to one
 * deployed workspace app. Returned by `AppBrowserBinding.launch` as an RPC
 * target so `js_exec` code can drive it like a small Playwright script:
 * navigate, click, fill, wait for text/selectors, evaluate JS in the page,
 * capture screenshots, and read console/page errors accumulated so far.
 */
export class AppBrowserSession extends RpcTarget {
  private readonly browser: Browser;
  private readonly page: Page;
  private readonly baseUrl: URL;
  private readonly hostIndex: WorkspaceAppHostIndex;
  private readonly logContext: Record<string, unknown>;
  private readonly remoteSessionId: string | null;
  private readonly removeInterception?: () => void;
  private readonly onClose?: () => void | Promise<void>;
  private readonly lifetimeTimer: ReturnType<typeof setTimeout>;
  private readonly consoleEntries: BrowserConsoleEntry[] = [];
  private readonly pageErrors: string[] = [];
  private readonly requestFailures: BrowserRequestFailure[] = [];
  private logsTruncated = false;
  private closed = false;
  private closedReason: string | null = null;

  constructor(init: AppBrowserSessionInit) {
    super();
    this.browser = init.browser;
    this.page = init.page;
    this.baseUrl = init.baseUrl;
    this.hostIndex = init.hostIndex;
    this.logContext = init.logContext;
    this.remoteSessionId = init.remoteSessionId ?? null;
    this.removeInterception = init.removeInterception;
    this.onClose = init.onClose;
    const maxLifetimeMs = init.maxLifetimeMs ?? BROWSER_SESSION_MAX_LIFETIME_MS;
    this.lifetimeTimer = setTimeout(() => {
      void this.closeInternal(`session exceeded the ${maxLifetimeMs}ms lifetime limit`);
    }, maxLifetimeMs);
    this.attachLogListeners();
  }

  private attachLogListeners(): void {
    this.page.on('console', (message) => {
      this.pushLog(this.consoleEntries, {
        type: message.type(),
        text: truncateText(message.text(), 500).text,
      });
    });
    this.page.on('pageerror', (error) => {
      this.pushLog(this.pageErrors, truncateError(error, 1000));
    });
    this.page.on('requestfailed', (request) => {
      this.pushLog(this.requestFailures, {
        url: truncateText(request.url(), 300).text,
        method: request.method(),
        error: request.failure()?.errorText ?? 'failed',
      });
    });
    this.page.on('response', (response) => {
      if (response.status() >= 400) {
        this.pushLog(this.requestFailures, {
          url: truncateText(response.url(), 300).text,
          method: response.request().method(),
          status: response.status(),
        });
      }
    });
  }

  private pushLog<T>(list: T[], entry: T): void {
    if (list.length >= BROWSER_SESSION_MAX_LOG_ENTRIES) {
      this.logsTruncated = true;
      list.shift();
    }
    list.push(entry);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error(
        `Browser session is closed${this.closedReason ? ` (${this.closedReason})` : ''}. Launch a new session with env.BROWSER.launch(...).`,
      );
    }
  }

  private async run<T>(action: string, fn: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    try {
      return await fn();
    } catch (error) {
      throw new Error(`${action} failed: ${truncateError(error)}`);
    }
  }

  private async waitForSelectorInternal(
    selector: string,
    timeoutMs: number | undefined,
    visible: boolean,
    hidden = false,
  ): Promise<void> {
    await this.page.waitForSelector(selector, {
      timeout: clampActionTimeout(timeoutMs),
      visible: hidden ? undefined : visible,
      hidden: hidden || undefined,
    });
  }

  private resolveTarget(path: string | undefined): string {
    const trimmed = (path ?? '/').trim() || '/';
    let url: URL;
    if (/^https?:\/\//i.test(trimmed)) {
      url = new URL(trimmed);
    } else if (trimmed.startsWith('/')) {
      // Resolve relative to the app base. A protocol-relative path such as
      // "//other-host" (or "/\\other-host", which the URL parser normalizes to
      // "//") resolves to a *different* host, so the host allow-list check below
      // runs on the resolved URL for both branches — not just the absolute one.
      url = new URL(trimmed, this.baseUrl);
    } else {
      throw new Error('goto expects a path starting with "/" or a full workspace app URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`goto only supports http(s) targets; got ${url.protocol}`);
    }
    if (
      url.host !== this.baseUrl.host
      && !isWorkspaceAppHostname(this.hostIndex, url.hostname)
    ) {
      throw new Error(
        `goto only accepts paths or URLs on this workspace's app hosts; got ${url.hostname}`,
      );
    }
    return url.toString();
  }

  async goto(path?: string): Promise<{ url: string; status: number | null }> {
    const targetUrl = this.resolveTarget(path);
    return await this.run(`goto ${targetUrl}`, async () => {
      // Single committed navigation. Unlike the screenshot helper we do NOT wait
      // for networkidle: apps with SSE/long-polling/websockets never go idle, so
      // that would stall the full navigation timeout and then fire a *second*
      // goto — double-loading one-time URLs and route loaders with side effects.
      // Explicit waitForSelector/waitForText handle post-load dynamic content,
      // and HTTP error statuses are returned (not thrown) so tests can assert on
      // 404/500 pages.
      const response = await this.page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: BROWSER_SESSION_NAVIGATION_TIMEOUT_MS,
      });
      return { url: this.page.url(), status: response?.status() ?? null };
    });
  }

  async click(selector: string, options?: AppBrowserActionOptions): Promise<{ ok: true }> {
    requireSelector(selector);
    return await this.run(`click ${selector}`, async () => {
      await this.waitForSelectorInternal(selector, options?.timeoutMs, true);
      await this.page.click(selector);
      return { ok: true as const };
    });
  }

  async fill(
    selector: string,
    value: string,
    options?: AppBrowserActionOptions,
  ): Promise<{ ok: true }> {
    requireSelector(selector);
    const text = typeof value === 'string' ? value : String(value ?? '');
    return await this.run(`fill ${selector}`, async () => {
      await this.waitForSelectorInternal(selector, options?.timeoutMs, true);
      // Select-all then delete clears controlled inputs (e.g. React) through
      // real key events, unlike assigning element.value directly.
      await this.page.click(selector, { clickCount: 3 });
      await this.page.keyboard.press('Backspace');
      if (text) await this.page.type(selector, text);
      return { ok: true as const };
    });
  }

  async type(
    selector: string,
    text: string,
    options?: AppBrowserActionOptions,
  ): Promise<{ ok: true }> {
    requireSelector(selector);
    return await this.run(`type into ${selector}`, async () => {
      await this.waitForSelectorInternal(selector, options?.timeoutMs, true);
      await this.page.type(selector, typeof text === 'string' ? text : String(text ?? ''));
      return { ok: true as const };
    });
  }

  async press(key: string, options?: { selector?: string } & AppBrowserActionOptions): Promise<{ ok: true }> {
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('key must be a non-empty string, e.g. "Enter"');
    }
    return await this.run(`press ${key}`, async () => {
      if (options?.selector) {
        await this.waitForSelectorInternal(options.selector, options?.timeoutMs, true);
        await this.page.focus(options.selector);
      }
      await this.page.keyboard.press(key as KeyInput);
      return { ok: true as const };
    });
  }

  async select(
    selector: string,
    values: string | string[],
    options?: AppBrowserActionOptions,
  ): Promise<{ selected: string[] }> {
    requireSelector(selector);
    const list = (Array.isArray(values) ? values : [values]).map((value) => String(value));
    return await this.run(`select ${selector}`, async () => {
      await this.waitForSelectorInternal(selector, options?.timeoutMs, true);
      const selected = await this.page.select(selector, ...list);
      return { selected };
    });
  }

  async hover(selector: string, options?: AppBrowserActionOptions): Promise<{ ok: true }> {
    requireSelector(selector);
    return await this.run(`hover ${selector}`, async () => {
      await this.waitForSelectorInternal(selector, options?.timeoutMs, true);
      await this.page.hover(selector);
      return { ok: true as const };
    });
  }

  async waitForSelector(
    selector: string,
    options?: { hidden?: boolean } & AppBrowserActionOptions,
  ): Promise<{ ok: true }> {
    requireSelector(selector);
    const action = options?.hidden ? `wait for ${selector} to disappear` : `wait for ${selector}`;
    return await this.run(action, async () => {
      await this.waitForSelectorInternal(
        selector,
        options?.timeoutMs,
        true,
        options?.hidden === true,
      );
      return { ok: true as const };
    });
  }

  async waitForText(text: string, options?: AppBrowserActionOptions): Promise<{ ok: true }> {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('text must be a non-empty string');
    }
    return await this.run(`wait for text ${JSON.stringify(text)}`, async () => {
      await this.page.waitForFunction(
        (expected: string) => (document.body?.innerText ?? '').includes(expected),
        { timeout: clampActionTimeout(options?.timeoutMs) },
        text,
      );
      return { ok: true as const };
    });
  }

  async waitForFunction(expression: string, options?: AppBrowserActionOptions): Promise<{ ok: true }> {
    if (typeof expression !== 'string' || !expression.trim()) {
      throw new Error('expression must be a non-empty JavaScript string');
    }
    return await this.run('waitForFunction', async () => {
      await this.page.waitForFunction(expression, {
        timeout: clampActionTimeout(options?.timeoutMs),
      });
      return { ok: true as const };
    });
  }

  async waitForTimeout(ms: number): Promise<{ ok: true; waitedMs: number }> {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new Error('ms must be a non-negative number of milliseconds, e.g. waitForTimeout(500)');
    }
    const waitedMs = Math.min(Math.floor(ms), BROWSER_SESSION_MAX_ACTION_TIMEOUT_MS);
    return await this.run(`wait ${waitedMs}ms`, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, waitedMs));
      return { ok: true as const, waitedMs };
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    if (typeof expression !== 'string' || !expression.trim()) {
      throw new Error('expression must be a non-empty JavaScript string');
    }
    return await this.run('evaluate', async () => {
      const value = await this.page.evaluate(expression);
      return toJsonSafe(value);
    });
  }

  async textContent(
    selector?: string,
    options?: AppBrowserActionOptions,
  ): Promise<{ text: string; truncated: boolean }> {
    const target = selector === undefined ? 'body' : requireSelector(selector);
    return await this.run(`read text of ${target}`, async () => {
      await this.waitForSelectorInternal(target, options?.timeoutMs, false);
      const raw = await this.page.$eval(
        target,
        (element) => (element instanceof HTMLElement ? element.innerText : element.textContent) ?? '',
      );
      return truncateText(raw.trim(), BROWSER_SESSION_MAX_TEXT_CHARS);
    });
  }

  async hasText(
    text: string,
    options?: { selector?: string },
  ): Promise<boolean> {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('text must be a non-empty string');
    }
    const target = options?.selector === undefined
      ? 'body'
      : requireSelector(options.selector);
    return await this.run(`check text ${JSON.stringify(text)} in ${target}`, async () => {
      if (!await this.page.$(target)) return false;
      return await this.page.$eval(
        target,
        (element, expected) => {
          const visibleText = element instanceof HTMLElement
            ? element.innerText
            : element.textContent ?? '';
          return visibleText.includes(expected);
        },
        text,
      );
    });
  }

  async getAttribute(
    selector: string,
    attribute: string,
    options?: AppBrowserActionOptions,
  ): Promise<string | null> {
    requireSelector(selector);
    if (typeof attribute !== 'string' || !attribute.trim()) {
      throw new Error('attribute must be a non-empty string');
    }
    return await this.run(`read ${attribute} of ${selector}`, async () => {
      await this.waitForSelectorInternal(selector, options?.timeoutMs, false);
      return this.page.$eval(selector, (element, name) => element.getAttribute(name), attribute);
    });
  }

  async count(selector: string): Promise<number> {
    requireSelector(selector);
    return await this.run(`count ${selector}`, async () => {
      return this.page.$$eval(selector, (elements) => elements.length);
    });
  }

  async exists(selector: string): Promise<boolean> {
    requireSelector(selector);
    return await this.run(`check ${selector}`, async () => {
      return Boolean(await this.page.$(selector));
    });
  }

  async content(options?: {
    selector?: string;
    maxChars?: number;
  }): Promise<{ html: string; truncated: boolean }> {
    const maxChars = Math.min(
      typeof options?.maxChars === 'number' && options.maxChars > 0
        ? Math.floor(options.maxChars)
        : BROWSER_SESSION_MAX_TEXT_CHARS,
      BROWSER_SESSION_MAX_TEXT_CHARS,
    );
    return await this.run('read page content', async () => {
      const html = options?.selector
        ? await this.page.$eval(requireSelector(options.selector), (element) => element.outerHTML)
        : await this.page.content();
      const { text, truncated } = truncateText(html, maxChars);
      return { html: text, truncated };
    });
  }

  async url(): Promise<string> {
    this.ensureOpen();
    return this.page.url();
  }

  async title(): Promise<string> {
    return await this.run('read page title', () => this.page.title());
  }

  async screenshot(options?: {
    fullPage?: boolean;
  }): Promise<{ imageDataUrl: string; width: number; height: number }> {
    return await this.run('screenshot', async () => {
      const viewport = this.page.viewport();
      const width = viewport?.width ?? 1280;
      const height = viewport?.height ?? 720;
      const image = (await this.page.screenshot({
        type: 'jpeg',
        quality: 80,
        ...(options?.fullPage ? { fullPage: true } : { clip: screenshotClip(width, height) }),
      })) as Buffer;
      return { imageDataUrl: bufferToImageDataUrl(image), width, height };
    });
  }

  async logs(): Promise<AppBrowserSessionLogs> {
    return {
      console: [...this.consoleEntries],
      pageErrors: [...this.pageErrors],
      requestFailures: [...this.requestFailures],
      truncated: this.logsTruncated,
    };
  }

  async close(): Promise<{ closed: true }> {
    await this.closeInternal(null);
    return { closed: true as const };
  }

  sessionId(): string | null {
    return this.remoteSessionId;
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = 'session disconnected';
    clearTimeout(this.lifetimeTimer);
    try {
      this.removeInterception?.();
    } catch {
      // best-effort cleanup
    }
    try {
      await this.browser.disconnect();
    } catch (error) {
      console.warn('[app-browser] browser disconnect failed', {
        ...this.logContext,
        error: truncateError(error),
      });
    }
  }

  private async closeInternal(reason: string | null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason;
    clearTimeout(this.lifetimeTimer);
    try {
      this.removeInterception?.();
    } catch {
      // best-effort cleanup
    }
    try {
      await this.page.close();
    } catch (error) {
      console.warn('[app-browser] page close failed', {
        ...this.logContext,
        error: truncateError(error),
      });
    }
    try {
      await this.browser.close();
    } catch (error) {
      console.warn('[app-browser] browser close failed', {
        ...this.logContext,
        error: truncateError(error),
      });
    }
    try {
      await this.onClose?.();
    } catch (error) {
      console.warn('[app-browser] onClose hook failed', {
        ...this.logContext,
        error: truncateError(error),
      });
    }
  }

  [Symbol.dispose](): void {
    void this.closeInternal('session disposed').catch(() => {});
  }
}

export async function launchAppBrowserSession(
  env: AppBrowserBindingEnv,
  context: AppBrowserBindingProps,
  input: AppBrowserLaunchInput,
): Promise<AppBrowserSession> {
  const scriptName = input.scriptName?.trim();
  if (!scriptName) {
    throw new Error('scriptName is required');
  }
  if (!env.BROWSER) {
    throw new Error('Browser sessions require the BROWSER binding');
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
  const script = await orgStub.getWorkerScript(scriptName);
  if (!script) {
    throw new Error(`App not found: ${scriptName}`);
  }
  if (script.workspace_id !== context.workspaceId) {
    throw new Error(`App ${scriptName} is not in this workspace`);
  }
  if (!script.is_public && !env.DISPATCHER) {
    throw new Error('Browser sessions for private apps require the DISPATCHER binding');
  }

  const baseUrl = new URL(await buildWorkspaceAppUrl(env, context, scriptName, '/'));
  const logContext = {
    scriptName,
    orgId: context.orgId,
    workspaceId: context.workspaceId,
  };

  const { default: puppeteer } = await import('@cloudflare/puppeteer');

  let liveSessions: unknown[] | null = null;
  let workspaceSessionCount: number | null = null;
  try {
    const sessions = await puppeteer.sessions(env.BROWSER);
    liveSessions = Array.isArray(sessions) ? sessions : [];
    const liveIds = liveSessions
      .map((entry) => (entry as { sessionId?: unknown })?.sessionId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    workspaceSessionCount = await orgStub.reconcileBrowserSessions(
      context.workspaceId,
      liveIds,
    );
  } catch (error) {
    console.warn('[app-browser] session-capacity check failed; proceeding', {
      ...logContext,
      error: truncateError(error),
    });
  }
  if (liveSessions !== null) {
    assertBrowserSessionCapacity(liveSessions);
  }
  if (workspaceSessionCount !== null) {
    assertWorkspaceBrowserSessionCapacity(workspaceSessionCount);
  }

  const browser = await puppeteer.launch(env.BROWSER);
  const browserSessionId =
    typeof browser.sessionId === 'function' ? browser.sessionId() : null;
  try {
    const page = await browser.newPage();
    await page.setViewport(screenshotViewport(input.width, input.height));
    page.setDefaultTimeout(BROWSER_SESSION_DEFAULT_ACTION_TIMEOUT_MS);

    const hostIndex = await buildWorkspaceAppHostIndex(env, context);
    let removeInterception: (() => void) | undefined;
    if (!script.is_public) {
      removeInterception = await installDispatchRequestInterception(
        page,
        env,
        context,
        hostIndex,
        { redirect: 'manual' },
      );
    }

    const session = new AppBrowserSession({
      browser,
      page,
      baseUrl,
      hostIndex,
      logContext,
      remoteSessionId: browserSessionId,
      removeInterception,
      onClose: browserSessionId
        ? () => orgStub.removeBrowserSession(browserSessionId)
        : undefined,
    });
    try {
      await session.goto(input.path ?? '/');
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
    if (browserSessionId) {
      await orgStub
        .recordBrowserSession(context.workspaceId, browserSessionId)
        .catch((error) => {
          console.warn('[app-browser] failed to record browser session', {
            ...logContext,
            error: truncateError(error),
          });
        });
    }
    return session;
  } catch (error) {
    await browser.close().catch(() => {});
    throw new Error(`Browser session launch failed: ${truncateError(error)}`);
  }
}

export async function connectAppBrowserSession(
  env: AppBrowserBindingEnv,
  context: AppBrowserBindingProps,
  input: AppBrowserLaunchInput & { sessionId: string },
): Promise<AppBrowserSession> {
  const scriptName = input.scriptName?.trim();
  if (!scriptName) {
    throw new Error('scriptName is required');
  }
  const sessionId = input.sessionId?.trim();
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  if (!env.BROWSER) {
    throw new Error('Browser sessions require the BROWSER binding');
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
  const script = await orgStub.getWorkerScript(scriptName);
  if (!script) {
    throw new Error(`App not found: ${scriptName}`);
  }
  if (script.workspace_id !== context.workspaceId) {
    throw new Error(`App ${scriptName} is not in this workspace`);
  }
  if (!script.is_public && !env.DISPATCHER) {
    throw new Error('Browser sessions for private apps require the DISPATCHER binding');
  }

  const baseUrl = new URL(await buildWorkspaceAppUrl(env, context, scriptName, '/'));
  const logContext = {
    scriptName,
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    browserSessionId: sessionId,
  };
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  const browser = await puppeteer.connect(env.BROWSER, sessionId);
  try {
    const hostIndex = await buildWorkspaceAppHostIndex(env, context);
    const pages = await browser.pages();
    const page = pages.find((candidate) => {
      try {
        const hostname = new URL(candidate.url()).hostname;
        return hostname === baseUrl.hostname || isWorkspaceAppHostname(hostIndex, hostname);
      } catch {
        return false;
      }
    }) ?? pages.at(-1) ?? await browser.newPage();
    await page.setViewport(screenshotViewport(input.width, input.height));
    page.setDefaultTimeout(BROWSER_SESSION_DEFAULT_ACTION_TIMEOUT_MS);

    let removeInterception: (() => void) | undefined;
    if (!script.is_public) {
      removeInterception = await installDispatchRequestInterception(
        page,
        env,
        context,
        hostIndex,
        { redirect: 'manual' },
      );
    }

    return new AppBrowserSession({
      browser,
      page,
      baseUrl,
      hostIndex,
      logContext,
      remoteSessionId: sessionId,
      removeInterception,
      onClose: () => orgStub.removeBrowserSession(sessionId),
    });
  } catch (error) {
    await browser.disconnect().catch(() => {});
    throw new Error(`Browser session reconnect failed: ${truncateError(error)}`);
  }
}

/**
 * Virtual binding that launches interactive Browser Rendering sessions against
 * deployed workspace apps, so js_exec code can run Playwright-style UI tests.
 * Private apps route through the dispatcher service binding, mirroring
 * AppScreenshotBinding.
 */
export class AppBrowserBinding extends WorkerEntrypoint<
  AppBrowserBindingEnv,
  AppBrowserBindingProps
> {
  private get context(): AppBrowserBindingProps {
    return this.ctx.props;
  }

  async launch(input: AppBrowserLaunchInput): Promise<AppBrowserSession> {
    return launchAppBrowserSession(this.env, this.context, input);
  }
}
