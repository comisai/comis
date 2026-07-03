// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { rehydrateSpendFromStore } from "./setup-spend-rehydration.js";

// ---------------------------------------------------------------------------
// rehydrateSpendFromStore — the boot-root spend-rehydration helper.
// Pure + unit-testable without booting the daemon. obsStore is undefined when
// persistence is disabled → no rehydration source → accumulator starts at $0
// (honest degradation, NOT a bug).
// ---------------------------------------------------------------------------
describe("rehydrateSpendFromStore", () => {
  it("rehydrates the accumulator ONCE with the boot rows mapped from getRollingSpendUsd", () => {
    const acc = { rehydrate: vi.fn(), recordSpend: vi.fn(), checkAndReserve: vi.fn(), reconcile: vi.fn() };
    const obsStore = {
      getRollingSpendUsd: vi.fn(() => [
        { agentId: "agent-1", totalCostUsd: 1.25 },
        { agentId: "agent-2", totalCostUsd: 3.5 },
      ]),
    };

    rehydrateSpendFromStore(acc as any, obsStore as any, 24 * 60 * 60 * 1000);

    expect(obsStore.getRollingSpendUsd).toHaveBeenCalledWith(24 * 60 * 60 * 1000);
    expect(acc.rehydrate).toHaveBeenCalledTimes(1);
    // global + per-agent seeded; tenantId is a placeholder at boot (obs_token_usage has no tenant_id column).
    expect(acc.rehydrate).toHaveBeenCalledWith([
      { agentId: "agent-1", tenantId: "default", costUsd: 1.25 },
      { agentId: "agent-2", tenantId: "default", costUsd: 3.5 },
    ]);
  });

  it("no-ops when obsStore is undefined (persistence disabled → accumulator starts at $0)", () => {
    const acc = { rehydrate: vi.fn(), recordSpend: vi.fn(), checkAndReserve: vi.fn(), reconcile: vi.fn() };

    rehydrateSpendFromStore(acc as any, undefined, 24 * 60 * 60 * 1000);

    expect(acc.rehydrate).not.toHaveBeenCalled();
  });
});
