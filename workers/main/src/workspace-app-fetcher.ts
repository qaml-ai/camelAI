import type { OrgDO } from './auth.js';
import {
  getAppIframeUrl,
  getAppUrl,
  getPreferredAppUrl,
  isAppCustomDomainReady,
} from '../../../src/lib/app-url.js';

export interface WorkspaceAppContext {
  orgId: string;
  workspaceId: string;
}

export type DispatcherBinding = {
  fetchWorkspaceApp(request: Request): Promise<Response>;
};

export interface WorkspaceAppFetcherEnv {
  DISPATCHER?: DispatcherBinding;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKER_BASE_URL?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
}

export interface WorkspaceAppRoute {
  scriptName: string;
  orgSlug: string;
  dispatchScriptName: string;
  workspaceId: string;
  orgId: string;
  isPublic: boolean;
}

export interface WorkspaceAppHostIndex {
  routesByHostname: ReadonlyMap<string, WorkspaceAppRoute>;
  hostnames: ReadonlySet<string>;
}

const MAX_REDIRECTS = 20;
const MAX_REDIRECT_BODY_BYTES = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const STRIPPED_COOKIE_NAMES = new Set([
  'chiridion_run_session',
]);

const CROSS_ORIGIN_REDIRECT_HEADERS = [
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
];

export const PLATFORM_DISPATCH_SCRIPT_HEADER = 'x-camelai-platform-dispatch-script';
export const PLATFORM_DISPATCH_SCRIPT_NAME_HEADER = 'x-camelai-platform-script-name';
const PLATFORM_DISPATCH_HEADERS = [
  PLATFORM_DISPATCH_SCRIPT_HEADER,
  PLATFORM_DISPATCH_SCRIPT_NAME_HEADER,
] as const;

function stripPlatformDispatchHeaders(headers: Headers): void {
  for (const name of PLATFORM_DISPATCH_HEADERS) {
    headers.delete(name);
  }
}

function syncRequestHostHeader(headers: Headers, url: URL): void {
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  headers.set('Host', host);
}

function applyPlatformDispatchRoute(headers: Headers, route: WorkspaceAppRoute): void {
  headers.set(PLATFORM_DISPATCH_SCRIPT_HEADER, route.dispatchScriptName);
  headers.set(PLATFORM_DISPATCH_SCRIPT_NAME_HEADER, route.scriptName);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/:\d+$/, '');
}

function appUrlContext(env: WorkspaceAppFetcherEnv) {
  return {
    hostname: env.WORKER_BASE_URL,
    vanityDomain: env.LOCAL_APP_VANITY_DOMAIN,
    iframeDomain: env.LOCAL_APP_IFRAME_DOMAIN,
  };
}

export async function buildWorkspaceAppHostIndex(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
): Promise<WorkspaceAppHostIndex> {
  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
  const info = await orgStub.getInfo();
  const routesByHostname = new Map<string, WorkspaceAppRoute>();
  const orgSlug = typeof info?.slug === 'string' && info.slug.trim()
    ? info.slug.trim()
    : undefined;
  if (!orgSlug) {
    return { routesByHostname, hostnames: new Set() };
  }
  const scripts = await orgStub.listWorkerScriptsByWorkspace(context.workspaceId);
  const urlContext = appUrlContext(env);

  for (const script of scripts) {
    const dispatchScriptName = `${script.script_name}--${orgSlug}`;
    const route: WorkspaceAppRoute = {
      scriptName: script.script_name,
      orgSlug,
      dispatchScriptName,
      workspaceId: context.workspaceId,
      orgId: context.orgId,
      isPublic: script.is_public,
    };

    const urls = [
      getPreferredAppUrl(script, { hostname: urlContext, orgSlug }),
      getAppUrl(script.script_name, urlContext, orgSlug),
      getAppIframeUrl(script.script_name, urlContext, orgSlug),
    ];
    for (const appUrl of urls) {
      routesByHostname.set(normalizeHostname(new URL(appUrl).hostname), route);
    }
    if (isAppCustomDomainReady(script) && script.custom_domain_hostname) {
      routesByHostname.set(normalizeHostname(script.custom_domain_hostname), route);
    }
  }

  return {
    routesByHostname,
    hostnames: new Set(routesByHostname.keys()),
  };
}

export function isWorkspaceAppHostname(
  index: WorkspaceAppHostIndex,
  hostname: string,
): boolean {
  return index.hostnames.has(normalizeHostname(hostname));
}

export function resolveWorkspaceAppRoute(
  index: WorkspaceAppHostIndex,
  hostname: string,
): WorkspaceAppRoute | null {
  return index.routesByHostname.get(normalizeHostname(hostname)) ?? null;
}

