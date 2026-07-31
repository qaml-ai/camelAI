import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  createOrg,
  createUser,
  createWorkspace,
  type TestEnv,
} from "./test-helpers";
import type { OrgSsoConfig } from "../src/org-sso";
import { canCreateEnterpriseSsoUser } from "../src/identity/user-do";

const testEnv = env as unknown as TestEnv;

async function freshOrg() {
  const email = `sso-${crypto.randomUUID()}@example.com`;
  const { userId } = await createUser(testEnv, email, "password", "SSO Admin");
  const { org, defaultWorkspaceId } = await createOrg(
    testEnv,
    "SSO Org",
    userId,
  );
  return {
    userId,
    org,
    defaultWorkspaceId,
    orgStub: testEnv.ORG.get(testEnv.ORG.idFromName(org.id)),
  };
}

function config(actor: string): OrgSsoConfig {
  return {
    enabled: true,
    connection_id: crypto.randomUUID(),
    protocol: "oidc",
    issuer: "https://idp.example.com",
    client_id: "client",
    client_secret_encrypted: "ciphertext",
    client_auth_method: "client_secret_post",
    email_claim: "email",
    email_domains: ["example.com"],
    jit_provisioning_enabled: false,
    config_version: 1,
    session_ttl_seconds: 28_800,
    updated_at: Date.now(),
    updated_by: actor,
  };
}

