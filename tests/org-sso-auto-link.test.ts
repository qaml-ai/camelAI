import { describe, expect, it, vi } from "vitest";
import type { User } from "@/types";
import type { AuthEnv } from "@/lib/auth-helpers";
import {
  resolveOrgSsoUser,
  validateOrgSsoIdentityClaims,
} from "@/lib/org-sso.server";

function user(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "alice@example.com",
    email_verified_at: Date.now(),
    name: "Alice",
    created_at: Date.now(),
    is_superuser: false,
    avatar: { color: "#000000", content: "A" },
    is_orphaned: false,
    orphaned_at: null,
    ...overrides,
  };
}

function authEnv(profile: User): AuthEnv {
  const userStub = { getProfile: vi.fn().mockResolvedValue(profile) };
  return {
    EMAIL_TO_USER: {
      get: vi.fn().mockResolvedValue(profile.id),
    },
    USER: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => userStub),
    },
    APP_KV: {
      get: vi.fn().mockResolvedValue(null),
    },
  } as unknown as AuthEnv;
}

const googleIdentity = validateOrgSsoIdentityClaims(
  {
    sub: "google-subject",
    email: "alice@example.com",
    email_verified: true,
    hd: "example.com",
  },
  {
    issuer: "https://accounts.google.com",
    email_claim: "email",
    email_domains: ["example.com"],
  },
);

