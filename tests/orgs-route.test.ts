import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getUserOrgsMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getUserOrgs: getUserOrgsMock,
}));

const { loader } = await import("@/routes/api/orgs");

describe("GET /api/orgs (lazy switcher org list)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({ env: true });
    getAuthEnvMock.mockReturnValue({ auth: true });
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_1" },
      session: { auth_source: null, org_id: "org_1" },
    });
  });

  it("returns the user's full, named org list from getUserOrgs", async () => {
    const orgs = [
      { org_id: "org_1", org_name: "Primary", role: "owner", joined_at: 10, last_workspace_id: null },
      { org_id: "org_2", org_name: "Side Project", role: "member", joined_at: 20, last_workspace_id: null },
    ];
    getUserOrgsMock.mockResolvedValue(orgs);

    const result = await loader({
      request: new Request("https://camelai.test/api/orgs"),
      context: {},
      params: {},
    } as never);

    // Resolves names for ALL orgs (the per-org getInfo fan-out that no longer runs
    // in the auth critical path), keyed by the authenticated user.
    expect(getUserOrgsMock).toHaveBeenCalledWith({ auth: true }, "user_1", { d1Read: true });
    expect(result).toEqual({ orgs });
  });

  it("returns only the bound org for an enterprise SSO session", async () => {
    const orgs = [
      { org_id: "org_1", org_name: "Primary", role: "owner", joined_at: 10, last_workspace_id: null },
      { org_id: "org_2", org_name: "Side Project", role: "member", joined_at: 20, last_workspace_id: null },
    ];
    getUserOrgsMock.mockResolvedValue(orgs);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_1" },
      session: { auth_source: "enterprise_oidc", org_id: "org_1" },
    });

    const result = await loader({
      request: new Request("https://camelai.test/api/orgs"),
      context: {},
      params: {},
    } as never);

    expect(result).toEqual({ orgs: [orgs[0]] });
  });

  it("requires auth (propagates the redirect thrown by requireAuthContext)", async () => {
    requireAuthContextMock.mockRejectedValue(
      new Response(null, { status: 302, headers: { Location: "/login" } }),
    );

    await expect(
      loader({
        request: new Request("https://camelai.test/api/orgs"),
        context: {},
        params: {},
      } as never),
    ).rejects.toBeInstanceOf(Response);
    expect(getUserOrgsMock).not.toHaveBeenCalled();
  });
});
