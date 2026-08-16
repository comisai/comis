// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent result processor module.
 * Contains helper functions for processing sub-agent execution results:
 * - Abort reason classification
 * - Announcement message building and delivery
 * - Output validation
 * - Result file sweeping
 * - Failure record persistence
 * Extracted from sub-agent-runner.ts to separate result processing concerns
 * from spawn lifecycle management.
 * @module
 */

import type { RootRunIdResolver } from "@comis/core";
import { resolveReservationRoot } from "./reservation-root.js";
import { promptTimeoutHint, type AbortEvidence } from "./abort-fallout.js";
import {
  conversationScopeToSessionKey,
  createStableAnnouncementOperationId,
  safePath,
  systemNowMs,
  systemNowDate,
  systemScheduleTimeout,
  toSafeErrorLogString,
  scrubSecretsFromText,
  type DeliveryOrigin,
  type ChannelEndpoint,
  type ConversationLocator,
  type AnnouncementParentDecisionReservation,
} from "@comis/core";
import { fromPromise, TimeoutError, withTimeout } from "@comis/shared";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AnnouncementBatcher,
  AnnouncementDeadLetterQueue,
  CompletionAttachmentShape,
  SendGovernedCompletionAnnouncement,
} from "./announcement-ports.js";
import { createCompletionAnnouncementOperationPlan } from "./completion-announcement-operations.js";
import { buildAnnounceKey, type DeliveryDedup } from "./announce-key.js";
import { ANNOUNCE_PARENT_TIMEOUT_MS, type SubAgentRunnerDeps, type SubAgentRunnerLogger } from "./sub-agent-runner.js";
import {
  buildAnnouncementRewriteInput,
  enforceAnnouncementTerminalOutcome,
  stripAnnouncementInstruction,
  type AbortClassification,
  type AnnouncementTerminalOutcome,
} from "./sub-agent-announcement-content.js";
import { NO_PROGRESS_LOOP_THRESHOLD } from "../executor/turn-loop-detector.js";
import { classifyErrorContext } from "./sub-agent-error-classification.js";
export {
  buildAnnouncementMessage,
  validateOutputs,
} from "./sub-agent-announcement-content.js";
export type { AbortClassification, ValidationResult } from "./sub-agent-announcement-content.js";
export { classifyErrorContext } from "./sub-agent-error-classification.js";

// ---------------------------------------------------------------------------
// Abort classification
// ---------------------------------------------------------------------------

/**
 * Is this finish reason an ABORT, or a completion/hand-off that merely isn't `stop`?
 *
 * The runner previously classified an abort whenever `finishReason` was neither `stop` nor
 * `end_turn`. Two legitimate outcomes fail that test and were therefore reported as aborts:
 *
 * - `completed_with_tool_errors` — a first-class **completed** outcome. `SystemHealthReport`
 *   documents it as *degraded-but-finished* ("Of `degraded`, how many finished
 *   `completed_with_tool_errors`"), and `classifyAgentFinishErrorKind` maps it to
 *   `undefined` — i.e. no error at all.
 * - `background_pending` — the turn handed work off and finished; the work continues.
 *
 * Live consequence of getting this wrong: a fully-grounded report reached the user stamped
 * `⚠️ This background task failed`, while the operator saw `errorKind: "resource"` — a
 * capacity-shaped verdict — for a turn that had no resource problem. It affected 12 turns in a
 * single window.
 *
 * Unknown reasons are treated as aborts (fail-closed): a new terminal state should surface for
 * investigation rather than pass silently as a success.
 *
 * @param finishReason The `finishReason` from the execution result.
 * @returns true when the reason represents an actual abort worth classifying.
 */
export function isSubAgentAbortFinishReason(finishReason: string): boolean {
  switch (finishReason) {
    case "stop":
    case "end_turn":
    case "completed_with_tool_errors":
    case "background_pending":
      return false;
    default:
      return true;
  }
}

/**
 * Classify a sub-agent abort reason from finishReason and optional error context.
 * Maps supported finish reasons to specific abort categories with remediation
 * hints and severity levels. Normal completions (stop, end_turn) are not
 * expected inputs but are handled gracefully as "unknown".
 * @param finishReason - The finishReason from ExecutionResult or error context
 * @param errorMessage - Optional error message for pattern matching (error finishReason)
 * @param errorCause - Optional error.cause message for deeper stack trace investigation
 * @param evidence - Delegation state; branches the prompt_timeout hint (abort-fallout.ts) */
