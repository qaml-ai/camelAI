import { describe, expect, it } from "vitest";
import { CodeModeToolsBinding } from "../src/code-mode-tools";
import { createPiSystemPrompt } from "../src/pi-system-prompt";
import { PI_SKILL_NAMES } from "../src/pi-skills-bundle";
import {
  listAgentSkillFiles,
  parseSelfhostAgentSkillsJson,
  readAgentSkillFile,
  resolveAgentSkillCatalog,
} from "../src/selfhost-agent-pack";

const customSkillsJson = JSON.stringify({
  files: {
    "acme-runbooks/SKILL.md": `---
name: acme-runbooks
description: Follow ACME internal checklists. Use when shipping internal tools.
---

# ACME runbooks
`,
    "acme-runbooks/CHECKLIST.md": "# Checklist\n",
    "developing-software/SKILL.md": `---
name: developing-software
description: Custom override for developing-software. Use when creating projects.
---

# Override
`,
  },
  descriptions: {
    "acme-runbooks": "Follow ACME internal checklists. Use when shipping internal tools.",
    "developing-software": "Custom override for developing-software. Use when creating projects.",
  },
});

describe("selfhost agent pack", () => {
  it("parses custom skills JSON and merges with bundled catalog", () => {
    const catalog = resolveAgentSkillCatalog({
      SELFHOST_AGENT_SKILLS_JSON: customSkillsJson,
      SELFHOST_AGENT_PROMPT_APPEND: "Prefer internal mirrors.",
      SELFHOST_AGENT_PROMPT_PREPEND: "Finance apps need audit logs.",
    });

    expect(catalog.customSkillNames).toEqual(["acme-runbooks", "developing-software"]);
    expect(catalog.skillNames).toContain("acme-runbooks");
    expect(catalog.skillNames).toContain("developing-software");
    expect(catalog.skillNames.length).toBeGreaterThan(PI_SKILL_NAMES.length);
    expect(catalog.skillDescriptions["acme-runbooks"]).toContain("ACME");
    expect(catalog.skillDescriptions["developing-software"]).toContain("Custom override");
    expect(catalog.promptAppend).toBe("Prefer internal mirrors.");
    expect(catalog.promptPrepend).toBe("Finance apps need audit logs.");
    expect(catalog.hasCustomSkills).toBe(true);
    expect(catalog.hasPromptCustomization).toBe(true);
  });

  it("serves deployment skills and keeps overrides from falling through to bundled siblings", () => {
    const env = { SELFHOST_AGENT_SKILLS_JSON: customSkillsJson };

    const custom = readAgentSkillFile(env, "acme-runbooks", "SKILL.md");
    expect(custom?.source).toBe("deployment_skill");
    expect(custom?.text).toContain("ACME runbooks");
    expect(listAgentSkillFiles(env, "acme-runbooks")).toEqual([
      "CHECKLIST.md",
      "SKILL.md",
    ]);

    const override = readAgentSkillFile(env, "developing-software", "SKILL.md");
    expect(override?.source).toBe("deployment_skill");
    expect(override?.text).toContain("# Override");

    // Overridden skill must not expose bundled sibling files that were not
    // included in the deployment pack.
    expect(readAgentSkillFile(env, "developing-software", "VANILLA-APPS.md")).toBeNull();
    expect(listAgentSkillFiles(env, "developing-software")).toEqual(["SKILL.md"]);

    const bundled = readAgentSkillFile(env, "file-sharing", "SKILL.md");
    expect(bundled?.source).toBe("bundled_skill");
    expect(bundled?.text).toContain("name: file-sharing");
  });

  it("ignores invalid skills JSON without breaking bundled skills", () => {
    const catalog = resolveAgentSkillCatalog({
      SELFHOST_AGENT_SKILLS_JSON: "{not-json",
    });
    expect(catalog.customSkillNames).toEqual([]);
    expect(catalog.skillNames).toEqual([...PI_SKILL_NAMES]);
    expect(parseSelfhostAgentSkillsJson("{not-json}")).toEqual({
      files: {},
      descriptions: {},
      names: [],
    });
  });

  it("includes deployment prompt sections in the system prompt", () => {
    const catalog = resolveAgentSkillCatalog({
      SELFHOST_AGENT_SKILLS_JSON: customSkillsJson,
      SELFHOST_AGENT_PROMPT_APPEND: "Always include audit logs.",
      SELFHOST_AGENT_PROMPT_PREPEND: "Operate under ACME policy.",
    });

    const prompt = createPiSystemPrompt(
      { threadId: "t1", workspaceId: "w1", orgId: "o1" },
      {
        skillNames: catalog.skillNames,
        skillDescriptions: catalog.skillDescriptions,
        promptPrepend: catalog.promptPrepend,
        promptAppend: catalog.promptAppend,
      },
    );

    expect(prompt.startsWith("## Deployment Policy")).toBe(true);
    expect(prompt).toContain("Operate under ACME policy.");
    expect(prompt).toContain("You are camelAI");
    expect(prompt).toContain('read_skill({ skill: "acme-runbooks" })');
    expect(prompt).toContain("## Deployment Instructions");
    expect(prompt).toContain("Always include audit logs.");
    expect(prompt).toContain("Thread ID: t1");
  });

  it("serves deployment skills through CodeModeToolsBinding.read_skill", async () => {
    const toolsBinding = Object.create(CodeModeToolsBinding.prototype) as CodeModeToolsBinding & {
      env: Record<string, string>;
    };
    toolsBinding.env = {
      SELFHOST_AGENT_SKILLS_JSON: customSkillsJson,
    };

    const result = await CodeModeToolsBinding.prototype.callTool.call(toolsBinding, "read_skill", {
      skill: "acme-runbooks",
      file: "CHECKLIST.md",
    });
    expect(result).toMatchObject({
      text: "# Checklist\n",
      details: {
        skill: "acme-runbooks",
        file: "CHECKLIST.md",
        source: "deployment_skill",
      },
    });
  });
});
