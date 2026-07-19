// SPDX-License-Identifier: Apache-2.0
import {
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

function scriptLocaleFromRequest(text: string | undefined): string | undefined {
  if (text === undefined || scriptShares(text).size === 0) return undefined;
  const scriptClass = dominantScript(text);
  if (scriptClass === "latin" || scriptClass === "other") return undefined;
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
  if (expectedClass === undefined || actualClass === "other" || expectedClass === actualClass) {
    return undefined;
  }
  return {
    kind: "locale_script_mismatch",
    locale: policy.locale,
    expectedScript: localeResult.value.script,
    actualScript: isoScriptByClass[actualClass],
    responseChars: response.length,
  };
}
