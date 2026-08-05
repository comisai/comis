// SPDX-License-Identifier: Apache-2.0
import type { ContextExhaustionCause } from "../context-engine/errors.js";
import type { ErrorKind } from "@comis/core";
import { tryCatch } from "@comis/shared";
import { NO_PROGRESS_LOOP_THRESHOLD } from "./turn-loop-detector.js";

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
  | "execution_failed"
  | "background_task_failed_notice"
  | "delegation_evidence_missing"
  | "persistent_action_evidence_missing"
  | "destructive_action_not_verified"
  | "provider_requires_model"
  | "agent_update_noop"
  | "ongoing_work_evidence_missing"
  | "scheduler_state_evidence_missing"
  | "completion_evidence_missing"
  | "sender_authority_overclaim"
  | "vision_unavailable"
  | "response_locale_unavailable"
  | "background_pending_running"
  | "background_pending_ready"
  | "background_pending_updates"
  | "activity_card_approval_required"
  | "activity_card_detail_server"
  | "activity_card_detail_credential"
  | "activity_card_detail_command"
  | "activity_card_detail_secret";

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
    `I stopped at the governor limit of ${NO_PROGRESS_LOOP_THRESHOLD} consecutive `
      + "no-progress tool results. This includes successful calls when the tool and "
      + "its result stay unchanged, as well as failed or blocked calls. Try a different "
      + "approach or change the condition before retrying.",
  tool_failure_notice:
    "\n\nNote: one of the tools I used reported an error, so part of this may be"
      + " incomplete — ",
  tool_failure_notice_unnamed:
    "\n\nNote: one of the tools I used reported an error, so part of this may be"
      + " incomplete.",
  prompt_timeout:
    "The request took too long to process. Please try again with a simpler message.",
  execution_failed:
    "I couldn't complete that request because a required service failed. The request was not completed.",
  background_task_failed_notice:
    "⚠️ This background task failed, so its result may be incomplete.",
  delegation_evidence_missing:
    "I did not successfully start the requested sub-agent in this turn, so I cannot claim a new independent check. Please retry the request.",
  persistent_action_evidence_missing:
    "I did not perform or verify the requested repeated action in this turn, so I cannot report it as successful. Please retry the request.",
  destructive_action_not_verified:
    "I could not verify that anything was deleted. The command had no observable effect, so I am not treating the deletion as complete.",
  provider_requires_model:
    "I did not change the agent. The requested value names a provider, not an exact model. "
      + "Test that provider's credentials, list its available models, then retry with both "
      + "the provider and an exact model identifier.",
  agent_update_noop:
    "No configuration change was needed. This agent already uses",
  ongoing_work_evidence_missing:
    "I did not start ongoing work in this turn. A required step failed, so there "
      + "is no background task running or result still pending. Please retry the request.",
  scheduler_state_evidence_missing:
    "I did not verify the current reminder or scheduled-job state in this turn, so I cannot "
      + "say that it is set. I need to check the scheduler before confirming it.",
  completion_evidence_missing:
    "I could not verify the request as complete because one or more tool steps still failed. "
      + "Treat the result below as partial; any completion claim in it is unverified.",
  sender_authority_overclaim:
    "Your current trust does not authorize admin-only changes. I can use tools available at "
      + "your current trust level, but your approval cannot grant admin access. Installing "
      + "skills, connecting services, changing agent or system configuration, and similar "
      + "management actions require an authorized administrator and may also require runtime "
      + "approval. I cannot raise my own trust, grant myself access, disable sandboxing, or "
      + "bypass approval controls.",
  vision_unavailable:
    "I couldn't analyze this image because no vision provider is available. "
      + "Re-uploading the same image will not help until the vision configuration changes. "
      + "Settings:",
  response_locale_unavailable:
    "I couldn't produce a response in the language and writing system requested for this message. "
      + "Please retry or select a model that supports it.",
  pipeline_timeout:
    "I stopped this request because it was taking too long and hit the time limit "
      + "for a single turn. Nothing was left half-applied. If it needs many lookups, "
      + "ask for a narrower slice (fewer items, a shorter date range) and I can do the "
      + "rest in follow-ups.",
  // The pending-background notice. `{labels}` is substituted with the task list; a pack that
  // omits the token still works (the labels are appended). A positional placeholder is used
  // rather than caller-side concatenation because word order does not survive translation —
  // Hebrew is RTL and "prose: list" is not a safe universal shape.
  background_pending_running:
    "⏳ Background work is still running: {labels}. I will continue this conversation when it finishes.",
  background_pending_ready:
    "⏳ A background result is ready: {labels}. I will continue this conversation with it.",
  background_pending_updates:
    "⏳ Background work has updates pending: {labels}. I will continue this conversation as they are ready.",
  // The approval card a user must ACT on. `{operation}` is the tool call being authorized and
  // `{details}` its redacted specifics; both are identifiers, substituted verbatim, so a pack can
  // translate the surrounding words but never rename what is being approved. A template that
  // omits `{details}` drops them — nothing is appended behind the author's back. These defaults
  // are byte-identical to the English label they replace, so a deployment with no pack sees no
  // change.
  activity_card_approval_required: "approval required: {operation} — {details}",
  activity_card_detail_server: "server",
  activity_card_detail_credential: "credential",
  activity_card_detail_command: "command",
  activity_card_detail_secret: "secret",
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
          // A SCRIPT-only response locale (`und-Hebr`) has no language subtag at all —
          // `new Intl.Locale("und-Hebr").language` is `undefined` — so the fallback above cannot
          // reach an operator's `he` pack and every runtime notice fell through to English. Live:
          // a fully-Hebrew answer carried an English-only "background task failed" banner, and
          // another carried BOTH (the model wrote Hebrew, the runtime appended English).
          //
          // `maximize()` supplies the missing subtag from ICU likely-subtags data, so this stays
          // generic — no language is named here, and it works for any script (`und-Arab`→`ar`,
          // `und-Hans`→`zh`). It runs LAST, after exact and plain-language matches, because
          // maximize is a probabilistic guess (`und-Cyrl` maximizes to `ru`, not `uk`); and it can
          // only ever select an operator-supplied pack — with no pack, English still wins.
          const maximized = tryCatch(() => new Intl.Locale(canonical).maximize().language);
          if (maximized.ok) {
            const scriptFallback = canonicalPacks.get(maximized.value)?.[id];
            if (scriptFallback !== undefined) return scriptFallback;
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

/** Honest terminal reply for an execution rejection before a normal answer. */
export function selectExecutionFailureReply(
  locale: string | undefined,
  opts: { errorKind: ErrorKind; traceId?: string },
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  const incident = opts.traceId === undefined || opts.traceId.length === 0
    ? ""
    : `; incident ${opts.traceId}`;
  return `${catalog.resolve(locale, "execution_failed")} (reason: ${opts.errorKind}${incident})`;
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

/** Honest replacement when a persistent action has no current-turn tool proof. */
export function selectPersistentActionEvidenceMissingReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "persistent_action_evidence_missing");
}

