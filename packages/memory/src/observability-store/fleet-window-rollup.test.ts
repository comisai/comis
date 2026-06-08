// SPDX-License-Identifier: Apache-2.0
/**
 * `reduceFleetWindow` — pure cross-session window-rollup reducer (A2).
 *
 * The reducer folds the per-session A1 rollups (`SessionSummaryRollup[]` from
 * 159-01) into a single fleet aggregate: session count, degraded rate, merged +
 * capped top errorKinds, breaker-trip total, per-tool ok/failed, and cost — with
 * synthetic sessions (`source !== "runtime"`) excluded.
 *
 * THE LOAD-BEARING TEST is `excludes synthetic …`: it asserts the two
 * `excludeSynthetic` branches produce DIFFERENT counts (sessionCount 1 vs 2,
 * degradedRate 0 vs 0.5). If the exclusion were a no-op (the Phase-158 gap-gate
 * trap), both branches would be byte-identical and the assertion would fail. The
 * filter therefore PROVABLY acts on the real `SessionSummaryRollup.source` field
 * that 159-01 threaded onto the row's `details` JSON — not a field that does not
 * exist.
 *
 * RED on pre-patch code: `./fleet-window-rollup.js` does not exist, so the import
 * of `reduceFleetWindow` / `FleetWindowRollup` fails to resolve.
 */
import { describe, it, expect } from "vitest";
import { reduceFleetWindow } from "./fleet-window-rollup.js";
import type { FleetWindowRollup } from "./fleet-window-rollup.js";
import type { SessionSummaryRollup } from "./observability-store-types.js";

function makeRollup(overrides: Partial<SessionSummaryRollup> = {}): SessionSummaryRollup {
  return {
    sessionKey: "sess-default",
    lastTs: 1_700_000_000_000,
    degraded: false,
    costUsd: 0,
    toolStats: {},
    breakerTripCount: 0,
    turnCount: 0,
    topErrorKinds: {},
    source: "runtime",
    ...overrides,
  };
}

