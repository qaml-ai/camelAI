import { beforeEach, describe, expect, it, vi } from "vitest";
import { SELFHOST_CAPABILITY_CONTRACT_VERSION } from "@/lib/selfhost-capabilities";

const getEnvMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/selfhost-ai-provider", () => ({
  isSelfhostRuntime: (env: { CF_ACCOUNT_ID?: string }) =>
    env.CF_ACCOUNT_ID === "selfhost",
  getSelfhostAiProviderStatus: () => ({
    configured: true,
    valid: true,
    provider: "bedrock",
  }),
}));

const { loader } = await import("@/routes/api/selfhost.health");

describe("self-host health route", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    getEnvMock.mockReturnValue({
      CF_ACCOUNT_ID: "selfhost",
      APP_KV: {},
      SESSIONS: {},
      R2_BUCKET: {},
      APP_DB: {
        prepare: () => ({
          first: async () => ({ ok: 1 }),
        }),
      },
      ARTIFACTS: {},
      PROJECT_BUILD_SANDBOX: {},
      ANALYSIS_SANDBOX: {},
      DB_QUERY_SANDBOX: {},
      WORKER_BASE_URL: "https://selfhost.example",
      LOCAL_APP_VANITY_DOMAIN: "apps.selfhost.example",
      LOCAL_APP_IFRAME_DOMAIN: "preview.selfhost.example",
      LOCAL_ARTIFACTS_BASE_URL: "http://local-artifacts:7001",
    });
  });

  it("reports disabled email capabilities without degrading health", async () => {
    const response = await loader({ context: {} } as never);
    const body = await response.json() as {
      ok: boolean;
      status: string;
      checks: Array<{ name: string; status: string; message?: string }>;
      capabilities: {
        version: number;
        features: Record<string, { available: boolean | null; state: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "agent-pack",
          status: "ok",
          message: expect.stringContaining("No custom agent pack"),
        }),
      ]),
    );
    expect(body.checks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "email", status: "warn" }),
      ]),
    );
    expect(body.capabilities.version).toBe(SELFHOST_CAPABILITY_CONTRACT_VERSION);
    expect(body.capabilities.features.outbound_email).toMatchObject({
      state: "disabled",
      available: false,
    });
    expect(body.capabilities.features.project_builds).toMatchObject({
      state: "configured",
      available: null,
    });
    expect(body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "PROJECT_BUILD_SANDBOX",
          status: "ok",
          message: expect.stringContaining("Docker execution"),
        }),
      ]),
    );
  });

  it("summarizes a loaded agent pack in health checks", async () => {
    getEnvMock.mockReturnValue({
      ...getEnvMock(),
      SELFHOST_AGENT_PROMPT_APPEND: "Prefer internal mirrors.",
      SELFHOST_AGENT_SKILLS_JSON: JSON.stringify({
        files: {
          "acme-runbooks/SKILL.md": "---\nname: acme-runbooks\ndescription: ACME\n---\n",
        },
      }),
    });

    const response = await loader({ context: {} } as never);
    const body = await response.json() as {
      checks: Array<{ name: string; status: string; message?: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "agent-pack",
          status: "ok",
          message: expect.stringContaining("acme-runbooks"),
        }),
      ]),
    );
  });

  it("fails readiness and downgrades compute capability when a sandbox binding is missing", async () => {
    getEnvMock.mockReturnValue({
      ...getEnvMock(),
      PROJECT_BUILD_SANDBOX: undefined,
    });

    const response = await loader({ context: {} } as never);
    const body = await response.json() as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
      capabilities: {
        features: Record<string, { available: boolean | null; state: string }>;
      };
    };

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "PROJECT_BUILD_SANDBOX",
          status: "fail",
        }),
      ]),
    );
    expect(body.capabilities.features.project_builds).toMatchObject({
      state: "unavailable",
      available: false,
    });
    expect(body.capabilities.features.project_deploys.available).toBe(false);
  });

  it("requires the configured facade plane to pass its live gateway probe", async () => {
    const facade = {
      fetch: vi.fn(async () => Response.json({ ok: false }, { status: 503 })),
    };
    getEnvMock.mockReturnValue({
      ...getEnvMock(),
      R2_BUCKET: undefined,
      ARTIFACTS: undefined,
      PROJECT_BUILD_SANDBOX: undefined,
      ANALYSIS_SANDBOX: undefined,
      DB_QUERY_SANDBOX: undefined,
      LOCAL_ARTIFACTS_BASE_URL: undefined,
      OBJECT_STORE_SERVICE: facade,
      ARTIFACTS_SERVICE: facade,
      COMPUTE_SERVICE: facade,
    });

    const response = await loader({ context: {} } as never);
    const body = await response.json() as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
      capabilities: { features: Record<string, { available: boolean | null }> };
    };

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(facade.fetch).toHaveBeenCalledOnce();
    expect(body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "binding-facades", status: "fail" }),
      expect.objectContaining({ name: "R2_BUCKET", status: "fail" }),
      expect.objectContaining({ name: "PROJECT_BUILD_SANDBOX", status: "fail" }),
    ]));
    expect(body.capabilities.features.project_builds.available).toBe(false);
  });

  it("accepts facade-backed capabilities only after the host gateway is healthy", async () => {
    const facade = {
      fetch: vi.fn(async () => Response.json({ ok: true })),
    };
    getEnvMock.mockReturnValue({
      ...getEnvMock(),
      R2_BUCKET: undefined,
      ARTIFACTS: undefined,
      PROJECT_BUILD_SANDBOX: undefined,
      ANALYSIS_SANDBOX: undefined,
      DB_QUERY_SANDBOX: undefined,
      LOCAL_ARTIFACTS_BASE_URL: undefined,
      OBJECT_STORE_SERVICE: facade,
      ARTIFACTS_SERVICE: facade,
      COMPUTE_SERVICE: facade,
    });

    const response = await loader({ context: {} } as never);
    const body = await response.json() as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
      capabilities: { features: Record<string, { state: string }> };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "binding-facades", status: "ok" }),
      expect.objectContaining({ name: "R2_BUCKET", status: "ok" }),
      expect.objectContaining({ name: "PROJECT_BUILD_SANDBOX", status: "ok" }),
    ]));
    expect(body.capabilities.features.project_builds.state).toBe("configured");
  });
});
