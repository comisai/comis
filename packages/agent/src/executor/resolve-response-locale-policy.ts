// SPDX-License-Identifier: Apache-2.0
import {
  classifyCodepoint,
  dominantScript,
  scriptShares,
  type ResponseLocalePolicy,
  type ScriptClass,
} from "@comis/core";
import { tryCatch } from "@comis/shared";

export interface ResolveResponseLocalePolicyInput {
  readonly explicitLocale?: string;
  readonly requestLocale?: string;
  /** Exact current user-authored text used only for open script fallback. */
  readonly requestText?: string;
  /**
   * The turn's inbound user messages in arrival order, when a turn coalesced
   * several. Takes precedence over {@link requestText}.
   *
   * Each message is qualified as a language signal INDEPENDENTLY. Concatenating
   * them first would let several sub-threshold fragments sum into prose none of
   * them contains — two consecutive install pastes, each correctly rejected on
   * its own, once added up to an enforced Latin script on a Hebrew
   * conversation, and the reply came back transliterated.
   */
  readonly requestTexts?: readonly string[];
  readonly translationTarget?: string;
}

export interface ResolvedLocale {
  readonly policy: ResponseLocalePolicy;
  readonly confidence: "high" | "medium" | "low";
}

export interface ResponseLocaleQualityFinding {
  readonly kind: "locale_script_mismatch";
  readonly locale: string;
  readonly expectedScript: string;
  readonly actualScript: string;
  readonly responseChars: number;
}

function canonicalLocale(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const result = tryCatch(() => Intl.getCanonicalLocales(raw.trim()));
  return result.ok && result.value.length === 1 ? result.value[0] : undefined;
}

export function resolveResponseLocalePolicy(
  input: ResolveResponseLocalePolicyInput,
): ResponseLocalePolicy {
  const translationTarget = canonicalLocale(input.translationTarget);
  const explicitLocale = canonicalLocale(input.explicitLocale);
  if (explicitLocale !== undefined) {
    return {
      locale: explicitLocale,
      source: "explicit",
      ...(translationTarget === undefined ? {} : { translationTarget }),
      enforceLocale: true,
    };
  }

  // Clear prose in the current request is a better conversation-language
  // signal than a client UI locale. The prose threshold excludes short
  // identifier-heavy fragments, so only a high-confidence script signal
  // enables bounded post-generation repair.
  const requestScriptLocale = scriptLocaleFromRequestBatch(
    input.requestTexts ?? (input.requestText === undefined ? [] : [input.requestText]),
  );
  if (requestScriptLocale !== undefined) {
    return {
      locale: requestScriptLocale,
      source: "request",
      ...(translationTarget === undefined ? {} : { translationTarget }),
      enforceLocale: true,
    };
  }

  const requestLocale = canonicalLocale(input.requestLocale);
  if (requestLocale !== undefined) {
    return {
      locale: requestLocale,
      source: "request",
      ...(translationTarget === undefined ? {} : { translationTarget }),
      enforceLocale: false,
    };
  }

  return {
    source: "unset",
    ...(translationTarget === undefined ? {} : { translationTarget }),
    enforceLocale: false,
  };
}

/** Resolve locale policy and record how authoritative its source is. */
export function resolveLocale(input: ResolveResponseLocalePolicyInput): ResolvedLocale {
  const policy = resolveResponseLocalePolicy(input);
  const confidence = policy.source === "explicit"
    ? "high" as const
    : policy.source === "request"
      ? "medium" as const
      : "low" as const;
  return { policy, confidence };
}

function scriptClassForIsoScript(script: string): ScriptClass | undefined {
  switch (script) {
    case "Latn": return "latin";
    case "Cyrl": return "cyrillic";
    case "Hebr": return "hebrew";
    case "Arab": return "arabic";
    case "Hans":
    case "Hant":
    case "Jpan":
    case "Kore": return "cjk";
    case "Thai": return "thai";
    case "Grek": return "greek";
    case "Deva": return "devanagari";
    default: return undefined;
  }
}

const isoScriptByClass: Readonly<Record<ScriptClass, string>> = {
  latin: "Latn",
  cyrillic: "Cyrl",
  hebrew: "Hebr",
  arabic: "Arab",
  cjk: "Hani",
  thai: "Thai",
  greek: "Grek",
  devanagari: "Deva",
  other: "Zyyy",
};

