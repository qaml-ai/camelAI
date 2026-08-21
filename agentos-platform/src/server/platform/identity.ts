import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";

export type Org = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
};

export type Workspace = {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  createdAt: string;
};

export type User = {
  id: string;
  email: string;
  name: string;
  orgId: string;
  createdAt: string;
};

export type Thread = {
  id: string;
  workspaceId: string;
  orgId: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type DemoTenant = {
  org: Org;
  workspace: Workspace;
  user: User;
};

const DEMO_ORG_ID = "org_demo";
const DEMO_WORKSPACE_ID = "ws_demo";
const DEMO_USER_ID = "user_demo";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

function orgKey(id: string): string {
  return `org:${id}`;
}

function workspaceKey(id: string): string {
  return `workspace:${id}`;
}

function userKey(id: string): string {
  return `user:${id}`;
}

function userPasswordKey(id: string): string {
  return `user-password:${id}`;
}

function threadKey(id: string): string {
  return `thread:${id}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export class IdentityService {
  constructor(private readonly store: Store) {}

  createOrg(input: { name: string; slug?: string; id?: string }): Org {
    const name = input.name?.trim();
    if (!name) {
      throw new Error("createOrg: name is required");
    }
    const id = input.id ?? `org_${randomUUID()}`;
    if (this.store.get(orgKey(id))) {
      throw new Error(`createOrg: org already exists: ${id}`);
    }
    const org: Org = {
      id,
      name,
      slug: input.slug?.trim() || slugify(name),
      createdAt: nowIso(),
    };
    this.store.set(orgKey(id), org);
    return org;
  }

  getOrg(id: string): Org | undefined {
    return this.store.get<Org>(orgKey(id));
  }

  createWorkspace(input: {
    orgId: string;
    name: string;
    slug?: string;
    id?: string;
  }): Workspace {
    const name = input.name?.trim();
    if (!name) {
      throw new Error("createWorkspace: name is required");
    }
    if (!input.orgId) {
      throw new Error("createWorkspace: orgId is required");
    }
    if (!this.store.get(orgKey(input.orgId))) {
      throw new Error(`createWorkspace: org not found: ${input.orgId}`);
    }
    const id = input.id ?? `ws_${randomUUID()}`;
    if (this.store.get(workspaceKey(id))) {
      throw new Error(`createWorkspace: workspace already exists: ${id}`);
    }
    const workspace: Workspace = {
      id,
      orgId: input.orgId,
      name,
      slug: input.slug?.trim() || slugify(name),
      createdAt: nowIso(),
    };
    this.store.set(workspaceKey(id), workspace);
    return workspace;
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.store.get<Workspace>(workspaceKey(id));
  }

  createUser(input: {
    email: string;
    name: string;
    orgId: string;
    id?: string;
  }): User {
    const email = input.email?.trim().toLowerCase();
    const name = input.name?.trim();
    if (!email) {
      throw new Error("createUser: email is required");
    }
    if (!name) {
      throw new Error("createUser: name is required");
    }
    if (!input.orgId) {
      throw new Error("createUser: orgId is required");
    }
    if (!this.store.get(orgKey(input.orgId))) {
      throw new Error(`createUser: org not found: ${input.orgId}`);
    }
    const existingUser = this.findUserByEmail(email);
    if (existingUser) {
      throw new Error(`createUser: email already exists: ${email}`);
    }
    const id = input.id ?? `user_${randomUUID()}`;
    if (this.store.get(userKey(id))) {
      throw new Error(`createUser: user already exists: ${id}`);
    }
    const user: User = {
      id,
      email,
      name,
      orgId: input.orgId,
      createdAt: nowIso(),
    };
    this.store.set(userKey(id), user);
    return user;
  }

  getUser(id: string): User | undefined {
    return this.store.get<User>(userKey(id));
  }

  findUserByEmail(email: string): User | undefined {
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) {
      return undefined;
    }
    return this.store
      .listByPrefix<User>("user:")
      .map((entry) => entry.value)
      .find((user) => user.email.toLowerCase() === normalizedEmail);
  }

  setPasswordHash(userId: string, passwordHash: string): void {
    if (!this.getUser(userId)) {
      throw new Error(`setPasswordHash: user not found: ${userId}`);
    }
    if (!passwordHash?.trim()) {
      throw new Error("setPasswordHash: passwordHash is required");
    }
    this.store.set(userPasswordKey(userId), passwordHash);
  }

  getPasswordHash(userId: string): string | undefined {
    if (!userId) {
      return undefined;
    }
    return this.store.get<string>(userPasswordKey(userId));
  }

  createThread(input: {
    workspaceId: string;
    orgId?: string;
    title?: string;
    model?: string;
    id?: string;
  }): Thread {
    if (!input.workspaceId) {
      throw new Error("createThread: workspaceId is required");
    }
    const workspace = this.store.get<Workspace>(workspaceKey(input.workspaceId));
    if (!workspace) {
      throw new Error(`createThread: workspace not found: ${input.workspaceId}`);
    }
    const orgId = input.orgId ?? workspace.orgId;
    if (orgId !== workspace.orgId) {
      throw new Error(
        `createThread: orgId ${orgId} does not own workspace ${workspace.id}`,
      );
    }
    const id = input.id ?? `thread_${randomUUID()}`;
    if (this.store.get(threadKey(id))) {
      throw new Error(`createThread: thread already exists: ${id}`);
    }
    const stamp = nowIso();
    const thread: Thread = {
      id,
      workspaceId: workspace.id,
      orgId,
      title: input.title?.trim() || "New chat",
      model: input.model?.trim() || DEFAULT_MODEL,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.store.set(threadKey(id), thread);
    return thread;
  }

  getThread(id: string): Thread | undefined {
    if (!id) {
      throw new Error("getThread: id is required");
    }
    return this.store.get<Thread>(threadKey(id));
  }

  listThreads(workspaceId: string): Thread[] {
    if (!workspaceId) {
      throw new Error("listThreads: workspaceId is required");
    }
    return this.store
      .listByPrefix<Thread>("thread:")
      .map((entry) => entry.value)
      .filter((thread) => thread.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateThread(
    id: string,
    patch: Partial<Pick<Thread, "title" | "model">>,
  ): Thread {
    const thread = this.getThread(id);
    if (!thread) {
      throw new Error(`updateThread: thread not found: ${id}`);
    }
    const next: Thread = {
      ...thread,
      title: patch.title?.trim() || thread.title,
      model: patch.model?.trim() || thread.model,
      updatedAt: nowIso(),
    };
    this.store.set(threadKey(id), next);
    return next;
  }

  /**
   * Idempotent local-dev bootstrap: demo org, workspace, and user.
   */
  ensureDemoTenant(): DemoTenant {
    let org = this.getOrg(DEMO_ORG_ID);
    if (!org) {
      org = this.createOrg({
        id: DEMO_ORG_ID,
        name: "Demo Org",
        slug: "demo",
      });
    }

    let workspace = this.getWorkspace(DEMO_WORKSPACE_ID);
    if (!workspace) {
      workspace = this.createWorkspace({
        id: DEMO_WORKSPACE_ID,
        orgId: org.id,
        name: "Demo Workspace",
        slug: "demo",
      });
    }

    let user = this.getUser(DEMO_USER_ID);
    if (!user) {
      user = this.createUser({
        id: DEMO_USER_ID,
        orgId: org.id,
        email: "demo@localhost",
        name: "Demo User",
      });
    }

    return { org, workspace, user };
  }
}
