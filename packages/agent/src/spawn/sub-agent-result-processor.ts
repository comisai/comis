// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent result processor module.
 * Contains helper functions for processing sub-agent execution results:
 * - Abort reason classification
 * - Error context classification
 * - Announcement message building and delivery
 * - Output validation
 * - Result file sweeping
 * - Failure record persistence
 * Extracted from sub-agent-runner.ts to separate result processing concerns
 * from spawn lifecycle management.
 * @module
 */

import {
  parseFormattedSessionKey,
  safePath,
  tryGetContext,
  systemNowMs,
  systemNowDate,
  systemScheduleTimeout,
  systemSleep,
  scrubSecretsFromText,
} from "@comis/core";
import { withTimeout } from "@comis/shared";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AnnouncementBatcher, AnnouncementDeadLetterQueue } from "./announcement-ports.js";
import { buildAnnounceKey, type DeliveryDedup } from "./announce-key.js";
import { ANNOUNCE_PARENT_TIMEOUT_MS, type SubAgentRunnerDeps, type SubAgentRunnerLogger } from "./sub-agent-runner.js";

// ---------------------------------------------------------------------------
// Abort classification
// ---------------------------------------------------------------------------

export interface AbortClassification {
  category: "step_limit" | "budget" | "context_full" | "external_timeout" | "provider_degraded" | "unknown";
  hint: string;
  severity: "expected" | "actionable" | "investigate";
}

/**
 * Classify a sub-agent abort reason from finishReason and optional error context.
 * Maps 7 possible finishReason values to 5 abort categories with remediation
 * hints and severity levels. Normal completions (stop, end_turn) are not
 * expected inputs but are handled gracefully as "unknown".
 * @param finishReason - The finishReason from ExecutionResult or error context
 * @param errorMessage - Optional error message for pattern matching (error finishReason)
 * @param errorCause - Optional error.cause message for deeper stack trace investigation
 */
