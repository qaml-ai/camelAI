import {
  LUCIDE_ICON_METADATA,
  type LucideIconMetadataEntry,
} from "./lucide-icon-metadata.generated";
import { DEFAULT_CHAT_GROUP_ICON } from "./chat-group-icons";

const EXACT_CANONICAL_SCORE = 1_200;
const EXACT_ALIAS_SCORE = 1_150;
const EXACT_TAG_SCORE = 800;
const EXACT_CATEGORY_SCORE = 650;
const MIN_CLEAR_MATCH_SCORE = 220;
// Two fully matched ordinary words score at least 300. This keeps weak
// single-token coincidences out while allowing stable base-icon tie-breaking
// for phrases such as "speech bubbles".
const MIN_AMBIGUOUS_FALLBACK_SCORE = 300;
const MAX_MODEL_TERMS = 3;
const MAX_MODEL_TERM_LENGTH = 64;
const MAX_MODEL_TERM_WORDS = 6;

const MODIFIER_TOKENS = [
  "2",
  "3",
  "arrow",
  "check",
  "closed",
  "cog",
  "down",
  "left",
  "minus",
  "off",
  "open",
  "plus",
  "right",
  "up",
  "x",
] as const;

const SEARCH_STOP_WORDS = ["a", "an", "of", "the"] as const;

export type LucideIconMatchReason =
  | "exact_name"
  | "exact_alias"
  | "exact_tag"
  | "exact_category"
  | "token_overlap";

export interface LucideIconCandidate {
  name: string;
  score: number;
  reason: LucideIconMatchReason;
}

export type LucideIconResolution =
  | {
      icon: string;
      outcome: "metadata_match" | "ambiguous_fallback";
      term: string;
    }
  | {
      icon: null;
      outcome: "no_metadata_match";
      term: null;
    };

interface SearchableMetadataEntry {
  metadata: LucideIconMetadataEntry;
  name: string;
  nameTokens: readonly string[];
  aliases: readonly string[];
  aliasTokens: readonly (readonly string[])[];
  tags: readonly string[];
  tagTokens: readonly (readonly string[])[];
  categories: readonly string[];
  categoryTokens: readonly (readonly string[])[];
  baseModifierTokens: readonly string[];
}

export function normalizeLucideSearchPhrase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function phraseTokens(value: string): readonly string[] {
  const normalized = normalizeLucideSearchPhrase(value);
  return normalized
    ? normalized
        .split(" ")
        .filter(
          (token) =>
            !SEARCH_STOP_WORDS.includes(
              token as (typeof SEARCH_STOP_WORDS)[number],
            ),
        )
    : [];
}

function queryTokenForms(token: string): readonly string[] {
  const forms = [token];
  if (token.length > 4 && token.endsWith("ies")) {
    forms.push(`${token.slice(0, -3)}y`);
  }
  if (token.length > 4 && token.endsWith("ing")) {
    const stem = token.slice(0, -3);
    forms.push(stem, `${stem}e`);
  }
  if (token.length > 3 && token.endsWith("ed")) {
    const stem = token.slice(0, -2);
    forms.push(stem, `${stem}e`);
  }
  if (token.length > 4 && token.endsWith("es")) {
    forms.push(token.slice(0, -2));
  }
  if (token.length > 3 && token.endsWith("s")) {
    forms.push(token.slice(0, -1));
  }
  return forms;
}

function metadataTokenForms(token: string): readonly string[] {
  const forms = [token];
  if (token.length > 4 && token.endsWith("ies")) {
    forms.push(`${token.slice(0, -3)}y`);
  }
  if (token.length > 4 && token.endsWith("es")) {
    forms.push(token.slice(0, -2));
  }
  if (token.length > 3 && token.endsWith("s")) {
    forms.push(token.slice(0, -1));
  }
  return forms;
}

function tokensMatch(left: string, right: string): boolean {
  return queryTokenForms(left).some((form) =>
    metadataTokenForms(right).includes(form),
  );
}

function hasTokenMatch(
  queryToken: string,
  fields: readonly (readonly string[])[],
): boolean {
  return fields.some((tokens) =>
    tokens.some((fieldToken) => tokensMatch(queryToken, fieldToken)),
  );
}

let canonicalMetadataNames: ReadonlySet<string> | undefined;

