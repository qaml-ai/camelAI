import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureSelfhostAgentPackSkeleton,
  extractSkillDescription,
  loadSelfhostAgentPack,
} from "../scripts/selfhost-agent-pack.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "camelai-agent-pack-"));
  tempDirs.push(dir);
  return dir;
}

describe("selfhost-agent-pack loader", () => {
  it("extracts skill descriptions from frontmatter", () => {
    expect(
      extractSkillDescription(`---
name: demo
description: Do the thing. Use when needed.
---
body`),
    ).toBe("Do the thing. Use when needed.");
  });

  it("loads prompt files and skills from the agent directory", async () => {
    const root = await makeTempRoot();
    const agentDir = path.join(root, ".selfhost/agent");
    await fs.mkdir(path.join(agentDir, "skills/acme-runbooks"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "prompt.append.md"), " Always prefer mirrors. \n");
    await fs.writeFile(path.join(agentDir, "prompt.prepend.md"), "ACME policy.\n");
    await fs.writeFile(
      path.join(agentDir, "skills/acme-runbooks/SKILL.md"),
      `---
name: acme-runbooks
description: Follow ACME runbooks. Use when shipping internal tools.
---

# ACME
`,
    );
    await fs.writeFile(
      path.join(agentDir, "skills/acme-runbooks/extra.md"),
      "# Extra\n",
    );

    const pack = await loadSelfhostAgentPack(root, {
      SELFHOST_AGENT_DIR: ".selfhost/agent",
    });

    expect(pack.source).toEqual({
      promptAppend: "file",
      promptPrepend: "file",
      skills: "dir",
    });
    expect(pack.promptAppend).toBe("Always prefer mirrors.");
    expect(pack.promptPrepend).toBe("ACME policy.");
    expect(pack.skillNames).toEqual(["acme-runbooks"]);
    expect(pack.skills.files["acme-runbooks/SKILL.md"]).toContain("# ACME");
    expect(pack.skills.files["acme-runbooks/extra.md"]).toContain("# Extra");
    expect(pack.skills.descriptions["acme-runbooks"]).toContain("ACME runbooks");
  });

  it("lets env overrides win over files", async () => {
    const root = await makeTempRoot();
    const agentDir = path.join(root, ".selfhost/agent");
    await fs.mkdir(path.join(agentDir, "skills/from-disk"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "prompt.append.md"), "from file");
    await fs.writeFile(
      path.join(agentDir, "skills/from-disk/SKILL.md"),
      `---
name: from-disk
description: From disk.
---
`,
    );

    const pack = await loadSelfhostAgentPack(root, {
      SELFHOST_AGENT_DIR: ".selfhost/agent",
      SELFHOST_AGENT_PROMPT_APPEND: "from env",
      SELFHOST_AGENT_SKILLS_JSON: JSON.stringify({
        files: {
          "from-env/SKILL.md": `---
name: from-env
description: From env.
---
`,
        },
      }),
    });

    expect(pack.promptAppend).toBe("from env");
    expect(pack.source.promptAppend).toBe("env");
    expect(pack.source.skills).toBe("env");
    expect(pack.skillNames).toEqual(["from-env"]);
  });

  it("rejects skills missing SKILL.md", async () => {
    const root = await makeTempRoot();
    const agentDir = path.join(root, ".selfhost/agent");
    await fs.mkdir(path.join(agentDir, "skills/broken"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "skills/broken/notes.md"), "# notes\n");

    await expect(
      loadSelfhostAgentPack(root, { SELFHOST_AGENT_DIR: ".selfhost/agent" }),
    ).rejects.toThrow(/missing SKILL.md/);
  });

  it("creates a skeleton without overwriting an existing README", async () => {
    const root = await makeTempRoot();
    const first = await ensureSelfhostAgentPackSkeleton(root, {
      SELFHOST_AGENT_DIR: ".selfhost/agent",
    });
    const readmePath = path.join(first.agentDir, "README.md");
    await fs.writeFile(readmePath, "custom readme\n");
    await ensureSelfhostAgentPackSkeleton(root, {
      SELFHOST_AGENT_DIR: ".selfhost/agent",
    });
    expect(await fs.readFile(readmePath, "utf8")).toBe("custom readme\n");
    await expect(fs.stat(path.join(first.agentDir, "skills"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });
});
