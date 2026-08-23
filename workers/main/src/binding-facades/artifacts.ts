import {
  bindingFacadeJson,
  jsonRequest,
  type BindingFacadeFetcher,
} from "./transport.js";

export interface ArtifactRepoInfo {
  id?: string;
  name: string;
  remote?: string;
  defaultBranch?: string;
  status?: "ready" | "creating" | "importing" | "forking";
  token?: string;
}

export interface ArtifactTokenResult {
  plaintext: string;
  expiresAt?: string | number;
}

export interface ArtifactsRepoLike extends ArtifactRepoInfo {
  createToken(scope?: "read" | "write", ttlSeconds?: number): Promise<ArtifactTokenResult>;
}

export interface ArtifactsBindingLike {
  create(
    name: string,
    options?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactRepoInfo>;
  get(name: string): Promise<ArtifactsRepoLike>;
}

export interface ArtifactsFacadeEnv {
  ARTIFACTS?: ArtifactsBindingLike;
  ARTIFACTS_SERVICE?: BindingFacadeFetcher;
}

export function resolveArtifactsBinding(env: ArtifactsFacadeEnv): ArtifactsBindingLike | undefined {
  if (env.ARTIFACTS) return env.ARTIFACTS;
  return env.ARTIFACTS_SERVICE
    ? new ServiceArtifactsBinding(env.ARTIFACTS_SERVICE)
    : undefined;
}

export class ServiceArtifactsBinding implements ArtifactsBindingLike {
  constructor(private readonly service: BindingFacadeFetcher) {}

  async create(
    name: string,
    options: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    } = {},
  ): Promise<ArtifactRepoInfo> {
    return bindingFacadeJson<ArtifactRepoInfo>(
      this.service,
      "artifacts",
      "repos",
      jsonRequest({ name, ...options }, { method: "POST" }),
    );
  }

  async get(name: string): Promise<ArtifactsRepoLike> {
    const info = await bindingFacadeJson<ArtifactRepoInfo>(
      this.service,
      "artifacts",
      "repo",
      { method: "GET" },
      { name },
    );
    return new ServiceArtifactsRepo(this.service, normalizeRepo(info, name));
  }
}

class ServiceArtifactsRepo implements ArtifactsRepoLike {
  readonly id?: string;
  readonly name: string;
  readonly remote: string;
  readonly defaultBranch?: string;
  readonly status?: "ready" | "creating" | "importing" | "forking";
  readonly token?: string;

  constructor(
    private readonly service: BindingFacadeFetcher,
    info: ArtifactRepoInfo & { remote: string },
  ) {
    this.id = info.id;
    this.name = info.name;
    this.remote = info.remote;
    this.defaultBranch = info.defaultBranch;
    this.status = info.status;
    this.token = info.token;
  }

  createToken(
    scope: "read" | "write" = "write",
    ttlSeconds = 600,
  ): Promise<ArtifactTokenResult> {
    return bindingFacadeJson<ArtifactTokenResult>(
      this.service,
      "artifacts",
      "tokens",
      jsonRequest({ scope, ttlSeconds }, { method: "POST" }),
      { name: this.name },
    );
  }
}

function normalizeRepo(
  info: ArtifactRepoInfo,
  fallbackName: string,
): ArtifactRepoInfo & { remote: string } {
  const name = info.name?.trim() || fallbackName;
  const remote = info.remote;
  if (!remote || typeof remote !== "string") {
    throw new Error(`Artifacts facade returned no remote for ${name}`);
  }
  return { ...info, name, remote };
}
