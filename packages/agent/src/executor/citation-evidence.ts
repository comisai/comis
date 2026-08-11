// SPDX-License-Identifier: Apache-2.0
/** Exact fetched-URL grounding for model-authored citations. */

import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { err, ok, tryCatch, type Result } from "@comis/shared";

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MARKDOWN_LINK = /(!?)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/giu;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/giu;
const BARE_URL = /https?:\/\/[^\s<>\])]+/giu;
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/gu;
export const CITATION_EVIDENCE_CUSTOM_TYPE = "citation_evidence";

/**
 * Prose punctuation the bare-URL class absorbs when a sentence ends on a URL.
 * A citation is matched by exact digest, so a fetched URL written as prose
 * ("Source: https://example.com/a.") must be compared without the terminator
 * or the guard strips its own evidence and blocks delivery.
 */
const TRAILING_PROSE_PUNCTUATION = new Set([
  ".", ",", ";", ":", "!", "?", "'", "\"", "*", "”", "’", "»",
]);

/** Trailing runs are prose, not path — bound the candidate ladder per URL. */
const MAX_TRAILING_TRIM = 8;

/** A destination may carry balanced parens; bound how many are recovered. */
const MAX_ABSORBED_PARENS = 4;

const CitationEvidenceRecordSchema = z.strictObject({
  sourceMessageId: z.string().min(1).max(256),
  urlDigests: z.array(z.string().regex(SHA256_HEX)).min(1).max(100),
});

interface TextRange {
  start: number;
  end: number;
}

interface Replacement extends TextRange {
  text: string;
}

export interface CitationEvidenceGuardResult {
  response: string;
  corrected: boolean;
  reason?: "citation_without_fetch_evidence";
  matchedDigests: readonly string[];
  removedCitationCount: number;
}