const FOREIGN_SCRIPT_MIN_SHARE = 0.15;
const FOREIGN_SCRIPT_MIN_UNITS = 8;
const LATIN_PROSE_MIN_SHARE = 0.2;
const LATIN_PROSE_MIN_WORDS = 4;
const LATIN_WORD = /\b[A-Za-z][A-Za-z'’]*\b/g;
const COMMAND_OPTION = /(^|\s)--?[A-Za-z0-9][A-Za-z0-9-]*(?:\s|$)/;

function withoutProtectedResponseSpans(text: string): string {
  const lower = text.toLowerCase();
  const parts: string[] = [];
  let plainStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    let end = -1;
    if (text.startsWith("```", cursor)) {
      const close = text.indexOf("```", cursor + 3);
      if (close !== -1) end = close + 3;
    } else if (text[cursor] === "`") {
      const close = text.indexOf("`", cursor + 1);
      if (close !== -1 && !text.slice(cursor + 1, close).includes("\n")) end = close + 1;
    } else if (text[cursor] === "[") {
      const labelEnd = text.indexOf("](", cursor + 1);
      const close = labelEnd === -1 ? -1 : text.indexOf(")", labelEnd + 2);
      if (
        labelEnd !== -1 &&
        close !== -1 &&
        !text.slice(cursor + 1, close).includes("\n")
      ) {
        end = close + 1;
      }
    } else if (
      lower.startsWith("http://", cursor) ||
      lower.startsWith("https://", cursor) ||
      lower.startsWith("www.", cursor)
    ) {
      end = cursor;
      while (end < text.length && !/\s/.test(text[end]!)) end++;
    }
    if (end === -1) {
      cursor++;
      continue;
    }
    parts.push(text.slice(plainStart, cursor), " ");
    plainStart = end;
    cursor = end;
  }
  parts.push(text.slice(plainStart));
  return parts.join("");
}

function scriptUnits(text: string, scriptClass: ScriptClass): number {
  let units = 0;
  for (const character of text) {
    if (classifyCodepoint(character.codePointAt(0) ?? 0) === scriptClass) {
      units += character.length;
    }
  }
  return units;
}

function latinProseWordCount(text: string): number {
  const proseCandidate = withoutProtectedResponseSpans(text)
    .split("\n")
    .filter((line) => !COMMAND_OPTION.test(line))
    .join("\n");
  const latinWords = proseCandidate.match(LATIN_WORD) ?? [];
  return latinWords.filter((word) => {
    if (word.length < 2) return false;
    return word !== word.toUpperCase() || word.includes("'") || word.includes("’");
  }).length;
}

/**
 * Find a token that welds the expected script to a DIFFERENT non-Latin script.
 *
 * The share/unit thresholds below exist to protect legitimate mixed-script prose, and they are
 * right for bulk foreign text — but they are structurally blind to a few characters fused into one
 * token: three foreign letters in a long reply clear neither floor. Live: under enforcement for a
 * Hebrew response locale, a reply opened with one Hebrew letter welded to an Arabic word, and
 * enforcement reported nothing while claiming to enforce.
 *
 * A fused token is not prose. Quoting a foreign name puts it in its own word; it does not weld two
 * scripts inside a single token, so this needs no share threshold — which is precisely why the
 * thresholds could not catch it. Latin is excluded: it mixes into non-Latin prose constantly
 * (identifiers, units, URLs) and is already covered by the prose-share rule.
 */
function fusedForeignScript(
  response: string,
  expectedClass: ScriptClass,
): ScriptClass | undefined {
  const proseCandidate = withoutProtectedResponseSpans(response);
  for (const token of proseCandidate.split(/[\s\p{P}\p{S}]+/u)) {
    if (token.length === 0) continue;
    let sawExpected = false;
    let foreign: ScriptClass | undefined;
    for (const character of token) {
      const cls = classifyCodepoint(character.codePointAt(0) ?? 0);
      if (cls === null || cls === "latin" || cls === "other") continue;
      if (cls === expectedClass) sawExpected = true;
      else foreign ??= cls;
    }
    if (sawExpected && foreign !== undefined) return foreign;
  }
  return undefined;
}


