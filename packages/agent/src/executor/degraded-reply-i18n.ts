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
  | "loop_detected"
  | "pipeline_timeout"
  | "tool_failure_notice"
  | "tool_failure_notice_unnamed"
  | "prompt_timeout"
  | "background_task_failed_notice"
  | "delegation_evidence_missing"
  | "destructive_action_not_verified"
  | "vision_unavailable";

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
  tool_failure_notice:
    "\n\nNote: one of the tools I used reported an error, so part of this may be"
      + " incomplete — ",
  tool_failure_notice_unnamed:
    "\n\nNote: one of the tools I used reported an error, so part of this may be"
      + " incomplete.",
  prompt_timeout:
    "The request took too long to process. Please try again with a simpler message.",
  background_task_failed_notice:
    "⚠️ This background task failed, so its result may be incomplete.",
  delegation_evidence_missing:
    "I did not successfully start the requested sub-agent in this turn, so I cannot claim a new independent check. Please retry the request.",
  destructive_action_not_verified:
    "I could not verify that anything was deleted. The command had no observable effect, so I am not treating the deletion as complete.",
  vision_unavailable:
    "I couldn't analyze this image because no vision provider is available. "
      + "Re-uploading the same image will not help until the vision configuration changes. "
      + "Settings:",
  pipeline_timeout:
    "I stopped this request because it was taking too long and hit the time limit "
      + "for a single turn. Nothing was left half-applied. If it needs many lookups, "
      + "ask for a narrower slice (fewer items, a shorter date range) and I can do the "
      + "rest in follow-ups.",
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

/** Every id an operator pack may define. Exported so config surfaces can list them. */
export const LOCALE_MESSAGE_IDS: readonly LocaleMessageId[] = Object.keys(
  ENGLISH_PACK,
) as LocaleMessageId[];

const KNOWN_MESSAGE_IDS = new Set<string>(LOCALE_MESSAGE_IDS);

/**
 * Build a catalog from the operator's raw `localePacks` config.
 *
 * This is the seam's ONLY production entry point. `createLocaleCatalog` takes a
 * typed pack; operator config arrives as an open `string -> string` record
 * because core does not own this runtime's message-id vocabulary. Unknown ids
 * are dropped and reported rather than silently retained — a typo in a pack
 * would otherwise look configured while the reply stayed English.
 */
export function catalogFromLocalePacks(
  packs: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined,
  onUnknownId?: (locale: string, messageId: string) => void,
): LocaleCatalog {
  if (packs === undefined) return DEFAULT_LOCALE_CATALOG;
  const typed: Record<string, LocalePack> = {};
  for (const [locale, pack] of Object.entries(packs)) {
    const known: Partial<Record<LocaleMessageId, string>> = {};
    for (const [id, text] of Object.entries(pack)) {
      if (KNOWN_MESSAGE_IDS.has(id)) known[id as LocaleMessageId] = text;
      else onUnknownId?.(locale, id);
    }
    if (Object.keys(known).length > 0) typed[locale] = known;
  }
  return createLocaleCatalog(typed);
}

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

/**
 * The reply for a turn killed by the execution wall-clock ceiling
 * (`executionTimeoutMs`). The model never returned, so there is no partial text
 * to annotate — this REPLACES the response entirely.
 */
/**
 * The trailing notice appended when a tool failed and the model's own reply did
 * not mention it. The failing tool's NAME is appended verbatim by the caller —
 * identifiers stay untranslated in every language (see the no-translation
 * principle in docs/operations/multilingual.mdx), only the prose is localized.
 */
export function selectToolFailureNotice(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "tool_failure_notice");
}

/**
 * The tool-failure notice for the case with NO nameable culprit — the only
 * unrecovered failure was the background poller, which relays other tools'
 * failures and must never be blamed. The named variant ends in an em-dash
 * awaiting a tool name; using it here left the reply ending "incomplete — ".
 */
export function selectToolFailureNoticeUnnamed(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "tool_failure_notice_unnamed");
}

/**
 * The reply for a turn killed by the stall budget or whole-turn retry timeout.
 * Was a hard-coded English literal in error-classifier.ts, shipped verbatim into
 * conversations in any language.
 */
export function selectPromptTimeoutReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "prompt_timeout");
}

/** Deterministic terminal-state disclosure for a failed background task. */
export function selectBackgroundTaskFailedNotice(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "background_task_failed_notice");
}

/** Honest replacement when a delegation claim has no current-turn spawn proof. */
export function selectDelegationEvidenceMissingReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "delegation_evidence_missing");
}

/** Honest replacement when a destructive command reports no observable effect. */
export function selectDestructiveActionNotVerifiedReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "destructive_action_not_verified");
}

/** Honest replacement when image analysis reached the unavailable terminal. */
export function selectVisionUnavailableReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "vision_unavailable");
}

export function selectPipelineTimeoutReply(
  locale: string | undefined,
  opts: { traceId?: string },
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "pipeline_timeout") + incidentRef(opts.traceId);
}
