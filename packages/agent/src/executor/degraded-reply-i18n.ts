// SPDX-License-Identifier: Apache-2.0
import type { ContextExhaustionCause } from "../context-engine/errors.js";
import { tryCatch } from "@comis/shared";

export const CAP_KNOB_BY_CLASS: Readonly<Record<string, string>> = {
  small: "contextEngine.budget.effectiveContextCapSmall",
  nano: "contextEngine.budget.effectiveContextCapNano",
};

export type LocaleMessageId =
  | "context_exhausted"
  | "cause_oversized_input"
  | "cause_oversized_history_message"
  | "cause_fixed_overhead_exceeds_window"
  | "advice_default"
  | "advice_history"
  | "advice_fixed_overhead"
  | "output_starved"
  | "loop_detected";

export type LocalePack = Readonly<Partial<Record<LocaleMessageId, string>>>;

export interface LocaleCatalog {
  resolve(locale: string | undefined, id: LocaleMessageId): string;
}

const ENGLISH_PACK: Readonly<Record<LocaleMessageId, string>> = {
  context_exhausted:
    "I couldn't complete that request because this conversation exceeded the model's context limit. ",
  cause_oversized_input:
    "This message is too large for the selected model. Shorten it or split it into smaller parts. ",
  cause_oversized_history_message:
    "An earlier message is too large for the selected model. Start a new session, then try again. ",
  cause_fixed_overhead_exceeds_window:
    "The selected model does not have enough context capacity for this agent's instructions and tools. ",
  advice_default:
    "Try a more focused request, disable tools this agent does not need, or choose a model with a larger context window.",
  advice_history: "If this keeps happening, choose a model with a larger context window.",
  advice_fixed_overhead:
    "Disable tools this agent does not need or choose a model with a larger context window.",
  output_starved:
    "\n\n⚠️ My response was cut short by the model's output limit. Try a more focused request or choose a model with a larger output limit.",
  loop_detected:
    "I stopped because I kept repeating an action that wasn't making progress "
      + "(usually a tool that failed or was blocked) and didn't want to loop. The "
      + "request may need a different approach, or that capability isn't available here.",
};

function canonicalLocale(raw: string): string | undefined {
  const canonical = tryCatch(() => Intl.getCanonicalLocales(raw.trim()));
  return canonical.ok && canonical.value.length === 1 ? canonical.value[0] : undefined;
}

export function createLocaleCatalog(
  packs: Readonly<Record<string, LocalePack>> = {},
): LocaleCatalog {
  const canonicalPacks = new Map<string, LocalePack>();
  for (const [rawLocale, pack] of Object.entries(packs)) {
    const locale = canonicalLocale(rawLocale);
    if (locale !== undefined) canonicalPacks.set(locale, pack);
  }
  return {
    resolve(locale, id) {
      if (locale !== undefined) {
        const canonical = canonicalLocale(locale);
        if (canonical !== undefined) {
          const exact = canonicalPacks.get(canonical)?.[id];
          if (exact !== undefined) return exact;
          const languageResult = tryCatch(() => new Intl.Locale(canonical).language);
          if (languageResult.ok) {
            const languageFallback = canonicalPacks.get(languageResult.value)?.[id];
            if (languageFallback !== undefined) return languageFallback;
          }
        }
      }
      return ENGLISH_PACK[id];
    },
  };
}

export const DEFAULT_LOCALE_CATALOG = createLocaleCatalog();

function incidentRef(traceId?: string): string {
  return traceId !== undefined && traceId.length > 0 ? ` (incident ${traceId})` : "";
}

export function selectOutputStarvedAnnotation(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "output_starved");
}

export interface SelectContextExhaustedOpts {
  capabilityClass?: string;
  traceId?: string;
  cause?: ContextExhaustionCause;
}

function causeMessageId(cause: ContextExhaustionCause): LocaleMessageId | undefined {
  switch (cause) {
    case "oversized_input": return "cause_oversized_input";
    case "oversized_history_message": return "cause_oversized_history_message";
    case "fixed_overhead_exceeds_window": return "cause_fixed_overhead_exceeds_window";
    case "aggregate": return undefined;
    default: {
      const _exhaustive: never = cause;
      return _exhaustive;
    }
  }
}

function adviceMessageId(cause: ContextExhaustionCause): LocaleMessageId {
  if (cause === "fixed_overhead_exceeds_window") return "advice_fixed_overhead";
  if (cause === "oversized_history_message") return "advice_history";
  return "advice_default";
}

export function selectContextExhaustedReply(
  locale: string | undefined,
  opts: SelectContextExhaustedOpts,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  const cause = opts.cause ?? "aggregate";
  const causeId = causeMessageId(cause);
  return catalog.resolve(locale, "context_exhausted")
    + (causeId === undefined ? "" : catalog.resolve(locale, causeId))
    + catalog.resolve(locale, adviceMessageId(cause))
    + incidentRef(opts.traceId);
}

export function selectLoopDetectedReply(
  locale: string | undefined,
  opts: { traceId?: string },
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "loop_detected") + incidentRef(opts.traceId);
}
