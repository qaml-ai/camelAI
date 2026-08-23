import {
  bindingFacadeFetch,
  bindingFacadeJson,
  jsonRequest,
  type BindingFacadeFetcher,
} from "./transport.js";

export type ComputeFacadeKind = "project-build" | "analysis" | "db-query";

export interface ComputeFacadeEnv {
  COMPUTE_SERVICE?: BindingFacadeFetcher;
}

export function resolveComputeSandbox<T>(
  env: ComputeFacadeEnv,
  input: {
    kind: ComputeFacadeKind;
    id: string;
    nativeAvailable: boolean;
    native: () => T;
  },
): T {
  if (input.nativeAvailable) return input.native();
  if (env.COMPUTE_SERVICE) {
    return new ServiceSandboxClient(
      env.COMPUTE_SERVICE,
      input.kind,
      input.id,
    ) as unknown as T;
  }
  throw new Error(`No ${input.kind} compute binding is configured`);
}

export class ServiceSandboxClient {
  constructor(
    private readonly service: BindingFacadeFetcher,
    readonly kind: ComputeFacadeKind,
    readonly id: string,
  ) {
    if (!id.trim()) throw new TypeError("Compute facade requires a sandbox id");
  }

  exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number },
  ): Promise<{ success?: boolean; stdout?: string; stderr?: string; exitCode?: number }> {
    return this.rpc("exec", [command, options]);
  }

  probeShell(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout?: string; stderr?: string; exitCode?: number }> {
    return this.rpc("probeShell", [command, options]);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown> {
    return this.rpc("mkdir", [path, options]);
  }

  exists(path: string): Promise<{ exists: boolean }> {
    return this.rpc("exists", [path]);
  }

  listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean },
  ): Promise<{ files: Array<{
    name: string;
    type: "file" | "directory";
    relativePath?: string;
    absolutePath?: string;
    size?: number;
  }> }> {
    return this.rpc("listFiles", [path, options]);
  }

  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: "base64" | "utf8" },
  ): Promise<unknown> {
    const headers = new Headers();
    headers.set("content-type", "application/octet-stream");
    const body = content;
    const init = {
      method: "PUT",
      headers,
      body,
      ...(content instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit;
    const response = await bindingFacadeFetch(
      this.service,
      "compute",
      "file",
      init,
      {
        kind: this.kind,
        id: this.id,
        path,
        encoding: options?.encoding ?? "utf8",
      },
    );
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  async readFile(
    path: string,
    options?: { encoding?: "base64" | "utf8" | "none" },
  ): Promise<{
    content: string | ReadableStream<Uint8Array>;
    size?: number;
    mimeType?: string;
  }> {
    const encoding = options?.encoding ?? "utf8";
    const response = await bindingFacadeFetch(
      this.service,
      "compute",
      "file",
      { method: "GET" },
      { kind: this.kind, id: this.id, path, encoding },
    );
    const sizeHeader = response.headers.get("x-camelai-file-size");
    const size = sizeHeader === null ? undefined : Number.parseInt(sizeHeader, 10);
    const mimeType = response.headers.get("content-type") ?? undefined;
    return {
      content: encoding === "none"
        ? requireBody(response, path)
        : await response.text(),
      ...(Number.isFinite(size) ? { size } : {}),
      ...(mimeType ? { mimeType } : {}),
    };
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const response = await bindingFacadeFetch(
      this.service,
      "compute",
      "file",
      { method: "GET" },
      { kind: this.kind, id: this.id, path, encoding: "none" },
    );
    return requireBody(response, path);
  }

  noteBuildSessionActivity(windowMs?: number): Promise<void> {
    return this.rpc("noteBuildSessionActivity", [windowMs]);
  }

  restartZombieContainer(request: {
    operation: string;
    trigger: "exec_session_death" | "probe_session_death";
    error?: string;
  }): Promise<{ restarted: boolean; reason: string } | undefined> {
    return this.rpc("restartZombieContainer", [request]);
  }

  resetSession(): Promise<void> {
    return this.rpc("resetSession", []);
  }

  ensureMounted(
    bucketBinding: string,
    prefix: string,
    mountPath?: string,
    options?: { readOnly?: boolean },
  ): Promise<void> {
    return this.rpc("ensureMounted", [bucketBinding, prefix, mountPath, options]);
  }

  ensureConnectionsRpc(params: unknown): Promise<void> {
    return this.rpc("ensureConnectionsRpc", [params]);
  }

  sealAppEgress(): Promise<void> {
    return this.rpc("sealAppEgress", []);
  }

  ensureReady(): Promise<void> {
    return this.rpc("ensureReady", []);
  }

  ensureRelayEgress(relayHostname: string): Promise<void> {
    return this.rpc("ensureRelayEgress", [relayHostname]);
  }

  ensureWarehouseExportMount(prefix: string): Promise<void> {
    return this.rpc("ensureWarehouseExportMount", [prefix]);
  }

  startProcess(
    command: string,
    options?: { processId?: string; env?: Record<string, string | undefined> },
  ): Promise<unknown> {
    return this.rpc("startProcess", [command, options]);
  }

  private rpc<T>(method: string, args: unknown[]): Promise<T> {
    return bindingFacadeJson<T>(
      this.service,
      "compute",
      "rpc",
      jsonRequest({ method, args }, { method: "POST" }),
      { kind: this.kind, id: this.id },
    );
  }
}

function requireBody(response: Response, path: string): ReadableStream<Uint8Array> {
  if (!response.body) throw new Error(`Compute facade returned no file body for ${path}`);
  return response.body;
}