function configuredAppDomain(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return normalizeHostname(new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname);
  } catch {
    return normalizeHostname(trimmed.replace(/^https?:\/\//, '').split('/')[0] ?? '');
  }
}

export function isLocalAppHostname(hostname: string, env: WorkspaceAppFetcherEnv): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.startsWith('127.0.0.1')
  ) {
    return true;
  }
  for (const domain of [
    configuredAppDomain(env.LOCAL_APP_VANITY_DOMAIN),
    configuredAppDomain(env.LOCAL_APP_IFRAME_DOMAIN),
  ]) {
    if (domain && (host === domain || host.endsWith(`.${domain}`))) {
      return true;
    }
  }
  if (env.WORKER_BASE_URL) {
    try {
      const platformHost = normalizeHostname(new URL(env.WORKER_BASE_URL).hostname);
      if (platformHost && (host === platformHost || host.endsWith(`.${platformHost}`))) {
        return true;
      }
    } catch {
      // ignore invalid platform base URL
    }
  }
  return false;
}

function finalizeWorkspaceAppUrl(url: URL, env: WorkspaceAppFetcherEnv): string {
  const platformBase = env.WORKER_BASE_URL?.trim();
  if (!platformBase || !isLocalAppHostname(url.hostname, env)) {
    return url.toString();
  }
  try {
    const platform = new URL(platformBase);
    url.protocol = platform.protocol;
    if (platform.port) {
      url.port = platform.port;
    }
  } catch {
    // ignore invalid platform base URL
  }
  return url.toString();
}

export function shouldUseDispatchInterceptionForScreenshot(
  isPublic: boolean,
  env: Pick<WorkspaceAppFetcherEnv, 'DISPATCHER'>,
): boolean {
  return !isPublic && !!env.DISPATCHER;
}

export function applyWorkspaceAppPath(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') {
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  }
  if (trimmed.startsWith('//')) {
    throw new Error('Workspace app path must stay on the app origin');
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    throw new Error('Workspace app path must stay on the app origin');
  }
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const relative = new URL(normalized, 'http://workspace-app.local');
  url.pathname = relative.pathname;
  url.search = relative.search;
  url.hash = relative.hash;
  return url;
}

export async function buildWorkspaceAppUrl(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  scriptName: string,
  path = '/',
): Promise<string> {
  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
  const script = await orgStub.getWorkerScript(scriptName);
  if (!script) {
    throw new Error(`App not found: ${scriptName}`);
  }
  if (script.workspace_id !== context.workspaceId) {
    throw new Error(`App ${scriptName} is not in this workspace`);
  }
  const info = await orgStub.getInfo();
  const orgSlug = typeof info?.slug === 'string' && info.slug.trim()
    ? info.slug.trim()
    : undefined;
  const base = getPreferredAppUrl(
    { ...script, script_name: scriptName },
    { hostname: appUrlContext(env), orgSlug },
  );
  const url = applyWorkspaceAppPath(base, path);
  return finalizeWorkspaceAppUrl(url, env);
}

function sanitizeWorkspaceAppRequest(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  stripPlatformDispatchHeaders(headers);
  const cookieHeader = headers.get('Cookie');
  if (cookieHeader) {
    const filtered = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter((part) => {
        const name = part.split('=')[0]?.trim();
        return name && !STRIPPED_COOKIE_NAMES.has(name);
      });
    if (filtered.length > 0) {
      headers.set('Cookie', filtered.join('; '));
    } else {
      headers.delete('Cookie');
    }
  }
  syncRequestHostHeader(headers, url);
  return new Request(request, { headers });
}

function assertWorkspaceAppAccess(
  index: WorkspaceAppHostIndex,
  context: WorkspaceAppContext,
  hostname: string,
): WorkspaceAppRoute {
  const route = resolveWorkspaceAppRoute(index, hostname);
  if (!route) {
    throw new Error(`Hostname is not a workspace deployed app: ${hostname}`);
  }
  if (route.orgId !== context.orgId || route.workspaceId !== context.workspaceId) {
    throw new Error('Workspace app access denied');
  }
  return route;
}

function resolveRedirectMethod(status: number, method: string): string {
  if (status === 303) return 'GET';
  if ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD') {
    return 'GET';
  }
  return method;
}

function stripCrossOriginRedirectHeaders(headers: Headers): void {
  for (const name of CROSS_ORIGIN_REDIRECT_HEADERS) {
    headers.delete(name);
  }
}

