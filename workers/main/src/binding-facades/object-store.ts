import {
  bindingFacadeResponseError,
  bindingFacadeUrl,
  jsonRequest,
  readJsonResponse,
  type BindingFacadeFetcher,
} from "./transport.js";

const CAPABILITY = "object-store";
export const OBJECT_METADATA_HEADER = "x-camelai-object-metadata";
const OBJECT_OPTIONS_HEADER = "x-camelai-object-options";

export interface ObjectStoreFacadeEnv {
  R2_BUCKET?: R2Bucket;
  OBJECT_STORE_SERVICE?: BindingFacadeFetcher;
}

export interface FacadeObjectMetadata {
  key: string;
  version?: string;
  size: number;
  etag: string;
  httpEtag?: string;
  uploaded: string;
  httpMetadata?: R2HTTPMetadata & { cacheExpiry?: Date | string };
  customMetadata?: Record<string, string>;
  range?: R2Range;
  storageClass?: string;
  checksums?: R2StringChecksums;
  ssecKeyMd5?: string;
}

interface FacadeListResult {
  objects: FacadeObjectMetadata[];
  delimitedPrefixes?: string[];
  truncated?: boolean;
  cursor?: string;
}

interface FacadeMultipartResult {
  key: string;
  uploadId: string;
}

export function resolveObjectStore(
  env: ObjectStoreFacadeEnv,
  bindingName = "R2_BUCKET",
): R2Bucket {
  return resolveObjectStoreBinding(env, bindingName, env.R2_BUCKET);
}

export function resolveObjectStoreBinding(
  env: Pick<ObjectStoreFacadeEnv, "OBJECT_STORE_SERVICE">,
  bindingName: string,
  native?: R2Bucket,
): R2Bucket {
  if (native) return native;
  if (env.OBJECT_STORE_SERVICE) {
    return new ServiceR2Bucket(env.OBJECT_STORE_SERVICE, bindingName) as unknown as R2Bucket;
  }
  throw new Error(
    `${bindingName} is not configured: provide a native R2 binding or OBJECT_STORE_SERVICE`,
  );
}

export function hasObjectStore(env: ObjectStoreFacadeEnv): boolean {
  return Boolean(env.OBJECT_STORE_SERVICE || env.R2_BUCKET);
}

export function hasObjectStoreBinding(
  env: Pick<ObjectStoreFacadeEnv, "OBJECT_STORE_SERVICE">,
  native?: R2Bucket,
): boolean {
  return Boolean(native || env.OBJECT_STORE_SERVICE);
}

export class ServiceR2Bucket {
  constructor(
    private readonly service: BindingFacadeFetcher,
    private readonly bindingName: string,
  ) {}

  async head(key: string): Promise<R2Object | null> {
    const response = await this.request("object", {
      method: "HEAD",
    }, { key });
    if (response.status === 404) return null;
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return objectFromMetadata(readObjectMetadata(response));
  }

  async get(
    key: string,
    options?: R2GetOptions,
  ): Promise<R2ObjectBody | R2Object | null> {
    const headers = new Headers();
    if (options) headers.set(OBJECT_OPTIONS_HEADER, encodeValue(options));
    const response = await this.request("object", { method: "GET", headers }, { key });
    if (response.status === 404) return null;
    if (response.status === 304 || response.status === 412) {
      return objectFromMetadata(readObjectMetadata(response));
    }
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return objectFromMetadata(readObjectMetadata(response), response);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const headers = new Headers();
    if (options) headers.set(OBJECT_OPTIONS_HEADER, encodeValue(options));
    const init = streamRequestInit("PUT", normalizeBody(value), headers);
    const response = await this.request("object", init, { key });
    if (response.status === 412) return null;
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return objectFromMetadata(readObjectMetadata(response));
  }

