import {
  PI_SKILL_DESCRIPTIONS,
  PI_SKILL_FILES,
  PI_SKILL_NAMES,
} from "./pi-skills-bundle";

export const SELFHOST_AGENT_PROMPT_APPEND_BINDING = "SELFHOST_AGENT_PROMPT_APPEND";
export const SELFHOST_AGENT_PROMPT_PREPEND_BINDING = "SELFHOST_AGENT_PROMPT_PREPEND";
export const SELFHOST_AGENT_SKILLS_JSON_BINDING = "SELFHOST_AGENT_SKILLS_JSON";

export type SelfhostAgentPackEnv = {
  SELFHOST_AGENT_PROMPT_APPEND?: string;
  SELFHOST_AGENT_PROMPT_PREPEND?: string;
  SELFHOST_AGENT_SKILLS_JSON?: string;
};

export type SelfhostAgentSkillsPayload = {
  files: Record<string, string>;
  descriptions: Record<string, string>;
};

export type ResolvedAgentSkillCatalog = {
  skillNames: string[];
  skillDescriptions: Record<string, string | undefined>;
  promptAppend: string;
  promptPrepend: string;
  customSkillNames: string[];
  hasCustomSkills: boolean;
  hasPromptCustomization: boolean;
};

export type AgentSkillReadResult = {
  text: string;
  skill: string;
  file: string;
  size: number;
  encoding: "utf8";
  source: "bundled_skill" | "deployment_skill";
};

type ParsedCustomSkills = {
  files: Record<string, string>;
  descriptions: Record<string, string>;
  names: string[];
};

function trimBinding(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseSelfhostAgentSkillsJson(
  raw: string | undefined,
): ParsedCustomSkills {
  const text = trimBinding(raw);
  if (!text) {
    return { files: {}, descriptions: {}, names: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("SELFHOST_AGENT_SKILLS_JSON is not valid JSON; ignoring custom skills");
    return { files: {}, descriptions: {}, names: [] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("SELFHOST_AGENT_SKILLS_JSON must be an object; ignoring custom skills");
    return { files: {}, descriptions: {}, names: [] };
  }

  const filesIn = (parsed as { files?: unknown }).files;
  if (!filesIn || typeof filesIn !== "object" || Array.isArray(filesIn)) {
    console.error("SELFHOST_AGENT_SKILLS_JSON.files is missing; ignoring custom skills");
    return { files: {}, descriptions: {}, names: [] };
  }

  const files: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(filesIn as Record<string, unknown>)) {
    if (typeof content === "string") files[filePath] = content;
  }

  const descriptions: Record<string, string> = {};
  const descriptionsIn = (parsed as { descriptions?: unknown }).descriptions;
  if (descriptionsIn && typeof descriptionsIn === "object" && !Array.isArray(descriptionsIn)) {
    for (const [name, value] of Object.entries(descriptionsIn as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) descriptions[name] = value.trim();
    }
  }

  const names = Object.keys(files)
    .filter((filePath) => filePath.endsWith("/SKILL.md"))
    .map((filePath) => filePath.slice(0, -"/SKILL.md".length))
    .sort();

  return { files, descriptions, names };
}

export function resolveAgentSkillCatalog(
  env?: SelfhostAgentPackEnv,
): ResolvedAgentSkillCatalog {
  const custom = parseSelfhostAgentSkillsJson(env?.SELFHOST_AGENT_SKILLS_JSON);
  const skillNames = Array.from(
    new Set<string>([...PI_SKILL_NAMES, ...custom.names]),
  ).sort();
  const skillDescriptions: Record<string, string | undefined> = {
    ...PI_SKILL_DESCRIPTIONS,
    ...custom.descriptions,
  };
  const promptAppend = trimBinding(env?.SELFHOST_AGENT_PROMPT_APPEND);
  const promptPrepend = trimBinding(env?.SELFHOST_AGENT_PROMPT_PREPEND);

  return {
    skillNames,
    skillDescriptions,
    promptAppend,
    promptPrepend,
    customSkillNames: custom.names,
    hasCustomSkills: custom.names.length > 0,
    hasPromptCustomization: Boolean(promptAppend || promptPrepend),
  };
}

export function readAgentSkillFile(
  env: SelfhostAgentPackEnv | undefined,
  skill: string,
  file: string,
): AgentSkillReadResult | null {
  const custom = parseSelfhostAgentSkillsJson(env?.SELFHOST_AGENT_SKILLS_JSON);
  const key = `${skill}/${file}`;
  const customContent = custom.files[key];
  if (typeof customContent === "string") {
    return {
      text: customContent,
      skill,
      file,
      size: customContent.length,
      encoding: "utf8",
      source: "deployment_skill",
    };
  }

  // When a deployment skill overrides a bundled skill name, keep reads inside
  // that pack (do not fall through to leftover bundled sibling files).
  if (custom.names.includes(skill)) {
    return null;
  }

  const bundled = PI_SKILL_FILES[key];
  if (typeof bundled !== "string") return null;
  return {
    text: bundled,
    skill,
    file,
    size: bundled.length,
    encoding: "utf8",
    source: "bundled_skill",
  };
}

export function listAgentSkillFiles(
  env: SelfhostAgentPackEnv | undefined,
  skill: string,
): string[] {
  const custom = parseSelfhostAgentSkillsJson(env?.SELFHOST_AGENT_SKILLS_JSON);
  if (custom.names.includes(skill)) {
    const prefix = `${skill}/`;
    return Object.keys(custom.files)
      .filter((filePath) => filePath.startsWith(prefix))
      .map((filePath) => filePath.slice(prefix.length))
      .sort();
  }

  const prefix = `${skill}/`;
  return Object.keys(PI_SKILL_FILES)
    .filter((filePath) => filePath.startsWith(prefix))
    .map((filePath) => filePath.slice(prefix.length))
    .sort();
}