function buildRedirectRequest(
  sourceRequest: Request,
  responseStatus: number,
  nextUrl: URL,
  replayBody: Uint8Array<ArrayBuffer> | null | undefined,
): Request {
  const method = resolveRedirectMethod(responseStatus, sourceRequest.method);
  const headers = new Headers(sourceRequest.headers);
  stripPlatformDispatchHeaders(headers);
  headers.delete('Host');
  if (nextUrl.origin !== new URL(sourceRequest.url).origin) {
    stripCrossOriginRedirectHeaders(headers);
  }
  const forwardsBody = method !== 'GET' && method !== 'HEAD';
  if (!forwardsBody) {
    headers.delete('Content-Length');
    headers.delete('Content-Type');
  }
  if (forwardsBody && replayBody === undefined) {
    throw new TypeError('Cannot follow a redirect with a request body over 1 MiB');
  }
  return new Request(nextUrl, {
    method,
    headers,
    redirect: 'manual',
    body: forwardsBody ? replayBody : null,
    signal: sourceRequest.signal,
  });
}

async function retainRedirectBody(
  request: Request,
): Promise<Uint8Array<ArrayBuffer> | null | undefined> {
  if (!request.body) return null;
  const reader = request.clone().body!.getReader();
  let buffer = new Uint8Array(0);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return buffer.subarray(0, size);
      const nextSize = size + value.byteLength;
      if (nextSize > MAX_REDIRECT_BODY_BYTES) {
        // Only the replay copy is canceled. Its tee sibling still forwards the
        // upload. Cancellation can wait for that sibling, so don't await it.
        void reader.cancel().catch(() => {});
        return undefined;
      }
      if (nextSize > buffer.byteLength) {
        const capacity = Math.max(nextSize, Math.min(buffer.byteLength * 2, MAX_REDIRECT_BODY_BYTES));
        const expanded = new Uint8Array(capacity);
        expanded.set(buffer);
        buffer = expanded;
      }
      buffer.set(value, size);
      size = nextSize;
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchWorkspaceAppOnce(
  env: WorkspaceAppFetcherEnv,
  request: Request,
  route: WorkspaceAppRoute,
): Promise<Response> {
  const sanitized = sanitizeWorkspaceAppRequest(request);
  const headers = new Headers(sanitized.headers);
  applyPlatformDispatchRoute(headers, route);
  const forwarded = new Request(sanitized, { headers, redirect: 'manual' });
  if (!env.DISPATCHER || typeof env.DISPATCHER.fetchWorkspaceApp !== 'function') {
    throw new Error('DISPATCHER service binding is not configured');
  }
  return env.DISPATCHER.fetchWorkspaceApp(forwarded);
}

async function followRedirects(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  request: Request,
  index: WorkspaceAppHostIndex,
  initialRoute: WorkspaceAppRoute | null,
): Promise<Response> {
  const redirectMode = request.redirect;
  let replayBody = redirectMode === 'follow' ? await retainRedirectBody(request) : null;
  let currentRequest = request;
  let route = initialRoute;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = route
      ? await fetchWorkspaceAppOnce(env, currentRequest, route)
      : await fetch(currentRequest, { redirect: 'manual' });

    if (redirectMode === 'manual' || !REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (redirectMode === 'error') {
      void response.body?.cancel().catch(() => {});
      throw new Error('Redirect encountered while redirect mode is "error"');
    }

    const location = response.headers.get('Location');
    if (!location) {
      return response;
    }

    void response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) {
      throw new Error('Too many redirects');
    }

    const nextUrl = new URL(location, currentRequest.url);
    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
      throw new TypeError('Redirect must use HTTP or HTTPS');
    }
    // An external fetch stays on the public network for the rest of its chain.
    route = route && isWorkspaceAppHostname(index, nextUrl.hostname)
      ? assertWorkspaceAppAccess(index, context, nextUrl.hostname)
      : null;
    currentRequest = buildRedirectRequest(currentRequest, response.status, nextUrl, replayBody);
    if (currentRequest.method === 'GET' || currentRequest.method === 'HEAD') replayBody = null;
  }

  throw new Error('Too many redirects');
}

export async function fetchWorkspaceAppViaDispatch(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  request: Request,
  index: WorkspaceAppHostIndex,
): Promise<Response> {
  const route = assertWorkspaceAppAccess(index, context, new URL(request.url).hostname);
  return followRedirects(env, context, request, index, route);
}

export function normalizeWorkspaceAppRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Request {
  if (input instanceof Request) {
    return init ? new Request(input, init) : input;
  }
  return new Request(input, init);
}

export async function performWorkspaceAppFetch(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deps: { getHostIndex: () => Promise<WorkspaceAppHostIndex> },
): Promise<Response> {
  const request = normalizeWorkspaceAppRequest(input, init);
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fetch(request);
  }

  const hostIndex = await deps.getHostIndex();
  if (!isWorkspaceAppHostname(hostIndex, url.hostname)) {
    return followRedirects(env, context, request, hostIndex, null);
  }

  return fetchWorkspaceAppViaDispatch(env, context, request, hostIndex);
}
