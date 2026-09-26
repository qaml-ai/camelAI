import { getIntegrationDefinition } from './integration-registry';

/**
 * Shared utilities for @-mention parsing, slugging, and expansion.
 *
 * This module is intentionally framework-agnostic so it can be imported from
 * the React app (mention menu, message bubble) and from worker / sandbox code
 * (server-side mention expansion).
 */

export interface MentionableConnection {
  kind: 'connection';
  id: string;
  integration_type: string;
  name: string;
  /** Insertion order tiebreaker for slug collisions; lower = earlier. */
  created_at?: number;
}

export interface MentionableProject {
  kind: 'project';
  id: string;
  name: string;
  description: string;
  created_at?: number;
  updated_at?: number;
}

export type Mentionable = MentionableConnection | MentionableProject;

export interface MentionProjectSource {
  id: string;
  name: string;
  description?: string;
  kind?: 'project' | 'clone';
  createdAt?: string;
  updatedAt?: string;
}

export interface MentionMatch<T extends Mentionable = Mentionable> {
  /** The slug as it appeared in the text, without the leading "@". */
  slug: string;
  /** Resolved target, or null when no item matched the slug. */
  target: T | null;
  /** Index of the leading "@" in the source string. */
  index: number;
  /** Length of the matched substring including the "@". */
  length: number;
}

const SLUG_CHARSET = /[a-z0-9_]/;
const MENTION_ANNOTATION_REGEX = /\s*⟦ref:[^⟧]*⟧/g;

/**
 * Convert a connection name to its slug form. Stable on both client and server
 * so the slug a user inserts in the textarea is the same one the server can
 * resolve back to an integration.
 *
 *   slug("My Prod DB")     → "my_prod_db"
 *   slug("Stripe (Live)")  → "stripe_live"
 *   slug("123 Main")       → "123_main"
 */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function filterMentionables<T extends Mentionable>(
  items: ReadonlyArray<T>,
): T[] {
  return items.filter((item) => slug(item.name).length > 0);
}

/**
 * Rank items for the live @-mention menu. Empty queries are alphabetic;
 * typed queries prefer natural name prefixes, then slug prefixes, then
 * type/display-name prefixes, then substring matches.
 */
export function rankMentionables<T extends Mentionable>(
  items: ReadonlyArray<T>,
  query: string,
): T[] {
  const mentionableItems = filterMentionables(items);
  const q = normalizeMentionSearch(query);
  const compactQ = compactMentionSearch(query);
  const rawQ = query.toLowerCase().trim();
  if (!q) {
    return [...mentionableItems].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  const tiers: [T[], T[], T[], T[]] = [[], [], [], []];
  const slugsById = new Map<string, string>();
  for (const [itemSlug, item] of buildSlugMap(mentionableItems)) {
    slugsById.set(item.id, itemSlug);
  }

  for (const item of mentionableItems) {
    const rawName = item.name.toLowerCase();
    const normalizedName = normalizeMentionSearch(item.name);
    const compactName = compactMentionSearch(item.name);
    const itemSlug = slugsById.get(item.id) ?? slug(item.name);
    const normalizedSlug = normalizeMentionSearch(itemSlug);
    const compactSlug = compactMentionSearch(itemSlug);
    const type = normalizeMentionSearch(
      item.kind === 'connection' ? item.integration_type : 'project',
    );
    const compactType = compactMentionSearch(
      item.kind === 'connection' ? item.integration_type : 'project',
    );
    const displayName = item.kind === 'connection'
      ? getIntegrationDefinition(item.integration_type)?.displayName ?? ''
      : '';
    const normalizedDisplayName = normalizeMentionSearch(displayName);
    const compactDisplayName = compactMentionSearch(displayName);

    if (
      rawName.startsWith(rawQ) ||
      normalizedName.startsWith(q) ||
      compactName.startsWith(compactQ)
    ) {
      tiers[0].push(item);
    } else if (
      itemSlug.startsWith(rawQ) ||
      normalizedSlug.startsWith(q) ||
      compactSlug.startsWith(compactQ)
    ) {
      tiers[1].push(item);
    } else if (
      type.startsWith(q) ||
      compactType.startsWith(compactQ) ||
      normalizedDisplayName.startsWith(q) ||
      compactDisplayName.startsWith(compactQ)
    ) {
      tiers[2].push(item);
    } else if (
      rawName.includes(rawQ) ||
      normalizedName.includes(q) ||
      compactName.includes(compactQ) ||
      itemSlug.includes(rawQ) ||
      normalizedSlug.includes(q) ||
      compactSlug.includes(compactQ) ||
      (
        item.kind === 'connection' &&
        (
          type.includes(q) ||
          compactType.includes(compactQ) ||
          normalizedDisplayName.includes(q) ||
          compactDisplayName.includes(compactQ)
        )
      )
    ) {
      tiers[3].push(item);
    }
  }

  for (const tier of tiers) {
    tier.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  return [...tiers[0], ...tiers[1], ...tiers[2], ...tiers[3]];
}

function normalizeMentionSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactMentionSearch(value: string): string {
  return normalizeMentionSearch(value).replace(/\s+/g, '');
}

/**
 * Produce a slug → item map for the given list. Collisions get
 * deterministic `-2`, `-3`, … suffixes. Connections are assigned first to
 * preserve their historical connection-only slugs when projects are added;
 * within each kind, assignment is ordered by `created_at` ascending and id.
 */
export function buildSlugMap<T extends Mentionable>(
  items: ReadonlyArray<T>,
): Map<string, T> {
  const ordered = [...items].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'connection' ? -1 : 1;
    }
    const aCreated = a.created_at ?? 0;
    const bCreated = b.created_at ?? 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.id.localeCompare(b.id);
  });

  const result = new Map<string, T>();
  const baseCounts = new Map<string, number>();

  for (const item of ordered) {
    const base = slug(item.name);
    if (!base) continue;

    const count = (baseCounts.get(base) ?? 0) + 1;
    baseCounts.set(base, count);
    const finalSlug = count === 1 ? base : `${base}-${count}`;
    result.set(finalSlug, item);
  }

  return result;
}