function getCanonicalMetadataNames(): ReadonlySet<string> {
  // Kept lazy because exact/alias matches do not otherwise need the full name
  // set. More importantly, the catalog module itself is now loaded only for
  // the infrequent avatar-generation path.
  return canonicalMetadataNames ??= new Set(
    LUCIDE_ICON_METADATA.map((entry) => entry.name),
  );
}

function findBaseModifierTokens(name: string): readonly string[] {
  const tokens = name.split("-");
  const canonicalNames = getCanonicalMetadataNames();
  for (let length = tokens.length - 1; length > 0; length -= 1) {
    if (canonicalNames.has(tokens.slice(0, length).join("-"))) {
      return tokens.slice(length);
    }
  }
  return [];
}

function indexMetadataEntry(
  metadata: LucideIconMetadataEntry,
): SearchableMetadataEntry {
  const aliases = metadata.aliases.map(normalizeLucideSearchPhrase);
  const tags = metadata.tags.map(normalizeLucideSearchPhrase);
  const categories = metadata.categories.map(normalizeLucideSearchPhrase);
  return {
    metadata,
    name: normalizeLucideSearchPhrase(metadata.name),
    nameTokens: phraseTokens(metadata.name),
    aliases,
    aliasTokens: aliases.map(phraseTokens),
    tags,
    tagTokens: tags.map(phraseTokens),
    categories,
    categoryTokens: categories.map(phraseTokens),
    baseModifierTokens: findBaseModifierTokens(metadata.name),
  };
}

function scoreEntry(
  entry: SearchableMetadataEntry,
  query: string,
  queryTokens: readonly string[],
): LucideIconCandidate | null {
  let score = 0;
  let reason: LucideIconMatchReason = "token_overlap";

  if (query === entry.name) {
    score = EXACT_CANONICAL_SCORE;
    reason = "exact_name";
  } else if (entry.aliases.includes(query)) {
    score = EXACT_ALIAS_SCORE;
    reason = "exact_alias";
  } else if (entry.tags.includes(query)) {
    score = EXACT_TAG_SCORE;
    reason = "exact_tag";
  } else if (entry.categories.includes(query)) {
    score = EXACT_CATEGORY_SCORE;
    reason = "exact_category";
  }

  let matchedQueryTokens = 0;
  for (const queryToken of queryTokens) {
    let tokenScore = 0;
    if (hasTokenMatch(queryToken, [entry.nameTokens])) tokenScore = 150;
    if (hasTokenMatch(queryToken, entry.aliasTokens)) {
      tokenScore = Math.max(tokenScore, 130);
    }
    if (hasTokenMatch(queryToken, entry.tagTokens)) {
      tokenScore = Math.max(tokenScore, 90);
    }
    if (hasTokenMatch(queryToken, entry.categoryTokens)) {
      tokenScore = Math.max(tokenScore, 45);
    }
    if (tokenScore > 0) {
      score += tokenScore;
      matchedQueryTokens += 1;
    }
  }

  if (matchedQueryTokens === queryTokens.length && queryTokens.length > 0) {
    score += 120;
  }

  if (score <= 0) return null;

  const queryRequestsModifier = queryTokens.some((token) =>
    MODIFIER_TOKENS.includes(token as (typeof MODIFIER_TOKENS)[number]),
  );
  const candidateModifiers = entry.nameTokens.filter((token) =>
    MODIFIER_TOKENS.includes(token as (typeof MODIFIER_TOKENS)[number]),
  );
  if (!queryRequestsModifier) {
    score -= candidateModifiers.length * 30;
    if (entry.nameTokens.length === 1) score += 60;
  } else {
    score +=
      candidateModifiers.filter((modifier) => queryTokens.includes(modifier))
        .length * 40;
  }
  if (
    entry.baseModifierTokens.length > 0 &&
    !entry.baseModifierTokens.some((modifier) => queryTokens.includes(modifier))
  ) {
    score -= 60;
  }

  return score > 0 ? { name: entry.metadata.name, score, reason } : null;
}

