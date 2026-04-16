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
  type SessionKey,
} from "@comis/core";
import { withTimeout } from "@comis/shared";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AnnouncementBatcher } from "./announcement-batcher.js";
import type { AnnouncementDeadLetterQueue } from "./announcement-dead-letter.js";
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
  const cutoff = Date.now() - retentionMs;

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
    await mkdir(dirname(diskPath), { recursive: true });

    // Classify error for structured context
    const errorContext = classifyErrorContext(params.error, params.endReason);

    await writeFile(
      diskPath,
      JSON.stringify({
        runId: params.runId,
        sessionKey: params.sessionKey,
        task: params.task,
        status: "failed",
        error: params.error,
        endReason: params.endReason,
        failedAt: new Date().toISOString(),
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
      errorKind: "internal",
    }, "Failure record persistence failed");
  }
}

// ---------------------------------------------------------------------------
// Error context classification
// ---------------------------------------------------------------------------

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
      } else if (lowerMsg.includes("rate limit") || lowerMsg.includes("429")) {
        errorType = "RateLimited";
        retryable = true;
      } else if (lowerMsg.includes("provider") || lowerMsg.includes("5") && lowerMsg.includes("00")) {
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
}): Promise<void> {
  const { announcementText, announceChannelType, announceChannelId, callerAgentId, callerSessionKey, runId } = params;

  // Route through batcher for coalesced delivery when available
  if (deps.batcher && callerAgentId && callerSessionKey) {
    deps.batcher.enqueue({
      announcementText,
      announceChannelType,
      announceChannelId,
      callerAgentId,
      callerSessionKey,
      runId,
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
        "announceToParent",
      );
      deps.logger?.debug({ runId, channelType: announceChannelType }, "Sub-agent announcement injected into parent session");
      return;
    } catch (announceErr) {
      deps.logger?.warn({
        runId,
        hint: "Parent session injection failed; falling back to direct channel send",
        errorKind: "internal",
        err: announceErr,
      }, "Sub-agent parent announcement failed");
    }
  }

  // Direct channel send with internal instruction stripped
  // Extract thread context from ALS so fallback delivery lands in the correct thread
  const ctx = tryGetContext();
  const threadId = ctx?.deliveryOrigin?.threadId;
  await deps.sendToChannel(announceChannelType, announceChannelId, stripAnnouncementInstruction(announcementText), threadId ? { threadId } : undefined).catch((sendErr) => {
    deps.logger?.warn({
      runId,
      channelType: announceChannelType,
      hint: "Failed to announce sub-agent result to channel; the sub-agent result is logged separately",
      errorKind: "network",
      err: sendErr,
    }, "Sub-agent announcement delivery failed");

    // Tier 3 -- persist to dead-letter queue for retry
    if (deps.deadLetterQueue) {
      deps.deadLetterQueue.enqueue({
        announcementText: stripAnnouncementInstruction(announcementText),
        channelType: announceChannelType,
        channelId: announceChannelId,
        runId,
        failedAt: Date.now(),
        attemptCount: 0,
        lastError: sendErr instanceof Error ? sendErr.message : String(sendErr),
        threadId,  // Persist thread context for retried deliveries
      });
    }
  });
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
 */
export async function deliverFailureNotification(
  params: {
    channelType: string;
    channelId: string;
    task: string;
    runtimeMs: number;
    runId: string;
  },
  deps: Pick<SubAgentRunnerDeps, "sendToChannel" | "logger">,
): Promise<void> {
  const taskPreview = params.task.length > 100
    ? params.task.slice(0, 97) + "..."
    : params.task;

  const message = [
    `Task failed: ${taskPreview}`,
    "The task encountered an error and could not complete.",
    `Runtime: ${(params.runtimeMs / 1000).toFixed(1)}s`,
  ].join("\n");

  // Extract thread context from ALS so failure notifications
  // land in the correct Telegram topic / thread.
  const ctx = tryGetContext();
  const threadId = ctx?.deliveryOrigin?.threadId;

  try {
    await deps.sendToChannel(params.channelType, params.channelId, message, threadId ? { threadId } : undefined);
  } catch (sendErr) {
    deps.logger?.warn({
      runId: params.runId,
      err: sendErr,
      hint: "Even direct channel send failed; user will not be notified",
      errorKind: "network",
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
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    results.push({ path: filePath, exists, size });
  }
  return results;
}