/** Full SHA-256 over the URL bytes exactly as delivered by web_fetch. */
export function citationUrlDigest(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

/** SHA-256 over a canonicalized search query, without retaining the query text. */
export function webSearchQueryDigest(query: unknown): string | undefined {
  if (typeof query !== "string") return undefined;
  const canonical = query.trim().replace(/\s+/gu, " ").toLowerCase();
  return canonical.length === 0
    ? undefined
    : createHash("sha256").update(canonical, "utf8").digest("hex");
}

function rangesFor(pattern: RegExp, text: string): TextRange[] {
  pattern.lastIndex = 0;
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function inside(index: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function overlaps(start: number, end: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function validDigests(values: readonly string[]): Set<string> {
  return new Set(values.filter((value) => SHA256_HEX.test(value)));
}

function pushMatched(digest: string, matched: string[], seen: Set<string>): void {
  if (seen.has(digest)) return;
  seen.add(digest);
  matched.push(digest);
}

interface EvidenceState {
  allowed: Set<string>;
  matchedDigests: string[];
  matchedSet: Set<string>;
}

function applyReplacements(text: string, replacements: readonly Replacement[]): string {
  let result = text;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, replacement.start)
      + replacement.text
      + result.slice(replacement.end);
  }
  return result;
}

function trailingProsePunctuation(raw: string): string {
  let end = raw.length;
  const floor = Math.max(0, raw.length - MAX_TRAILING_TRIM);
  while (end > floor && TRAILING_PROSE_PUNCTUATION.has(raw.charAt(end - 1))) end -= 1;
  return raw.slice(end);
}

function unbalancedOpenParens(url: string): number {
  let depth = 0;
  for (const character of url) {
    if (character === "(") depth += 1;
    else if (character === ")" && depth > 0) depth -= 1;
  }
  return depth;
}

/** The bare-URL class stops before `)`, so a parenthesized path arrives cut. */
function absorbBalancedParens(text: string, start: number, raw: string): string {
  const missing = Math.min(unbalancedOpenParens(raw), MAX_ABSORBED_PARENS);
  let absorbed = raw;
  for (let index = 0; index < missing; index += 1) {
    if (text.charAt(start + absorbed.length) !== ")") break;
    absorbed += ")";
  }
  return absorbed;
}

/**
 * Match a bare-URL occurrence against fetch evidence. Only trailing prose
 * punctuation and recovered closing parens are trimmed, so no lengthened or
 * rewritten URL can inherit a fetched URL's digest; a removal keeps the prose
 * terminator so the surrounding sentence survives the excision.
 */
function bareUrlVerdict(params: {
  text: string;
  start: number;
  raw: string;
  allowed: Set<string>;
}): { digest?: string; removalEnd: number; removalText: string } {
  const absorbed = absorbBalancedParens(params.text, params.start, params.raw);
  const floor = Math.max(0, absorbed.length - MAX_TRAILING_TRIM);
  let candidate = absorbed;
  for (;;) {
    const digest = citationUrlDigest(candidate);
    if (params.allowed.has(digest)) {
      return { digest, removalEnd: params.start + params.raw.length, removalText: "" };
    }
    const last = candidate.charAt(candidate.length - 1);
    if (
      candidate.length <= floor
      || (last !== ")" && !TRAILING_PROSE_PUNCTUATION.has(last))
    ) {
      break;
    }
    candidate = candidate.slice(0, -1);
  }
  return {
    removalEnd: params.start + params.raw.length,
    removalText: trailingProsePunctuation(params.raw),
  };
}

/**
 * A markdown destination may carry balanced parens the URL class truncates at.
 * The recovered form is accepted only when it carries exact fetch evidence, so
 * an unverified link is never widened.
 */
function hrefVerdict(params: {
  text: string;
  matchEnd: number;
  url: string;
  allowed: Set<string>;
}): { digest?: string; url: string; end: number } {
  const direct = citationUrlDigest(params.url);
  if (params.allowed.has(direct)) {
    return { digest: direct, url: params.url, end: params.matchEnd };
  }
  const missing = unbalancedOpenParens(params.url);
  const unchanged = { url: params.url, end: params.matchEnd };
  if (missing === 0 || missing > MAX_ABSORBED_PARENS) return unchanged;
  if (params.text.slice(params.matchEnd, params.matchEnd + missing) !== ")".repeat(missing)) {
    return unchanged;
  }
  const repaired = params.url + ")".repeat(missing);
  const digest = citationUrlDigest(repaired);
  return params.allowed.has(digest)
    ? { digest, url: repaired, end: params.matchEnd + missing }
    : unchanged;
}

/** Autolink + bare-URL sweep over one text region. */
function collectPlainUrlReplacements(params: {
  text: string;
  codeRanges: readonly TextRange[];
  occupied: TextRange[];
  state: EvidenceState;
}): { replacements: Replacement[]; removedCitationCount: number } {
  const replacements: Replacement[] = [];
  let removedCitationCount = 0;

  AUTOLINK.lastIndex = 0;
  for (const match of params.text.matchAll(AUTOLINK)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (inside(start, params.codeRanges) || overlaps(start, end, params.occupied)) continue;
    params.occupied.push({ start, end });
    const digest = citationUrlDigest(match[1]!);
    if (params.state.allowed.has(digest)) {
      pushMatched(digest, params.state.matchedDigests, params.state.matchedSet);
      continue;
    }
    replacements.push({ start, end, text: "" });
    removedCitationCount += 1;
  }

  BARE_URL.lastIndex = 0;
  for (const match of params.text.matchAll(BARE_URL)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (inside(start, params.codeRanges) || overlaps(start, end, params.occupied)) continue;
    const verdict = bareUrlVerdict({
      text: params.text,
      start,
      raw: match[0],
      allowed: params.state.allowed,
    });
    if (verdict.digest !== undefined) {
      pushMatched(verdict.digest, params.state.matchedDigests, params.state.matchedSet);
      continue;
    }
    const squareWrapped = params.text.charAt(start - 1) === "["
      && params.text.charAt(verdict.removalEnd) === "]";
    replacements.push({
      start: squareWrapped ? start - 1 : start,
      end: squareWrapped ? verdict.removalEnd + 1 : verdict.removalEnd,
      text: squareWrapped ? "" : verdict.removalText,
    });
    removedCitationCount += 1;
  }

  return { replacements, removedCitationCount };
}

/**
 * A link label is written back into the response verbatim, so it carries the
 * same evidence obligation as the destination. Without this, the very common
 * `[<url>](<url>)` shape leaves the unverified URL visible as plain text while
 * the guard reports the citation removed.
 */
function sanitizeLinkLabel(
  label: string,
  state: EvidenceState,
): { label: string; removedCitationCount: number } {
  const collected = collectPlainUrlReplacements({
    text: label,
    codeRanges: rangesFor(CODE_SPAN, label),
    occupied: [],
    state,
  });
  return {
    label: collected.replacements.length === 0
      ? label
      : applyReplacements(label, collected.replacements),
    removedCitationCount: collected.removedCitationCount,
  };
}

/**
 * Remove citation URLs whose exact digest has no successful-fetch evidence.
 * Code spans are excluded so an explicitly named unreachable URL can remain
 * visible as a failed target without being treated as a source citation.
 */
export function enforceCitationEvidence(params: {
  response: string;
  allowedUrlDigests: readonly string[];
  enabled: boolean;
}): CitationEvidenceGuardResult {
  if (!params.enabled) {
    return {
      response: params.response,
      corrected: false,
      matchedDigests: [],
      removedCitationCount: 0,
    };
  }

  const state: EvidenceState = {
    allowed: validDigests(params.allowedUrlDigests),
    matchedDigests: [],
    matchedSet: new Set<string>(),
  };
  const codeRanges = rangesFor(CODE_SPAN, params.response);
  const occupied: TextRange[] = [];
  const replacements: Replacement[] = [];
  let removedCitationCount = 0;

  MARKDOWN_LINK.lastIndex = 0;
  for (const match of params.response.matchAll(MARKDOWN_LINK)) {
    if (match.index === undefined || inside(match.index, codeRanges)) continue;
    const start = match.index;
    const label = sanitizeLinkLabel(match[2]!, state);
    removedCitationCount += label.removedCitationCount;
    if (match[1] === "!") {
      const end = start + match[0].length;
      occupied.push({ start, end });
      if (label.label !== match[2]) {
        replacements.push({ start, end, text: `![${label.label}](${match[3]!})` });
      }
      continue;
    }
    const href = hrefVerdict({
      text: params.response,
      matchEnd: start + match[0].length,
      url: match[3]!,
      allowed: state.allowed,
    });
    occupied.push({ start, end: href.end });
    if (href.digest !== undefined) {
      pushMatched(href.digest, state.matchedDigests, state.matchedSet);
      if (label.label !== match[2]) {
        const visible = label.label.trim().length > 0 ? label.label : href.url;
        replacements.push({ start, end: href.end, text: `[${visible}](${href.url})` });
      }
      continue;
    }
    replacements.push({ start, end: href.end, text: label.label });
    removedCitationCount += 1;
  }

  const plain = collectPlainUrlReplacements({
    text: params.response,
    codeRanges,
    occupied,
    state,
  });
  replacements.push(...plain.replacements);
  removedCitationCount += plain.removedCitationCount;

  if (replacements.length === 0) {
    return {
      response: params.response,
      corrected: false,
      matchedDigests: state.matchedDigests,
      removedCitationCount: 0,
    };
  }
  return {
    response: applyReplacements(params.response, replacements),
    corrected: true,
    reason: "citation_without_fetch_evidence",
    matchedDigests: state.matchedDigests,
    removedCitationCount,
  };
}

/** Fresh fetch evidence is authoritative; durable receipts fill only an evidence-free follow-up. */
export function citationEvidenceDigestsForTurn(params: {
  currentFetchDigests: readonly string[];
  relayedDigests: readonly string[];
  historicalDigests: readonly string[];
}): string[] {
  const freshDigests = [
    ...params.currentFetchDigests,
    ...params.relayedDigests,
  ];
  return [...validDigests(
    freshDigests.length > 0 ? freshDigests : params.historicalDigests,
  )];
}

/** Runtime citation receipts from completed earlier turns in this session. */
export function historicalCitationDigests(
  sessionManager: Pick<SessionManager, "getEntries"> | unknown,
): string[] {
  const getEntries = (sessionManager as { getEntries?: unknown } | undefined)?.getEntries;
  if (typeof getEntries !== "function") return [];
  const entriesResult = tryCatch(
    () => (getEntries as () => unknown[]).call(sessionManager),
  );
  if (!entriesResult.ok || !Array.isArray(entriesResult.value)) return [];
  const digests: string[] = [];
  const seen = new Set<string>();
  for (const rawEntry of entriesResult.value) {
    const entry = rawEntry as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    } | undefined;
    if (entry?.type !== "custom" || entry.customType !== CITATION_EVIDENCE_CUSTOM_TYPE) continue;
    const parsed = CitationEvidenceRecordSchema.safeParse(entry.data);
    if (!parsed.success) continue;
    for (const digest of parsed.data.urlDigests) {
      if (seen.has(digest)) continue;
      seen.add(digest);
      digests.push(digest);
      if (digests.length >= 500) return digests;
    }
  }
  return digests;
}

/** Append one idempotent, bounded receipt after citation guarding completes. */
export function appendCitationEvidenceRecord(params: {
  sessionManager: Pick<SessionManager, "getEntries" | "appendCustomEntry">;
  sourceMessageId: string;
  urlDigests: readonly string[];
}): Result<void, Error> {
  const candidate = CitationEvidenceRecordSchema.safeParse({
    sourceMessageId: params.sourceMessageId,
    urlDigests: [...new Set(params.urlDigests)],
  });
  if (!candidate.success) return err(new Error("Citation evidence record validation failed"));
  const entriesResult = tryCatch(() => params.sessionManager.getEntries());
  if (!entriesResult.ok) return entriesResult;
  for (const entry of entriesResult.value) {
    if (entry.type !== "custom" || entry.customType !== CITATION_EVIDENCE_CUSTOM_TYPE) continue;
    const stored = CitationEvidenceRecordSchema.safeParse(entry.data);
    if (!stored.success || stored.data.sourceMessageId !== candidate.data.sourceMessageId) continue;
    return stored.data.urlDigests.length === candidate.data.urlDigests.length
      && stored.data.urlDigests.every(
        (digest, index) => digest === candidate.data.urlDigests.at(index),
      )
      ? ok(undefined)
      : err(new Error("Citation evidence record identity conflict"));
  }
  const appended = tryCatch(() => params.sessionManager.appendCustomEntry(
    CITATION_EVIDENCE_CUSTOM_TYPE,
    candidate.data,
  ));
  return appended.ok ? ok(undefined) : err(appended.error);
}

/** Attribution vocabulary that never names anything other than evidence. */
const CITATION_VERB = /\b(?:cite|cited|cites|citing|citation|citations)\b/iu;

/** Casual attribution question: "where's that from", "where is this from". */
const PROVENANCE_QUESTION = /\bwhere(?:'?s| is| are)\b[^.!?\n]{0,40}\bfrom\b/iu;

/**
 * "source"/"reference" head plenty of noun phrases that name something other
 * than an attribution ("the source of truth", "source code", "reference
 * implementation"). Those uses are erased before the attribution nouns are
 * matched so an ordinary engineering question does not arm the citation guard
 * with zero receipts and strip every URL out of the answer.
 */
const NON_ATTRIBUTION_USE =
  /\bopen[-\s]sourc(?:e|ed|ing)\b|\bsources?[-\s](?:code|file|files|tree|control|map|maps|directory|repo|repository)\b|\bsources?\s+of\s+truth\b|\breferences?[-\s](?:implementation|implementations|architecture|manual|manuals|design|designs|guide|guides|doc|docs|documentation)\b|\bfor\s+references?\b|\bcross[-\s]references?\b/giu;

/** Attribution nouns, valid only outside the noun phrases erased above. */
const ATTRIBUTION_NOUN = /\b(?:references?|sources?)\b/iu;

/** Narrow trigger for a later request asking the agent to identify its sources. */
export function isCitationSourceRequest(request: string): boolean {
  if (CITATION_VERB.test(request) || PROVENANCE_QUESTION.test(request)) return true;
  NON_ATTRIBUTION_USE.lastIndex = 0;
  return ATTRIBUTION_NOUN.test(request.replace(NON_ATTRIBUTION_USE, " "));
}
