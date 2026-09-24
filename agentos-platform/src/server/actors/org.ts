import { actor } from "rivetkit";

export type OrgActorState = {
  orgId: string;
  name: string;
  creditCents: number;
};

export type OrgActorCreateInput = {
  orgId: string;
  name?: string;
  creditCents?: number;
};

export const org = actor({
  createState: (_c, input: OrgActorCreateInput): OrgActorState => {
    if (!input?.orgId?.trim()) {
      throw new Error("org create input requires orgId");
    }
    const creditCents = input.creditCents ?? 0;
    if (!Number.isInteger(creditCents) || creditCents < 0) {
      throw new Error("org creditCents must be a non-negative integer");
    }
    return {
      orgId: input.orgId,
      name: input.name?.trim() || "Untitled organization",
      creditCents,
    };
  },
  actions: {
    getInfo(c): OrgActorState {
      return { ...c.state };
    },
    grantCredits(c, cents: number): number {
      if (!Number.isInteger(cents) || cents <= 0) {
        throw new Error("grantCredits cents must be a positive integer");
      }
      c.state.creditCents += cents;
      return c.state.creditCents;
    },
    getCredits(c): number {
      return c.state.creditCents;
    },
  },
});