export function classifyAbortReason(
  finishReason: string,
  errorMessage?: string,
  errorCause?: string,
  evidence?: AbortEvidence,
): AbortClassification {
  switch (finishReason) {
    case "max_steps":
      return {
        category: "step_limit",
        hint: evidence?.stepLimit === undefined
          ? "Inspect comis explain <runId> for the binding max_steps limit, then increase that exact knob or simplify the task"
          : `Increase ${evidence.stepLimit.bindingKnob} above ${String(evidence.stepLimit.cap)}, or simplify the task`,
        severity: "actionable",
      };
    case "loop_detected":
      return {
        category: "loop_limit",
        hint:
          `The governor stopped after ${NO_PROGRESS_LOOP_THRESHOLD} consecutive no-progress `
          + "tool results, including successful calls whose result stayed unchanged; change "
          + "the condition or approach before retrying",
        severity: "actionable",
      };
    case "budget_exceeded":
      return {
        category: "budget",
        hint: "Increase token budget or reduce task scope",
        severity: "actionable",
      };
    case "spend_exceeded":
      // The dollars kill-switch abort. Reuses the existing
      // budget category with the actionable observability.spend.* hint emitSpendAbort
      // (bridge-safety-controls.ts) already uses — NOT the default "check daemon
      // logs" catch-all (a wrong-way, non-actionable pointer for a spend-killed
      // sub-agent).
      return {
        category: "budget",
        hint: "Spend ceiling exceeded; raise observability.spend.* (perAgentUsd / perTenantUsd / daemonGlobalUsd) or set observability.spend.action:'warn'",
        severity: "actionable",
      };
    case "context_loop":
    case "context_exhausted":
      return {
        category: "context_full",
        hint: "Enable compaction, reduce context, or split into smaller tasks",
        severity: "actionable",
      };
    case "circuit_open":
      return {
        category: "external_timeout",
        hint: "Circuit breaker opened due to repeated provider failures; wait and retry",
        severity: "investigate",
      };
    case "prompt_timeout":
      return {
        category: "prompt_timeout",
        hint: promptTimeoutHint(evidence),
        severity: "actionable",
      };
    case "provider_degraded":
      return {
        category: "provider_degraded",
        hint: "Provider is degraded across multiple agents; execution skipped to avoid empty response",
        severity: "investigate",
      };
    case "error": {
      // Investigate error message and cause for specific abort patterns
      const messagesToCheck = [errorMessage, errorCause].filter(Boolean) as string[];
      for (const msg of messagesToCheck) {
        if (msg.includes("Request was aborted")) {
          return {
            category: "external_timeout",
            hint: "External API timed out; check provider status and network connectivity",
            severity: "investigate",
          };
        }
        if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
          return {
            category: "external_timeout",
            hint: "Network timeout detected; check provider connectivity",
            severity: "investigate",
          };
        }
      }
      return {
        category: "unknown",
        hint: "Check daemon logs for full error stack trace",
        severity: "investigate",
      };
    }
    default:
      return {
        category: "unknown",
        hint: "Unexpected finish reason; check daemon logs",
        severity: "investigate",
      };
  }
}

// ---------------------------------------------------------------------------
// Disk sweep for expired result files
// ---------------------------------------------------------------------------

/**
 * Sweep expired result files from the subagent-results directory.
 * Follows the TTL cleanup pattern from media-handlers.ts.
 * Non-fatal: all errors are caught and logged.
 */
