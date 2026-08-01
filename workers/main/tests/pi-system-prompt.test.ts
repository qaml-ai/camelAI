import { describe, expect, it } from "vitest";

import {
  DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT,
  createPiSystemPrompt,
  createPiSubagentSystemPrompt,
} from "../src/pi-system-prompt";

const context = {
  threadId: "thread_1",
  workspaceId: "workspace_1",
  orgId: "org_1",
};

describe("createPiSystemPrompt deployed CONNECTIONS binding", () => {
  it("keeps js_exec CONNECTIONS guidance and omits the disable caveat by default", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
    });

    expect(prompt).toContain('await env.CONNECTIONS.find("provider-or-type")');
    expect(prompt).toContain("`integration-dashboard` for apps centered on workspace connections");
    expect(prompt).not.toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
  });

  it("adds a deployed-app CONNECTIONS disable caveat and softens the integration-dashboard template", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
      deployedConnectionsBindingEnabled: false,
    });

    expect(prompt).toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
    expect(prompt).toContain('await env.CONNECTIONS.find("provider-or-type")');
    expect(prompt).toContain(
      "`integration-dashboard` only when the UI is local/mock and never calls CONNECTIONS",
    );
    expect(prompt).not.toContain(
      "`integration-dashboard` for apps centered on workspace connections",
    );
  });

  it("propagates the caveat to subagent prompts", () => {
    const prompt = createPiSubagentSystemPrompt(context, "agent", {
      skillNames: ["developing-software"],
      deployedConnectionsBindingEnabled: false,
    });

    expect(prompt).toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
    expect(prompt).toContain("## Subagent Mode");
  });
});