describe("reduceFleetWindow", () => {
  it("excludes synthetic rows from every aggregate — and the two flag-branches DIFFER (no-op-trap guard)", () => {
    // A clean RUNTIME session (the legitimate fleet member).
    const runtimeRow = makeRollup({
      sessionKey: "sess-runtime",
      source: "runtime",
      degraded: false,
      costUsd: 1,
      breakerTripCount: 0,
      toolStats: { Read: { ok: 3, failed: 0 } },
      topErrorKinds: {},
    });
    // A SYNTHETIC (test) session with a distinct errorKind, a breaker trip, a
    // tool failure, and degraded:true — everything that would pollute the
    // operator-facing fleet metric if it leaked through.
    const syntheticRow = makeRollup({
      sessionKey: "sess-synthetic",
      source: "test",
      degraded: true,
      costUsd: 99,
      breakerTripCount: 5,
      toolStats: { Bash: { ok: 0, failed: 7 } },
      topErrorKinds: { synthetic_only_kind: 4 },
    });

    const excluded = reduceFleetWindow([runtimeRow, syntheticRow], { excludeSynthetic: true });
    const included = reduceFleetWindow([runtimeRow, syntheticRow], { excludeSynthetic: false });

    // --- excludeSynthetic: true — the synthetic row vanishes from every field. ---
    expect(excluded.sessionCount).toBe(1);
    expect(excluded.degradedRate).toBe(0); // the only kept session is non-degraded
    expect(excluded.breakerTripTotal).toBe(0); // the synthetic 5 trips are excluded
    expect(excluded.costUsd).toBe(1); // the synthetic $99 is excluded
    // The synthetic-only errorKind must be ABSENT from the merged map.
    expect(excluded.topErrorKinds).not.toHaveProperty("synthetic_only_kind");
    // The synthetic-only failing tool must be ABSENT from the merged tool stats.
    expect(excluded.toolStats).not.toHaveProperty("Bash");
    expect(excluded.toolStats.Read).toEqual({ ok: 3, failed: 0 });

    // --- COUNTER-ASSERTION: excludeSynthetic: false includes the synthetic row. ---
    expect(included.sessionCount).toBe(2);
    expect(included.degradedRate).toBe(0.5); // 1 of 2 sessions degraded
    expect(included.breakerTripTotal).toBe(5);
    expect(included.costUsd).toBe(100);
    expect(included.topErrorKinds).toHaveProperty("synthetic_only_kind", 4);
    expect(included.toolStats).toHaveProperty("Bash", { ok: 0, failed: 7 });

    // --- THE PIN: the two branches MUST differ. If the exclusion were a no-op,
    // these would be byte-identical and the filter would be meaningless. ---
    expect(excluded.sessionCount).not.toBe(included.sessionCount);
    expect(excluded.degradedRate).not.toBe(included.degradedRate);
  });

  it("excludes every non-runtime source value (test AND bench), not just one", () => {
    const runtimeRow = makeRollup({ sessionKey: "r", source: "runtime" });
    const testRow = makeRollup({ sessionKey: "t", source: "test" });
    const benchRow = makeRollup({ sessionKey: "b", source: "bench" });

    const out = reduceFleetWindow([runtimeRow, testRow, benchRow], { excludeSynthetic: true });
    // Only the single runtime row survives the filter.
    expect(out.sessionCount).toBe(1);

    // Without the filter, all three are counted.
    const all = reduceFleetWindow([runtimeRow, testRow, benchRow], { excludeSynthetic: false });
    expect(all.sessionCount).toBe(3);
  });

  it("merges topErrorKinds across sessions and caps the merged map to the top-N by summed count", () => {
    // Three runtime rows spanning >3 distinct kinds with differing total counts.
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "s1", topErrorKinds: { provider_error: 5, timeout: 1 } }),
      makeRollup({ sessionKey: "s2", topErrorKinds: { provider_error: 2, rate_limit: 4 } }),
      makeRollup({ sessionKey: "s3", topErrorKinds: { validation_error: 3, timeout: 2 } }),
    ];
    // Summed: provider_error=7, rate_limit=4, validation_error=3, timeout=3.
    // Five distinct kinds collapse; the cap (3) keeps the top three by count.
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });

    expect(Object.keys(out.topErrorKinds).length).toBe(3);
    expect(out.topErrorKinds.provider_error).toBe(7); // merged 5+2
    expect(out.topErrorKinds.rate_limit).toBe(4);
    // validation_error and timeout TIE at 3 — the deterministic tie-break (kind
    // name ascending) keeps "timeout" out and "validation_error" in.
    expect(out.topErrorKinds.validation_error).toBe(3);
    // The two lowest-ranked kinds are dropped by the cap.
    expect(out.topErrorKinds).not.toHaveProperty("timeout");
  });

  it("sums per-tool ok/failed across overlapping tool names and sums per-session cost", () => {
    const rows: SessionSummaryRollup[] = [
      makeRollup({
        sessionKey: "s1",
        costUsd: 0.25,
        toolStats: { Read: { ok: 2, failed: 1 }, Bash: { ok: 5, failed: 0 } },
      }),
      makeRollup({
        sessionKey: "s2",
        costUsd: 0.75,
        toolStats: { Read: { ok: 3, failed: 2 }, Grep: { ok: 1, failed: 0 } },
      }),
    ];
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });

    expect(out.toolStats.Read).toEqual({ ok: 5, failed: 3 }); // 2+3 ok, 1+2 failed
    expect(out.toolStats.Bash).toEqual({ ok: 5, failed: 0 });
    expect(out.toolStats.Grep).toEqual({ ok: 1, failed: 0 });
    expect(out.costUsd).toBeCloseTo(1.0, 10);
  });

  it("computes degradedRate as degraded/total over the KEPT runtime sessions", () => {
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "s1", degraded: true }),
      makeRollup({ sessionKey: "s2", degraded: false }),
      makeRollup({ sessionKey: "s3", degraded: true }),
      makeRollup({ sessionKey: "s4", degraded: false }),
    ];
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });
    expect(out.sessionCount).toBe(4);
    expect(out.degradedRate).toBe(0.5); // 2 of 4
  });

  it("returns degradedRate 0 (no divide-by-zero) when sessionCount is 0", () => {
    // All-synthetic input under excludeSynthetic:true → zero kept sessions.
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "t1", source: "test", degraded: true }),
      makeRollup({ sessionKey: "t2", source: "bench", degraded: true }),
    ];
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });
    expect(out.sessionCount).toBe(0);
    expect(out.degradedRate).toBe(0);
    expect(out.breakerTripTotal).toBe(0);
    expect(out.costUsd).toBe(0);
    expect(out.topErrorKinds).toEqual({});
    expect(out.toolStats).toEqual({});

    // Empty input is likewise safe.
    const empty = reduceFleetWindow([], { excludeSynthetic: true });
    expect(empty.sessionCount).toBe(0);
    expect(empty.degradedRate).toBe(0);
  });

  it("is deterministic: same input rows → deeply-equal output, with ties broken by kind name", () => {
    // Build kinds that tie on count so the ordering can only be stable if the
    // tie-break is deterministic (kind name ascending), independent of input order.
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "s1", topErrorKinds: { zeta: 2, alpha: 2 } }),
      makeRollup({ sessionKey: "s2", topErrorKinds: { mike: 2, bravo: 2 } }),
    ];
    const first: FleetWindowRollup = reduceFleetWindow(rows, { excludeSynthetic: true });
    const second: FleetWindowRollup = reduceFleetWindow(rows, { excludeSynthetic: true });
    expect(first).toEqual(second);

    // All four kinds tie at count 2; the cap (3) keeps the three lexicographically
    // smallest names: alpha, bravo, mike (zeta is dropped).
    expect(Object.keys(first.topErrorKinds)).toEqual(["alpha", "bravo", "mike"]);
    expect(first.topErrorKinds).not.toHaveProperty("zeta");

    // Reversing the input row order must not change the capped output (no
    // iteration-order dependence).
    const reversed = reduceFleetWindow([...rows].reverse(), { excludeSynthetic: true });
    expect(reversed).toEqual(first);
  });
});
