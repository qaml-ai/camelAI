import {
  PI_SKILL_DESCRIPTIONS,
  PI_SKILL_FILES,
  PI_SKILL_NAMES,
} from "./pi-skills-bundle";
import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";

export const SELFHOST_AGENT_PROMPT_APPEND_BINDING =
  "SELFHOST_AGENT_PROMPT_APPEND";
export const SELFHOST_AGENT_PROMPT_PREPEND_BINDING =
  "SELFHOST_AGENT_PROMPT_PREPEND";
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

function utf8BytesWithin(value: string, limit: number): boolean {
  if (value.length > limit) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const next = value.charCodeAt(index + 1);
    let size: number;
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      size = 4;
      index += 1;
    } else {
      size = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (size > limit - bytes) return false;
    bytes += size;
  }
  return true;
}

function trimBinding(
  value: string | undefined,
  limit: number,
  binding: string,
): string {
  if (typeof value !== "string") return "";
  if (!utf8BytesWithin(value, limit)) {
    console.error(`${binding} exceeds its runtime byte limit; ignoring it`);
    return "";
  }
  return value.trim();
}

export function parseSelfhostAgentSkillsJson(
  raw: string | undefined,
): ParsedCustomSkills {
  const text = trimBinding(
    raw,
    CHAT_RUNTIME_BOUNDS.selfhostAgentPackBytes,
    SELFHOST_AGENT_SKILLS_JSON_BINDING,
  );
  if (!text) {
    return { files: {}, descriptions: {}, names: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(
      "SELFHOST_AGENT_SKILLS_JSON is not valid JSON; ignoring custom skills",
    );
    return { files: {}, descriptions: {}, names: [] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(
      "SELFHOST_AGENT_SKILLS_JSON must be an object; ignoring custom skills",
    );
    return { files: {}, descriptions: {}, names: [] };
  }

  const filesIn = (parsed as { files?: unknown }).files;
  if (!filesIn || typeof filesIn !== "object" || Array.isArray(filesIn)) {
    console.error(
      "SELFHOST_AGENT_SKILLS_JSON.files is missing; ignoring custom skills",
    );
    return { files: {}, descriptions: {}, names: [] };
  }

  const files: Record<string, string> = {};
  let fileCount = 0;
  for (const filePath in filesIn as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(filesIn, filePath)) continue;
    fileCount += 1;
    if (
      fileCount > CHAT_RUNTIME_BOUNDS.selfhostAgentEntries ||
      filePath.length > CHAT_RUNTIME_BOUNDS.selfhostAgentPathChars
    ) {
      console.error(
        "SELFHOST_AGENT_SKILLS_JSON has too many or oversized file paths; ignoring custom skills",
      );
      return { files: {}, descriptions: {}, names: [] };
    }
    const content = (filesIn as Record<string, unknown>)[filePath];
    if (typeof content === "string") files[filePath] = content;
  }

  const descriptions: Record<string, string> = {};
  const descriptionsIn = (parsed as { descriptions?: unknown }).descriptions;
  if (
    descriptionsIn &&
    typeof descriptionsIn === "object" &&
    !Array.isArray(descriptionsIn)
  ) {
    let descriptionCount = 0;
    for (const name in descriptionsIn as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(descriptionsIn, name)) continue;
      descriptionCount += 1;
      if (
        descriptionCount > CHAT_RUNTIME_BOUNDS.selfhostAgentEntries ||
        name.length > CHAT_RUNTIME_BOUNDS.selfhostAgentPathChars
      ) {
        console.error(
          "SELFHOST_AGENT_SKILLS_JSON has too many or oversized descriptions; ignoring custom skills",
        );
        return { files: {}, descriptions: {}, names: [] };
      }
      const value = (descriptionsIn as Record<string, unknown>)[name];
      if (typeof value === "string") {
        if (!utf8BytesWithin(value, CHAT_RUNTIME_BOUNDS.systemPromptBytes)) {
          console.error(
            `SELFHOST_AGENT_SKILLS_JSON description "${name}" exceeds the system-prompt byte limit; ignoring it`,
          );
          continue;
        }
        const trimmed = value.trim();
        if (trimmed) descriptions[name] = trimmed;
      }
    }
  }

  const names: string[] = [];
  for (const filePath in files) {
    if (filePath.endsWith("/SKILL.md")) {
      const name = filePath.slice(0, -"/SKILL.md".length);
      if (
        name.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
        !/^[a-z0-9][a-z0-9._-]*$/i.test(name)
      ) {
        console.error(
          `SELFHOST_AGENT_SKILLS_JSON contains invalid skill name "${name.slice(0, CHAT_RUNTIME_BOUNDS.identifierChars)}"; ignoring custom skills`,
        );
        return { files: {}, descriptions: {}, names: [] };
      }
      names.push(name);
    }
  }
  names.sort();

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
  const promptAppend = trimBinding(
    env?.SELFHOST_AGENT_PROMPT_APPEND,
    CHAT_RUNTIME_BOUNDS.systemPromptBytes,
    SELFHOST_AGENT_PROMPT_APPEND_BINDING,
  );
  const promptPrepend = trimBinding(
    env?.SELFHOST_AGENT_PROMPT_PREPEND,
    CHAT_RUNTIME_BOUNDS.systemPromptBytes,
    SELFHOST_AGENT_PROMPT_PREPEND_BINDING,
  );

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
