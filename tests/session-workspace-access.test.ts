import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignedSessionCookieHeader } from "@/lib/cookies.server";

const getEnvMock = vi.fn();
const redirectIfBannedSessionMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/ban.server", () => ({
  redirectIfBannedSession: redirectIfBannedSessionMock,
}));

const { requireSessionWorkspaceAccess } = await import("@/lib/auth.server");

const TOKEN_SIGNING_SECRET = "test-session-secret";

async function makeRequest(): Promise<Request> {
  const request = new Request("https://camelai.test/api/test");
  const cookie = await createSignedSessionCookieHeader(
    {
      user_id: "user_123",
      org_id: "org_123",
      workspace_id: "ws_123",
      created_at: Date.now(),
      user_name: "Test User",
      user_email: "test@example.com",
      auth_source: null,
    },
    TOKEN_SIGNING_SECRET,
    request,
  );
  return new Request(request, {
    headers: {
      Cookie: cookie.split(";", 1)[0] ?? cookie,
    },
  });
}

describe("requireSessionWorkspaceAccess", () => {
  let userStub: {
    getSessionInvalidatedAt: ReturnType<typeof vi.fn>;
  };
  let orgStub: {
    isMember: ReturnType<typeof vi.fn>;
    getWorkspaceAccessContext: ReturnType<typeof vi.fn>;
  };
  let workspaceStub: {
    getInfoAndMemberAccess: ReturnType<typeof vi.fn>;
    getInfo: ReturnType<typeof vi.fn>;
    getMemberAccess: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    userStub = {
      getSessionInvalidatedAt: vi.fn().mockResolvedValue(null),
    };
    orgStub = {
      isMember: vi.fn().mockResolvedValue(true),
      getWorkspaceAccessContext: vi.fn().mockResolvedValue({
        workspace: {
          id: "ws_123",
          org_id: "org_123",
          archived: false,
        },
        access: "full",
      }),
    };
    workspaceStub = {
      getInfoAndMemberAccess: vi.fn().mockResolvedValue({
        info: {
          id: "ws_123",
          org_id: "org_123",
          archived: false,
        },
        memberAccess: {
          user_id: "user_123",
          access_level: "full",
          granted_by: "owner_123",
          granted_at: 1,
        },
      }),
      getInfo: vi.fn(async () => {
        throw new Error("unexpected workspace info read");
      }),
      getMemberAccess: vi.fn(async () => {
        throw new Error("unexpected member access read");
      }),
    };
    getEnvMock.mockReturnValue({
      TOKEN_SIGNING_SECRET,
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
    });
    redirectIfBannedSessionMock.mockResolvedValue(undefined);
  });

  it("uses the workspace access bootstrap RPC", async () => {
    const request = await makeRequest();

    await expect(
      requireSessionWorkspaceAccess(request, {}),
    ).resolves.toMatchObject({
      orgId: "org_123",
      workspaceId: "ws_123",
      userId: "user_123",
      access: "full",
    });

    expect(orgStub.getWorkspaceAccessContext).toHaveBeenCalledWith(
      "ws_123",
      "user_123",
    );
    expect(workspaceStub.getInfoAndMemberAccess).not.toHaveBeenCalled();
    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(workspaceStub.getMemberAccess).not.toHaveBeenCalled();
    expect(orgStub.isMember).toHaveBeenCalledWith("user_123");
  });

  it("fails when the workspace access bootstrap RPC is missing", async () => {
    const error = new Error("No such RPC method getWorkspaceAccessContext");
    orgStub.getWorkspaceAccessContext.mockRejectedValueOnce(error);
    const request = await makeRequest();

    await expect(
      requireSessionWorkspaceAccess(request, {}),
    ).rejects.toBe(error);

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(workspaceStub.getMemberAccess).not.toHaveBeenCalled();
  });

  it("retries transient workspace access bootstrap RPC failures", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    orgStub.getWorkspaceAccessContext
      .mockRejectedValueOnce(
        new Error("Durable Object reset because its code was updated."),
      )
      .mockResolvedValueOnce({
        workspace: {
          id: "ws_123",
          org_id: "org_123",
          archived: false,
        },
        access: "full",
      });
    const request = await makeRequest();

    await expect(
      requireSessionWorkspaceAccess(request, {}),
    ).resolves.toMatchObject({
      access: "full",
    });

    expect(orgStub.getWorkspaceAccessContext).toHaveBeenCalledTimes(2);
    expect(workspaceStub.getInfoAndMemberAccess).not.toHaveBeenCalled();
    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(workspaceStub.getMemberAccess).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("starts the workspace reads alongside the session checks, and decides nothing until the session is valid", async () => {
    let releaseInvalidation: (value: number | null) => void = () => {};
    userStub.getSessionInvalidatedAt.mockReturnValueOnce(
      new Promise((resolve) => { releaseInvalidation = resolve; }),
    );
    const request = await makeRequest();
    const pending = requireSessionWorkspaceAccess(request, {});
    await vi.waitFor(() => expect(orgStub.getWorkspaceAccessContext).toHaveBeenCalledWith("ws_123", "user_123"));
    expect(orgStub.isMember).toHaveBeenCalledWith("user_123");
    // A logout since the cookie was issued still refuses it.
    releaseInvalidation(Date.now() + 60_000);
    await expect(pending).rejects.toMatchObject({ status: 302 });
  });

  it("still redirects a banned session whose workspace reads started early", async () => {
    const banned = new Response(null, { status: 302, headers: { Location: "/banned" } });
    redirectIfBannedSessionMock.mockRejectedValueOnce(banned);
    const request = await makeRequest();
    await expect(requireSessionWorkspaceAccess(request, {})).rejects.toBe(banned);
  });

  it("reports where its time went", async () => {
    const timings: { session?: number; access?: number } = {};
    const request = await makeRequest();
    await requireSessionWorkspaceAccess(request, {}, undefined, { timings });
    expect(timings.session).toBeGreaterThanOrEqual(0);
    expect(timings.access).toBeGreaterThanOrEqual(timings.session!);
  });
});