describe("enterprise SSO first-login linking", () => {
  it("auto-links a verified existing organization member", async () => {
    const profile = user();
    const memberLookup = {
      getMember: vi.fn().mockResolvedValue({ role: "member" }),
    };
    await expect(
      resolveOrgSsoUser({
        authEnv: authEnv(profile),
        orgStub: memberLookup,
        identity: googleIdentity,
        mappedUserId: null,
        linkUserId: null,
      }),
    ).resolves.toEqual({
      userId: profile.id,
      user: profile,
      tenantScoped: false,
    });
    expect(memberLookup.getMember).toHaveBeenCalledWith(profile.id);
  });

  it("trusts the signed IdP email for an existing member", async () => {
    await expect(
      resolveOrgSsoUser({
        authEnv: authEnv(user({ email_verified_at: null })),
        orgStub: { getMember: vi.fn().mockResolvedValue({ role: "member" }) },
        identity: googleIdentity,
        mappedUserId: null,
        linkUserId: null,
      }),
    ).resolves.toMatchObject({ userId: "user-1" });
  });

  it("does not add an uninvited global non-member when open provisioning is disabled", async () => {
    await expect(
      resolveOrgSsoUser({
        authEnv: authEnv(user()),
        orgStub: {
          getMember: vi.fn().mockResolvedValue(null),
          claimSsoInvitedIdentity: vi.fn().mockResolvedValue(null),
        },
        identity: googleIdentity,
        mappedUserId: null,
        connectionId: "connection-1",
        issuer: "https://accounts.google.com",
        linkUserId: null,
      }),
    ).resolves.toBeNull();
  });

  it("creates an invited tenant user without allowing open provisioning", async () => {
    let storedProfile: User | null = null;
    const createTenantUser = vi.fn(
      async (id: string, email: string, name: string | null) => {
        storedProfile = user({ id, email, name });
        return storedProfile;
      },
    );
    const userStub = {
      getProfile: vi.fn(async () => storedProfile),
      createUserFromEnterpriseSso: createTenantUser,
    };
    const invitedEnv = {
      EMAIL_TO_USER: {
        get: vi.fn().mockResolvedValue(null),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    } as unknown as AuthEnv;
    const claimSsoInvitedIdentity = vi.fn().mockResolvedValue({
      userId: "invited-tenant-user",
      email: googleIdentity.email,
      tenantScoped: true,
      membershipRevoked: false,
    });
    const claimSsoJitIdentity = vi.fn();

    await expect(
      resolveOrgSsoUser({
        authEnv: invitedEnv,
        orgStub: {
          getMember: vi.fn().mockResolvedValue(null),
          claimSsoInvitedIdentity,
          claimSsoJitIdentity,
        },
        identity: googleIdentity,
        mappedUserId: null,
        connectionId: "connection-1",
        issuer: "https://accounts.google.com",
        linkUserId: null,
        jitProvisioningEnabled: false,
      }),
    ).resolves.toMatchObject({
      userId: "invited-tenant-user",
      tenantScoped: true,
    });

    expect(claimSsoInvitedIdentity).toHaveBeenCalledWith(
      "connection-1",
      "https://accounts.google.com",
      googleIdentity.subject,
      googleIdentity.email,
    );
    expect(claimSsoJitIdentity).not.toHaveBeenCalled();
    expect(createTenantUser).toHaveBeenCalledTimes(1);
  });

  it("repairs an invited tenant profile after the invitation was already consumed", async () => {
    let storedProfile: User | null = null;
    const createTenantUser = vi.fn(
      async (id: string, email: string, name: string | null) => {
        storedProfile = user({ id, email, name });
        return storedProfile;
      },
    );
    const userStub = {
      getProfile: vi.fn(async () => storedProfile),
      createUserFromEnterpriseSso: createTenantUser,
    };
    const invitedEnv = {
      EMAIL_TO_USER: {
        get: vi.fn().mockResolvedValue(null),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    } as unknown as AuthEnv;

    await expect(
      resolveOrgSsoUser({
        authEnv: invitedEnv,
        orgStub: {
          getMember: vi.fn().mockResolvedValue({
            user_id: "invited-tenant-user",
          }),
          claimSsoInvitedIdentity: vi.fn(),
        },
        identity: googleIdentity,
        mappedUserId: "invited-tenant-user",
        mappedTenantScoped: true,
        mappedMembershipRevoked: false,
        connectionId: "connection-1",
        issuer: "https://accounts.google.com",
        linkUserId: null,
        jitProvisioningEnabled: false,
      }),
    ).resolves.toMatchObject({
      userId: "invited-tenant-user",
      tenantScoped: true,
    });

    expect(createTenantUser).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a tenant profile for a mapping without active membership", async () => {
    const createTenantUser = vi.fn();
    const userStub = {
      getProfile: vi.fn().mockResolvedValue(null),
      createUserFromEnterpriseSso: createTenantUser,
    };
    const invitedEnv = {
      EMAIL_TO_USER: {
        get: vi.fn().mockResolvedValue(null),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    } as unknown as AuthEnv;

    await expect(
      resolveOrgSsoUser({
        authEnv: invitedEnv,
        orgStub: {
          getMember: vi.fn().mockResolvedValue(null),
          claimSsoInvitedIdentity: vi.fn(),
        },
        identity: googleIdentity,
        mappedUserId: "dangling-tenant-user",
        mappedTenantScoped: true,
        mappedMembershipRevoked: false,
        connectionId: "connection-1",
        issuer: "https://accounts.google.com",
        linkUserId: null,
        jitProvisioningEnabled: false,
      }),
    ).resolves.toBeNull();

    expect(createTenantUser).not.toHaveBeenCalled();
  });

  it("prefers and consumes an invitation before open provisioning", async () => {
    const profile = user({ id: "invited-user" });
    const claimSsoInvitedIdentity = vi.fn().mockResolvedValue({
      userId: profile.id,
      email: profile.email,
      tenantScoped: true,
      membershipRevoked: false,
    });
    const claimSsoJitIdentity = vi.fn();
    const userStub = {
      getProfile: vi.fn().mockResolvedValue(profile),
      createUserFromEnterpriseSso: vi.fn().mockResolvedValue(profile),
    };
    const invitedEnv = {
      EMAIL_TO_USER: {
        get: vi.fn().mockResolvedValue(null),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    } as unknown as AuthEnv;

    await expect(
      resolveOrgSsoUser({
        authEnv: invitedEnv,
        orgStub: {
          getMember: vi.fn().mockResolvedValue(null),
          claimSsoInvitedIdentity,
          claimSsoJitIdentity,
        },
        identity: googleIdentity,
        mappedUserId: null,
        connectionId: "connection-1",
        issuer: "https://accounts.google.com",
        linkUserId: null,
        jitProvisioningEnabled: true,
      }),
    ).resolves.toMatchObject({ userId: profile.id });

    expect(claimSsoInvitedIdentity).toHaveBeenCalledTimes(1);
    expect(claimSsoJitIdentity).not.toHaveBeenCalled();
  });

  it("keeps superusers out of enterprise-authenticated sessions", async () => {
    try {
      await resolveOrgSsoUser({
        authEnv: authEnv(user({ is_superuser: true })),
        orgStub: { getMember: vi.fn().mockResolvedValue({ role: "owner" }) },
        identity: googleIdentity,
        mappedUserId: null,
        linkUserId: null,
      });
      throw new Error("Expected superuser resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(403);
    }
  });

  it("creates and resumes a tenant-scoped JIT user without touching the global email index", async () => {
    const tenantUser = user({ id: "tenant-user-1" });
    let storedProfile: User | null = null;
    const emailGet = vi.fn().mockResolvedValue("global-user");
    const emailPut = vi.fn();
    const emailDelete = vi.fn();
    const createTenantUser = vi.fn(
      async (id: string, email: string, name: string | null) => {
        storedProfile = user({ id, email, name });
        return storedProfile;
      },
    );
    const userStub = {
      getProfile: vi.fn(async () => storedProfile),
      createUserFromEnterpriseSso: createTenantUser,
    };
    const globalUserStub = {
      getProfile: vi.fn(async () =>
        user({ id: "global-user", email: tenantUser.email }),
      ),
    };
    const tenantEnv = {
      EMAIL_TO_USER: {
        get: emailGet,
        put: emailPut,
        delete: emailDelete,
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn((id: string) =>
          id === "global-user" ? globalUserStub : userStub,
        ),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    } as unknown as AuthEnv;
    const claimSsoJitIdentity = vi.fn().mockResolvedValue({
      userId: tenantUser.id,
      email: tenantUser.email,
      tenantScoped: true,
    });
    const orgStub = {
      getMember: vi.fn().mockResolvedValue(null),
      claimSsoJitIdentity,
    };

    await expect(
      resolveOrgSsoUser({
        authEnv: tenantEnv,
        orgStub,
        identity: googleIdentity,
        mappedUserId: null,
        connectionId: "connection-1",
        issuer: "https://accounts.google.com",
        linkUserId: null,
        jitProvisioningEnabled: true,
      }),
    ).resolves.toMatchObject({ userId: tenantUser.id });

    // Simulate a repeat callback after an interrupted first login. The OrgDO
    // mapping is durable and account creation is idempotent at the same id.
    storedProfile = null;
    await expect(
      resolveOrgSsoUser({
        authEnv: tenantEnv,
        orgStub,
        identity: googleIdentity,
        mappedUserId: tenantUser.id,
        mappedTenantScoped: true,
        connectionId: "connection-1",
        issuer: "https://accounts.google.com",
        linkUserId: null,
        jitProvisioningEnabled: true,
      }),
    ).resolves.toMatchObject({ userId: tenantUser.id });

    expect(claimSsoJitIdentity).toHaveBeenCalledTimes(1);
    expect(orgStub.getMember).toHaveBeenCalledWith("global-user");
    expect(createTenantUser).toHaveBeenCalledTimes(2);
    expect(emailGet).toHaveBeenCalledWith("email:alice@example.com");
    expect(emailPut).not.toHaveBeenCalled();
    expect(emailDelete).not.toHaveBeenCalled();
  });

  it("rejects configured bootstrap superuser emails before claiming a tenant identity", async () => {
    const claimSsoJitIdentity = vi.fn();
    const superuserIdentity = {
      ...googleIdentity,
      email: "ops@camelai.test",
    };
    try {
      await resolveOrgSsoUser({
        authEnv: {
          ...authEnv(user()),
          SUPERUSER_EMAILS: "ops@camelai.test",
          EMAIL_TO_USER: {
            get: vi.fn().mockResolvedValue(null),
          },
        } as unknown as AuthEnv,
        orgStub: {
          getMember: vi.fn().mockResolvedValue(null),
          claimSsoJitIdentity,
        },
        identity: superuserIdentity,
        mappedUserId: null,
        connectionId: "connection-1",
        issuer: "https://accounts.google.com",
        linkUserId: null,
        jitProvisioningEnabled: true,
      });
      throw new Error("Expected superuser JIT provisioning to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(403);
    }
    expect(claimSsoJitIdentity).not.toHaveBeenCalled();
  });
});
