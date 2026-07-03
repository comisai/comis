// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-root rehydration of the daemon-wide spend accumulator (the dollars
 * kill-switch). This is a SEPARATE module from `setup-observability.ts`
 * because `getRollingSpendUsd` lives on `obsStore`, which the daemon builds
 * ~60-90 lines AFTER the `setupObservability(...)` call (and only when
 * `observability.persistence.enabled`). So the accumulator is CONSTRUCTED in
 * `setupObservability` (it needs only clock + config + eventBus), and REHYDRATED
 * here at the boot composition root once `obsStore` exists.
 *
 * Pure + unit-testable without booting the daemon.
 * @module
 */
import type { SpendAccumulator } from "@comis/agent";
import type { ObservabilityStore } from "@comis/memory";

/**
 * Seed the daemon-wide spend accumulator from the persisted rolling dollars —
 * called from daemon.ts AFTER `obsStore` exists.
 *
 * NO-OPS when `obsStore` is `undefined` (persistence disabled): there is then NO
 * durable source to rehydrate, so the accumulator starts at $0 and re-accrues
 * live from the `recordSpend` subscriber — a documented honest degradation, NOT
 * a bug.
 *
 * Known limitation: `obs_token_usage` has no `tenant_id` column, so the boot read groups by
 * `agent_id` only. Global + per-agent are seeded from the persisted dollars;
 * per-tenant accrues live-from-boot (the boot rows carry a placeholder
 * `tenantId: "default"`). Exact historical per-tenant would need a forward-only
 * `tenant_id` column — out of scope.
 */
export function rehydrateSpendFromStore(
  accumulator: SpendAccumulator,
  obsStore: ObservabilityStore | undefined,
  windowMs: number,
): void {
  if (!obsStore) return; // persistence disabled → no rehydration source → start at $0 (honest).
  const bootRows = obsStore
    .getRollingSpendUsd(windowMs)
    .map((r) => ({ agentId: r.agentId, tenantId: "default", costUsd: r.totalCostUsd }));
  accumulator.rehydrate(bootRows);
}