export async function sweepResultFiles(
  dataDir: string,
  retentionMs: number,
  _logger?: SubAgentRunnerLogger,
): Promise<void> {
  const resultsDir = safePath(dataDir, "subagent-results");
  const cutoff = systemNowMs() - retentionMs;

  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(resultsDir);
  } catch {
    // Directory may not exist yet (no subagents have run)
    return;
  }

  for (const sessionDir of sessionDirs) {
    try {
      const sessionPath = safePath(resultsDir, sessionDir);
      const sessionStat = await stat(sessionPath);
      if (!sessionStat.isDirectory()) continue;

      const files = await readdir(sessionPath);
      let removedCount = 0;

      for (const file of files) {
        try {
          const filePath = safePath(sessionPath, file);
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoff) {
            await unlink(filePath);
            removedCount++;
          }
        } catch {
          // Individual file cleanup failure is non-fatal
        }
      }

      // Remove empty session directory after sweeping its files
      if (removedCount > 0) {
        try {
          const remaining = await readdir(sessionPath);
          if (remaining.length === 0) {
            await rm(sessionPath, { recursive: true });
          }
        } catch {
          // Empty dir cleanup failure is non-fatal
        }
      }
    } catch {
      // Per-session-dir failure is non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Failure record persistence
// ---------------------------------------------------------------------------

/**
 * Persist a minimal failure record to disk for killed/failed subagent runs.
 * Belt-defense: wrapped in try/catch so it never blocks the failure/kill flow.
 * The JSON structure includes a `status: "failed"` field to distinguish from
 * success records written by the result condenser.
 */
export async function persistFailureRecord(params: {
  dataDir: string;
  sessionKey: string;
  runId: string;
  task: string;
  error: string;
  endReason: "failed" | "killed" | "watchdog_timeout" | "ghost_sweep";
  runtimeMs: number;
  // Structured error context for offline analysis
  /** Parent execution traceId for cross-session correlation. */
  parentTraceId?: string;
  /** Token/cost usage consumed before failure. */
  usage?: { totalTokens: number; costUsd: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheSavedUsd?: number };
  /** Who initiated a kill (endReason "killed") — a health-monitor kill must
   *  not read as a parent kill on the record the parent later polls. */
  killedBy?: "parent" | "health_monitor" | "operator" | "system";
}, logger?: SubAgentRunnerLogger): Promise<void> {
  try {
    const sanitizedKey = params.sessionKey.replace(/:/g, "_");
    const diskPath = safePath(params.dataDir, "subagent-results", sanitizedKey, `${params.runId}.json`);
    // fs-safe-allowed: sub-agent error-spill dir (`<dataDir>/subagent-results/<key>/`); follow-up plan should migrate to ensureContainedDir + writeRegularFile
    await mkdir(dirname(diskPath), { recursive: true });

    // Classify error for structured context (killedBy keeps the structured
    // errorType consistent with the attributed error string).
    const errorContext = classifyErrorContext(params.error, params.endReason, params.killedBy);

    // fs-safe-allowed: sub-agent error-spill writer (`<dataDir>/subagent-results/...`); follow-up plan should migrate to writeRegularFile
    await writeFile(
      diskPath,
      JSON.stringify({
        runId: params.runId,
        sessionKey: params.sessionKey,
        task: params.task,
        status: "failed",
        error: params.error,
        endReason: params.endReason,
        failedAt: systemNowDate().toISOString(),
        runtimeMs: params.runtimeMs,
        // Structured error context
        errorContext,
        // Kill attribution (endReason "killed" only)
        ...(params.killedBy ? { killedBy: params.killedBy } : {}),
        // Parent trace correlation (shared with success records)
        ...(params.parentTraceId ? { parentTraceId: params.parentTraceId } : {}),
        ...(params.usage ? { usage: params.usage } : {}),
      }, null, 2),
    );
  } catch (persistErr) {
    logger?.warn({
      runId: params.runId,
      err: persistErr,
      hint: "Failed to persist failure record to disk; diagnostics will be lost on restart",
      errorKind: "internal" as const,
    }, "Failure record persistence failed");
  }
}

// ---------------------------------------------------------------------------
// Announcement delivery helper
// ---------------------------------------------------------------------------

/** Preserve a topic only when it belongs to the selected announcement route. */
export function resolveAnnouncementThreadId(
  origin: DeliveryOrigin | undefined,
  channelType: string | undefined,
  channelId: string | undefined,
): string | undefined {
  return origin !== undefined
    && origin.channelType === channelType
    && origin.channelId === channelId
    ? origin.threadId
    : undefined;
}

/**
 * Deliver a sub-agent announcement through durable batching or a text-only
 * parent rewrite followed by one governed platform operation.
 * Errors during delivery are logged as warnings but never thrown -- a
 * delivery failure must not affect the sub-agent run status.
 */
export async function deliverAnnouncement(params: {
  announcementText: string;
  announceChannelType: string;
  announceChannelId: string;
  announceThreadId?: string;
  callerAgentId?: string;
  callerSessionKey?: string;
  callerConversation?: ConversationLocator;
  destinationEndpoint?: ChannelEndpoint;
  resolvedLanguage?: string;
  citationEvidence?: import("@comis/core").CitationEvidence;
  terminalOutcome: AnnouncementTerminalOutcome;
  /** Preserve an intentional child silent-control response through parent delivery. */
  suppressText?: boolean;
  runId: string;
  attachments?: CompletionAttachmentShape[];
}, deps: {
  announceToParent?: SubAgentRunnerDeps["announceToParent"];
  sendToChannel: SubAgentRunnerDeps["sendToChannel"];
  logger?: SubAgentRunnerLogger;
  batcher?: AnnouncementBatcher;
  deadLetterQueue?: AnnouncementDeadLetterQueue;
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
  /**
   * Shared, bounded delivered-key store. When the batcher is absent the
   * batcher cannot mark the key, so the non-batcher success branches mark this
   * sink instead — keeping the failure-path dedup (`deliverFailureNotification`)
   * correct whether or not a batcher is wired. The daemon wiring injects the
   * SAME instance the batcher uses.
   */
  deliveryDedup?: DeliveryDedup;
  /** Resolves the outward-ledger tree root for a caller turn. Stamped onto the
   *  parked decision reservation so a drain can later ask the ledger whether the
   *  announcement was ever actually sent, instead of parking it forever. */
  resolveRootRunId?: RootRunIdResolver;
}): Promise<void> {
  const { announceChannelType, announceChannelId, callerAgentId, callerSessionKey, runId } = params;

  // Build the idempotency key ONCE here via the shared
  // helper (single source of truth — the failure path uses the same builder),
  // then thread it as data through the batcher and the dead-letter entry; never
  // reconstruct it downstream. Undefined for a top-level spawn (no callerSessionKey).
  const announceKey = buildAnnounceKey(callerSessionKey, runId);

  // Scrub announcement text before any delivery path (batcher, parent, or direct channel).
  const announceScrub = scrubSecretsFromText(params.announcementText);
  if (announceScrub.redactions > 0) {
    deps.logger?.warn(
      { runId, redactions: announceScrub.redactions,
        hint: "Secret found in sub-agent announcement — redacted before relay",
        errorKind: "internal" as const },
      "Egress guard: announcement scrubbed",
    );
  }
  const announcementText = announceScrub.redactions > 0 ? announceScrub.text : params.announcementText;

  if (
    deps.sendGovernedAnnouncement
    && (!callerAgentId || !callerSessionKey || !params.callerConversation || !params.destinationEndpoint)
  ) {
    deps.logger?.warn({
      runId,
      channelType: announceChannelType,
      hint: "Bind the completion to its authenticated caller conversation and endpoint before delivery",
      errorKind: "precondition" as const,
    }, "Governed completion announcement has no delivery authority");
    return;
  }

  // Route through batcher for coalesced delivery when available
  if (deps.batcher && callerAgentId && callerSessionKey && params.callerConversation && params.destinationEndpoint) {
    const enqueued = await deps.batcher.enqueue({
      announcementText,
      announceChannelType,
      announceChannelId,
      announceThreadId: params.announceThreadId,
      callerAgentId,
      callerSessionKey,
      callerConversation: params.callerConversation,
      destinationEndpoint: params.destinationEndpoint,
      ...(params.resolvedLanguage ? { resolvedLanguage: params.resolvedLanguage } : {}),
      ...(params.citationEvidence ? { citationEvidence: params.citationEvidence } : {}),
      terminalOutcome: params.terminalOutcome,
      ...(params.suppressText ? { suppressText: true } : {}),
      runId,
      idempotencyKey: announceKey, reservationRootRunId: resolveReservationRoot(deps.resolveRootRunId, callerAgentId, params.callerConversation.conversationScope),
      ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    });
    if (!enqueued?.ok) {
      deps.logger?.warn(
        {
          runId,
          errorKind: "resource" as const,
          hint: "Restore durable announcement admission before retrying the retained completion",
        },
        "Sub-agent announcement was not admitted for batching",
      );
      return;
    }
    if (enqueued.value === "retained") {
      deps.logger?.debug(
        { runId, channelType: announceChannelType },
        "Sub-agent announcement is already durably retained",
      );
      return;
    }
    deps.logger?.debug({ runId, channelType: announceChannelType }, "Sub-agent announcement queued for batching");
    return;
  }

  let finalText = params.suppressText ? "" : stripAnnouncementInstruction(announcementText);
  let decisionReserved = false;

  async function resolveDecisionKey(
    decisionKey: string,
    outcome: "receipt_committed" | "no_reply",
  ): Promise<void> {
    if (!deps.deadLetterQueue) return;
    const boundary = await fromPromise(deps.deadLetterQueue.resolveDecision(decisionKey, outcome));
    if (boundary.ok && boundary.value.ok) return;
    deps.logger?.warn({
      runId,
      hint: "Repair decision-quarantine storage; the retained row safely suppresses replay",
      errorKind: "resource" as const,
    }, "Sub-agent parent decision reservation could not be resolved");
  }

  async function resolveDecision(outcome: "receipt_committed" | "no_reply"): Promise<void> {
    if (!decisionReserved || !announceKey || !deps.deadLetterQueue) return;
    await resolveDecisionKey(announceKey, outcome);
  }

  // Parent execution produces text only. The single irreversible send remains
  // below this branch so a rewritten response cannot bypass the outward ledger.
  if (
    !params.suppressText
    && deps.announceToParent
    && callerAgentId
    && callerSessionKey
    && params.callerConversation
  ) {
    if (deps.sendGovernedAnnouncement) {
      if (!announceKey || !deps.deadLetterQueue) {
        deps.logger?.warn({
          runId,
          hint: "Wire durable keyed decision reservations before governed parent rewriting",
          errorKind: "precondition" as const,
        }, "Sub-agent parent decision cannot be reserved");
        return;
      }
      // Stamp the ledger tree root; a reservation without it can never be adjudicated.
      const reservationRoot = resolveReservationRoot(deps.resolveRootRunId, callerAgentId, params.callerConversation?.conversationScope);
      if (!reservationRoot) {
        deps.logger?.warn({
          runId,
          hint: "Resolve a non-empty outward ledger root for the caller conversation before governed parent rewriting",
          errorKind: "precondition" as const,
        }, "Sub-agent parent decision has no adjudicable ledger root");
        return;
      }
      const destinationEndpoint = params.destinationEndpoint;
      if (!destinationEndpoint) {
        deps.logger?.warn({
          runId,
          hint: "Bind the completion to its authenticated destination before reserving its parent decision",
          errorKind: "precondition" as const,
        }, "Sub-agent parent decision has no recovery endpoint");
        return;
      }
      const reservationBoundary = await fromPromise(deps.deadLetterQueue.reserveDecision({
        idempotencyKey: announceKey,
        agentId: callerAgentId,
        runId,
        sessionKey: callerSessionKey,
        announcementText,
        channelType: announceChannelType,
        channelId: announceChannelId,
        failedAt: systemNowMs(),
        rootRunId: reservationRoot,
        deliveryAuthority: {
          tenantId: params.callerConversation.conversationScope.tenantId,
          agentId: callerAgentId,
          conversationRef: params.callerConversation.conversationRef,
        },
        destinationEndpoint,
        completionKeys: [announceKey],
        ...(params.announceThreadId ? { threadId: params.announceThreadId } : {}),
      }));
      if (!reservationBoundary.ok || !reservationBoundary.value.ok) {
        deps.logger?.warn({
          runId,
          hint: "Restore decision-quarantine storage before retrying the same completion",
          errorKind: "resource" as const,
        }, "Sub-agent parent decision reservation failed");
        return;
      }
      if (!reservationBoundary.value.value.created) {
        deps.logger?.debug({ runId }, "Sub-agent parent decision is already durably retained");
        return;
      }
      decisionReserved = true;
    }
    try {
      const parentSk = conversationScopeToSessionKey(params.callerConversation.conversationScope);
      if (!parentSk.ok) throw parentSk.error;
      const parentOptions = params.announceThreadId || params.resolvedLanguage || params.citationEvidence
        ? {
            ...(params.announceThreadId ? { threadId: params.announceThreadId } : {}),
            ...(params.resolvedLanguage ? { resolvedLanguage: params.resolvedLanguage } : {}),
            ...(params.citationEvidence ? { citationEvidence: params.citationEvidence } : {}),
          }
        : undefined;
      const candidate = await withTimeout(
        deps.announceToParent(
          callerAgentId,
          parentSk.value,
          params.callerConversation,
          buildAnnouncementRewriteInput(announcementText, params.terminalOutcome),
          announceChannelType,
          announceChannelId,
          parentOptions,
        ),
        ANNOUNCE_PARENT_TIMEOUT_MS,
        systemScheduleTimeout,
        "announceToParent",
      );
      if (candidate === undefined) {
        if (params.terminalOutcome.status === "completed" && !params.attachments?.length) {
          await resolveDecision("no_reply");
          if (announceKey) deps.deliveryDedup?.mark(announceKey);
          deps.logger?.debug(
            { runId, channelType: announceChannelType },
            "Parent intentionally suppressed the sub-agent announcement",
          );
          return;
        }
        finalText = "";
      } else {
        const candidateScrub = scrubSecretsFromText(candidate);
        if (candidateScrub.redactions > 0) {
          deps.logger?.warn(
            {
              runId,
              redactions: candidateScrub.redactions,
              hint: "Secret found in rewritten announcement — redacted before delivery",
              errorKind: "internal" as const,
            },
            "Egress guard: rewritten announcement scrubbed",
          );
        }
        finalText = candidateScrub.text;
      }
    } catch (announceErr) {
      deps.logger?.warn({
        runId,
        hint: "Inspect the quarantined parent decision before deciding whether to retry",
        errorKind: announceErr instanceof TimeoutError ? "timeout" as const : "internal" as const,
        err: toSafeErrorLogString(announceErr),
      }, "Sub-agent parent announcement ended without a safe delivery decision");
      return;
    }
  }

  if (params.suppressText && !params.attachments?.length) {
    if (announceKey) deps.deliveryDedup?.mark(announceKey);
    return;
  }

  const disclosure = enforceAnnouncementTerminalOutcome(finalText, params.terminalOutcome);
  finalText = disclosure.text ?? "";
  if (disclosure.corrected && deps.announceToParent) {
    deps.logger?.warn({
      runId,
      step: "completion-honesty",
      hint: "Inspect the parent announcement rewrite; the runtime appended the authoritative terminal disclosure",
      errorKind: "validation" as const,
    }, "Background-task terminal disclosure omitted by parent rewrite");
  }

  const threadId = params.announceThreadId;
  let delivered: boolean;
  let lastError = "direct channel send failed";

  if (
    deps.sendGovernedAnnouncement
    && callerAgentId
    && callerSessionKey
    && params.callerConversation
    && params.destinationEndpoint
  ) {
    const callerConversation = params.callerConversation;
    const destinationEndpoint = params.destinationEndpoint;
    const operationPlan = createCompletionAnnouncementOperationPlan(
      finalText,
      params.attachments ?? [],
    );
    if (operationPlan.pathReplacements > 0) {
      deps.logger?.debug({
        runId,
        replacements: operationPlan.pathReplacements,
        step: "completion-caption-egress",
      }, "Attached file paths replaced before completion delivery");
    }
    const operations: Array<{
      text: string;
      partId?: string;
      attachment?: CompletionAttachmentShape;
      reservationKey?: string;
    }> = operationPlan.operations.map((operation) => ({
      text: operation.text,
      ...(operation.partId ? { partId: operation.partId } : {}),
      ...(operation.attachment ? { attachment: operation.attachment } : {}),
    }));
    const reservationRoot = resolveReservationRoot(
      deps.resolveRootRunId,
      callerAgentId,
      callerConversation.conversationScope,
    );
    if (!announceKey || !deps.deadLetterQueue || !reservationRoot) {
      deps.logger?.warn({
        runId,
        hint: "Wire durable operation reservations and the caller ledger root before governed delivery",
        errorKind: "precondition" as const,
      }, "Sub-agent completion operations cannot be reserved");
      return;
    }
    const reservations: AnnouncementParentDecisionReservation[] = operations.map((operation) => {
      const reservationKey = createStableAnnouncementOperationId(
        callerAgentId,
        callerSessionKey,
        runId,
        operation.partId,
      );
      operation.reservationKey = reservationKey;
      return {
        idempotencyKey: reservationKey,
        agentId: callerAgentId,
        runId,
        sessionKey: callerSessionKey,
        announcementText: operation.text,
        channelType: announceChannelType,
        channelId: announceChannelId,
        failedAt: systemNowMs(),
        rootRunId: reservationRoot,
        deliveryAuthority: {
          tenantId: callerConversation.conversationScope.tenantId,
          agentId: callerAgentId,
          conversationRef: callerConversation.conversationRef,
        },
        destinationEndpoint,
        completionKeys: [announceKey],
        ...(threadId ? { threadId } : {}),
        ...(operation.partId ? { partId: operation.partId } : {}),
        ...(operation.attachment ? { attachment: operation.attachment } : {}),
      };
    });
    const transitioned = await fromPromise(deps.deadLetterQueue.replaceDecisions(
      decisionReserved ? [announceKey] : [],
      reservations,
    ));
    if (!transitioned.ok || !transitioned.value.ok) {
      deps.logger?.warn({
        runId,
        hint: "Restore decision-quarantine storage before retrying the completion",
        errorKind: "resource" as const,
      }, "Sub-agent completion operation reservations were not persisted");
      return;
    }
    if (!transitioned.value.value.created) {
      deps.logger?.debug({ runId }, "Sub-agent completion operations are already durably retained");
      return;
    }
    delivered = true;
    for (const operation of operations) {
      const boundary = await fromPromise(deps.sendGovernedAnnouncement({
        agentId: callerAgentId,
        callerSessionKey,
        callerConversation,
        destinationEndpoint,
        runId,
        channelType: announceChannelType,
        channelId: announceChannelId,
        text: operation.text,
        completionKeys: [announceKey],
        ...(operation.partId ? { partId: operation.partId } : {}),
        ...(operation.attachment ? { attachment: operation.attachment } : {}),
        ...(threadId ? { options: { threadId } } : {}),
      }));
      if (!boundary.ok || !boundary.value.ok) {
        delivered = false;
        lastError = "governed announcement boundary failed";
        break;
      }
      const outcome = boundary.value.value;
      if (!outcome.delivered) {
        if ("terminalDecision" in outcome) continue;
        delivered = false;
        lastError = outcome.failure;
        break;
      }
      if (operation.reservationKey) {
        await resolveDecisionKey(operation.reservationKey, "receipt_committed");
      }
    }
  } else {
    if (params.attachments?.length) {
      deps.logger?.warn({
        runId,
        channelType: announceChannelType,
        hint: "Wire governed attachment delivery before retrying the retained completion",
        errorKind: "precondition" as const,
      }, "Generated completion file has no governed delivery boundary");
      return;
    }
    const boundary = await fromPromise(
      deps.sendToChannel(
        announceChannelType,
        announceChannelId,
        finalText,
        threadId ? { threadId } : undefined,
      ),
    );
    delivered = boundary.ok && boundary.value;
    if (!boundary.ok) lastError = toSafeErrorLogString(boundary.error);
    else if (!boundary.value) lastError = "sendToChannel returned false";
  }

  if (delivered) {
    if (!deps.sendGovernedAnnouncement) await resolveDecision("receipt_committed");
    if (announceKey) deps.deliveryDedup?.mark(announceKey);
    return;
  }

  deps.logger?.warn({
    runId,
    channelType: announceChannelType,
    hint: "Inspect the retained announcement operation before any retry",
    errorKind: "network" as const,
  }, "Sub-agent announcement delivery failed");

  if (deps.sendGovernedAnnouncement || params.attachments?.length) return;

  if (deps.deadLetterQueue && callerAgentId && callerSessionKey) {
    const queued = await deps.deadLetterQueue.enqueue({
      announcementText: finalText,
      channelType: announceChannelType,
      channelId: announceChannelId,
      agentId: callerAgentId,
      runId,
      sessionKey: callerSessionKey,
      failedAt: systemNowMs(),
      attemptCount: 0,
      lastError,
      ...(threadId ? { threadId } : {}),
      ...(announceKey ? { idempotencyKey: announceKey } : {}),
      ...(params.callerConversation && params.destinationEndpoint ? {
        deliveryAuthority: {
          tenantId: params.callerConversation.conversationScope.tenantId,
          agentId: callerAgentId,
          conversationRef: params.callerConversation.conversationRef,
        },
        destinationEndpoint: params.destinationEndpoint,
      } : {}),
    });
    if (!queued?.ok) {
      deps.logger?.warn({
        runId,
        channelType: announceChannelType,
        hint: "Repair dead-letter storage before retrying or claiming the announcement was retained",
        errorKind: "resource" as const,
      }, "Sub-agent announcement dead-letter persistence failed");
    }
  }
}

// ---------------------------------------------------------------------------
// Failure notification (LLM-free)
// ---------------------------------------------------------------------------

interface FailureNotificationParams {
  channelType: string;
  channelId: string;
  task: string;
  runtimeMs: number;
  runId: string;
  /** Authenticated caller identity that owns the governed outward operation. */
  callerAgentId?: string;
  /** Formatted caller session key — needed to build the shared announceKey. */
  callerSessionKey?: string;
  /** Canonical caller authority for the governed outward operation. */
  callerConversation?: ConversationLocator;
  /** Immutable endpoint captured with the authenticated caller turn. */
  destinationEndpoint?: ChannelEndpoint;
  /** Topic captured from the exact requester route when the run was accepted. */
  threadId?: string;
  /** Cause line replacing the generic error sentence for attributed kills. */
  detail?: string;
}

type FailureNotificationDeps = Pick<
  SubAgentRunnerDeps,
  "sendToChannel" | "sendGovernedAnnouncement" | "logger" | "batcher"
> & {
    /**
     * Shared, bounded delivered-key store. Lets the failure-path dedup
     * work WITHOUT a batcher. When both a
     * batcher and a dedup are injected they are the SAME underlying set (the
     * batcher delegates to it), so checking/marking either is consistent.
     */
    deliveryDedup?: DeliveryDedup;
  };

const failureNotificationsInFlight = new Map<string, Promise<void>>();

async function deliverFailureNotificationOnce(
  params: FailureNotificationParams,
  deps: FailureNotificationDeps,
): Promise<void> {
  const taskPreview = params.task.length > 100
    ? params.task.slice(0, 97) + "..."
    : params.task;

  const message = [
    `Task failed: ${taskPreview}`,
    params.detail ?? "The task encountered an error and could not complete.",
    `Runtime: ${(params.runtimeMs / 1000).toFixed(1)}s`,
  ].join("\n");

  // Build the SAME idempotency key as the success path
  // via the shared `buildAnnounceKey` helper (one source of truth — divergence
  // would silently break the cross-path dedup) and dedup against the SAME
  // deliveredKeys set (reached via the batcher's hasDelivered/markDelivered).
  // A budget-failed graph node routes here; its failure-key
  // == its success-key, so a second sweep does not double-notify. Undefined for
  // a top-level spawn (no callerSessionKey) → no dedup.
  const announceKey = buildAnnounceKey(params.callerSessionKey, params.runId);
  // Dedup against the shared set whether reached via the batcher OR the
  // directly-injected DeliveryDedup (the no-batcher path). They are the same
  // underlying set in production; checking either suppresses a double-notify.
  const alreadyDelivered = announceKey !== undefined
    && (deps.batcher?.hasDelivered(announceKey) === true || deps.deliveryDedup?.has(announceKey) === true);
  // A completion announcement that is enqueued-but-unflushed (or
  // retained-uncertain) still OWNS delivery for this key — hasDelivered is
  // false only because the flush hasn't run yet. Sending the failure notice
  // now would double-notify the recipient once the batch drains (the
  // daemon-shutdown race: the run enqueued its announcement, then the
  // shutdown sweep suppressed the run and routed here).
  const announcementOwnsDelivery = announceKey !== undefined
    && deps.batcher?.hasPending?.(announceKey) === true;
  if (alreadyDelivered || announcementOwnsDelivery) {
    deps.logger?.debug({
      runId: params.runId,
      hint: announcementOwnsDelivery
        ? "pending completion announcement owns delivery; failure notification suppressed"
        : "duplicate failure notification suppressed",
    }, "Failure notification dedup no-op");
    return;
  }

  const threadId = params.threadId;

  if (
    deps.sendGovernedAnnouncement
    && (!params.callerAgentId || !params.callerSessionKey || !params.callerConversation || !params.destinationEndpoint)
  ) {
    deps.logger?.warn({
      runId: params.runId,
      hint: "Bind the failure notice to its authenticated caller agent and session before delivery",
      errorKind: "precondition" as const,
    }, "Governed failure notification has no delivery authority");
    return Promise.reject(new Error("Governed failure notification requires caller delivery authority"));
  }

  let delivered: boolean;
  let sendErr: Error | undefined;
  if (deps.sendGovernedAnnouncement) {
    if (!announceKey) {
      return Promise.reject(new Error("Governed failure notification requires a completion key"));
    }
    const boundary = await fromPromise(deps.sendGovernedAnnouncement({
      agentId: params.callerAgentId!,
      callerSessionKey: params.callerSessionKey!,
      callerConversation: params.callerConversation!,
      destinationEndpoint: params.destinationEndpoint!,
      runId: params.runId,
      channelType: params.channelType,
      channelId: params.channelId,
      text: message,
      completionKeys: [announceKey],
      ...(threadId ? { options: { threadId } } : {}),
    }));
    delivered = boundary.ok && boundary.value.ok && boundary.value.value.delivered;
  } else {
    const boundary = await fromPromise(deps.sendToChannel(
      params.channelType,
      params.channelId,
      message,
      threadId ? { threadId } : undefined,
    ));
    delivered = boundary.ok && boundary.value;
    sendErr = boundary.ok ? new Error("sendToChannel returned false") : boundary.error;
  }
  if (!delivered) {
    sendErr ??= new Error("Governed failure notification was not confirmed");
    deps.logger?.warn({
      runId: params.runId,
      err: toSafeErrorLogString(sendErr),
      hint: deps.sendGovernedAnnouncement
        ? "Inspect the retained governed operation before deciding whether to retry"
        : "Even direct channel send failed; user will not be notified",
      errorKind: "network" as const,
    }, "Failure notification delivery failed");
    return Promise.reject(sendErr);
  }

  // Mark delivered only after a confirmed true result. Both sinks resolve to
  // the same bounded set in production.
  if (announceKey) {
    deps.batcher?.markDelivered(announceKey);
    deps.deliveryDedup?.mark(announceKey);
  }
}

/**
 * Deliver one fixed-format, LLM-free failure notice. Keyed concurrent callers
 * join the same attempt; the governed sender provides durable replay blocking.
 */
export function deliverFailureNotification(
  params: FailureNotificationParams,
  deps: FailureNotificationDeps,
): Promise<void> {
  const announceKey = buildAnnounceKey(params.callerSessionKey, params.runId);
  if (announceKey === undefined) return deliverFailureNotificationOnce(params, deps);
  const existing = failureNotificationsInFlight.get(announceKey);
  if (existing !== undefined) return existing;
  const pending = deliverFailureNotificationOnce(params, deps).finally(() => {
    if (failureNotificationsInFlight.get(announceKey) === pending) {
      failureNotificationsInFlight.delete(announceKey);
    }
  });
  failureNotificationsInFlight.set(announceKey, pending);
  return pending;
}
