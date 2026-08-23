interface KvBinding {
  get(
    key: string,
    typeOrOptions?: "text" | "json" | "arrayBuffer" | { type?: string },
  ): Promise<unknown>;
  getWithMetadata(
    key: string,
    typeOrOptions?: "text" | "json" | "arrayBuffer" | { type?: string },
  ): Promise<{ value: unknown; metadata: unknown }>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: {
      expiration?: number;
      expirationTtl?: number;
      metadata?: unknown;
    },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor: string;
  }>;
}

interface Env {
  APP_KV: KvBinding;
  EMAIL_TO_USER: KvBinding;
  SESSIONS: KvBinding;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const prefix = "celld-smoke:";
    const textKey = `${prefix}a`;
    const binaryKey = `${prefix}b`;

    try {
      await env.APP_KV.put(textKey, JSON.stringify({ ok: true }), {
        metadata: { kind: "json" },
        expirationTtl: 60,
      });
      await env.APP_KV.put(binaryKey, new Uint8Array([0, 1, 2, 255]));

      const json = await env.APP_KV.get(textKey, "json");
      assert(
        typeof json === "object" &&
          json !== null &&
          (json as { ok?: unknown }).ok === true,
        "JSON round trip failed",
      );

      const withMetadata = await env.APP_KV.getWithMetadata(textKey, "text");
      assert(
        (withMetadata.metadata as { kind?: unknown })?.kind === "json",
        "metadata round trip failed",
      );

      const binary = await env.APP_KV.get(binaryKey, "arrayBuffer");
      assert(binary instanceof ArrayBuffer, "binary result is not an ArrayBuffer");
      assert(
        Array.from(new Uint8Array(binary)).join(",") === "0,1,2,255",
        "binary round trip failed",
      );

      const firstPage = await env.APP_KV.list({ prefix, limit: 1 });
      assert(firstPage.keys.length === 1, "first list page has the wrong size");
      assert(!firstPage.list_complete, "first list page should have a cursor");
      const secondPage = await env.APP_KV.list({
        prefix,
        limit: 1,
        cursor: firstPage.cursor,
      });
      assert(secondPage.keys.length === 1, "second list page has the wrong size");
      assert(secondPage.list_complete, "second list page should be complete");

      const isolated = await env.SESSIONS.get(textKey);
      assert(isolated === null, "KV namespaces are not isolated");

      await env.APP_KV.delete(textKey);
      assert((await env.APP_KV.get(textKey)) === null, "delete round trip failed");

      return Response.json({
        ok: true,
        checks: [
          "text",
          "json",
          "metadata",
          "binary",
          "pagination",
          "delete",
          "namespace-isolation",
        ],
      });
    } finally {
      await Promise.all([
        env.APP_KV.delete(textKey),
        env.APP_KV.delete(binaryKey),
        env.EMAIL_TO_USER.delete(textKey),
        env.SESSIONS.delete(textKey),
      ]);
    }
  },
};
