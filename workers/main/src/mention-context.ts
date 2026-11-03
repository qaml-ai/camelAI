/**
 * Per-turn user-message preprocessing for `@<slug>` mentions.
 *
 * Two coordinated transformations:
 *   1. Inline `⟦ref: ...⟧` annotations after each known `@<slug>` token so the
 *      agent can resolve the reference unambiguously even after a target gets
 *      renamed.
 *   2. `<camelai system message>` blocks that add context for matched
 *      connections and projects.
 */

import {
  buildSlugMap,
  expandMentions,
  parseMentions,
  projectsToMentionables,
  type Mentionable,
  type MentionableConnection,
  type MentionableProject,
} from '../../../src/lib/mentions';
import { RUNTIME_TOOL_PREFIX } from '../../../src/lib/agent-runtime-shared';
import type { WorkspaceIntegrationRecord } from './workspace';
import type { WorkspaceProject } from './workspace-filesystem-do';

function toMentionable(record: WorkspaceIntegrationRecord): MentionableConnection {
  return {
    kind: 'connection',
    id: record.id,
    integration_type: record.integration_type,
    name: record.name,
    created_at: record.created_at,
  };
}

function buildConnectionsSection(
  slugMap: ReadonlyMap<string, Mentionable>,
  integrationsById: Map<string, WorkspaceIntegrationRecord>,
): string {
  if (slugMap.size === 0) return '';

  const entries: string[] = [];
  for (const [slugValue, mentionable] of slugMap) {
    if (mentionable.kind !== 'connection') continue;
    const record = integrationsById.get(mentionable.id);
    if (!record) continue;
    entries.push(
      `- @${slugValue} — ${record.integration_type} "${record.name}" (connection id: ${record.id})`,
    );
  }

  if (entries.length === 0) return '';

  return [
    '<camelai system message>',
    '## Available connections',
    '',
    'The user has the following connections (integrations) configured. They may',
    'reference them by `@<slug>` in messages. Inspect and call their methods',
    `with the \`${RUNTIME_TOOL_PREFIX}connections_find\`, \`${RUNTIME_TOOL_PREFIX}connections_query\` and`,
    `\`${RUNTIME_TOOL_PREFIX}connections_invoke\` tools. Connection credentials are intentionally`,
    'hidden behind them.',
    '',
    ...entries,
    '</camelai system message>',
  ].join('\n');
}

function normalizeProjectDescription(description: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 200) return normalized;
  return `${normalized.slice(0, 197).trimEnd()}...`;
}

function buildProjectsSection(
  matchedProjects: ReadonlyArray<{ slug: string; project: MentionableProject }>,
): string {
  const entries: string[] = [];
  const seenProjectIds = new Set<string>();
  for (const { slug: slugValue, project } of matchedProjects) {
    if (seenProjectIds.has(project.id)) continue;
    seenProjectIds.add(project.id);
    const description = normalizeProjectDescription(project.description);
    entries.push(
      description
        ? `- @${slugValue} — project "${project.name}": ${description}`
        : `- @${slugValue} — project "${project.name}"`,
    );
  }

  if (entries.length === 0) return '';

  return [
    '<camelai system message>',
    '## Referenced projects',
    '',
    'The user @-mentioned these projects. The project name is the handle to use in',
    'tools: file tools take `location: "vm"` with `project: "<name>"`, and shell /',
    'runtime operations run inside that project\'s VM checkout at /workspace. Use',
    '`list_projects` for full details or other projects.',
    '',
    ...entries,
    '</camelai system message>',
  ].join('\n');
}

export interface AppliedMentionContext {
  /** Original content with mention context prepended and mentions expanded. */
  content: string;
  /** True when at least one `@<slug>` token in the body matched a known target. */
  hadMatchedMentions: boolean;
}

export function applyMentionContext(
  rawContent: string,
  sources: {
    integrations: WorkspaceIntegrationRecord[];
    projects: WorkspaceProject[];
  },
): AppliedMentionContext {
  if (!rawContent) {
    return { content: rawContent, hadMatchedMentions: false };
  }

  const connectionMentionables = sources.integrations.map(toMentionable);
  const projectMentionables = projectsToMentionables(sources.projects);
  const slugMap = buildSlugMap<Mentionable>([
    ...connectionMentionables,
    ...projectMentionables,
  ]);
  if (slugMap.size === 0) {
    return { content: rawContent, hadMatchedMentions: false };
  }

  const matches = parseMentions(rawContent, slugMap);
  const matchedConnections = matches.filter(
    (m) => m.target?.kind === 'connection',
  );
  const matchedProjects: Array<{ slug: string; project: MentionableProject }> = [];
  for (const match of matches) {
    if (match.target?.kind === 'project') {
      matchedProjects.push({ slug: match.slug, project: match.target });
    }
  }
  const hadMatchedMentions =
    matchedConnections.length > 0 || matchedProjects.length > 0;
  if (!hadMatchedMentions) {
    return { content: rawContent, hadMatchedMentions: false };
  }

  const expandedBody = expandMentions(rawContent, slugMap);
  const integrationsById = new Map(sources.integrations.map((r) => [r.id, r]));
  const sections = [
    matchedConnections.length > 0
      ? buildConnectionsSection(slugMap, integrationsById)
      : '',
    matchedProjects.length > 0 ? buildProjectsSection(matchedProjects) : '',
  ].filter(Boolean);
  const content = sections.length > 0
    ? `${sections.join('\n\n')}\n\n${expandedBody}`
    : expandedBody;
  return { content, hadMatchedMentions };
}
