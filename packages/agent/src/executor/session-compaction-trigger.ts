// SPDX-License-Identifier: Apache-2.0
/**
 * Session soft/hard compaction policy at the LCD after-turn boundary.
 *
 * The soft boundary extracts a durable conversation summary without changing
 * the model-facing LCD view. The hard boundary performs the same flush, then
 * delegates trimming to LCD's bounded leaf drain. Raw messages remain in the
 * lossless store; this module never mutates the SDK transcript.
 */

import {
  ContextEngineConfigSchema,
  validateMemoryWrite,
  type ComisLogger,
  type ContextEngineConfig,
  type ContextStorePort,
  type ContextStoreScope,
  type MemoryPort,
  type MemoryWriteScope,
  type SessionCompactionConfig,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import {
  summarizeLeafChunk,
  type LeafChunkItem,
  type LeafSummarizerDeps,
} from "../context-engine/lcd-leaf-summarizer.js";
import {
  estimateMessageChars,
  estimateMessageTokens,
} from "../safety/token-estimator.js";
import {
  maybeRunLeafPass,
  resolveContext,
} from "./lcd-compaction-trigger.js";

export type SessionCompactionBand = "below" | "soft" | "hard";

export interface SessionCompactionState {
  get(sessionKey: string): SessionCompactionBand | undefined;
  set(sessionKey: string, band: SessionCompactionBand): void;
}

export interface SessionCompactionRun {
  trigger?: "soft" | "hard";
  utilization: number;
  memoriesWritten: number;
  summariesCreated: number;
  success: boolean;
}

export interface RunSessionCompactionAfterTurnParams {
  store: ContextStorePort;
  scope: ContextStoreScope;
  sessionKey: SessionKey;
  formattedKey: string;
  sessionCompaction: SessionCompactionConfig;
  contextEngine: ContextEngineConfig | undefined;
  budgetWindowTokens: number;
  getSummarizerDeps: (() => LeafSummarizerDeps) | undefined;
  getFlushSummarizerDeps?: (() => LeafSummarizerDeps | undefined) | undefined;
  memoryPort?: MemoryPort;
  memoryScope?: MemoryWriteScope;
  state: SessionCompactionState;
  now: number;
  nowFn?: () => number;
  logger: ComisLogger;
  eventBus: TypedEventBus;
  embeddingEnqueue?: (entryId: string, content: string) => void;
}

interface FlushResult {
  memoriesWritten: number;
  success: boolean;
}

function determineTrigger(
  utilization: number,
  config: SessionCompactionConfig,
  previous: SessionCompactionBand | undefined,
): "soft" | "hard" | undefined {
  if (utilization >= config.hardThresholdRatio) {
    return previous === "hard" ? undefined : "hard";
  }
  if (utilization >= config.softThresholdRatio) {
    return previous === undefined || previous === "below" ? "soft" : undefined;
  }
  return undefined;
}

function chunkHistory(
  history: LeafChunkItem[],
  maxChars: number,
  overlapMessages: number,
): LeafChunkItem[][] {
  const chunks: LeafChunkItem[][] = [];
  let start = 0;
  while (start < history.length) {
    let end = start;
    let chars = 0;
    while (end < history.length) {
      const nextChars = estimateMessageChars(
        history.at(end)!.msg as unknown as Message,
      );
      if (end > start && chars + nextChars > maxChars) break;
      chars += nextChars;
      end++;
    }
    if (end === start) end++;
    chunks.push(history.slice(start, end));
    if (end >= history.length) break;
    start = Math.max(start + 1, end - overlapMessages);
  }
  return chunks;
}

async function summarizeHistory(
  history: LeafChunkItem[],
  config: SessionCompactionConfig,
  deps: LeafSummarizerDeps,
): Promise<Result<string, Error>> {
  if (history.length === 0) {
    return err(new Error("Session compaction flush found no resolvable history"));
  }

  const chunks = chunkHistory(
    history,
    config.chunkMaxChars,
    config.chunkOverlapMessages,
  );
  const summaries: string[] = [];
  for (const chunk of chunks) {
    const summarized = await fromPromise(
      summarizeLeafChunk(chunk, deps, {
        reserveTokens: config.reserveTokens,
      }),
    );
    if (!summarized.ok) return err(summarized.error);
    if (summarized.value.fallback) {
      return err(new Error(
        "Session compaction memory extraction reached the deterministic fallback",
      ));
    }
    summaries.push(summarized.value.content);
  }

  if (summaries.length === 1) return ok(summaries[0]!);
  if (!config.chunkMergeSummaries) return ok(summaries.join("\n\n"));

  const mergedMessage = {
    role: "user",
    content: summaries.join("\n\n"),
  } as unknown as AgentMessage;
  const originalHistoryTokens = history.reduce(
    (total, item) => total + item.tokens,
    0,
  );
  const maxMemoryTokens = Math.min(
    config.reserveTokens,
    originalHistoryTokens - 1,
  );
  if (maxMemoryTokens < 1) {
    return err(new Error(
      "Session compaction memory merge found no token budget below the original history",
    ));
  }
  const merged = await fromPromise(deps.summarize(
    [mergedMessage],
    { reserveTokens: maxMemoryTokens },
  ));
  if (!merged.ok) return err(merged.error);
  if (merged.value.trim().length === 0) {
    return err(new Error(
      "Session compaction memory merge returned empty content",
    ));
  }
  const outputMessage = {
    role: "user",
    content: merged.value,
  } as unknown as AgentMessage;
  const outputTokens = estimateMessageTokens(outputMessage as unknown as Message);
  if (outputTokens > maxMemoryTokens) {
    return err(new Error(
      "Session compaction memory merge exceeded "
      + `agents.<name>.session.compaction.reserveTokens=${config.reserveTokens}: `
      + `outputTokens=${outputTokens}, originalHistoryTokens=${originalHistoryTokens}, `
      + `acceptedMaxTokens=${maxMemoryTokens}`,
    ));
  }
  deps.logger.debug(
    {
      step: "session-compaction-memory-merge",
      chunkSummaryCount: summaries.length,
      outputTokens,
      originalHistoryTokens,
      maxMemoryTokens,
    },
    "Session compaction memory summaries merged",
  );
  return ok(merged.value);
}

async function flushToMemory(
  params: RunSessionCompactionAfterTurnParams,
  trigger: "soft" | "hard",
  history: LeafChunkItem[],
): Promise<FlushResult> {
  if (
    params.memoryPort === undefined
    || params.memoryScope === undefined
    || params.getFlushSummarizerDeps === undefined
  ) {
    params.logger.warn(
      {
        step: "session-compaction-flush",
        trigger,
        sessionKey: params.formattedKey,
        errorKind: "precondition" as const,
        hint:
          "Enable agents.<name>.memory.enabled and configure a resolvable "
          + "agents.<name>.operationModels.compaction model before retrying the flush",
      },
      "Session compaction memory flush unavailable",
    );
    return { memoriesWritten: 0, success: false };
  }
  const summarizerDeps = params.getFlushSummarizerDeps();
  if (summarizerDeps === undefined) {
    params.logger.warn(
      {
        step: "session-compaction-flush",
        trigger,
        sessionKey: params.formattedKey,
        errorKind: "config" as const,
        hint:
          "Register agents.<name>.session.compaction.flushModel or remove "
          + "that key to use the normal compaction model",
      },
      "Session compaction flush summarizer unavailable",
    );
    return { memoriesWritten: 0, success: false };
  }

  const summarized = await summarizeHistory(
    history,
    params.sessionCompaction,
    summarizerDeps,
  );
  if (!summarized.ok) {
    params.logger.warn(
      {
        step: "session-compaction-flush",
        trigger,
        sessionKey: params.formattedKey,
        err: summarized.error.message,
        errorKind: "dependency" as const,
        hint:
          "Inspect agents.<name>.session.compaction and "
          + "agents.<name>.operationModels.compaction; the LCD view was left intact",
      },
      "Session compaction memory summary failed",
    );
    return { memoriesWritten: 0, success: false };
  }

  const verdict = validateMemoryWrite(summarized.value);
  if (verdict.severity === "critical") {
    params.logger.warn(
      {
        step: "session-compaction-flush",
        trigger,
        sessionKey: params.formattedKey,
        patterns: verdict.patterns,
        errorKind: "validation" as const,
        hint:
          "The generated compaction memory matched a blocked secret or dangerous "
          + "pattern; inspect the source conversation and summarizer configuration",
      },
      "Session compaction memory summary rejected",
    );
    return { memoriesWritten: 0, success: false };
  }

  const entryId = randomUUID();
  const stored = await fromPromise(
    params.memoryPort.store({
      id: entryId,
      content: summarized.value,
      trustLevel: verdict.severity === "warn" ? "external" : "learned",
      source: {
        who: "compaction",
        sessionKey: params.formattedKey,
      },
      tags: ["compaction-summary", `trigger:${trigger}`],
      sourceType: "conversation",
      memoryType: "episodic",
      createdAt: params.now,
    }, params.memoryScope),
  );
  const failure = !stored.ok
    ? stored.error
    : !stored.value.ok
      ? stored.value.error
      : undefined;
  if (failure !== undefined) {
    params.logger.warn(
      {
        step: "session-compaction-flush",
        trigger,
        sessionKey: params.formattedKey,
        err: failure.message,
        errorKind: "dependency" as const,
        hint:
          "Check memory database connectivity and disk space, then retry the "
          + "session compaction flush",
      },
      "Session compaction memory write failed",
    );
    return { memoriesWritten: 0, success: false };
  }

  params.embeddingEnqueue?.(entryId, summarized.value);
  return { memoriesWritten: 1, success: true };
}

async function runTriggeredCompaction(
  params: RunSessionCompactionAfterTurnParams,
  trigger: "soft" | "hard",
  utilization: number,
  history: LeafChunkItem[],
): Promise<SessionCompactionRun> {
  const startedAt = params.nowFn?.() ?? params.now;
  if (trigger === "hard") {
    params.eventBus.emit("compaction:started", {
      agentId: params.scope.agentId,
      sessionKey: params.sessionKey,
      timestamp: params.now,
    });
  }

  const flushed = await flushToMemory(params, trigger, history);
  let summariesCreated = 0;
  if (
    trigger === "hard"
    && flushed.success
    && params.getSummarizerDeps !== undefined
  ) {
    const contextConfig =
      params.contextEngine ?? ContextEngineConfigSchema.parse({});
    const before = params.store.getSummaries(params.scope).length;
    await maybeRunLeafPass(
      params.store,
      params.scope,
      {
        contextThreshold: params.sessionCompaction.hardThresholdRatio,
        leafChunkTokens: contextConfig.leafChunkTokens,
        leafTargetTokens: contextConfig.leafTargetTokens,
        freshTailTurns: contextConfig.freshTailTurns,
        windowTokens: params.budgetWindowTokens,
      },
      params.getSummarizerDeps(),
      params.now,
      params.nowFn,
      params.logger,
      params.eventBus,
    );
    summariesCreated = Math.max(
      0,
      params.store.getSummaries(params.scope).length - before,
    );
  }

  const trimSucceeded = trigger === "soft" || summariesCreated > 0;
  const success = flushed.success && trimSucceeded;
  params.eventBus.emit("compaction:flush", {
    sessionKey: params.sessionKey,
    memoriesWritten: flushed.memoriesWritten,
    trigger,
    success,
    timestamp: params.now,
  });
  params.logger.info(
    {
      step: "session-compaction",
      trigger,
      sessionKey: params.formattedKey,
      utilization: Math.round(utilization * 1_000) / 1_000,
      softThresholdRatio: params.sessionCompaction.softThresholdRatio,
      hardThresholdRatio: params.sessionCompaction.hardThresholdRatio,
      memoriesWritten: flushed.memoriesWritten,
      summariesCreated,
      success,
      durationMs: Math.max(
        0,
        (params.nowFn?.() ?? params.now) - startedAt,
      ),
    },
    "Session compaction policy completed",
  );

  if (success) params.state.set(params.formattedKey, trigger);
  return {
    trigger,
    utilization,
    memoriesWritten: flushed.memoriesWritten,
    summariesCreated,
    success,
  };
}

/**
 * Evaluate and run the configured session compaction boundary once after a
 * successful LCD ingest. A per-session band latch makes threshold handling
 * edge-triggered: soft runs once, hard may follow once, and falling below soft
 * rearms the next cycle.
 */
export async function runSessionCompactionAfterTurn(
  params: RunSessionCompactionAfterTurnParams,
): Promise<Result<SessionCompactionRun, Error>> {
  const resolved = await fromPromise((async () => {
    const view = resolveContext(params.store, params.scope);
    const windowIsValid =
      Number.isFinite(params.budgetWindowTokens)
      && params.budgetWindowTokens > 0;
    if (!windowIsValid) {
      return {
        utilization: 0,
        memoriesWritten: 0,
        summariesCreated: 0,
        success: false,
      };
    }

    const utilization = view.resolvedTokens / params.budgetWindowTokens;
    const previous = params.state.get(params.formattedKey);
    params.logger.debug(
      {
        step: "session-compaction-gate",
        sessionKey: params.formattedKey,
        resolvedTokens: view.resolvedTokens,
        windowTokens: params.budgetWindowTokens,
        utilization: Math.round(utilization * 1_000) / 1_000,
        softThresholdRatio: params.sessionCompaction.softThresholdRatio,
        hardThresholdRatio: params.sessionCompaction.hardThresholdRatio,
        previousBand: previous,
      },
      "Session compaction thresholds evaluated",
    );

    if (utilization < params.sessionCompaction.softThresholdRatio) {
      params.state.set(params.formattedKey, "below");
      return {
        utilization,
        memoriesWritten: 0,
        summariesCreated: 0,
        success: true,
      };
    }

    const trigger = determineTrigger(
      utilization,
      params.sessionCompaction,
      previous,
    );
    if (trigger === undefined) {
      return {
        utilization,
        memoriesWritten: 0,
        summariesCreated: 0,
        success: true,
      };
    }
    return runTriggeredCompaction(params, trigger, utilization, view.history);
  })());

  if (!resolved.ok) {
    params.logger.warn(
      {
        step: "session-compaction",
        sessionKey: params.formattedKey,
        err: resolved.error.message,
        errorKind: "internal" as const,
        hint:
          "Inspect the LCD store and agents.<name>.session.compaction; "
          + "the live turn completed but automatic session compaction did not",
      },
      "Session compaction policy failed",
    );
  }
  return resolved;
}
