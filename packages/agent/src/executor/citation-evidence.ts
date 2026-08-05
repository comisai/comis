// SPDX-License-Identifier: Apache-2.0
/** Exact fetched-URL grounding for model-authored citations. */

import { createHash } from "node:crypto";

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MARKDOWN_LINK = /(!?)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/giu;
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/giu;
const BARE_URL = /https?:\/\/[^\s<>\])]+/giu;
const CODE_SPAN = /```[\s\S]*?```|`[^`\n]*`/gu;

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

  const allowed = validDigests(params.allowedUrlDigests);
  const codeRanges = rangesFor(CODE_SPAN, params.response);
  const occupied: TextRange[] = [];
  const replacements: Replacement[] = [];
  const matchedDigests: string[] = [];
  const matchedSet = new Set<string>();
  let removedCitationCount = 0;

  MARKDOWN_LINK.lastIndex = 0;
  for (const match of params.response.matchAll(MARKDOWN_LINK)) {
    if (match.index === undefined || inside(match.index, codeRanges)) continue;
    const start = match.index;
    const end = start + match[0].length;
    occupied.push({ start, end });
    if (match[1] === "!") continue;
    const url = match[3]!;
    const digest = citationUrlDigest(url);
    if (allowed.has(digest)) {
      pushMatched(digest, matchedDigests, matchedSet);
      continue;
    }
    replacements.push({ start, end, text: match[2]! });
    removedCitationCount += 1;
  }

  AUTOLINK.lastIndex = 0;
  for (const match of params.response.matchAll(AUTOLINK)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (inside(start, codeRanges) || overlaps(start, end, occupied)) continue;
    occupied.push({ start, end });
    const digest = citationUrlDigest(match[1]!);
    if (allowed.has(digest)) {
      pushMatched(digest, matchedDigests, matchedSet);
      continue;
    }
    replacements.push({ start, end, text: "" });
    removedCitationCount += 1;
  }

  BARE_URL.lastIndex = 0;
  for (const match of params.response.matchAll(BARE_URL)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (inside(start, codeRanges) || overlaps(start, end, occupied)) continue;
    const digest = citationUrlDigest(match[0]);
    if (allowed.has(digest)) {
      pushMatched(digest, matchedDigests, matchedSet);
      continue;
    }
    replacements.push({ start, end, text: "" });
    removedCitationCount += 1;
  }

  if (replacements.length === 0) {
    return {
      response: params.response,
      corrected: false,
      matchedDigests,
      removedCitationCount: 0,
    };
  }
  let response = params.response;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    response = response.slice(0, replacement.start)
      + replacement.text
      + response.slice(replacement.end);
  }
  return {
    response,
    corrected: true,
    reason: "citation_without_fetch_evidence",
    matchedDigests,
    removedCitationCount,
  };
}

/** Runtime-attached citation evidence from assistant turns before this request. */
export function historicalCitationDigests(session: unknown): string[] {
  const messages = (session as { messages?: unknown[] } | undefined)?.messages;
  if (!Array.isArray(messages)) return [];
  const lastUserIndex = messages.findLastIndex(
    (message) => (message as { role?: unknown } | undefined)?.role === "user",
  );
  const priorMessages = messages.slice(
    0,
    lastUserIndex < 0 ? messages.length : lastUserIndex,
  );
  const digests: string[] = [];
  const seen = new Set<string>();
  for (const rawMessage of priorMessages) {
    const message = rawMessage as {
      role?: unknown;
      citationEvidenceDigests?: unknown;
    } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.citationEvidenceDigests)) continue;
    for (const digest of message.citationEvidenceDigests) {
      if (typeof digest !== "string" || !SHA256_HEX.test(digest) || seen.has(digest)) continue;
      seen.add(digest);
      digests.push(digest);
      if (digests.length >= 500) return digests;
    }
  }
  return digests;
}

/** Narrow trigger for a later request asking the agent to identify its sources. */
export function isCitationSourceRequest(request: string): boolean {
  return /\b(?:cite|cites|citation|citations|reference|references|source|sources)\b/iu.test(request)
    || /\bwhere(?:'s| is| are)\b[^.!?\n]{0,40}\bfrom\b/iu.test(request);
}
