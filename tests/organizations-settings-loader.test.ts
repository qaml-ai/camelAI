import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const getOrgSettingsSummaryMock = vi.fn();
const getOrgMembersMock = vi.fn();
const listOrgWorkspacesMock = vi.fn();
const getOrgMock = vi.fn();
const createOrgMock = vi.fn();
const removeOrgMemberMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getOrgSettingsSummary: getOrgSettingsSummaryMock,
  getOrgMembers: getOrgMembersMock,
  listOrgWorkspaces: listOrgWorkspacesMock,
  getOrg: getOrgMock,
  createOrg: createOrgMock,
  removeOrgMember: removeOrgMemberMock,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => null,
}));

vi.mock("@/components/settings/settings-header", () => ({
  SettingsHeader: () => null,
}));

vi.mock("@/components/settings/org-memberships-list", () => ({
  OrgMembershipsList: () => null,
}));

const { action, loader } = await import("@/routes/_app.settings.organizations");

describe("organizations settings loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({ env: true });
    getAuthEnvMock.mockReturnValue({ auth: true });
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_1" },
      currentOrg: { id: "org_1" },
      orgs: [
        {
          org_id: "org_1",
          org_name: "Primary",
          role: "owner",
          joined_at: 10,
        },
        {
          org_id: "org_2",
          org_name: "Side Project",
          role: "member",
          joined_at: 20,
        },
      ],
    });
    getOrgSettingsSummaryMock.mockImplementation(
      async (_authEnv: unknown, orgId: string) => {
        if (orgId === "org_1") {
          return {
            billing_plan: "pro",
            billing_status: "active",
            member_count: 3,
            workspace_count: 2,
          };
        }
        return {
          billing_plan: "starter",
          billing_status: "trialing",
          member_count: 1,
          workspace_count: 1,
        };
      },
    );
  });

  it("loads one settings summary per org instead of separate member/workspace/info calls", async () => {
    const result = await loader({
      request: new Request("https://camelai.test/settings/organizations"),
      context: {},
      params: {},
    } as never);

    expect(getOrgSettingsSummaryMock).toHaveBeenCalledTimes(2);
    expect(getOrgSettingsSummaryMock).toHaveBeenNthCalledWith(
      1,
      { auth: true },
      "org_1",
    );
    expect(getOrgSettingsSummaryMock).toHaveBeenNthCalledWith(
      2,
      { auth: true },
      "org_2",
    );
    expect(getOrgMembersMock).not.toHaveBeenCalled();
    expect(listOrgWorkspacesMock).not.toHaveBeenCalled();
    expect(getOrgMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      currentOrgId: "org_1",
      currentUserId: "user_1",
      orgs: [
        {
          org_id: "org_1",
          billing_plan: "pro",
          member_count: 3,
          workspace_count: 2,
        },
        {
          org_id: "org_2",
          billing_plan: "starter",
          member_count: 1,
          workspace_count: 1,
        },
      ],
    });
  });

  it("falls back to the per-org summary name when the auth-context org name is blank (lazy orgs)", async () => {
    // After lazy-loading org names out of auth, AuthContext.orgs carries a name
    // only for the current org; others are "". The page must still render their
    // names from the per-org summary it already fetches.
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_1" },
      currentOrg: { id: "org_1" },
      orgs: [
        { org_id: "org_1", org_name: "Primary", role: "owner", joined_at: 10 },
        { org_id: "org_2", org_name: "", role: "member", joined_at: 20 },
      ],
    });
    getOrgSettingsSummaryMock.mockImplementation(
      async (_authEnv: unknown, orgId: string) => ({
        name: orgId === "org_1" ? "Primary" : "Side Project",
        billing_plan: "starter",
        billing_status: "trialing",
        member_count: 1,
        workspace_count: 1,
      }),
    );

    const result = await loader({
      request: new Request("https://camelai.test/settings/organizations"),
      context: {},
      params: {},
    } as never);

    const nameById = Object.fromEntries(
      result.orgs.map((org) => [org.org_id, org.org_name]),
    );
    expect(nameById.org_1).toBe("Primary");
    expect(nameById.org_2).toBe("Side Project");
  });

  it("hides archived orgs that linger in the auth bootstrap membership list", async () => {
    // Admin archiveOrg doesn't prune UserDO memberships, so an archived
    // org can still appear in authContext.orgs. The settings page must not
    // render it (or its "Switch to this org" action) — except the current org,
    // which stays visible so a user already inside one isn't stranded.
    getOrgSettingsSummaryMock.mockImplementation(
      async (_authEnv: unknown, orgId: string) => ({
        name: orgId === "org_1" ? "Primary" : "Side Project",
        archived: orgId === "org_2",
        billing_plan: "starter",
        billing_status: "trialing",
        member_count: 1,
        workspace_count: 1,
      }),
    );

    const result = await loader({
      request: new Request("https://camelai.test/settings/organizations"),
      context: {},
      params: {},
    } as never);

    const orgIds = result.orgs.map((org) => org.org_id);
    expect(orgIds).toContain("org_1");
    expect(orgIds).not.toContain("org_2");
  });

  it("keeps the current org visible even when it is archived", async () => {
    getOrgSettingsSummaryMock.mockImplementation(
      async (_authEnv: unknown, orgId: string) => ({
        name: orgId === "org_1" ? "Primary" : "Side Project",
        archived: true,
        billing_plan: "starter",
        billing_status: "trialing",
        member_count: 1,
        workspace_count: 1,
      }),
    );

    const result = await loader({
      request: new Request("https://camelai.test/settings/organizations"),
      context: {},
      params: {},
    } as never);

    const orgIds = result.orgs.map((org) => org.org_id);
    expect(orgIds).toEqual(["org_1"]);
  });

  it("does not let an enterprise session create a global organization", async () => {
    requireAuthContextMock.mockResolvedValueOnce({
      user: { id: "user_1" },
      session: {
        auth_source: "enterprise_oidc",
        org_id: "org_1",
      },
    });
    const formData = new FormData();
    formData.set("intent", "createOrg");
    formData.set("name", "Escaped org");

    const response = await action({
      request: new Request("https://camelai.test/settings/organizations", {
        method: "POST",
        body: formData,
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
    expect(createOrgMock).not.toHaveBeenCalled();
  });

  it("does not let an enterprise session leave a different organization", async () => {
    requireAuthContextMock.mockResolvedValueOnce({
      user: { id: "user_1" },
      session: {
        auth_source: "enterprise_oidc",
        org_id: "org_1",
      },
    });
    const formData = new FormData();
    formData.set("intent", "leaveOrg");
    formData.set("orgId", "org_2");

    const response = await action({
      request: new Request("https://camelai.test/settings/organizations", {
        method: "POST",
        body: formData,
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(403);
    expect(removeOrgMemberMock).not.toHaveBeenCalled();
  });
});
