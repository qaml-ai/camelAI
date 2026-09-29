import type { Route } from './+types/auth.logout';
import { getEnv } from '@/lib/cloudflare.server';
import { getSignedSessionFromRequest, createDeleteSessionCookieHeader } from '@/lib/cookies.server';
import { providerForAuthSource } from '../../../workers/main/src/helpers/proxy-auth-providers';
import type { ProxyAuthEnv } from '../../../workers/main/src/helpers/proxy-auth-core';
import type { UserDO } from '../../../workers/main/src/auth';
import { ENTERPRISE_OIDC_AUTH_SOURCE } from '../../../workers/main/src/signed-session';
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let accessLogoutUrl: string | null = null;
  try {
    const env = getEnv(context);
    const session = await getSignedSessionFromRequest(request, env.TOKEN_SIGNING_SECRET);
    // Reverse-proxy sessions (Cloudflare Access, Pomerium) must also be signed
    // out at the proxy, otherwise it silently re-logs the user back in.
    const proxyProvider = providerForAuthSource(session?.auth_source);
    accessLogoutUrl =
      proxyProvider?.getLogoutUrl(request, env as unknown as ProxyAuthEnv) ?? null;

    if (session && session.auth_source !== ENTERPRISE_OIDC_AUTH_SOURCE) {
      // Invalidate all outstanding signed sessions for this user so that
      // copied/stolen tokens created before this logout become unusable.
      // Enterprise OIDC cookies are org-scoped. Invalidating the UserDO here
      // would also log a linked global user out of unrelated organizations.
      const userNs = env.USER as DurableObjectNamespace<UserDO>;
      const userStub = userNs.get(userNs.idFromName(session.user_id));
      await userStub.invalidateSessions();
    }
  } catch (error) {
    console.error('Logout session invalidation error:', error);
    // Continue with cookie deletion even if DO call fails
  }

  return Response.json(
    { success: true, accessLogoutUrl },
    { headers: { 'Set-Cookie': createDeleteSessionCookieHeader(request) } }
  );
}
