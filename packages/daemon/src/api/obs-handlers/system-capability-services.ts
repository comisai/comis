// SPDX-License-Identifier: Apache-2.0
/**
 * The capability-service / managed-run slice of the system-health digest.
 *
 * A pure fold over the durable managed-run status counts
 * (`ManagedRunStorePort.countByStatus`) into the optional `capabilityServices`
 * section of the {@link SystemHealthReport}. It mirrors the autonomy slice's
 * honest-omit discipline: absent counts (the offline CLI, a store-read error) or
 * a window with no managed-run activity omit the block entirely, so a daemon
 * that never used a capability service carries no empty section.
 *
 * Content-free by construction: it emits counts, closed status-reason codes, and
 * one opaque host-minted run id — never a body, path, or objective.
 *
 * @module
 */
import type { ManagedRunHealthCounts, SystemHealthReport } from "@comis/core";

/** How many degraded reason codes the slice carries. Bounded like every digest field. */
const TOP_REASON_CODE_CAP = 5;

/** The statuses that count as degradation. A cancelled run is an intended outcome. */
const DEGRADED_STATUSES = ["failed", "unknown"] as const;

/**
 * Fold the durable managed-run counts into the optional `capabilityServices`
 * block, or `undefined` when there is nothing to report.
 */
export function computeCapabilityServicesSlice(
  counts: ManagedRunHealthCounts | undefined,
): SystemHealthReport["capabilityServices"] {
  if (counts === undefined) return undefined;
  const total = Object.values(counts.byStatus).reduce((sum, count) => sum + count, 0);
  // Honest omit: no managed-run activity in the window means nothing to diagnose,
  // and a daemon with no capability services would otherwise carry an empty block.
  if (total === 0) return undefined;
  const degraded = DEGRADED_STATUSES.reduce((sum, status) => sum + counts.byStatus[status], 0);
  const topReasonCodes = Object.entries(counts.degradedReasonCodes)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, TOP_REASON_CODE_CAP)
    .map(([code, count]) => ({ code, count }));
  return {
    runs: { total, degraded, degradedRate: degraded / total },
    services: { total: counts.distinctServiceInstances, degraded: counts.degradedServiceInstances },
    topReasonCodes,
    ...(counts.worstManagedRunId === undefined ? {} : { worstManagedRunId: counts.worstManagedRunId }),
  };
}