export function searchLucideIconMetadata(
  term: string,
  limit = 5,
): LucideIconCandidate[] {
  const query = normalizeLucideSearchPhrase(term);
  if (!query || limit <= 0) return [];
  const queryTokens = phraseTokens(term);
  if (queryTokens.length === 0) return [];

  // Score one catalog row at a time and retain only the requested leaders.
  // The previous SEARCH_INDEX permanently expanded every alias/tag/category
  // into normalized strings and token arrays, then flatMapped every match just
  // to sort and discard almost all of them. Peak retained work is now O(limit),
  // independent of the catalog size.
  const leaders: LucideIconCandidate[] = [];
  for (const metadata of LUCIDE_ICON_METADATA) {
    if (metadata.name === DEFAULT_CHAT_GROUP_ICON) continue;
    const candidate = scoreEntry(indexMetadataEntry(metadata), query, queryTokens);
    if (!candidate) continue;
    const insertAt = leaders.findIndex(
      (existing) =>
        candidate.score > existing.score ||
        (candidate.score === existing.score &&
          candidate.name.localeCompare(existing.name) < 0),
    );
    if (insertAt < 0) {
      if (leaders.length < limit) leaders.push(candidate);
    } else {
      leaders.splice(insertAt, 0, candidate);
      if (leaders.length > limit) leaders.pop();
    }
  }
  return leaders;
}

function isClearCandidate(
  top: LucideIconCandidate,
  runnerUp: LucideIconCandidate | undefined,
): boolean {
  if (top.score < MIN_CLEAR_MATCH_SCORE) return false;
  if (!runnerUp) return true;
  const requiredLead = Math.max(30, Math.ceil(top.score * 0.08));
  return top.score - runnerUp.score >= requiredLead;
}

export function resolveLucideIconTerms(
  terms: readonly string[],
): LucideIconResolution {
  let fallback: { candidate: LucideIconCandidate; term: string } | null = null;

  for (const term of terms.slice(0, MAX_MODEL_TERMS)) {
    const [top, runnerUp] = searchLucideIconMetadata(term, 2);
    if (!top) continue;
    if (top.reason === "exact_name" || top.reason === "exact_alias") {
      return { icon: top.name, outcome: "metadata_match", term };
    }
    if (isClearCandidate(top, runnerUp)) {
      return { icon: top.name, outcome: "metadata_match", term };
    }
    if (
      (top.score >= MIN_AMBIGUOUS_FALLBACK_SCORE ||
        (top.score >= 200 &&
          (!runnerUp || top.score - runnerUp.score >= 60))) &&
      (!fallback || top.score > fallback.candidate.score)
    ) {
      fallback = { candidate: top, term };
    }
  }

  if (fallback) {
    return {
      icon: fallback.candidate.name,
      outcome: "ambiguous_fallback",
      term: fallback.term,
    };
  }
  return { icon: null, outcome: "no_metadata_match", term: null };
}

function collectJsonStrings(value: unknown, output: string[]): void {
  if (output.length >= MAX_MODEL_TERMS) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectJsonStrings(item, output);
  }
}

function cleanModelTerm(value: string): string | null {
  const cleaned = value
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
    .replace(
      /^\s*(?:here (?:are|is)(?: three)? (?:icons?|pictograms?|symbols?)|my (?:choices|suggestions))\s*:\s*/i,
      "",
    )
    .replace(
      /^\s*(?:icons?|pictograms?|symbols?|terms?|alternatives?)\s*:\s*/i,
      "",
    )
    .replace(/^[\s`'"[{(]+|[\s`'"\]})!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned || cleaned.length > MAX_MODEL_TERM_LENGTH) return null;
  if (!/[a-z]/i.test(cleaned)) return null;
  if (cleaned.split(/\s+/).length > MAX_MODEL_TERM_WORDS) return null;
  return cleaned;
}

export function parseGeneratedPictogramTerms(value: string | null): string[] {
  if (!value?.trim()) return [];
  const withoutFence = value
    .trim()
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const rawTerms: string[] = [];

  try {
    collectJsonStrings(JSON.parse(withoutFence), rawTerms);
  } catch {
    rawTerms.push(...withoutFence.split(/[,;|\n]+/));
  }

  const terms: string[] = [];
  for (const rawTerm of rawTerms) {
    // A JSON field may itself contain the requested comma-separated response.
    for (const part of rawTerm.split(/[,;|\n]+/)) {
      const cleaned = cleanModelTerm(part);
      if (!cleaned || terms.includes(cleaned)) continue;
      terms.push(cleaned);
      if (terms.length >= MAX_MODEL_TERMS) return terms;
    }
  }
  return terms;
}
