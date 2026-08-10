// SPDX-License-Identifier: Apache-2.0
/**
 * degraded-reply — deterministic user-facing reply builder for degraded turns.
 *
 * PURE: no LLM, no I/O, no globals — same input → same output always.
 * Keyed on the named degraded endReason (output_starved / context_exhausted /
 * loop_detected).
 * Fail-closed: always returns a non-empty honest line even when partial text is empty.
 *
 * Each builder takes an optional resolved BCP-47 locale tag and delegates the
 * actual string selection to
 * `degraded-reply-i18n.ts` — the single source of the phrase strings. With no
 * `language` (or "en") the canonical English reply is returned byte-identical:
 * the i18n `en` row IS today's literals, so there is no duplicate and no
 * drift. Raw configuration paths stay internal; the incident ref and warning
 * marker stay verbatim across languages.
 *
 * @module
 */

import type { ContextExhaustionCause } from "../context-engine/errors.js";
import type { ErrorKind } from "@comis/core";
import {
  selectOutputStarvedAnnotation,
  selectContextExhaustedReply,
  selectLoopDetectedReply,
  selectPipelineTimeoutReply,
  selectToolFailureNotice,
  selectToolFailureNoticeUnnamed,
  selectPromptTimeoutReply,
  selectExecutionFailureReply,
  selectBackgroundTaskFailedNotice,
  selectDelegationEvidenceMissingReply,
  selectPersistentActionEvidenceMissingReply,
  selectOutboundAudioEvidenceMissingReply,
  selectDestructiveActionNotVerifiedReply,
  selectProviderRequiresModelReply,
  selectAgentUpdateNoOpReply,
  selectOngoingWorkEvidenceMissingReply,
  selectRuntimeSelfReportEvidenceMissingReply,
  selectSchedulerStateEvidenceMissingReply,
  selectPendingSchedulerConfirmationReply,
  selectCompletionEvidenceMissingReply,
  selectSenderAuthorityOverclaimReply,
  selectVisionUnavailableReply,
  selectResponseLocaleUnavailableReply,
  type LocaleCatalog,
} from "./degraded-reply-i18n.js";

export { catalogFromLocalePacks, LOCALE_MESSAGE_IDS } from "./degraded-reply-i18n.js";
export type { LocaleCatalog, LocaleMessageId, LocalePack } from "./degraded-reply-i18n.js";

// CAP_KNOB_BY_CLASS lives in degraded-reply-i18n.ts as an internal diagnostic
// mapping. Re-exported here for callers that need to associate capability
// classes with operator settings; user-facing replies do not interpolate it.
export { CAP_KNOB_BY_CLASS } from "./degraded-reply-i18n.js";

/** Optional context for the synthesized context-exhausted reply. */
export interface ContextExhaustedReplyOpts {
  /** The model's capability class, used to select profile-aware recovery advice. */
  capabilityClass?: string;
  /** The turn's traceId — appended as an incident ref so the operator (or an LLM
   *  agent) can run `comis explain <traceId>` directly from the chat message. */
  traceId?: string;
  /** Why the fit failed — branches the advice so it names the remedy
   *  that actually applies. Omitted/aggregate → the default reply. */
  cause?: ContextExhaustionCause;
  /** The resolved response locale. Missing packs fall back to English. */
  language?: string;
  /** Application-injected deterministic locale strings. */
  localeCatalog?: LocaleCatalog;
}

/**
 * Returns the annotation string to APPEND for an output_starved turn.
 * Starts with "\n\n⚠️ " so appending to partial text is visually separated.
 * Localized when the injected catalog contains a matching locale pack.
 */
export function buildOutputStarvedAnnotation(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectOutputStarvedAnnotation(language, localeCatalog);
}

/**
 * Returns the synthesized honest reply to REPLACE result.response for a
 * context_exhausted turn (the model never ran; the prior content was either
 * a canned placeholder or the operator-facing redirect). Still PURE —
 * same opts → same string. With no opts the canonical English reply is
 * returned byte-identical.
 */
export function buildContextExhaustedReply(opts?: ContextExhaustedReplyOpts): string {
  return selectContextExhaustedReply(opts?.language, {
    capabilityClass: opts?.capabilityClass,
    traceId: opts?.traceId,
    cause: opts?.cause,
  }, opts?.localeCatalog);
}