  async delete(keys: string | string[]): Promise<void> {
    const response = await this.request(
      "delete",
      jsonRequest({ keys: Array.isArray(keys) ? keys : [keys] }, { method: "POST" }),
    );
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const response = await this.request(
      "list",
      jsonRequest({ options: serializeValue(options ?? {}) }, { method: "POST" }),
    );
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    const result = await readJsonResponse<FacadeListResult>(CAPABILITY, response);
    const objects = (result.objects ?? []).map((metadata) => objectFromMetadata(metadata));
    return {
      objects,
      delimitedPrefixes: result.delimitedPrefixes ?? [],
      ...(result.truncated
        ? { truncated: true as const, cursor: result.cursor ?? "" }
        : { truncated: false as const }),
    };
  }

  async createMultipartUpload(
    key: string,
    options?: R2MultipartOptions,
  ): Promise<R2MultipartUpload> {
    const response = await this.request(
      "multipart/create",
      jsonRequest(
        { key, options: serializeValue(options ?? {}) },
        { method: "POST" },
      ),
    );
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    const result = await readJsonResponse<FacadeMultipartResult>(CAPABILITY, response);
    return new ServiceR2MultipartUpload(
      this.service,
      this.bindingName,
      result.key || key,
      result.uploadId,
    );
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    return new ServiceR2MultipartUpload(
      this.service,
      this.bindingName,
      key,
      uploadId,
    );
  }

  private request(
    path: string,
    init: RequestInit,
    search: Record<string, string | undefined> = {},
  ): Promise<Response> {
    return this.service.fetch(
      new Request(
        bindingFacadeUrl(CAPABILITY, path, {
          binding: this.bindingName,
          ...search,
        }),
        init,
      ),
    );
  }
}

class ServiceR2MultipartUpload implements R2MultipartUpload {
  constructor(
    private readonly service: BindingFacadeFetcher,
    private readonly bindingName: string,
    readonly key: string,
    readonly uploadId: string,
  ) {}

  async uploadPart(
    partNumber: number,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: R2UploadPartOptions,
  ): Promise<R2UploadedPart> {
    const headers = new Headers();
    if (options) headers.set(OBJECT_OPTIONS_HEADER, encodeValue(options));
    const response = await this.service.fetch(
      new Request(
        bindingFacadeUrl(CAPABILITY, "multipart/part", {
          binding: this.bindingName,
          key: this.key,
          uploadId: this.uploadId,
          partNumber,
        }),
        streamRequestInit("PUT", normalizeBody(value), headers),
      ),
    );
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return readJsonResponse<R2UploadedPart>(CAPABILITY, response);
  }

  async abort(): Promise<void> {
    const response = await this.service.fetch(
      new Request(
        bindingFacadeUrl(CAPABILITY, "multipart/abort", {
          binding: this.bindingName,
        }),
        jsonRequest({ key: this.key, uploadId: this.uploadId }, { method: "POST" }),
      ),
    );
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
  }

  async complete(uploadedParts: R2UploadedPart[]): Promise<R2Object> {
    const response = await this.service.fetch(
      new Request(
        bindingFacadeUrl(CAPABILITY, "multipart/complete", {
          binding: this.bindingName,
        }),
        jsonRequest(
          { key: this.key, uploadId: this.uploadId, uploadedParts },
          { method: "POST" },
        ),
      ),
    );
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return objectFromMetadata(readObjectMetadata(response));
  }
}

export function encodeObjectMetadata(metadata: FacadeObjectMetadata): string {
  return encodeValue(metadata);
}

export function decodeObjectMetadata(value: string): FacadeObjectMetadata {
  return decodeValue<FacadeObjectMetadata>(value);
}

function readObjectMetadata(response: Response): FacadeObjectMetadata {
  const encoded = response.headers.get(OBJECT_METADATA_HEADER);
  if (!encoded) {
    throw new Error("Object-store facade response is missing object metadata");
  }
  return decodeObjectMetadata(encoded);
}

