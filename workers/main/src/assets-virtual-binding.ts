import { WorkerEntrypoint } from "cloudflare:workers";
import {
  normalizeSelfhostAssetPath,
  selfhostAssetObjectKey,
  selfhostAssetsKey,
  type SelfhostAssetsRecord,
} from "./selfhost-assets-registry.js";
import { resolveObjectStore } from "./binding-facades/object-store.js";

interface AssetsVirtualBindingEnv {
  APP_KV: KVNamespace;
  R2_BUCKET?: R2Bucket;
  OBJECT_STORE_SERVICE?: Fetcher;
}

interface AssetsVirtualBindingProps {
  appId: string;
}

function lookupAsset(
  record: SelfhostAssetsRecord,
  requestPath: string,
) {
  const path = normalizeSelfhostAssetPath(requestPath);
  return (
    record.manifest[path] ??
    record.manifest[`${path.replace(/\/+$/, "")}/index.html`]
  );
}

export class AssetsVirtualBinding extends WorkerEntrypoint<AssetsVirtualBindingEnv, AssetsVirtualBindingProps> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const stored = await this.env.APP_KV.get(selfhostAssetsKey(this.ctx.props.appId));
    if (!stored) return new Response("Not Found", { status: 404 });

    const record = JSON.parse(stored) as SelfhostAssetsRecord;
    const url = new URL(request.url);
    const entry = lookupAsset(record, decodeURIComponent(url.pathname));
    if (!entry) return new Response("Not Found", { status: 404 });

    const object = await resolveObjectStore(this.env).get(
      selfhostAssetObjectKey(record.appId, entry.hash),
    );
    if (!object) return new Response("Not Found", { status: 404 });

    const headers = new Headers();
    if (entry.contentType) {
      headers.set("content-type", entry.contentType);
    } else if (object.httpMetadata?.contentType) {
      headers.set("content-type", object.httpMetadata.contentType);
    }
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");

    return new Response(request.method === "HEAD" ? null : object.body, {
      headers,
    });
  }
}
