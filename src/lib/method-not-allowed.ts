/**
 * Resource routes that only export an `action` make React Router throw
 * "You made a GET request to ... but did not provide a `loader`" on a GET/HEAD
 * (a stray browser visit, prefetch, or crawler), which surfaces as an
 * ssr_error. Export `loader = actionOnlyLoader('POST')` from such routes so the
 * GET is answered with a plain 405 instead.
 */
export function methodNotAllowed(allowed: readonly string[]): Response {
  return Response.json(
    { error: 'Method not allowed' },
    { status: 405, headers: { Allow: allowed.join(', ') } },
  );
}

export function actionOnlyLoader(...allowed: [string, ...string[]]): () => Response {
  return () => methodNotAllowed(allowed);
}
