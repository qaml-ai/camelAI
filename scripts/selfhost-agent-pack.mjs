#!/usr/bin/env node
/**
 * Load the enterprise self-host agent customization pack from disk.
 *
 * Layout (under SELFHOST_AGENT_DIR, default `.selfhost/agent`):
 *   prompt.append.md
 *   prompt.prepend.md
 *   skills/<skill-name>/SKILL.md
 *   skills/<skill-name>/*.md
 *
 * Env overrides (win over files when non-empty):
 *   SELFHOST_AGENT_PROMPT_APPEND
 *   SELFHOST_AGENT_PROMPT_PREPEND
 *   SELFHOST_AGENT_SKILLS_JSON
 *   SELFHOST_AGENT_SKILLS_DIR
 *   SELFHOST_AGENT_DIR
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_AGENT_DIR = ".selfhost/agent";
export const MAX_SKILLS_JSON_CHARS = 1_500_000;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * @typedef {{
 *   files: Record<string, string>,
 *   descriptions: Record<string, string>,
 * }} SelfhostAgentSkillsPayload
 *
 * @typedef {{
 *   agentDir: string,
 *   skillsDir: string,
 *   promptAppend: string,
 *   promptPrepend: string,
 *   skills: SelfhostAgentSkillsPayload,
 *   skillNames: string[],
 *   source: {
 *     promptAppend: "env" | "file" | "none",
 *     promptPrepend: "env" | "file" | "none",
 *     skills: "env" | "dir" | "none",
 *   },
 * }} SelfhostAgentPack
 */

/**
 * @param {string} content
 * @returns {string | undefined}
 */
export function extractSkillDescription(content) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch?.[1];
  if (!frontmatter) return undefined;
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return descriptionMatch?.[1]?.trim() || undefined;
}

/**
 * @param {string} repoRoot
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<SelfhostAgentPack>}
 */
export async function loadSelfhostAgentPack(repoRoot, env = {}) {
  const agentDirRel = String(env.SELFHOST_AGENT_DIR || DEFAULT_AGENT_DIR).trim() || DEFAULT_AGENT_DIR;
  const agentDir = path.isAbsolute(agentDirRel)
    ? agentDirRel
    : path.resolve(repoRoot, agentDirRel);

  const skillsDirEnv = String(env.SELFHOST_AGENT_SKILLS_DIR || "").trim();
  const skillsDir = skillsDirEnv
    ? (path.isAbsolute(skillsDirEnv) ? skillsDirEnv : path.resolve(repoRoot, skillsDirEnv))
    : path.join(agentDir, "skills");

  /** @type {SelfhostAgentPack["source"]} */
  const source = {
    promptAppend: "none",
    promptPrepend: "none",
    skills: "none",
  };

  let promptAppend = String(env.SELFHOST_AGENT_PROMPT_APPEND || "").trim();
  if (promptAppend) {
    source.promptAppend = "env";
  } else {
    promptAppend = await readOptionalText(path.join(agentDir, "prompt.append.md"));
    if (promptAppend) source.promptAppend = "file";
  }

  let promptPrepend = String(env.SELFHOST_AGENT_PROMPT_PREPEND || "").trim();
  if (promptPrepend) {
    source.promptPrepend = "env";
  } else {
    promptPrepend = await readOptionalText(path.join(agentDir, "prompt.prepend.md"));
    if (promptPrepend) source.promptPrepend = "file";
  }

  /** @type {SelfhostAgentSkillsPayload} */
  let skills = { files: {}, descriptions: {} };
  const skillsJson = String(env.SELFHOST_AGENT_SKILLS_JSON || "").trim();
  if (skillsJson) {
    skills = parseSkillsPayload(skillsJson);
    source.skills = "env";
  } else {
    skills = await loadSkillsFromDir(skillsDir);
    if (Object.keys(skills.files).length > 0) source.skills = "dir";
  }

  const encoded = JSON.stringify(skills);
  if (encoded.length > MAX_SKILLS_JSON_CHARS) {
    throw new Error(
      `Self-host agent skills pack is too large (${encoded.length} chars; max ${MAX_SKILLS_JSON_CHARS}). ` +
        `Reduce skills under ${path.relative(repoRoot, skillsDir) || skillsDir}.`,
    );
  }

  const skillNames = Object.keys(skills.files)
    .filter((filePath) => filePath.endsWith("/SKILL.md"))
    .map((filePath) => filePath.slice(0, -"/SKILL.md".length))
    .sort();

  return {
    agentDir,
    skillsDir,
    promptAppend,
    promptPrepend,
    skills,
    skillNames,
    source,
  };
}

/**
 * Ensure the default agent pack directory skeleton exists.
 * @param {string} repoRoot
 * @param {Record<string, string | undefined>} env
 */
