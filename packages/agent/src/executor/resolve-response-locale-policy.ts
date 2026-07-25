// SPDX-License-Identifier: Apache-2.0
import {
  classifyCodepoint,
  dominantScript,
  scriptShares,
  type ResponseLocalePolicy,
  type ResponseLocaleSource,
  type ScriptClass,
} from "@comis/core";
import { tryCatch } from "@comis/shared";

export interface ResolveResponseLocalePolicyInput {
  readonly explicitLocale?: string;
  readonly requestLocale?: string;
  /** Exact current user-authored text used only for open script fallback. */
  readonly requestText?: string;
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
  const candidates: ReadonlyArray<readonly [string | undefined, ResponseLocaleSource, boolean]> = [
    [input.explicitLocale, "explicit", true],
    [input.requestLocale, "request", true],
  ];
  const translationTarget = canonicalLocale(input.translationTarget);
  for (const [raw, source, enforceLocale] of candidates) {
    const locale = canonicalLocale(raw);
    if (locale !== undefined) {
      // The request-tier locale is TRANSPORT metadata (a client UI
      // language_code, a caller-supplied field) — a device setting, not the
      // conversation's language. When the user's current message is written
      // in a script that contradicts it, the conversation wins: skip the
      // transport locale so the script fallback below (or unset) governs,
      // and a correct same-script reply is never repaired toward the device
      // language. The explicit operator locale is a deliberate pin and is
      // never overridden.
      if (source === "request" && contradictsRequestScript(locale, input.requestText)) {
        continue;
      }
      return {
        locale,
        source,
        ...(translationTarget === undefined ? {} : { translationTarget }),
        enforceLocale,
      };
    }
  }
  const requestScriptLocale = scriptLocaleFromRequest(input.requestText);
  if (requestScriptLocale !== undefined) {
    return {
      locale: requestScriptLocale,
      source: "request",
      ...(translationTarget === undefined ? {} : { translationTarget }),
      enforceLocale: true,
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

/**
 * True when the current request text carries a clear script signal that
 * contradicts the candidate locale's script. No text, no classifiable
 * shares, an "other" dominant class, or an unknown locale script all mean
 * "cannot judge" — the locale is kept.
 */
function contradictsRequestScript(locale: string, requestText: string | undefined): boolean {
  if (requestText === undefined || scriptShares(requestText).size === 0) return false;
  const dominantClass = dominantScript(requestText);
  if (dominantClass === "other") return false;
  if (dominantClass === "latin" && latinProseWordCount(requestText) < LATIN_PROSE_MIN_WORDS) return false;
  const maximized = tryCatch(() => new Intl.Locale(locale).maximize());
  if (!maximized.ok || maximized.value.script === undefined) return false;
  const localeClass = scriptClassForIsoScript(maximized.value.script);
  if (localeClass === undefined) return false;
  return localeClass !== dominantClass;
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
  const proseCandidate = withoutProtectedResponseSpans(text);
  const latinWords = proseCandidate.match(LATIN_WORD) ?? [];
  return latinWords.filter((word) => {
    if (word.length < 2) return false;
    return word !== word.toUpperCase() || word.includes("'") || word.includes("’");
  }).length;
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
  const actualClass = dominantScript(response);
  if (expectedClass === undefined || actualClass === "other") {
    return undefined;
  }
  const mismatchedClass = expectedClass === actualClass
    ? substantialForeignScript(response, expectedClass)
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
