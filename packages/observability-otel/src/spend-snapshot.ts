// SPDX-License-Identifier: Apache-2.0
/**
 * The structural read-only spend-snapshot contract the daemon threads from the
 * 177 `SpendAccumulator` (`@comis/agent`) into this extension's `comis_spend_*`
 * observable gauges.
 *
 * Declared structurally (NOT imported from `@comis/agent`) so the extension does
 * not take a build-graph dependency on `@comis/agent` — the daemon, which owns
 * both references, injects the live accumulator (whose `getSnapshot()` shape is
 * byte-identical to this). Mirrors `SpendAccumulator.getSnapshot()` (178-01 Task
 * 3): content-free dollar counts keyed by the `${tenantId} ${agentId}` /
 * `tenantId` scope keys.
 *
 * Lives in its own module (not inlined in `index.ts`) so both the barrel and the
 * `metric-mapping.ts` gauge wiring import the SAME type without a cycle.
 *
 * @module
 */

/**
 * A read-only spend-totals accessor (the `comis_spend_*` gauge source). The maps
 * are fresh copies on the accumulator side — a caller cannot corrupt the
 * kill-switch counters (T-178-02). `perAgent` reflects BOTH billed spend and
 * in-flight reservations.
 */
export interface SpendSnapshotReader {
  /** A read-only view of current spend totals (billed + in-flight reservations). */
  getSnapshot(): {
    readonly perAgent: ReadonlyMap<string, number>;
    readonly perTenant: ReadonlyMap<string, number>;
    readonly global: number;
  };
}