/**
 * Top-level dispatcher: returns the annotation (output_starved) or synthesized
 * reply (context_exhausted / loop_detected). Returns undefined for any other
 * endReason so that healthy turns are strict no-ops. Forwards the resolved
 * `language` tag to each builder.
 */
export function buildDegradedReply(
  endReason: string,
  opts?: ContextExhaustedReplyOpts,
): string | undefined {
  if (endReason === "output_starved") {
    return buildOutputStarvedAnnotation(opts?.language, opts?.localeCatalog);
  }
  if (endReason === "context_exhausted") return buildContextExhaustedReply(opts);
  if (endReason === "loop_detected") return buildLoopDetectedReply(opts);
  return undefined;
}

/**
 * Honest reply for a turn the loop-guard stopped: the model kept repeating
 * an action that made no progress (most often a tool that kept failing or was
 * blocked) and was halted before it could run to the makespan ceiling. Used as an
 * APPEND when partial text exists, or a REPLACE when the turn produced no usable
 * text (a pure tool-loop). PURE: same opts → same string.
 */
export function buildLoopDetectedReply(opts?: ContextExhaustedReplyOpts): string {
  return selectLoopDetectedReply(opts?.language, {
    traceId: opts?.traceId,
  }, opts?.localeCatalog);
}

/**
 * Honest reply for a turn the execution wall-clock ceiling killed
 * (`executionTimeoutMs`). REPLACES the response — a pipeline timeout means the
 * model never returned, so there is nothing partial to annotate.
 *
 * This exists so the timeout reply is a MEMBER of the localizable platform-reply
 * set. It used to be a literal at the send site in the orchestrator, which put
 * the one message a stuck turn is guaranteed to produce outside the only
 * mechanism that can translate it. PURE: same opts → same string.
 */
export function buildPipelineTimeoutReply(opts?: ContextExhaustedReplyOpts): string {
  return selectPipelineTimeoutReply(opts?.language, {
    traceId: opts?.traceId,
  }, opts?.localeCatalog);
}

/**
 * Localized notice that a tool failed, for appending to a reply that did not
 * itself mention the failure. The caller appends the tool name verbatim.
 */
export function buildToolFailureNotice(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectToolFailureNotice(language, localeCatalog);
}

/**
 * Localized tool-failure notice for the case with no nameable culprit. Reads as
 * a complete sentence — the named variant deliberately ends in an em-dash so the
 * caller can append the tool name.
 */
export function buildToolFailureNoticeUnnamed(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectToolFailureNoticeUnnamed(language, localeCatalog);
}

/**
 * Localized reply for a turn killed by the stall budget or the whole-turn retry
 * timeout. PURE: same input -> same string.
 */
export function buildPromptTimeoutReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectPromptTimeoutReply(language, localeCatalog);
}

/** Localized reason-coded reply for a turn that rejected before normal output. */
export function buildExecutionFailureReply(
  opts: {
    errorKind: ErrorKind;
    traceId?: string;
    language?: string;
    localeCatalog?: LocaleCatalog;
  },
): string {
  return selectExecutionFailureReply(opts.language, {
    errorKind: opts.errorKind,
    traceId: opts.traceId,
  }, opts.localeCatalog);
}

/**
 * Localized deterministic disclosure appended after a model rewrites a failed
 * background-task result. The terminal state is runtime-owned and cannot be
 * suppressed or softened by the rewrite.
 */
export function buildBackgroundTaskFailedNotice(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectBackgroundTaskFailedNotice(language, localeCatalog);
}

/** Honest replacement when requested delegation lacks current-turn spawn proof. */
export function buildDelegationEvidenceMissingReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectDelegationEvidenceMissingReply(language, localeCatalog);
}

/** Honest replacement when a persistent action lacks current-turn tool proof. */
export function buildPersistentActionEvidenceMissingReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectPersistentActionEvidenceMissingReply(language, localeCatalog);
}

/** Honest replacement when requested audio lacks current-turn delivery proof. */
export function buildOutboundAudioEvidenceMissingReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectOutboundAudioEvidenceMissingReply(language, localeCatalog);
}

