// SPDX-License-Identifier: Apache-2.0
/**
 * trace.artifacts payload assembly.
 *
 * Emitted once per session, immediately BEFORE session.ended, by
 * comis-session-manager.destroySession. Direct emit — see
 * DIRECT_EMIT_TRAJECTORY_TYPES in
 * test/architecture/trajectory-event-types-known.test.ts.
 *
 * @module
 */

export interface TraceArtifactsRunState {
  readonly finalStatus: string;
  readonly aborted: boolean;
  readonly timedOut?: boolean;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  };
  readonly cumulativeCostUsd: number;
  readonly compactionCount?: number;
  readonly lastToolError?: {
    readonly toolName: string;
    readonly errorText: string;
    readonly durationMs: number;
  };
  readonly turnCount: number;
  readonly durationMs?: number;
}

export interface TraceArtifactsPayload extends Record<string, unknown> {
  readonly finalStatus: string;
  readonly aborted: boolean;
  readonly timedOut?: boolean;
  readonly usage: Record<string, number>;
  readonly promptCacheHitRate?: number;
  readonly cumulativeCostUsd: number;
  readonly compactionCount?: number;
  readonly lastToolError?: Record<string, unknown>;
  readonly turnCount: number;
  readonly durationMs?: number;
}

function clampFloat(n: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

export function buildTraceArtifacts(runState: TraceArtifactsRunState): TraceArtifactsPayload {
  const { usage } = runState;
  const cacheBase = usage.cacheReadTokens + usage.inputTokens;
  const promptCacheHitRate =
    cacheBase > 0 ? clampFloat(usage.cacheReadTokens / cacheBase) : undefined;

  const out: Record<string, unknown> = {
    finalStatus: runState.finalStatus,
    aborted: runState.aborted,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
    cumulativeCostUsd: clampFloat(runState.cumulativeCostUsd),
    turnCount: runState.turnCount,
  };

  if (runState.timedOut !== undefined) out.timedOut = runState.timedOut;
  if (promptCacheHitRate !== undefined) out.promptCacheHitRate = promptCacheHitRate;
  if (runState.compactionCount !== undefined) out.compactionCount = runState.compactionCount;
  if (runState.lastToolError !== undefined) out.lastToolError = { ...runState.lastToolError };
  if (runState.durationMs !== undefined) out.durationMs = runState.durationMs;

  return out as TraceArtifactsPayload;
}