describe("OrgDO enterprise SSO state", () => {
  it("creates enterprise SSO users as verified non-superusers", async () => {
    const userId = crypto.randomUUID();
    const user = await testEnv.USER.get(
      testEnv.USER.idFromName(userId),
    ).createUserFromEnterpriseSso(
      userId,
      `enterprise-${userId}@example.com`,
      "Enterprise User",
    );
    expect(user).toMatchObject({
      id: userId,
      is_superuser: false,
    });
    expect(user.email_verified_at).toBeTypeOf("number");
  });

  it("refuses to create a superuser identity through enterprise SSO", () => {
    expect(
      canCreateEnterpriseSsoUser("ops@camelai.test", "ops@camelai.test"),
    ).toBe(false);
    expect(canCreateEnterpriseSsoUser("member@example.com")).toBe(true);
    expect(canCreateEnterpriseSsoUser("admin-one@example.com")).toBe(true);
  });

  it("atomically consumes a login transaction once", async () => {
    const { orgStub } = await freshOrg();
    const transaction = {
      id: crypto.randomUUID(),
      connection_id: "connection",
      config_version: 1,
      pkce_verifier: "verifier",
      nonce: "nonce",
      browser_binding_hash: "binding-hash",
      link_user_id: null,
      redirect_path: "/chat",
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    };
    await orgStub.createSsoTransaction(transaction);
    await expect(
      orgStub.consumeSsoTransaction(transaction.id, "wrong-hash"),
    ).resolves.toBeNull();
    await expect(
      orgStub.consumeSsoTransaction(transaction.id, "binding-hash"),
    ).resolves.toMatchObject(transaction);
    await expect(
      orgStub.consumeSsoTransaction(transaction.id, "binding-hash"),
    ).resolves.toBeNull();
  });

  it("does not return an expired transaction", async () => {
    const { orgStub } = await freshOrg();
    const id = crypto.randomUUID();
    await orgStub.createSsoTransaction({
      id,
      connection_id: "connection",
      config_version: 1,
      pkce_verifier: "verifier",
      nonce: "nonce",
      browser_binding_hash: "binding-hash",
      link_user_id: null,
      redirect_path: "/",
      created_at: Date.now() - 20_000,
      expires_at: Date.now() - 10_000,
    });
    await expect(
      orgStub.consumeSsoTransaction(id, "binding-hash"),
    ).resolves.toBeNull();
  });

  it("stores connection tests for their initiating admin and consumes only successful tests", async () => {
    const { orgStub, userId } = await freshOrg();
    const candidate = { ...config(userId), enabled: false };
    const id = crypto.randomUUID();
    await orgStub.createSsoConnectionTest({
      id,
      actor_user_id: userId,
      base_config_version: 0,
      config: candidate,
      status: "pending",
      checks: {
        discovery_document_found: true,
        authorization_endpoint_found: true,
        token_endpoint_found: true,
        jwks_loaded: true,
        token_exchange_succeeded: false,
      },
      identity: null,
      error: null,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      completed_at: null,
    });
    await expect(
      orgStub.getSsoConnectionTest(id, "different-user"),
    ).resolves.toBeNull();
    await expect(
      orgStub.consumeSuccessfulSsoConnectionTest(id, userId),
    ).resolves.toBeNull();

    await orgStub.completeSsoConnectionTest(id, userId, {
      status: "succeeded",
      checks: {
        discovery_document_found: true,
        authorization_endpoint_found: true,
        token_endpoint_found: true,
        jwks_loaded: true,
        token_exchange_succeeded: true,
      },
      identity: {
        email: "admin@example.com",
        domain: "example.com",
        email_verified: true,
        hosted_domain: "example.com",
      },
      error: null,
      completed_at: Date.now(),
    });
    await expect(
      orgStub.consumeSuccessfulSsoConnectionTest(id, userId),
    ).resolves.toMatchObject({
      id,
      status: "succeeded",
      identity: { email: "admin@example.com" },
    });
    await expect(orgStub.getSsoConnectionTest(id, userId)).resolves.toBeNull();
  });

  it("does not return an expired connection test", async () => {
    const { orgStub, userId } = await freshOrg();
    const id = crypto.randomUUID();
    await orgStub.createSsoConnectionTest({
      id,
      actor_user_id: userId,
      base_config_version: 0,
      config: { ...config(userId), enabled: false },
      status: "pending",
      checks: {
        discovery_document_found: true,
        authorization_endpoint_found: true,
        token_endpoint_found: true,
        jwks_loaded: true,
        token_exchange_succeeded: false,
      },
      identity: null,
      error: null,
      created_at: Date.now() - 20_000,
      expires_at: Date.now() - 10_000,
      completed_at: null,
    });
    await expect(orgStub.getSsoConnectionTest(id, userId)).resolves.toBeNull();
  });

  it("version-bumps on disable so issued sessions are revocable", async () => {
    const { orgStub, userId } = await freshOrg();
    const active = config(userId);
    await orgStub.setSsoConfig(active, userId);
    const disabled = await orgStub.disableSsoConfig(userId);
    expect(disabled).toMatchObject({ enabled: false, config_version: 2 });
    await expect(orgStub.getSsoConfig()).resolves.toMatchObject({
      enabled: false,
      config_version: 2,
    });
  });

  it("keys external identities by connection, issuer, and subject", async () => {
    const { orgStub } = await freshOrg();
    await expect(
      orgStub.bindSsoIdentity(
        "connection-a",
        "https://one.example",
        "same-sub",
        "user-a",
        "a@example.com",
      ),
    ).resolves.toBe("user-a");
    await expect(
      orgStub.bindSsoIdentity(
        "connection-b",
        "https://two.example",
        "same-sub",
        "user-b",
        "b@example.com",
      ),
    ).resolves.toBe("user-b");
    await expect(
      orgStub.getSsoIdentityUserId(
        "connection-a",
        "https://one.example",
        "same-sub",
      ),
    ).resolves.toBe("user-a");
    await expect(
      orgStub.getSsoIdentityUserId(
        "connection-b",
        "https://two.example",
        "same-sub",
      ),
    ).resolves.toBe("user-b");
  });

  it("atomically converges concurrent JIT claims without using a global email identity", async () => {
    const { orgStub } = await freshOrg();
    const connectionId = crypto.randomUUID();
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        orgStub.claimSsoJitIdentity(
          connectionId,
          "https://idp.example.com",
          "subject-1",
          "tenant-user@example.com",
        ),
      ),
    );
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((claim) => claim?.userId))).toHaveProperty(
      "size",
      1,
    );
    expect(claims.every((claim) => claim?.tenantScoped)).toBe(true);

    await expect(
      orgStub.claimSsoJitIdentity(
        connectionId,
        "https://idp.example.com",
        "subject-2",
        "tenant-user@example.com",
      ),
    ).resolves.toBeNull();
  });

  it("atomically provisions a matching invitation and preserves its access policy", async () => {
    const {
      org,
      orgStub,
      userId: ownerId,
      defaultWorkspaceId,
    } = await freshOrg();
    const allowedWorkspace = await createWorkspace(
      testEnv,
      org.id,
      "Invited workspace",
      ownerId,
    );
    const email = `invited-${crypto.randomUUID()}@example.com`;
    const invitation = await orgStub.createInvitation(email, "admin", ownerId, {
      [defaultWorkspaceId]: "none",
      [allowedWorkspace.id]: "full",
    });
    const connectionId = crypto.randomUUID();
    const issuer = "https://idp.example.com";
    const subject = "invited-subject";

    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        orgStub.claimSsoInvitedIdentity(connectionId, issuer, subject, email),
      ),
    );
    expect(claims.every(Boolean)).toBe(true);
    expect(new Set(claims.map((claim) => claim?.userId))).toHaveProperty(
      "size",
      1,
    );
    const userId = claims[0]!.userId;
    await expect(orgStub.getInvitation(invitation.id)).resolves.toBeNull();
    await expect(orgStub.getMember(userId)).resolves.toMatchObject({
      role: "admin",
    });
    await expect(
      orgStub.getWorkspaceAccess(defaultWorkspaceId, userId),
    ).resolves.toBe("none");
    await expect(
      orgStub.getWorkspaceAccess(allowedWorkspace.id, userId),
    ).resolves.toBe("full");
    await expect(
      orgStub.claimSsoInvitedIdentity(
        connectionId,
        issuer,
        "different-subject",
        email,
      ),
    ).resolves.toBeNull();
  });

  it("does not persist an SSO identity without a matching invitation", async () => {
    const { orgStub } = await freshOrg();
    const connectionId = crypto.randomUUID();
    const issuer = "https://idp.example.com";
    const subject = "uninvited-subject";
    const email = `uninvited-${crypto.randomUUID()}@example.com`;

    await expect(
      orgStub.claimSsoInvitedIdentity(connectionId, issuer, subject, email),
    ).resolves.toBeNull();
    await expect(
      orgStub.getSsoIdentity(connectionId, issuer, subject),
    ).resolves.toBeNull();
  });

  it("allows only one subject to consume an invitation", async () => {
    const { orgStub, userId: ownerId } = await freshOrg();
    const connectionId = crypto.randomUUID();
    const issuer = "https://idp.example.com";
    const email = `single-use-${crypto.randomUUID()}@example.com`;
    await orgStub.createInvitation(email, "member", ownerId);

    const claims = await Promise.all([
      orgStub.claimSsoInvitedIdentity(
        connectionId,
        issuer,
        "first-subject",
        email,
      ),
      orgStub.claimSsoInvitedIdentity(
        connectionId,
        issuer,
        "second-subject",
        email,
      ),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(
      await orgStub.getSsoIdentityByEmail(connectionId, issuer, email),
    ).toMatchObject({
      email,
      tenantScoped: true,
      membershipRevoked: false,
    });
  });

  it("requires an explicit same-user link to rebind an email after connection rotation", async () => {
    const { orgStub, userId } = await freshOrg();
    const email = `rotation-${crypto.randomUUID()}@example.com`;
    const issuer = "https://idp.example.com";

    expect(
      await orgStub.bindSsoIdentity(
        "old-connection",
        issuer,
        "old-subject",
        userId,
        email,
      ),
    ).toBe(userId);
    expect(
      await orgStub.bindSsoIdentity(
        "new-connection",
        issuer,
        "new-subject",
        userId,
        email,
      ),
    ).toBeNull();
    expect(
      await orgStub.bindSsoIdentity(
        "new-connection",
        issuer,
        "new-subject",
        crypto.randomUUID(),
        email,
        true,
      ),
    ).toBeNull();
    expect(
      await orgStub.bindSsoIdentity(
        "new-connection",
        issuer,
        "new-subject",
        userId,
        email,
        true,
      ),
    ).toBe(userId);
  });

  it("lets an explicit invitation restore a removed SSO identity", async () => {
    const { orgStub, userId: ownerId } = await freshOrg();
    const connectionId = crypto.randomUUID();
    const issuer = "https://idp.example.com";
    const subject = "returning-subject";
    const email = `returning-${crypto.randomUUID()}@example.com`;
    const identity = await orgStub.claimSsoJitIdentity(
      connectionId,
      issuer,
      subject,
      email,
    );
    expect(identity).not.toBeNull();
    await orgStub.addMember(identity!.userId, "member", ownerId, {
      workspaceAccessDefault: "none",
    });
    await orgStub.removeMember(identity!.userId, ownerId);
    await orgStub.createInvitation(email, "member", ownerId);

    await expect(
      orgStub.claimSsoInvitedIdentity(connectionId, issuer, subject, email),
    ).resolves.toMatchObject({
      userId: identity!.userId,
      membershipRevoked: false,
    });
    await expect(orgStub.getMember(identity!.userId)).resolves.toMatchObject({
      role: "member",
    });
  });

  it("does not let a JIT claim silently acquire an existing global member identity", async () => {
    const { orgStub } = await freshOrg();
    const connectionId = crypto.randomUUID();
    await orgStub.bindSsoIdentity(
      connectionId,
      "https://idp.example.com",
      "linked-subject",
      "global-user",
      "member@example.com",
    );
    await expect(
      orgStub.claimSsoJitIdentity(
        connectionId,
        "https://idp.example.com",
        "rotated-subject",
        "member@example.com",
      ),
    ).resolves.toBeNull();
  });

  it("keeps removed SSO identities revoked until explicit membership restoration", async () => {
    const { orgStub, userId: ownerId } = await freshOrg();
    const connectionId = crypto.randomUUID();
    const identity = await orgStub.claimSsoJitIdentity(
      connectionId,
      "https://idp.example.com",
      "subject-1",
      "removed-user@example.com",
    );
    expect(identity).not.toBeNull();
    const userId = identity!.userId;
    await orgStub.addMember(userId, "member", ownerId, {
      workspaceAccessDefault: "none",
    });
    await orgStub.removeMember(userId, ownerId);
    await expect(
      orgStub.getSsoIdentity(
        connectionId,
        "https://idp.example.com",
        "subject-1",
      ),
    ).resolves.toMatchObject({ userId, membershipRevoked: true });
    await expect(
      orgStub.claimSsoJitIdentity(
        crypto.randomUUID(),
        "https://rotated-idp.example.com",
        "replacement-subject",
        "removed-user@example.com",
      ),
    ).resolves.toBeNull();

    await orgStub.addMember(userId, "member", ownerId, {
      workspaceAccessDefault: "none",
    });
    await expect(
      orgStub.getSsoIdentity(
        connectionId,
        "https://idp.example.com",
        "subject-1",
      ),
    ).resolves.toMatchObject({ userId, membershipRevoked: false });
  });

  it("defaults JIT members to no access across existing and future workspaces", async () => {
    const {
      org,
      orgStub,
      userId: ownerId,
      defaultWorkspaceId,
    } = await freshOrg();
    const second = await createWorkspace(
      testEnv,
      org.id,
      "Existing restricted workspace",
      ownerId,
    );
    const jitUserId = crypto.randomUUID();
    await orgStub.addMember(jitUserId, "member", "enterprise-sso-jit", {
      workspaceAccessDefault: "none",
    });
    await orgStub.setWorkspaceAccess(
      defaultWorkspaceId,
      jitUserId,
      "full",
      "enterprise-sso-jit",
    );

    await expect(
      orgStub.getWorkspaceAccess(defaultWorkspaceId, jitUserId),
    ).resolves.toBe("full");
    await expect(
      orgStub.getWorkspaceAccess(second.id, jitUserId),
    ).resolves.toBe("none");
    await expect(orgStub.listUserWorkspaces(jitUserId)).resolves.toEqual([
      expect.objectContaining({ id: defaultWorkspaceId }),
    ]);
    await expect(
      orgStub.listWorkspaceMembers(second.id),
    ).resolves.toContainEqual({ user_id: jitUserId, access_level: "none" });

    const future = await createWorkspace(
      testEnv,
      org.id,
      "Future restricted workspace",
      ownerId,
    );
    await expect(
      orgStub.getWorkspaceAccess(future.id, jitUserId),
    ).resolves.toBe("none");
  });

  it("atomically restores a default-none member and exact workspace overrides", async () => {
    const {
      org,
      orgStub,
      userId: ownerId,
      defaultWorkspaceId,
    } = await freshOrg();
    const restricted = await createWorkspace(
      testEnv,
      org.id,
      "Restricted workspace",
      ownerId,
    );
    const jitUserId = crypto.randomUUID();
    await orgStub.addMember(jitUserId, "member", ownerId, {
      workspaceAccessDefault: "none",
      initialWorkspaceId: defaultWorkspaceId,
    });
    const accessRows = (await orgStub.listWorkspaceAccessRows())
      .filter((row) => row.user_id === jitUserId)
      .map((row) => ({
        workspaceId: row.workspace_id,
        accessLevel: row.access_level,
      }));

    await orgStub.removeMember(jitUserId, ownerId);
    await orgStub.addMember(jitUserId, "member", ownerId, {
      workspaceAccessDefault: "none",
      workspaceAccessRows: accessRows,
    });

    await expect(
      orgStub.getWorkspaceAccess(defaultWorkspaceId, jitUserId),
    ).resolves.toBe("full");
    await expect(
      orgStub.getWorkspaceAccess(restricted.id, jitUserId),
    ).resolves.toBe("none");
    await expect(orgStub.getMember(jitUserId)).resolves.toMatchObject({
      workspace_access_default: "none",
    });
  });
});
