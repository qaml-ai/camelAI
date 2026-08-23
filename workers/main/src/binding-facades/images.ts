import {
  bindingFacadeResponseError,
  bindingFacadeUrl,
  jsonRequest,
  readJsonResponse,
  type BindingFacadeFetcher,
} from "./transport";

const CAPABILITY = "images";
const OPTIONS_HEADER = "x-camelai-image-options";

export interface ImagesFacadeEnv {
  IMAGES?: ImagesBinding;
  IMAGES_SERVICE?: BindingFacadeFetcher;
}

export interface PortableImageMetadata {
  id: string;
  filename?: string;
  uploaded?: string;
  requireSignedURLs: boolean;
  meta?: Record<string, unknown>;
  variants: string[];
  draft?: boolean;
  creator?: string;
}

export interface PortableImageUploadOptions {
  id?: string;
  filename?: string;
  requireSignedURLs?: boolean;
  metadata?: Record<string, unknown>;
  creator?: string;
  encoding?: "base64";
}

export interface PortableImageUpdateOptions {
  requireSignedURLs?: boolean;
  metadata?: Record<string, unknown>;
  creator?: string;
}

export interface PortableImageListOptions {
  limit?: number;
  cursor?: string;
  sortOrder?: "asc" | "desc";
  creator?: string;
}

export interface PortableImageList {
  images: PortableImageMetadata[];
  cursor?: string;
  listComplete: boolean;
}

export interface PortableImageHandle {
  details(): Promise<PortableImageMetadata | null>;
  bytes(): Promise<ReadableStream<Uint8Array> | null>;
  update(options: PortableImageUpdateOptions): Promise<PortableImageMetadata>;
  delete(): Promise<boolean>;
}

export interface PortableHostedImagesBinding {
  image(imageId: string): PortableImageHandle;
  upload(
    image: ReadableStream<Uint8Array> | ArrayBuffer,
    options?: PortableImageUploadOptions,
  ): Promise<PortableImageMetadata>;
  list(options?: PortableImageListOptions): Promise<PortableImageList>;
}

export function resolveImagesBinding(env: ImagesFacadeEnv): ImagesBinding | undefined {
  if (env.IMAGES) return env.IMAGES;
  return env.IMAGES_SERVICE
    ? new ServiceImagesBinding(env.IMAGES_SERVICE)
    : undefined;
}

export class ServiceImagesBinding implements ImagesBinding {
  readonly hosted: PortableHostedImagesBinding;

  constructor(private readonly service: BindingFacadeFetcher) {
    this.hosted = new ServiceHostedImagesBinding(service);
  }

  async info(
    stream: ReadableStream<Uint8Array>,
    options?: ImageInputOptions,
  ): Promise<ImageInfoResponse> {
    const response = await this.service.fetch(new Request(
      bindingFacadeUrl(CAPABILITY, "info"),
      streamInit("PUT", stream, options),
    ));
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return readJsonResponse<ImageInfoResponse>(CAPABILITY, response);
  }

  input(
    stream: ReadableStream<Uint8Array>,
    options?: ImageInputOptions,
  ): ImageTransformer {
    return new ServiceImageTransformer(this.service, stream, options);
  }
}

class ServiceImageTransformer implements ImageTransformer {
  constructor(
    private readonly service: BindingFacadeFetcher,
    private readonly inputStream: ReadableStream<Uint8Array>,
    private readonly inputOptions?: ImageInputOptions,
    private readonly transforms: ImageTransform[] = [],
  ) {}

  transform(transform: ImageTransform): ImageTransformer {
    return new ServiceImageTransformer(
      this.service,
      this.inputStream,
      this.inputOptions,
      [...this.transforms, transform],
    );
  }

  draw(): ImageTransformer {
    throw new Error("The portable images facade does not yet support draw(); use transform() and output()");
  }

  async output(options: ImageOutputOptions): Promise<ImageTransformationResult> {
    const response = await this.service.fetch(new Request(
      bindingFacadeUrl(CAPABILITY, "transform"),
      streamInit("PUT", this.inputStream, {
        input: this.inputOptions,
        transforms: this.transforms,
        output: options,
      }),
    ));
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    const contentType = response.headers.get("content-type") || options.format;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      response: () => new Response(bytes.slice(), {
        headers: { "content-type": contentType },
      }),
      contentType: () => contentType,
      image: (imageOptions) => imageOptions?.encoding === "base64"
        ? streamFromBytes(new TextEncoder().encode(encodeBase64(bytes)))
        : streamFromBytes(bytes.slice()),
    };
  }
}

class ServiceHostedImagesBinding implements PortableHostedImagesBinding {
  constructor(private readonly service: BindingFacadeFetcher) {}

  image(imageId: string): PortableImageHandle {
    return new ServiceImageHandle(this.service, imageId);
  }

  async upload(
    image: ReadableStream<Uint8Array> | ArrayBuffer,
    options?: PortableImageUploadOptions,
  ): Promise<PortableImageMetadata> {
    const response = await this.service.fetch(new Request(
      bindingFacadeUrl(CAPABILITY, "hosted/upload"),
      streamInit("PUT", image, options),
    ));
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return readJsonResponse<PortableImageMetadata>(CAPABILITY, response);
  }

  async list(options?: PortableImageListOptions): Promise<PortableImageList> {
    const response = await this.service.fetch(new Request(
      bindingFacadeUrl(CAPABILITY, "hosted/list"),
      jsonRequest({ options }, { method: "POST" }),
    ));
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return readJsonResponse<PortableImageList>(CAPABILITY, response);
  }
}

class ServiceImageHandle implements PortableImageHandle {
  constructor(
    private readonly service: BindingFacadeFetcher,
    private readonly imageId: string,
  ) {}

  async details(): Promise<PortableImageMetadata | null> {
    const response = await this.request("details", { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return readJsonResponse<PortableImageMetadata>(CAPABILITY, response);
  }

  async bytes(): Promise<ReadableStream<Uint8Array> | null> {
    const response = await this.request("bytes", { method: "GET" });
    if (response.status === 404) return null;
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    if (!response.body) throw new Error(`Images facade returned no body for ${this.imageId}`);
    return response.body;
  }

  async update(options: PortableImageUpdateOptions): Promise<PortableImageMetadata> {
    const response = await this.request(
      "update",
      jsonRequest({ options }, { method: "PATCH" }),
    );
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return readJsonResponse<PortableImageMetadata>(CAPABILITY, response);
  }

  async delete(): Promise<boolean> {
    const response = await this.request("", { method: "DELETE" });
    if (response.status === 404) return false;
    if (!response.ok) throw await bindingFacadeResponseError(CAPABILITY, response);
    return true;
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    return this.service.fetch(new Request(
      bindingFacadeUrl(CAPABILITY, `hosted/image${path ? `/${path}` : ""}`, {
        id: this.imageId,
      }),
      init,
    ));
  }
}

function streamInit(
  method: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  options: unknown,
): RequestInit {
  const headers = new Headers({ "content-type": "application/octet-stream" });
  if (options !== undefined) headers.set(OPTIONS_HEADER, encodeOptions(options));
  return {
    method,
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit;
}

function encodeOptions(value: unknown): string {
  return encodeBase64(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
