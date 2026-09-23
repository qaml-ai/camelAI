import {
  DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException,
} from "@aws-sdk/client-s3";
import { PreconditionFailed, segmentLog, type SegmentStore, type Storage } from "./storage.ts";

/**
 * Storage on S3. Documents are `<prefix>/<key>.json` with ETag versions and
 * If-Match / If-None-Match conditional writes. Logs are `<prefix>/<key>.log/`
 * holding immutable segment objects (see `segmentLog`). Credentials come from
 * the default AWS chain (the instance role on EC2).
 */
export function s3Storage(options: { bucket: string; prefix?: string; region?: string; client?: S3Client }): Storage {
  const client = options.client ?? new S3Client({ region: options.region });
  const bucket = options.bucket;
  const base = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const objectKey = (key: string) => (base ? `${base}/${key}` : key);
  const conditionFailed = (error: unknown) => error instanceof S3ServiceException &&
    (error.$metadata.httpStatusCode === 412 || error.$metadata.httpStatusCode === 409 || error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict");
  const missing = (error: unknown) => error instanceof S3ServiceException && (error.name === "NoSuchKey" || error.$metadata.httpStatusCode === 404);

  async function list(prefix: string) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: objectKey(prefix), ContinuationToken: token }));
      for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }
  async function getText(key: string) {
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return { text: await object.Body!.transformToString("utf8"), etag: object.ETag! };
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async function put(key: string, body: string, condition: { IfMatch?: string; IfNoneMatch?: string }, label: string) {
    try {
      const result = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json", ...condition }));
      return result.ETag!;
    } catch (error) { if (conditionFailed(error)) throw new PreconditionFailed(label); throw error; }
  }

  function segments(key: string): SegmentStore {
    const directory = `${objectKey(key)}.log/`;
    return {
      async list() {
        const names = (await list(`${key}.log/`)).map(name => name.slice(directory.length));
        return {
          segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b),
          snapshots: names.filter(name => /^snapshot-\d+$/.test(name)).map(name => Number(name.slice(9))).sort((a, b) => a - b),
        };
      },
      async read(name) {
        const object = await getText(directory + name);
        if (!object) throw new Error(`Missing log object ${directory}${name}`);
        return object.text;
      },
      async create(name, body) { await put(directory + name, body, { IfNoneMatch: "*" }, `${key}/${name}`); },
      async remove(names) {
        for (let index = 0; index < names.length; index += 1000) {
          const batch = names.slice(index, index + 1000);
          if (batch.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map(name => ({ Key: directory + name })), Quiet: true } }));
        }
      },
    };
  }

  return {
    async readJson(key) {
      const object = await getText(`${objectKey(key)}.json`);
      return object && { value: JSON.parse(object.text), version: object.etag };
    },
    writeJson(key, value, expected) {
      const condition = expected === null ? { IfNoneMatch: "*" } : expected !== undefined ? { IfMatch: expected } : {};
      return put(`${objectKey(key)}.json`, JSON.stringify(value), condition, key);
    },
    async deleteJson(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${objectKey(key)}.json` })); },
    async listJson(prefix) {
      const skip = base ? base.length + 1 : 0;
      return (await list(prefix)).filter(name => name.endsWith(".json")).map(name => name.slice(skip, -".json".length)).sort();
    },
    log: key => segmentLog(segments(key), key),
    async hasLog(key) {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${objectKey(key)}.log/`, MaxKeys: 1 }));
      return (page.KeyCount ?? 0) > 0;
    },
  };
}