/** Honest replacement when a destructive command had no observable effect. */
export function buildDestructiveActionNotVerifiedReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectDestructiveActionNotVerifiedReply(language, localeCatalog);
}

/** Honest replacement when a provider name was supplied as a model identifier. */
export function buildProviderRequiresModelReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectProviderRequiresModelReply(language, localeCatalog);
}

/** Honest replacement when the requested agent binding already matches runtime state. */
export function buildAgentUpdateNoOpReply(
  language: string | undefined,
  provider: string,
  modelId: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectAgentUpdateNoOpReply(language, provider, modelId, localeCatalog);
}

/** Honest replacement when no runtime receipt supports continued-work prose. */
export function buildOngoingWorkEvidenceMissingReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectOngoingWorkEvidenceMissingReply(language, localeCatalog);
}

/** Honest replacement when runtime self-report evidence is unavailable. */
export function buildRuntimeSelfReportEvidenceMissingReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectRuntimeSelfReportEvidenceMissingReply(language, localeCatalog);
}

/** Honest replacement when no current scheduler receipt supports a state claim. */
export function buildSchedulerStateEvidenceMissingReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectSchedulerStateEvidenceMissingReply(language, localeCatalog);
}

/** Neutral confirmation request after a gated scheduler removal stops before mutation. */
export function buildPendingSchedulerConfirmationReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectPendingSchedulerConfirmationReply(language, localeCatalog);
}

/** Honest replacement when unrecovered tool evidence contradicts a completion claim. */
export function buildCompletionEvidenceMissingReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectCompletionEvidenceMissingReply(language, localeCatalog);
}

/** Honest replacement when the model assigns admin authority to a below-admin sender. */
export function buildSenderAuthorityOverclaimReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectSenderAuthorityOverclaimReply(language, localeCatalog);
}

/** Honest replacement after the bounded locale repair still violates policy. */
export function buildResponseLocaleUnavailableReply(
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return selectResponseLocaleUnavailableReply(language, localeCatalog);
}

interface VisionFailureRecord {
  readonly toolName: string;
  readonly success: boolean;
  readonly errorText?: string;
}

/**
 * Identify the actionable image-analysis terminal emitted when neither the
 * active model nor the configured vision registry can serve the request.
 *
 * All four signatures are required so an attachment-resolution error or an
 * ordinary provider failure cannot trigger the deterministic replacement.
 */
export function hasUnavailableVisionFailure(
  records?: ReadonlyArray<VisionFailureRecord>,
): boolean {
  return records?.some((record) => {
    const errorText = record.errorText;
    return record.toolName === "image_analyze"
      && !record.success
      && errorText !== undefined
      && errorText.includes("No vision provider available for image analysis.")
      && errorText.includes("integrations.media.vision.providers")
      && errorText.includes("integrations.media.vision.defaultProvider")
      && errorText.includes("Re-uploading will not help until that configuration changes.");
  }) ?? false;
}

type UnknownRecord = Record<string, unknown>;

interface RecordedToolCall {
  readonly index: number;
  readonly name: string;
  readonly arguments: unknown;
}

interface UnavailableVisionAttempt {
  readonly resultIndex: number;
  readonly source: string;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null
    ? value as UnknownRecord
    : undefined;
}

function resultText(message: UnknownRecord): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function resultEvidence(message: UnknownRecord): string {
  const details = asRecord(message.details);
  if (typeof details?.stdout === "string" && details.stdout.trim().length > 0) {
    return details.stdout;
  }
  return resultText(message);
}

function sourceFromVisionArguments(value: unknown): string | undefined {
  const args = asRecord(value);
  if (args === undefined) return undefined;
  const source = args.source;
  if (typeof source === "string" && source.trim().length > 0) {
    return source;
  }
  const attachmentUrl = args.attachment_url;
  if (typeof attachmentUrl === "string" && attachmentUrl.trim().length > 0) {
    return attachmentUrl;
  }
  return undefined;
}

