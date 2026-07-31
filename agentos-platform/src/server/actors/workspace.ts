import { actor } from "rivetkit";

export type WorkspaceActorState = {
  workspaceId: string;
  orgId: string;
  name: string;
  threadIds: string[];
};

export type WorkspaceActorCreateInput = {
  workspaceId: string;
  orgId: string;
  name?: string;
};

export const workspace = actor({
  createState: (
    _c,
    input: WorkspaceActorCreateInput,
  ): WorkspaceActorState => {
    if (!input?.workspaceId?.trim()) {
      throw new Error("workspace create input requires workspaceId");
    }
    if (!input.orgId?.trim()) {
      throw new Error("workspace create input requires orgId");
    }
    return {
      workspaceId: input.workspaceId,
      orgId: input.orgId,
      name: input.name?.trim() || "Untitled workspace",
      threadIds: [],
    };
  },
  actions: {
    listThreads(c): string[] {
      return [...c.state.threadIds];
    },
    registerThread(c, threadId: string): string[] {
      const normalized = threadId?.trim();
      if (!normalized) {
        throw new Error("registerThread requires threadId");
      }
      if (!c.state.threadIds.includes(normalized)) {
        c.state.threadIds.push(normalized);
      }
      return [...c.state.threadIds];
    },
    getInfo(c): WorkspaceActorState {
      return {
        ...c.state,
        threadIds: [...c.state.threadIds],
      };
    },
  },
});
