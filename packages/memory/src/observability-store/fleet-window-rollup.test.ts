// SPDX-License-Identifier: Apache-2.0
/**
 * `reduceFleetWindow` — pure cross-session window-rollup reducer.
 *
 * The reducer folds the per-session rollups (`SessionSummaryRollup[]`) into a
 * single fleet aggregate: session count, degraded rate, merged +
 * capped top errorKinds, breaker-trip total, per-tool ok/failed, and cost — with
 * synthetic sessions (`source !== "runtime"`) excluded.
 *
 * THE LOAD-BEARING TEST is `excludes synthetic …`: it asserts the two
 * `excludeSynthetic` branches produce DIFFERENT counts (sessionCount 1 vs 2,
 * degradedRate 0 vs 0.5). If the exclusion were a no-op,
 * both branches would be byte-identical and the assertion would fail. The
 * filter therefore PROVABLY acts on the real `SessionSummaryRollup.source` field
 * threaded onto the row's `details` JSON — not a field that does not
 * exist.
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
    // name ASCENDING) ranks "timeout" before "validation_error" ('t' < 'v'), so
    // the cap (3) keeps "timeout" and drops "validation_error".
    expect(out.topErrorKinds.timeout).toBe(3);
    // The lower-ranked tied kind is dropped by the cap.
    expect(out.topErrorKinds).not.toHaveProperty("validation_error");
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

  it("exposes the ABSOLUTE degradedCount over the KEPT (synthetic-excluded) rows, reconciling with degradedRate", () => {
    // The reducer already excludes synthetic rows from every metric and
    // computes the absolute degraded count internally; it must EXPOSE that count
    // so the fleet handler's `sessions.degraded` shares the synthetic-excluded
    // population with `total` (sessionCount) and `degradedRate` — instead of
    // re-deriving degraded from the UNFILTERED rows (which double-counts a
    // synthetic degraded row). A `{degraded:true, source:"test"}` row must NOT
    // inflate degradedCount, and degradedCount/sessionCount must equal
    // degradedRate exactly.
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "r1", source: "runtime", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "r2", source: "runtime", degraded: false }),
      makeRollup({ sessionKey: "r3", source: "runtime", degraded: false }),
      // A SYNTHETIC degraded row — must be excluded from the absolute count.
      makeRollup({ sessionKey: "t1", source: "test", degraded: true, endReason: "output_starved" }),
    ];
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });

    // Only the runtime degraded row counts: 1, not 2.
    expect(out.degradedCount).toBe(1);
    // degradedCount is over the SAME kept population as sessionCount/degradedRate.
    expect(out.sessionCount).toBe(3);
    expect(out.degradedCount / out.sessionCount).toBeCloseTo(out.degradedRate);
    // The absolute count never exceeds the kept session total.
    expect(out.degradedCount).toBeLessThanOrEqual(out.sessionCount);
    // And it reconciles with sum(degradedByCause) (also synthetic-excluded).
    const sumByCause = Object.values(out.degradedByCause).reduce((a, b) => a + b, 0);
    expect(out.degradedCount).toBe(sumByCause);
    // The synthetic row's cause is absent from degradedByCause.
    expect(out.degradedByCause).not.toHaveProperty("output_starved");
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

  it("coerces non-finite / non-number nested values to finite numbers (NaN/string corruption guard)", () => {
    // A malformed row that bypassed query-layer validation (the reducer is a
    // public export reachable directly by the fleet handler, so it must not
    // trust its caller). `topErrorKinds.timeout` is a STRING and `toolStats.write`
    // is a number-instead-of-{ok,failed} — both would corrupt the arithmetic.
    const malformed = makeRollup({
      sessionKey: "malformed",
      // topErrorKinds value is a string → `0 + "5"` = "05" without coercion.
      topErrorKinds: { timeout: "5" as unknown as number },
      // toolStats value is a bare number → `acc.ok += s.ok` = NaN without coercion.
      toolStats: { write: 5 as unknown as { ok: number; failed: number } },
    });
    const valid = makeRollup({
      sessionKey: "valid",
      topErrorKinds: { timeout: 2 },
      toolStats: { Read: { ok: 3, failed: 1 } },
    });

    const out = reduceFleetWindow([malformed, valid], { excludeSynthetic: true });

    // topErrorKinds: the valid `2` survives; the string "5" is coerced to 0 (dropped
    // from the sum), so `timeout` is a FINITE number, never the string "25"/"05".
    expect(Number.isFinite(out.topErrorKinds.timeout)).toBe(true);
    expect(out.topErrorKinds.timeout).toBe(2);
    expect(typeof out.topErrorKinds.timeout).toBe("number");

    // toolStats: the bare-number `write` contributes finite zeros (not NaN); the
    // valid `Read` is summed normally.
    expect(out.toolStats.write).toEqual({ ok: 0, failed: 0 });
    expect(Number.isFinite(out.toolStats.write.ok)).toBe(true);
    expect(Number.isFinite(out.toolStats.write.failed)).toBe(true);
    expect(out.toolStats.Read).toEqual({ ok: 3, failed: 1 });

    // No NaN anywhere in the numeric outputs.
    expect(Number.isFinite(out.costUsd)).toBe(true);
    expect(Number.isFinite(out.breakerTripTotal)).toBe(true);
    expect(Number.isFinite(out.degradedRate)).toBe(true);
  });

  it("emits toolStats keys in a deterministic (name-asc) order independent of input ordering", () => {
    // Two rows whose tool names sort differently from their insertion order.
    const rowsA: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "s1", toolStats: { zzz: { ok: 1, failed: 0 } } }),
      makeRollup({ sessionKey: "s2", toolStats: { aaa: { ok: 1, failed: 0 } } }),
    ];
    // The SAME logical rollups, traversed in the OPPOSITE order.
    const rowsB: SessionSummaryRollup[] = [...rowsA].reverse();

    const outA = reduceFleetWindow(rowsA, { excludeSynthetic: true });
    const outB = reduceFleetWindow(rowsB, { excludeSynthetic: true });

    // The toolStats KEY ENUMERATION ORDER must be byte-identical across the two
    // input permutations (deepEqual is key-order-insensitive, so assert the key
    // arrays directly — and that they are sorted name-ascending).
    expect(Object.keys(outA.toolStats)).toEqual(["aaa", "zzz"]);
    expect(Object.keys(outB.toolStats)).toEqual(["aaa", "zzz"]);
    expect(Object.keys(outA.toolStats)).toEqual(Object.keys(outB.toolStats));
    // A JSON serialization (cache-key / wire-digest consumer) is byte-stable.
    expect(JSON.stringify(outA.toolStats)).toBe(JSON.stringify(outB.toolStats));
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

  // ------------------------------------------------------------------------
  // degradedByCause: the fleet-level detector ("N sessions degraded
  // by context_exhausted, M by output_starved" over the window).
  // ------------------------------------------------------------------------

  it("counts degraded sessions BY endReason cause — only degraded rows contribute", () => {
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "s1", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "s2", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "s3", degraded: true, endReason: "output_starved" }),
      makeRollup({ sessionKey: "s4", degraded: true, endReason: "error" }),
      // A NON-degraded session — its endReason (success) must NOT be counted.
      makeRollup({ sessionKey: "s5", degraded: false, endReason: "success" }),
    ];
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });

    expect(out.degradedByCause).toEqual({
      context_exhausted: 2,
      output_starved: 1,
      error: 1,
    });
    // The clean session's "success" is never a degradation cause.
    expect(out.degradedByCause).not.toHaveProperty("success");
  });

  it("counts `completed_with_tool_errors` sessions in deliveredWithToolErrorsCount (a SUBSET of degradedCount) — the user still got a reply", () => {
    // The live friction: a fleet of turns that DELIVERED a final answer despite a
    // (recovered/acknowledged) tool error read as high-degraded. `completed_with_
    // tool_errors` means a clean finish WITH tool errors — softer than a hard
    // failure (no reply). Split it so the fleet finding reports the HARD rate.
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "d1", degraded: true, endReason: "completed_with_tool_errors" }),
      makeRollup({ sessionKey: "d2", degraded: true, endReason: "completed_with_tool_errors" }),
      // Genuine hard failures — the user got a degraded/no reply.
      makeRollup({ sessionKey: "h1", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "h2", degraded: true, endReason: "error" }),
      makeRollup({ sessionKey: "ok", degraded: false, endReason: "success" }),
    ];
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });

    expect(out.sessionCount).toBe(5);
    expect(out.degradedCount).toBe(4); // invariant preserved: still counts every degraded row
    expect(out.deliveredWithToolErrorsCount).toBe(2); // the delivered-with-tool-errors subset
    // degradedByCause still buckets it (visible in the breakdown, invariant sum==degradedCount).
    expect(out.degradedByCause.completed_with_tool_errors).toBe(2);
    // The HARD degraded count (what actually failed the user) = 4 - 2 = 2.
    expect(out.degradedCount - out.deliveredWithToolErrorsCount).toBe(2);
  });

  it("deliveredWithToolErrorsCount is 0 when no session finished completed_with_tool_errors", () => {
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "h", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "ok", degraded: false, endReason: "success" }),
    ];
    expect(reduceFleetWindow(rows, { excludeSynthetic: true }).deliveredWithToolErrorsCount).toBe(0);
  });

  it("excludes synthetic rows from degradedByCause (the metric-integrity filter)", () => {
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "r", source: "runtime", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "t", source: "test", degraded: true, endReason: "output_starved" }),
    ];
    const excluded = reduceFleetWindow(rows, { excludeSynthetic: true });
    const included = reduceFleetWindow(rows, { excludeSynthetic: false });

    expect(excluded.degradedByCause).toEqual({ context_exhausted: 1 });
    expect(excluded.degradedByCause).not.toHaveProperty("output_starved");
    // Counter-assertion: the two branches differ (no no-op trap).
    expect(included.degradedByCause).toEqual({ context_exhausted: 1, output_starved: 1 });
  });

  it("a degraded row with a missing/blank endReason folds into an 'unknown' cause (never a crash)", () => {
    // The reducer is a public export reachable directly by the handler — a row
    // whose endReason field is absent (pre-change persisted rows) or blank must
    // still be COUNTED as degraded, bucketed under a stable 'unknown' label.
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "s1", degraded: true }), // endReason omitted
      makeRollup({ sessionKey: "s2", degraded: true, endReason: "" }),
      makeRollup({ sessionKey: "s3", degraded: true, endReason: "context_exhausted" }),
    ];
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });
    expect(out.degradedByCause.unknown).toBe(2);
    expect(out.degradedByCause.context_exhausted).toBe(1);
  });

  it("keeps EVERY distinct degraded cause in a window — the cap covers the full closed endReason union, so no real cause is silently dropped", () => {
    // The cap must cover the FULL closed degraded-cause union so a
    // pathological window that touches every cause cannot silently drop the
    // lowest-count tail (which would understate sum(degradedByCause) vs
    // sessions.degraded with no truncations[] breadcrumb). The reachable
    // degraded causes are the 9 non-"success" members of the sessionEnd.endReason
    // union (error, timeout, budget_exceeded, budget_exhausted, circuit_open,
    // provider_degraded, completed_with_tool_errors, context_exhausted,
    // output_starved) PLUS the defensive "unknown" bucket = 10 distinct causes.
    const degradedCauses = [
      "error",
      "timeout",
      "budget_exceeded",
      "budget_exhausted",
      "circuit_open",
      "provider_degraded",
      "completed_with_tool_errors",
      "context_exhausted",
      "output_starved",
      "unknown",
    ] as const;
    // One degraded session per distinct cause (each count == 1) — the worst case
    // for a cap (no cause is "more important" by count, so any drop is arbitrary).
    const rows: SessionSummaryRollup[] = degradedCauses.map((cause, i) =>
      makeRollup({
        sessionKey: `s${i}`,
        degraded: true,
        // The "unknown" cause is produced by a blank endReason (the reducer's
        // UNKNOWN_CAUSE fold), exactly as a real missing-endReason row would be.
        endReason: cause === "unknown" ? "" : cause,
      }),
    );
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });

    // Every distinct degraded cause is present — none silently dropped.
    expect(Object.keys(out.degradedByCause).length).toBe(degradedCauses.length);
    for (const cause of degradedCauses) {
      expect(out.degradedByCause[cause]).toBe(1);
    }
    // sum(degradedByCause) reconciles with the absolute degraded count (no drop).
    const sumByCause = Object.values(out.degradedByCause).reduce((a, b) => a + b, 0);
    expect(sumByCause).toBe(out.degradedCount);
    expect(out.degradedCount).toBe(degradedCauses.length);
  });

  it("is deterministic + bounded: degradedByCause is capped and key-order-stable across input permutations", () => {
    // Distinct causes with differing counts so the top-N selection + tie-break
    // are deterministic. The cap covers the full closed degraded-cause union
    // (10), so these 5 distinct causes are within bound — the bound is
    // asserted explicitly below; the determinism/key-order pins are the focus.
    const rows: SessionSummaryRollup[] = [
      makeRollup({ sessionKey: "a", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "b", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "c", degraded: true, endReason: "context_exhausted" }),
      makeRollup({ sessionKey: "d", degraded: true, endReason: "output_starved" }),
      makeRollup({ sessionKey: "e", degraded: true, endReason: "output_starved" }),
      makeRollup({ sessionKey: "f", degraded: true, endReason: "error" }),
      makeRollup({ sessionKey: "g", degraded: true, endReason: "circuit_open" }),
      makeRollup({ sessionKey: "h", degraded: true, endReason: "budget_exhausted" }),
    ];
    const out = reduceFleetWindow(rows, { excludeSynthetic: true });
    const reversed = reduceFleetWindow([...rows].reverse(), { excludeSynthetic: true });

    // Bounded against DoS — the cap covers the closed degraded-cause union (10).
    expect(Object.keys(out.degradedByCause).length).toBeLessThanOrEqual(10);
    // The highest-count cause is always retained.
    expect(out.degradedByCause.context_exhausted).toBe(3);
    expect(out.degradedByCause.output_starved).toBe(2);
    // Key-order-stable across input permutations (cache-key / wire-digest safe).
    expect(Object.keys(out.degradedByCause)).toEqual(Object.keys(reversed.degradedByCause));
    expect(JSON.stringify(out.degradedByCause)).toBe(JSON.stringify(reversed.degradedByCause));
  });
});
