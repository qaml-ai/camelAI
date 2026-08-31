/**
 * Cloudflare API proxy route
 */

import type { RouteContext } from '../types.js';
import { proxyCloudflareApi, cfApiError } from '../cf-api-proxy.js';
import { handleDeploySideEffects } from '../services/deploy.js';

export async function handleCfProxy({ req, env }: RouteContext): Promise<Response> {
  return proxyCloudflareApi(req, env, {
    onDeploySideEffects: (info) => handleDeploySideEffects(env, info),
  }).catch((e) => cfApiError(10004, `Proxy failed: ${e}`, 502));
}