export function classifyAbortReason(
  finishReason: string,
  errorMessage?: string,
  errorCause?: string,
): AbortClassification {
  switch (finishReason) {
    case "max_steps":
      return {
        category: "step_limit",
        hint: "Increase max_steps in sessions_spawn or simplify the task",
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
}, logger?: SubAgentRunnerLogger): Promise<void> {
  try {
    const sanitizedKey = params.sessionKey.replace(/:/g, "_");
    const diskPath = safePath(params.dataDir, "subagent-results", sanitizedKey, `${params.runId}.json`);
    // fs-safe-allowed: sub-agent error-spill dir (`<dataDir>/subagent-results/<key>/`); follow-up plan should migrate to ensureContainedDir + writeRegularFile
    await mkdir(dirname(diskPath), { recursive: true });

    // Classify error for structured context
    const errorContext = classifyErrorContext(params.error, params.endReason);

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
// Error context classification
// ---------------------------------------------------------------------------

/**
 * Transport-layer failures are transient: they self-heal on a
 * retry-with-backoff in the announcement batcher. The bare Node errno spellings
 * do NOT contain "timeout"/"timed out" (e.g. "ETIMEDOUT".toLowerCase() is
 * "etimedout"), so the existing timeout branch misses them — match these
 * explicitly. Matched case-insensitively as a substring of the error message
 * (real delivery errors wrap the errno in surrounding text, e.g.
 * "connect ECONNREFUSED 127.0.0.1:443").
 *
 * The token list is deliberately errno-style only, PLUS the errno-less real
 * phrasings emitted by undici/fetch ("fetch failed", "network request failed",
 * "socket hang up"). The natural-language phrases "connection reset" /
 * "connection refused" are intentionally OMITTED: every genuine Node transport
 * error carries its errno spelling (ECONNRESET / ECONNREFUSED, already matched
 * here), so those phrases add no real-failure coverage but DO over-match a
 * PERMANENT error that quotes them as content (e.g. a tool result
 * `"connection refused by policy"`). Keeping the list errno-anchored bounds the
 * false-positive surface (mirrors the 5xx `\b5\d{2}\b` word-boundary guard).
 */
const TRANSIENT_TRANSPORT_TOKENS = [
  "etimedout",
  "econnreset",
  "econnrefused",
  "epipe",
  "enetunreach",
  "eai_again",
  "socket hang up",
  "fetch failed",
  "network request failed",
];

/**
 * Classify an error message and endReason into structured error context
 * for offline analysis and retry decisions.
 */
export function classifyErrorContext(
  errorMessage: string,
  endReason: "failed" | "killed" | "watchdog_timeout" | "ghost_sweep",
): {
  errorType: string;
  retryable: boolean;
  failingTool?: string;
} {
  const lowerMsg = errorMessage.toLowerCase();

  // Derive errorType from endReason and error message patterns
  let errorType: string;
  let retryable: boolean;

  switch (endReason) {
    case "watchdog_timeout":
      errorType = "ExecutionTimeout";
      retryable = true;
      break;
    case "ghost_sweep":
      errorType = "GhostRunTimeout";
      retryable = true;
      break;
    case "killed":
      errorType = "KilledByParent";
      retryable = false;
      break;
    default: {
      // Classify from error message content
      if (lowerMsg.includes("budget") || lowerMsg.includes("cost limit")) {
        errorType = "BudgetExceeded";
        retryable = false;
      } else if (lowerMsg.includes("timeout") || lowerMsg.includes("timed out")) {
        errorType = "ExecutionTimeout";
        retryable = true;
      } else if (TRANSIENT_TRANSPORT_TOKENS.some((token) => lowerMsg.includes(token))) {
        // Transport-layer blips (ECONNRESET/ECONNREFUSED/EPIPE/
        // "socket hang up"/"fetch failed"/...) are transient — the batcher
        // retries them with backoff before dead-lettering. Placed AFTER the
        // budget/timeout branches (which precede it) so a permanent budget
        // message never reaches here.
        errorType = "TransportError";
        retryable = true;
      } else if (lowerMsg.includes("rate limit") || lowerMsg.includes("429")) {
        errorType = "RateLimited";
        retryable = true;
      } else if (lowerMsg.includes("provider") || /\b5\d{2}\b/.test(errorMessage)) {
        // Match HTTP 5xx status codes (500-599) bounded by word boundaries
        // so token counts like "50000" or "100" do not falsely trigger.
        errorType = "ProviderError";
        retryable = true;
      } else if (lowerMsg.includes("circuit") || lowerMsg.includes("breaker")) {
        errorType = "CircuitBreakerOpen";
        retryable = true;
      } else if (lowerMsg.includes("context") && (lowerMsg.includes("exhaust") || lowerMsg.includes("loop"))) {
        errorType = "ContextExhausted";
        retryable = false;
      } else if (lowerMsg.includes("max steps") || lowerMsg.includes("step limit")) {
        errorType = "StepLimitReached";
        retryable = false;
      } else {
        errorType = "Unknown";
        retryable = false;
      }
    }
  }

  // Attempt to extract failing tool from error message
  // Pattern: "Tool X failed", "error in tool X", "X: error"
  let failingTool: string | undefined;
  const toolMatch = errorMessage.match(/\btool[:\s]+["']?(\w+)["']?/i)
    ?? errorMessage.match(/^(\w+):\s/);
  if (toolMatch?.[1]) {
    failingTool = toolMatch[1];
  }

  return {
    errorType,
    retryable,
    ...(failingTool ? { failingTool } : {}),
  };
}

// ---------------------------------------------------------------------------
// Announcement template
// ---------------------------------------------------------------------------

export interface ValidationResult {
  path: string;
  exists: boolean;
  size?: number;
}

/**
 * Build a structured [System Message] block for injecting sub-agent results
 * into the parent session. The parent agent rewrites this in its own voice
 * and can respond with NO_REPLY to suppress trivial results.
 */
export function buildAnnouncementMessage(params: {
  task: string;
  status: "completed" | "failed";
  response?: string;
  error?: string;
  runtimeMs: number;
  stepsExecuted?: number;
  tokensUsed: number;
  cost: number;
  finishReason?: string;
  sessionKey: string;
  validation?: ValidationResult[];
  abort?: AbortClassification;
  errorContext?: { errorType: string; retryable: boolean; failingTool?: string };
}): string {
  // Map abnormal finishReasons to status labels and announcement verbs
  const finishReasonMap: Record<string, { label: string; verb: string }> = {
    max_steps: { label: "Halted (max steps reached)", verb: "halted (max steps reached)" },
    context_loop: { label: "Halted (context loop)", verb: "halted (context loop)" },
    context_exhausted: { label: "Halted (context exhausted)", verb: "halted (context exhausted)" },
    budget_exceeded: { label: "Halted (budget exceeded)", verb: "halted (budget exceeded)" },
    error: { label: "Halted (error)", verb: "halted (error)" },
  };

  let statusLabel: string;
  let announcementVerb: string;

  if (params.status === "failed") {
    statusLabel = "Failed";
    announcementVerb = "failed";
  } else {
    const mapped = params.finishReason ? finishReasonMap[params.finishReason] : undefined;
    if (mapped) {
      statusLabel = mapped.label;
      announcementVerb = mapped.verb;
      // Enrich generic "error" label with specific error type when available
      if (params.finishReason === "error" && params.errorContext) {
        const retryHint = params.errorContext.retryable ? ", retryable" : "";
        const toolHint = params.errorContext.failingTool ? ` on ${params.errorContext.failingTool}` : "";
        statusLabel = `Halted (${params.errorContext.errorType}${toolHint}${retryHint})`;
        announcementVerb = `halted (${params.errorContext.errorType.toLowerCase()})`;
      }
    } else if (params.finishReason && params.finishReason !== "stop" && params.finishReason !== "end_turn") {
      statusLabel = `Completed (${params.finishReason})`;
      announcementVerb = "completed with warnings";
    } else {
      statusLabel = "Success";
      announcementVerb = "completed";
    }
  }

  const resultText = params.status === "completed"
    ? (params.response ?? "No output")
    : `Error: ${params.error ?? "Unknown error"}`;

  let validationLine = "";
  if (params.validation && params.validation.length > 0) {
    const verified = params.validation.filter((v) => v.exists).length;
    const total = params.validation.length;
    validationLine = `Outputs: ${verified}/${total} verified`;
    const missing = params.validation.filter((v) => !v.exists);
    if (missing.length > 0) {
      validationLine += ` | Missing: ${missing.map((v) => v.path).join(", ")}`;
    }
    validationLine += "\n";
  }

  let abortLine = "";
  if (params.abort) {
    abortLine = `Abort: ${params.abort.category} | Hint: ${params.abort.hint}\n`;
  }

  return (
    `[System Message]\n` +
    `A background task has ${announcementVerb}.\n\n` +
    `Task: ${params.task}\n` +
    `Status: ${statusLabel}\n` +
    `Result: ${resultText}\n\n` +
    `---\n` +
    `Runtime: ${(params.runtimeMs / 1000).toFixed(1)}s | ` +
    `Steps: ${params.stepsExecuted ?? 0} | ` +
    `Tokens: ${params.tokensUsed} | ` +
    `Cost: $${params.cost.toFixed(4)} | ` +
    `Session: ${params.sessionKey}\n` +
    validationLine +
    abortLine +
    `\n` +
    `Inform the user about this completed background task. ` +
    `Summarize the result in your own voice. ` +
    `If no user notification is needed, respond with NO_REPLY.`
  );
}

// ---------------------------------------------------------------------------
// Safety net: strip internal LLM instruction from announcement text
// ---------------------------------------------------------------------------

/** Strip internal LLM instruction from announcement text for direct channel delivery. */
export function stripAnnouncementInstruction(text: string): string {
  const marker = "Inform the user about this completed background task.";
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}

// ---------------------------------------------------------------------------
// Announcement delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a sub-agent announcement via parent session injection or direct
 * channel send. Encapsulates the two-tier fallback: try announceToParent
 * first (for persona rewriting), fall back to sendToChannel with stripped
 * internal instruction text.
 * Errors during delivery are logged as warnings but never thrown -- a
 * delivery failure must not affect the sub-agent run status.
 */
export async function deliverAnnouncement(params: {
  announcementText: string;
  announceChannelType: string;
  announceChannelId: string;
  callerAgentId?: string;
  callerSessionKey?: string;
  runId: string;
}, deps: {
  announceToParent?: SubAgentRunnerDeps["announceToParent"];
  sendToChannel: SubAgentRunnerDeps["sendToChannel"];
  logger?: SubAgentRunnerLogger;
  batcher?: AnnouncementBatcher;
  deadLetterQueue?: AnnouncementDeadLetterQueue;
  /**
   * Shared, bounded delivered-key store. When the batcher is absent the
   * batcher cannot mark the key, so the non-batcher success branches mark this
   * sink instead — keeping the failure-path dedup (`deliverFailureNotification`)
   * correct whether or not a batcher is wired. The daemon wiring injects the
   * SAME instance the batcher uses.
   */
  deliveryDedup?: DeliveryDedup;
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

  // Route through batcher for coalesced delivery when available
  if (deps.batcher && callerAgentId && callerSessionKey) {
    deps.batcher.enqueue({
      announcementText,
      announceChannelType,
      announceChannelId,
      callerAgentId,
      callerSessionKey,
      runId,
      idempotencyKey: announceKey,
    });
    deps.logger?.debug({ runId, channelType: announceChannelType }, "Sub-agent announcement queued for batching");
    return;
  }

  // Prefer parent session injection for persona rewriting; fall back to direct channel send
  if (deps.announceToParent && callerAgentId && callerSessionKey) {
    try {
      const parentSk = parseFormattedSessionKey(callerSessionKey);
      if (!parentSk) throw new Error(`Invalid parent session key: ${callerSessionKey}`);
      await withTimeout(
        deps.announceToParent(
          callerAgentId,
          parentSk,
          announcementText,
          announceChannelType,
          announceChannelId,
        ),
        ANNOUNCE_PARENT_TIMEOUT_MS,
        systemScheduleTimeout,
        "announceToParent",
      );
      // Mark delivered on this non-batcher success branch (there is no
      // batcher here to mark) so the failure path dedups. Marked ONLY after the
      // confirmed await — a failed/timed-out injection falls through to the
      // direct send below and stays unmarked.
      if (announceKey) deps.deliveryDedup?.mark(announceKey);
      deps.logger?.debug({ runId, channelType: announceChannelType }, "Sub-agent announcement injected into parent session");
      return;
    } catch (announceErr) {
      deps.logger?.warn({
        runId,
        hint: "Parent session injection failed; falling back to direct channel send",
        errorKind: "internal" as const,
        err: announceErr,
      }, "Sub-agent parent announcement failed");
    }
  }

  // Direct channel send with internal instruction stripped
  // Extract thread context from ALS so fallback delivery lands in the correct thread
  const ctx = tryGetContext();
  const threadId = ctx?.deliveryOrigin?.threadId;
  try {
    const ok = await deps.sendToChannel(announceChannelType, announceChannelId, stripAnnouncementInstruction(announcementText), threadId ? { threadId } : undefined);
    // Mark delivered ONLY on a confirmed success (ok === true). A throw
    // or a `false` return (transport refused without throwing) leaves the key
    // open so the failure path / a retry can re-notify.
    if (ok && announceKey) deps.deliveryDedup?.mark(announceKey);
  } catch (sendErr) {
    deps.logger?.warn({
      runId,
      channelType: announceChannelType,
      hint: "Failed to announce sub-agent result to channel; the sub-agent result is logged separately",
      errorKind: "network" as const,
      err: sendErr,
    }, "Sub-agent announcement delivery failed");

    // Tier 3 -- persist to dead-letter queue for retry
    if (deps.deadLetterQueue) {
      deps.deadLetterQueue.enqueue({
        announcementText: stripAnnouncementInstruction(announcementText),
        channelType: announceChannelType,
        channelId: announceChannelId,
        runId,
        failedAt: systemNowMs(),
        attemptCount: 0,
        lastError: sendErr instanceof Error ? sendErr.message : String(sendErr),
        threadId,  // Persist thread context for retried deliveries
        idempotencyKey: announceKey,  // same key threaded onto the DLQ entry
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Failure notification (LLM-free)
// ---------------------------------------------------------------------------

/**
 * Deliver a static failure notification directly to the channel.
 * Unlike `deliverAnnouncement`, this function does NOT call `announceToParent`
 * or any LLM. It sends a fixed-format message via `sendToChannel`, avoiding
 * the circular dependency when the LLM provider is the cause of the failure.
 * Never throws -- delivery errors are logged as warnings.
 *
 * DELIBERATE ASYMMETRY: this path is SINGLE-ATTEMPT by design. The failure
 * path's requirement is IDEMPOTENCY (the shared dedup above), NOT the
 * transient retry/DLQ self-healing the SUCCESS fallback has
 * (`sendWithRetry` in the batcher). Mirroring that here means injecting the
 * classifier/backoff/maxRetries/eventBus (and a DLQ) and a parallel retry loop
 * — a materially restructured failure path. The
 * asymmetry with the hardened success path is therefore a documented decision,
 * not an oversight. On a transient transport
 * blip the notification is dropped (logged with a hint).
 */
export async function deliverFailureNotification(
  params: {
    channelType: string;
    channelId: string;
    task: string;
    runtimeMs: number;
    runId: string;
    /** Formatted caller session key — needed to build the shared announceKey. */
    callerSessionKey?: string;
  },
  deps: Pick<SubAgentRunnerDeps, "sendToChannel" | "logger" | "batcher"> & {
    /**
     * Shared, bounded delivered-key store. Lets the failure-path dedup
     * work WITHOUT a batcher. When both a
     * batcher and a dedup are injected they are the SAME underlying set (the
     * batcher delegates to it), so checking/marking either is consistent.
     */
    deliveryDedup?: DeliveryDedup;
  },
): Promise<void> {
  const taskPreview = params.task.length > 100
    ? params.task.slice(0, 97) + "..."
    : params.task;

  const message = [
    `Task failed: ${taskPreview}`,
    "The task encountered an error and could not complete.",
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
  if (alreadyDelivered) {
    deps.logger?.debug({
      runId: params.runId,
      hint: "duplicate failure notification suppressed",
    }, "Failure notification dedup no-op");
    return;
  }

  // Extract thread context from ALS so failure notifications
  // land in the correct Telegram topic / thread.
  const ctx = tryGetContext();
  const threadId = ctx?.deliveryOrigin?.threadId;

  try {
    await deps.sendToChannel(params.channelType, params.channelId, message, threadId ? { threadId } : undefined);
    // Mark delivered ONLY after a successful send (a failed send
    // must stay retry-eligible / re-notifiable). Mark BOTH sinks: the batcher
    // (when wired) and the shared dedup (so dedup holds without a
    // batcher). Both resolve to the same set in production. No-op without a key.
    if (announceKey) {
      deps.batcher?.markDelivered(announceKey);
      deps.deliveryDedup?.mark(announceKey);
    }
  } catch (sendErr) {
    deps.logger?.warn({
      runId: params.runId,
      err: sendErr,
      hint: "Even direct channel send failed; user will not be notified",
      errorKind: "network" as const,
    }, "Failure notification delivery failed");
  }
}

// ---------------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------------

/**
 * Validate expected output files exist on disk with retry for I/O race conditions.
 * Best-effort: retries handle transient filesystem delays (e.g., flush lag).
 */
export async function validateOutputs(
  paths: string[],
  retries = 3,
  delayMs = 200,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const filePath of paths) {
    let exists = false;
    let size: number | undefined;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const s = await stat(filePath);
        exists = true;
        size = s.size;
        break;
      } catch {
        if (attempt < retries - 1) {
          await systemSleep(delayMs);
        }
      }
    }
    results.push({ path: filePath, exists, size });
  }
  return results;
}