function objectFromMetadata(
  metadata: FacadeObjectMetadata,
  response?: Response,
): R2Object | R2ObjectBody {
  const uploaded = new Date(metadata.uploaded);
  if (Number.isNaN(uploaded.getTime())) {
    throw new Error(`Object-store facade returned an invalid upload date for ${metadata.key}`);
  }
  const httpMetadata = metadata.httpMetadata
    ? {
        ...metadata.httpMetadata,
        ...(metadata.httpMetadata.cacheExpiry
          ? { cacheExpiry: new Date(metadata.httpMetadata.cacheExpiry) }
          : {}),
      }
    : undefined;
  const checksums = new FacadeR2Checksums(metadata.checksums ?? {});
  const object = {
    key: metadata.key,
    version: metadata.version ?? metadata.etag,
    size: metadata.size,
    etag: metadata.etag,
    httpEtag: metadata.httpEtag ?? quoteEtag(metadata.etag),
    checksums,
    uploaded,
    httpMetadata,
    customMetadata: metadata.customMetadata,
    range: metadata.range,
    storageClass: metadata.storageClass ?? "Standard",
    ssecKeyMd5: metadata.ssecKeyMd5,
    writeHttpMetadata(headers: Headers): void {
      writeHttpMetadata(headers, httpMetadata);
    },
  };
  if (!response) return object as unknown as R2Object;
  return {
    ...object,
    get body(): ReadableStream {
      if (!response.body) throw new Error(`Object-store facade returned no body for ${metadata.key}`);
      return response.body;
    },
    get bodyUsed(): boolean {
      return response.bodyUsed;
    },
    arrayBuffer: () => response.arrayBuffer(),
    async bytes(): Promise<Uint8Array> {
      return new Uint8Array(await response.arrayBuffer());
    },
    text: () => response.text(),
    json: <T>() => response.json() as Promise<T>,
    blob: () => response.blob(),
  } as unknown as R2ObjectBody;
}

class FacadeR2Checksums implements R2Checksums {
  constructor(private readonly values: R2StringChecksums) {}

  get md5(): ArrayBuffer | undefined { return checksumBytes(this.values.md5); }
  get sha1(): ArrayBuffer | undefined { return checksumBytes(this.values.sha1); }
  get sha256(): ArrayBuffer | undefined { return checksumBytes(this.values.sha256); }
  get sha384(): ArrayBuffer | undefined { return checksumBytes(this.values.sha384); }
  get sha512(): ArrayBuffer | undefined { return checksumBytes(this.values.sha512); }

  toJSON(): R2StringChecksums {
    return { ...this.values };
  }
}

function checksumBytes(value: string | undefined): ArrayBuffer | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function writeHttpMetadata(headers: Headers, metadata?: R2HTTPMetadata): void {
  if (!metadata) return;
  if (metadata.contentType) headers.set("content-type", metadata.contentType);
  if (metadata.contentLanguage) headers.set("content-language", metadata.contentLanguage);
  if (metadata.contentDisposition) headers.set("content-disposition", metadata.contentDisposition);
  if (metadata.contentEncoding) headers.set("content-encoding", metadata.contentEncoding);
  if (metadata.cacheControl) headers.set("cache-control", metadata.cacheControl);
  if (metadata.cacheExpiry) headers.set("expires", metadata.cacheExpiry.toUTCString());
}

function normalizeBody(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): BodyInit | null {
  if (value === null || typeof value === "string" || value instanceof ArrayBuffer || value instanceof Blob) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    ).buffer;
  }
  return value as ReadableStream<Uint8Array>;
}

function streamRequestInit(method: string, body: BodyInit | null, headers: Headers): RequestInit {
  return {
    method,
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Headers) return { __type: "headers", value: Object.fromEntries(value) };
  if (value instanceof Date) return { __type: "date", value: value.toISOString() };
  if (value instanceof ArrayBuffer) return { __type: "bytes", value: encodeBytes(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return {
      __type: "bytes",
      value: encodeBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, serializeValue(child)]),
    );
  }
  return value;
}

function encodeValue(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(serializeValue(value))));
}

function decodeValue<T>(value: string): T {
  return deserializeValue(
    JSON.parse(new TextDecoder().decode(decodeBytes(value))),
  ) as T;
}

function deserializeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deserializeValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.__type === "date" && typeof record.value === "string") {
    return new Date(record.value);
  }
  if (record.__type === "bytes" && typeof record.value === "string") {
    return decodeBytes(record.value).buffer;
  }
  if (record.__type === "headers" && record.value && typeof record.value === "object") {
    return new Headers(record.value as Record<string, string>);
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, deserializeValue(child)]),
  );
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function quoteEtag(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`;
}