function containsSource(value: unknown, source: string, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") return value.includes(source);
  if (Array.isArray(value)) {
    return value.some((entry) => containsSource(entry, source, depth + 1));
  }
  const record = asRecord(value);
  return record !== undefined
    && Object.values(record).some((entry) => containsSource(entry, source, depth + 1));
}

function evidenceTokens(text: string): Set<string> {
  const matches = text
    .slice(0, 20_000)
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(matches.filter((token) => token.length >= 2));
}

function evidenceGroundsResponse(evidence: string, response: string): boolean {
  const evidenceSet = evidenceTokens(evidence);
  const responseSet = evidenceTokens(response);
  if (evidenceSet.size < 4 || responseSet.size < 4) return false;
  let overlap = 0;
  for (const token of evidenceSet) {
    if (responseSet.has(token)) overlap += 1;
  }
  return overlap >= 4
    && overlap / Math.min(evidenceSet.size, responseSet.size) >= 0.5;
}

function collectToolCalls(messages: ReadonlyArray<unknown>): Map<string, RecordedToolCall> {
  const calls = new Map<string, RecordedToolCall>();
  for (const [index, entry] of messages.entries()) {
    const message = asRecord(entry);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      const block = asRecord(item);
      if (
        block?.type !== "toolCall"
        || typeof block.id !== "string"
        || typeof block.name !== "string"
      ) {
        continue;
      }
      calls.set(block.id, {
        index,
        name: block.name,
        arguments: block.arguments,
      });
    }
  }
  return calls;
}

function latestUnavailableVisionAttempt(
  messages: ReadonlyArray<unknown>,
  calls: ReadonlyMap<string, RecordedToolCall>,
): UnavailableVisionAttempt | undefined {
  let latest: UnavailableVisionAttempt | undefined;
  for (const [index, entry] of messages.entries()) {
    const message = asRecord(entry);
    if (
      message?.role !== "toolResult"
      || message.toolName !== "image_analyze"
      || message.isError !== true
      || typeof message.toolCallId !== "string"
    ) {
      continue;
    }
    const call = calls.get(message.toolCallId);
    const source = call?.name === "image_analyze"
      ? sourceFromVisionArguments(call.arguments)
      : undefined;
    if (
      source !== undefined
      && hasUnavailableVisionFailure([{
        toolName: "image_analyze",
        success: false,
        errorText: resultText(message),
      }])
    ) {
      latest = { resultIndex: index, source };
    }
  }
  return latest;
}

/**
 * Return the later tool that grounded a response after configured image
 * analysis was unavailable. The proof is deliberately conservative: the tool
 * must run after the failure, consume the exact same source, succeed, and
 * produce evidence with substantial token overlap against the final response.
 */
export function groundedVisionFallbackTool(
  response: string,
  messages: ReadonlyArray<unknown>,
): string | undefined {
  const calls = collectToolCalls(messages);
  const attempt = latestUnavailableVisionAttempt(messages, calls);
  if (attempt === undefined || response.trim().length === 0) return undefined;

  for (const [index, entry] of messages.entries()) {
    if (index <= attempt.resultIndex) continue;
    const message = asRecord(entry);
    if (
      message?.role !== "toolResult"
      || message.isError !== false
      || typeof message.toolCallId !== "string"
      || typeof message.toolName !== "string"
    ) {
      continue;
    }
    const call = calls.get(message.toolCallId);
    if (
      call === undefined
      || call.index <= attempt.resultIndex
      || call.name !== message.toolName
      || !containsSource(call.arguments, attempt.source)
    ) {
      continue;
    }
    const details = asRecord(message.details);
    if (typeof details?.exitCode === "number" && details.exitCode !== 0) continue;
    if (evidenceGroundsResponse(resultEvidence(message), response)) {
      return call.name;
    }
  }
  return undefined;
}

/**
 * Replace model-authored recovery advice with the runtime-owned capability
 * truth. Configuration identifiers remain verbatim across locales.
 */
export function buildVisionUnavailableReply(
  agentId: string,
  language?: string,
  localeCatalog?: LocaleCatalog,
): string {
  return `${selectVisionUnavailableReply(language, localeCatalog)} `
    + `agents.${agentId}.model, integrations.media.vision.providers, `
    + "integrations.media.vision.defaultProvider.";
}