/** Honest replacement when a destructive command reports no observable effect. */
export function selectDestructiveActionNotVerifiedReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "destructive_action_not_verified");
}

/** Honest replacement when a provider name was supplied as a model identifier. */
export function selectProviderRequiresModelReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "provider_requires_model");
}

/** Honest replacement when the requested agent binding already matches runtime state. */
export function selectAgentUpdateNoOpReply(
  locale: string | undefined,
  provider: string,
  modelId: string,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return `${catalog.resolve(locale, "agent_update_noop")} ${provider} / ${modelId}.`;
}

/** Honest replacement when a terminal reply promises unrecorded ongoing work. */
export function selectOngoingWorkEvidenceMissingReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "ongoing_work_evidence_missing");
}

/** Honest replacement when current scheduler state lacks a current-turn receipt. */
export function selectSchedulerStateEvidenceMissingReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "scheduler_state_evidence_missing");
}

/** Honest replacement when affirmative completion prose contradicts failed tool evidence. */
export function selectCompletionEvidenceMissingReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "completion_evidence_missing");
}

/** Honest replacement when a below-admin sender is described as the authority grantor. */
export function selectSenderAuthorityOverclaimReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "sender_authority_overclaim");
}

/** Honest replacement when image analysis reached the unavailable terminal. */
export function selectVisionUnavailableReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "vision_unavailable");
}

/** Honest replacement after the bounded locale repair still violates policy. */
export function selectResponseLocaleUnavailableReply(
  locale: string | undefined,
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "response_locale_unavailable");
}

export function selectPipelineTimeoutReply(
  locale: string | undefined,
  opts: { traceId?: string },
  catalog: LocaleCatalog = DEFAULT_LOCALE_CATALOG,
): string {
  return catalog.resolve(locale, "pipeline_timeout") + incidentRef(opts.traceId);
}
