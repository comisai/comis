// SPDX-License-Identifier: Apache-2.0
/** Content-free cache and restart lifecycle folds for `obs.explain`. */
import type { Acc } from "./obs-explain-signals-acc.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Aggregate cache invalidation cost and token-drop evidence by reason. */
export function accumulateCacheBreak(acc: Acc, data: Record<string, unknown>): void {
  const reason = asString(data.reason) ?? "unknown";
  const estCostUsd = asNumber(data.estCostUsd) ?? 0;
  const tokenDrop = asNumber(data.tokenDrop) ?? 0;
  const previous = acc.cacheBreaksByReason.get(reason) ?? {
    count: 0,
    estCostUsd: 0,
    tokenDrop: 0,
  };
  acc.cacheBreaksByReason.set(reason, {
    count: previous.count + 1,
    estCostUsd: previous.estCostUsd + estCostUsd,
    tokenDrop: previous.tokenDrop + tokenDrop,
  });
}

/** Fold one durable suspension or recovery into a bounded restart summary. */
export function accumulateRestartRecovery(
  acc: Acc,
  type: "durable.suspended" | "durable.resumed",
  data: Record<string, unknown>,
): void {
  const rootRunId = asString(data.rootRunId);
  const checkpointId = asString(data.checkpointId);
  if (rootRunId === undefined || checkpointId === undefined) return;
  const previous = acc.restartRecovery ?? {
    suspended: 0,
    resumed: 0,
    lastStatus: "suspended" as const,
    rootRunId,
    checkpointId,
  };
  const lastStatus = type === "durable.resumed" ? "resumed" as const : "suspended" as const;
  acc.restartRecovery = {
    suspended: previous.suspended + Number(type === "durable.suspended"),
    resumed: previous.resumed + Number(type === "durable.resumed"),
    lastStatus,
    rootRunId,
    checkpointId,
  };
}