/**
 * Find substantial wrong-script prose hidden behind a longer matching-script
 * tail. Protected code, links, URLs, acronyms, and short identifier clusters
 * remain valid mixed-script content.
 */
function substantialForeignScript(
  response: string,
  expectedClass: ScriptClass,
): ScriptClass | undefined {
  const proseCandidate = withoutProtectedResponseSpans(response);
  const shares = scriptShares(proseCandidate);
  for (const [scriptClass, share] of shares) {
    if (
      scriptClass !== expectedClass &&
      scriptClass !== "latin" &&
      scriptClass !== "other" &&
      share >= FOREIGN_SCRIPT_MIN_SHARE &&
      scriptUnits(proseCandidate, scriptClass) >= FOREIGN_SCRIPT_MIN_UNITS
    ) {
      return scriptClass;
    }
  }
  if (expectedClass === "latin" || (shares.get("latin") ?? 0) < LATIN_PROSE_MIN_SHARE) {
    return undefined;
  }
  return latinProseWordCount(response) >= LATIN_PROSE_MIN_WORDS ? "latin" : undefined;
}

function scriptLocaleFromRequest(text: string | undefined): string | undefined {
  if (text === undefined || scriptShares(text).size === 0) return undefined;
  const scriptClass = dominantScript(text);
  if (scriptClass === "other") return undefined;
  if (scriptClass === "latin" && latinProseWordCount(text) < LATIN_PROSE_MIN_WORDS) return undefined;
  return canonicalLocale(`und-${isoScriptByClass[scriptClass]}`);
}

/**
 * Resolve the script locale from a turn's inbound messages, qualifying each one
 * on its own and taking the most recent that carries a signal.
 *
 * Per-message qualification is the point: the prose threshold decides whether a
 * message is natural language at all, and that question is only meaningful per
 * message. Scoring the concatenation lets N identifier-heavy fragments sum past
 * the threshold, and lets bulk Latin config text outweigh a short sentence of
 * real prose in the same batch. Most-recent-wins preserves the documented
 * precedence of the current request over earlier turns.
 */
function scriptLocaleFromRequestBatch(texts: readonly string[]): string | undefined {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const locale = scriptLocaleFromRequest(texts[index]);
    if (locale !== undefined) return locale;
  }
  return undefined;
}

export function evaluateResponseLocale(
  policy: ResponseLocalePolicy,
  response: string,
): ResponseLocaleQualityFinding | undefined {
  if (!policy.enforceLocale || policy.locale === undefined || response.trim().length === 0) {
    return undefined;
  }
  const locale = policy.locale;
  const localeResult = tryCatch(() => new Intl.Locale(locale).maximize());
  if (!localeResult.ok || localeResult.value.script === undefined) return undefined;
  const expectedClass = scriptClassForIsoScript(localeResult.value.script);
  // A response carrying NO script-bearing characters — a bare number, a
  // percentage, a formatted figure with markup and an emoji — cannot satisfy ANY
  // script requirement, so enforcing one can only discard a correct answer.
  // `dominantScript` defaults to "latin" on an empty share map, so such a
  // response reads as Latin and fails a non-Latin target on every repair
  // attempt. Live: "give me one number: how many vehicles in total?" was
  // answered correctly and the user received "choose a model that supports it"
  // instead (locale und-Hebr, expected Hebr, actual Latn, after a failed repair).
  if (scriptShares(response).size === 0) return undefined;
  const actualClass = dominantScript(response);
  if (expectedClass === undefined || actualClass === "other") {
    return undefined;
  }
  // Fusion is checked FIRST and independently of the share thresholds: a welded token is never
  // legitimate prose, and by construction it cannot clear a share floor.
  const mismatchedClass = expectedClass === actualClass
    ? fusedForeignScript(response, expectedClass)
      ?? substantialForeignScript(response, expectedClass)
    : actualClass;
  if (mismatchedClass === undefined) return undefined;
  return {
    kind: "locale_script_mismatch",
    locale: policy.locale,
    expectedScript: localeResult.value.script,
    actualScript: isoScriptByClass[mismatchedClass],
    responseChars: response.length,
  };
}