export async function ensureSelfhostAgentPackSkeleton(repoRoot, env = {}) {
  const agentDirRel = String(env.SELFHOST_AGENT_DIR || DEFAULT_AGENT_DIR).trim() || DEFAULT_AGENT_DIR;
  const agentDir = path.isAbsolute(agentDirRel)
    ? agentDirRel
    : path.resolve(repoRoot, agentDirRel);
  const skillsDir = path.join(agentDir, "skills");
  await fs.mkdir(skillsDir, { recursive: true });

  const readmePath = path.join(agentDir, "README.md");
  if (!existsSync(readmePath)) {
    await fs.writeFile(
      readmePath,
      [
        "# Self-host agent customization",
        "",
        "Drop Markdown here to customize the coding agent for this deployment.",
        "",
        "- `prompt.append.md` — added after the stock camelAI system prompt",
        "- `prompt.prepend.md` — optional policy/identity text before the stock prompt",
        "- `skills/<name>/SKILL.md` — extra skills (same format as `sandbox/skills/`)",
        "",
        "Restart the app (or re-run configure + up) after changes. Custom skills",
        "override bundled skills with the same name. Full prompt replacement is",
        "not supported; deployment text is additive.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  return { agentDir, skillsDir };
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readOptionalText(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/**
 * @param {string} skillsDir
 * @returns {Promise<SelfhostAgentSkillsPayload>}
 */
async function loadSkillsFromDir(skillsDir) {
  /** @type {SelfhostAgentSkillsPayload} */
  const skills = { files: {}, descriptions: {} };
  if (!existsSync(skillsDir)) return skills;

  const skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const skillName = entry.name;
    if (!SKILL_NAME_RE.test(skillName)) {
      throw new Error(
        `Invalid self-host skill directory name "${skillName}" under ${skillsDir}. ` +
          `Use names matching ${SKILL_NAME_RE}.`,
      );
    }
    const skillRoot = path.join(skillsDir, skillName);
    const markdownFiles = await listMarkdownFiles(skillRoot);
    if (!markdownFiles.includes("SKILL.md")) {
      throw new Error(
        `Self-host skill "${skillName}" is missing SKILL.md under ${skillRoot}.`,
      );
    }
    for (const relativePath of markdownFiles) {
      const absolute = path.join(skillRoot, relativePath);
      const content = await fs.readFile(absolute, "utf8");
      skills.files[`${skillName}/${relativePath}`] = content;
      if (relativePath === "SKILL.md") {
        const description = extractSkillDescription(content);
        if (description) skills.descriptions[skillName] = description;
      }
    }
  }
  return skills;
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listMarkdownFiles(root) {
  /** @type {string[]} */
  const files = [];
  async function walk(dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "." || entry.name === "..") continue;
        await walk(path.join(dir, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;
      const segments = relative.split("/");
      if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`Invalid skill file path: ${relative}`);
      }
      files.push(relative);
    }
  }
  await walk(root, "");
  return files.sort();
}

/**
 * @param {string} raw
 * @returns {SelfhostAgentSkillsPayload}
 */
function parseSkillsPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `SELFHOST_AGENT_SKILLS_JSON is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SELFHOST_AGENT_SKILLS_JSON must be an object with files/descriptions");
  }
  const filesIn = parsed.files;
  if (!filesIn || typeof filesIn !== "object" || Array.isArray(filesIn)) {
    throw new Error("SELFHOST_AGENT_SKILLS_JSON.files must be an object of path → markdown");
  }
  /** @type {Record<string, string>} */
  const files = {};
  for (const [filePath, content] of Object.entries(filesIn)) {
    if (typeof content !== "string") {
      throw new Error(`SELFHOST_AGENT_SKILLS_JSON.files[${filePath}] must be a string`);
    }
    const segments = filePath.split("/");
    if (
      segments.length < 2 ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      !SKILL_NAME_RE.test(segments[0])
    ) {
      throw new Error(`Invalid skill file path in SELFHOST_AGENT_SKILLS_JSON: ${filePath}`);
    }
    files[filePath] = content;
  }
  /** @type {Record<string, string>} */
  const descriptions = {};
  const descriptionsIn = parsed.descriptions;
  if (descriptionsIn != null) {
    if (typeof descriptionsIn !== "object" || Array.isArray(descriptionsIn)) {
      throw new Error("SELFHOST_AGENT_SKILLS_JSON.descriptions must be an object when provided");
    }
    for (const [name, value] of Object.entries(descriptionsIn)) {
      if (typeof value === "string" && value.trim()) descriptions[name] = value.trim();
    }
  }
  for (const [filePath, content] of Object.entries(files)) {
    if (!filePath.endsWith("/SKILL.md")) continue;
    const skillName = filePath.slice(0, -"/SKILL.md".length);
    if (!descriptions[skillName]) {
      const description = extractSkillDescription(content);
      if (description) descriptions[skillName] = description;
    }
  }
  return { files, descriptions };
}