/**
 * Get the slug an item will be assigned in the given list. Useful for
 * components that want to render a chip without rebuilding the whole map by
 * hand. Returns null when the item's name slugs to an empty string.
 */
export function slugForMentionable<T extends Mentionable>(
  item: T,
  slugMap: ReadonlyMap<string, T>,
): string | null {
  for (const [s, found] of slugMap) {
    if (found.kind === item.kind && found.id === item.id) return s;
  }
  return null;
}

function parseIsoDateMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function projectsToMentionables(
  projects: readonly MentionProjectSource[],
): MentionableProject[] {
  const result: MentionableProject[] = [];

  for (const project of projects) {
    if ((project.kind ?? 'project') === 'clone') {
      // Clones remain available through project tools, but are deliberately
      // excluded from @-mentions so client/server slug maps stay identical.
      continue;
    }

    result.push({
      kind: 'project',
      id: project.id,
      name: project.name,
      description: project.description ?? '',
      created_at: parseIsoDateMs(project.createdAt),
      updated_at: parseIsoDateMs(project.updatedAt),
    });
  }

  return result;
}

function isWordBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isSlugChar(ch: string): boolean {
  return SLUG_CHARSET.test(ch) || ch === '-';
}

function mentionSlugBefore(body: string, index: number): string | null {
  let end = index;
  while (end > 0 && /\s/.test(body[end - 1] ?? '')) {
    end--;
  }

  let start = end;
  while (start > 0 && isSlugChar(body[start - 1] ?? '')) {
    start--;
  }

  if (start === end || body[start - 1] !== '@') {
    return null;
  }

  if (!isWordBoundaryChar(body[start - 2])) {
    return null;
  }

  return body.slice(start, end).toLowerCase();
}

export interface AnnotatedMentionRef {
  slug: string;
  id: string | null;
}

export interface MentionAnnotationDisplay {
  displayText: string;
  annotatedMentions: AnnotatedMentionRef[];
}

function annotationConnectionId(annotation: string): string | null {
  const idMatch = annotation.match(/\sid=([^⟧\s]+)\s*⟧$/);
  return idMatch?.[1] ?? null;
}

export function stripMentionAnnotationsWithMetadata(
  body: string,
): MentionAnnotationDisplay {
  const annotatedMentions: AnnotatedMentionRef[] = [];
  let displayText = '';
  let cursor = 0;

  for (const match of body.matchAll(MENTION_ANNOTATION_REGEX)) {
    const annotation = match[0];
    const index = match.index ?? 0;
    const slug = mentionSlugBefore(body, index);
    if (slug) {
      annotatedMentions.push({
        slug,
        id: annotationConnectionId(annotation),
      });
    }

    displayText += body.slice(cursor, index);
    cursor = index + annotation.length;
  }

  displayText += body.slice(cursor);
  return { displayText, annotatedMentions };
}

export function stripMentionAnnotations(body: string): string {
  return stripMentionAnnotationsWithMetadata(body).displayText;
}

/**
 * Walk every `@<slug>` token in `body` whose `@` is preceded by whitespace or
 * the start of the string. Returns one entry per match — including those whose
 * slug isn't in `slugMap` (so callers can decide whether to render them as
 * plain text). Mid-word `@` (e.g. inside an email address) is ignored.
 */
export function parseMentions<T extends Mentionable>(
  body: string,
  slugMap: ReadonlyMap<string, T>,
): MentionMatch<T>[] {
  const matches: MentionMatch<T>[] = [];

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '@') continue;
    if (!isWordBoundaryChar(body[i - 1])) continue;

    let end = i + 1;
    while (end < body.length && isSlugChar(body[end])) {
      end++;
    }

    if (end === i + 1) continue;

    const candidate = body.slice(i + 1, end).toLowerCase();
    matches.push({
      slug: candidate,
      target: slugMap.get(candidate) ?? null,
      index: i,
      length: end - i,
    });
  }

  return matches;
}

/**
 * Annotate every known `@<slug>` mention in `body` with a stable
 * `⟦ref: <type> "<name>" id=<id>⟧` marker. Unknown slugs are left untouched so
 * stale references in old transcripts don't crash. Mentions are processed
 * right-to-left so earlier indices remain valid after each splice.
 */
export function expandMentions(
  body: string,
  slugMap: ReadonlyMap<string, Mentionable>,
): string {
  if (!body || slugMap.size === 0) return body;

  const matches = parseMentions(body, slugMap);
  if (matches.length === 0) return body;

  let result = body;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    if (!match.target) continue;
    const annotationType = match.target.kind === 'connection'
      ? match.target.integration_type
      : 'project';
    const annotation = ` ⟦ref: ${annotationType} "${match.target.name}" id=${match.target.id}⟧`;
    const insertAt = match.index + match.length;
    result = result.slice(0, insertAt) + annotation + result.slice(insertAt);
  }

  return result;
}
