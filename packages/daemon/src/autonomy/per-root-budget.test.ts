// SPDX-License-Identifier: Apache-2.0
/**
 * Contract for the per-`rootRunId` aggregate budget meter.
 *
 * The cost-bound limb of the bounded-autonomy floor: three limbs that abort a
 * self-spawning loop on ANY of $ / token / wall-clock. The $-limb REUSES the
 * 3-state pricing gate (`checkSpendCeiling` + `resolvePricingState`)
 * VERBATIM — re-scoped to the `rootRunId` (scope `{ tenantId: "_root", agentId:
 * rootRunId }`) — so the unknown=uncountable (not $0) behavior and the
 * fail-closed $-cap refusal on unknown pricing are inherited, not re-implemented.
 * The NET-NEW value is (a) the per-root scope, (b) a token limb, (c) a per-root
 * wall-clock deadline — the three that bite a zero-price (subscription)
 * native-provider loop where the $-cap cannot.
 *
 * Pins:
 *   - the token limb accumulates per root and trips when the running total exceeds
 *     `tokens`,
 *   - the wall-clock limb anchors at `registerRoot` and trips when
 *     `clock.now() - startMs > wallClockMs` (FakeClock-driven, no Date.now),
 *   - the zero-price model (anthropic native + no catalog entry → "unknown"):
 *     the $-limb returns `unpriceable` (NOT $0), AND the token/wall-clock limbs
 *     STILL enforce,
 *   - the free model (ollama → "free"): the $-limb never trips, but the
 *     token/wall-clock limbs STILL apply (a free model is not DoS-immune to time),
 *   - the priced reserve: under the caps → ok; over the $-cap → exceeded,
 *   - two roots have independent token + $ totals (cross-root isolation).
 *
 * All time is the injected `createFakeClock` (the globals gate); the meter returns
 * a `SpendGateOutcome`, never throwing (the raw-throw gate).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { SpendGateOutcome } from "@comis/agent";
import { createFakeClock, type FakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createPerRootBudget, type PerRootBudget } from "./per-root-budget.js";

// Pricing-state fixtures (verified against resolvePricingState at HEAD):
//   anthropic + a no-catalog model → "unknown" (the zero-price chimera)
//   ollama + anything             → "free" (gateway/local — $0 is honest)
//   anthropic + a catalog model    → "priced"
const ZERO_PRICE_PROVIDER = "anthropic";
const ZERO_PRICE_MODEL = "zzz-nonexistent-model-xyz"; // no catalog entry → "unknown"
const FREE_PROVIDER = "ollama";
const FREE_MODEL = "llama3";
const PRICED_PROVIDER = "anthropic";
const PRICED_MODEL = "claude-sonnet-4-5-20250929"; // catalog-priced

/** Build the SUT with sane caps; each test overrides the limb it exercises. */
function makeBudget(
  overrides: Partial<{ aggregateUsd: number; tokens: number; wallClockMs: number }> = {},
): { budget: PerRootBudget; clock: FakeClock } {
  const clock = createFakeClock(1_000_000);
  const budget = createPerRootBudget({
    clock,
    config: {
      aggregateUsd: overrides.aggregateUsd ?? 100,
      tokens: overrides.tokens ?? 1_000_000,
      wallClockMs: overrides.wallClockMs ?? 3_600_000,
    },
    logger: createMockLogger(),
  });
  return { budget, clock };
}

describe("per-root-budget — $/token/wall-clock limbs reusing the 3-state gate", () => {
  it("trips the per-root token limb when the accumulated token total exceeds the cap", () => {
    const { budget } = makeBudget({ tokens: 1000 });
    budget.registerRoot("root-T");

    // 600 + 600 > 1000 → the second reserve trips the token limb.
    const first = budget.reserveBudget("root-T", FREE_PROVIDER, FREE_MODEL, 0, 600);
    expect(first.kind).not.toBe("exceeded");

    const second = budget.reserveBudget("root-T", FREE_PROVIDER, FREE_MODEL, 0, 600);
    expect(second.kind).toBe("exceeded");
    if (second.kind === "exceeded") {
      // The error reports the token cap that was breached (the limb's own cap).
      expect(second.error.capUsd).toBe(1000);
    }
  });

  it("trips the per-root wall-clock limb once the FakeClock advances past the deadline", () => {
    const wallClockMs = 60_000;
    const { budget, clock } = makeBudget({ wallClockMs });
    budget.registerRoot("root-W");

    // At t0 (registration), well within the deadline → not exceeded.
    const atStart = budget.reserveBudget("root-W", FREE_PROVIDER, FREE_MODEL, 0, 1);
    expect(atStart.kind).not.toBe("exceeded");

    // Advance past the per-root deadline → the wall-clock limb trips,
    // enforced regardless of pricing (a free model is used here).
    clock.advance(wallClockMs + 1);
    const afterDeadline = budget.reserveBudget("root-W", FREE_PROVIDER, FREE_MODEL, 0, 1);
    expect(afterDeadline.kind).toBe("exceeded");
    if (afterDeadline.kind === "exceeded") {
      expect(afterDeadline.error.capUsd).toBe(wallClockMs);
    }
  });

  it("surfaces unpriceable for a zero-price native model while the token and wall-clock limbs still enforce", () => {
    // The zero-price chimera case: a native provider with no catalog entry burning tokens.
    const { budget, clock } = makeBudget({ tokens: 1000, wallClockMs: 60_000 });
    budget.registerRoot("root-Z");

    // The $-limb REFUSES (fail-closed): unpriceable, NOT a silent ok with $0 counted.
    const priced = budget.reserveBudget("root-Z", ZERO_PRICE_PROVIDER, ZERO_PRICE_MODEL, 5, 100);
    expect(priced.kind).toBe("unpriceable");

    // The token limb STILL enforces despite the unknown price: push over 1000 tokens.
    const overTokens = budget.reserveBudget("root-Z", ZERO_PRICE_PROVIDER, ZERO_PRICE_MODEL, 5, 1000);
    expect(overTokens.kind).toBe("exceeded");

    // And the wall-clock limb STILL enforces on a fresh zero-price root.
    budget.registerRoot("root-Z2");
    clock.advance(60_001);
    const overWall = budget.reserveBudget("root-Z2", ZERO_PRICE_PROVIDER, ZERO_PRICE_MODEL, 5, 1);
    expect(overWall.kind).toBe("exceeded");
  });

  it("brands a per-root $-limb trip with limb aggregateUsd + unit usd so the abort event names the exact knob", () => {
    const { budget } = makeBudget({ aggregateUsd: 1.0 });
    budget.registerRoot("root-D");

    // Two priced reserves: the first fits, the second crosses the $1 cap.
    const first = budget.reserveBudget("root-D", PRICED_PROVIDER, PRICED_MODEL, 0.6, 100);
    expect(first.kind).toBe("ok");
    const second = budget.reserveBudget("root-D", PRICED_PROVIDER, PRICED_MODEL, 0.6, 100);
    expect(second.kind).toBe("exceeded");
    if (second.kind === "exceeded") {
      // checkSpendCeiling's SpendError is shared with the daemon-wide
      // observability.spend ceiling and carries no limb. Without the per-root
      // $-branch branding its own trip, the execution.aborted record has no
      // perRootBudget payload and the explain spend verdict points the operator
      // at observability.spend.* — the wrong knob tree for a per-root trip
      // (observed live). The $-limb must self-identify like the token and
      // wall-clock limbs do.
      expect(second.error.limb).toBe("aggregateUsd");
      expect(second.error.unit).toBe("usd");
      expect(second.error.currentUsd).toBeCloseTo(0.6);
      expect(second.error.capUsd).toBe(1.0);
    }
  });

  it("fires onLimbWarning ONCE per root+limb when the token limb crosses 80% of its cap", () => {
    // The wedge arrived with zero warning (observed live): the meter enforced
    // silently until the abort. A once-per-(root,limb) pre-trip warning gives
    // the fleet lens a health signal BEFORE the session dies.
    const clock = createFakeClock(1_000_000);
    const warnings: Array<{ rootRunId: string; limb: string; spent: number; cap: number; unit: string }> = [];
    const budget = createPerRootBudget({
      clock,
      config: { aggregateUsd: 100, tokens: 1_000, wallClockMs: 3_600_000 },
      logger: createMockLogger(),
      onLimbWarning: (w) => { warnings.push(w); },
    });
    budget.registerRoot("root-W80");

    // 500/1000 = 50% -> no warning yet.
    budget.reserveBudget("root-W80", FREE_PROVIDER, FREE_MODEL, 0, 500);
    expect(warnings).toHaveLength(0);
    // 850/1000 = 85% -> the token limb warning fires once.
    budget.reserveBudget("root-W80", FREE_PROVIDER, FREE_MODEL, 0, 350);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ rootRunId: "root-W80", limb: "tokens", cap: 1_000, unit: "tokens" });
    // Further reserves above the threshold do NOT re-fire (once per root+limb).
    budget.reserveBudget("root-W80", FREE_PROVIDER, FREE_MODEL, 0, 50);
    expect(warnings).toHaveLength(1);
  });

  it("fires onLimbWarning for the $ limb at 80% of aggregateUsd (via the gate's granted-reserve warn)", () => {
    const clock = createFakeClock(1_000_000);
    const warnings: Array<{ limb: string; unit: string }> = [];
    const budget = createPerRootBudget({
      clock,
      config: { aggregateUsd: 1.0, tokens: 1_000_000, wallClockMs: 3_600_000 },
      logger: createMockLogger(),
      onLimbWarning: (w) => { warnings.push(w); },
    });
    budget.registerRoot("root-D80");

    budget.reserveBudget("root-D80", PRICED_PROVIDER, PRICED_MODEL, 0.85, 10);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ limb: "aggregateUsd", unit: "usd" });
  });

  it("evictRoot re-arms the once-per-limb warning guard (token limb — the $-accumulator is deliberately not per-root-evictable)", () => {
    const clock = createFakeClock(1_000_000);
    const warnings: Array<{ limb: string }> = [];
    const budget = createPerRootBudget({
      clock,
      config: { aggregateUsd: 100, tokens: 1_000, wallClockMs: 3_600_000 },
      logger: createMockLogger(),
      onLimbWarning: (w) => { warnings.push(w); },
    });
    budget.registerRoot("root-R80");

    budget.reserveBudget("root-R80", FREE_PROVIDER, FREE_MODEL, 0, 850);
    expect(warnings).toHaveLength(1);

    // Eviction clears the once-guard AND the token total, so a re-used root
    // (the interactive-session per-turn re-anchor) warns afresh next time it
    // approaches the cap.
    budget.evictRoot("root-R80");
    budget.registerRoot("root-R80");
    budget.reserveBudget("root-R80", FREE_PROVIDER, FREE_MODEL, 0, 850);
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.limb === "tokens")).toBe(true);
  });

  it("never trips the dollar limb for a free model yet still enforces the token limb", () => {
    const { budget } = makeBudget({ aggregateUsd: 0.0001, tokens: 1000 });
    budget.registerRoot("root-F");

    // Even with a near-zero $-cap, a free (local/gateway) model is never DoSed on $.
    const freeOk = budget.reserveBudget("root-F", FREE_PROVIDER, FREE_MODEL, 999, 500);
    expect(freeOk.kind).toBe("free");

    // But a free model that burns 2000 tokens against a 1000 cap STILL trips the token limb.
    const overTokens = budget.reserveBudget("root-F", FREE_PROVIDER, FREE_MODEL, 0, 2000);
    expect(overTokens.kind).toBe("exceeded");
  });

  it("reserves a priced model under all caps and trips the dollar limb over the per-root cap", () => {
    const { budget } = makeBudget({ aggregateUsd: 10, tokens: 1_000_000 });
    budget.registerRoot("root-P");

    // Under the $-cap → a granted reservation.
    const ok = budget.reserveBudget("root-P", PRICED_PROVIDER, PRICED_MODEL, 4, 100);
    expect(ok.kind).toBe("ok");

    // 4 + 7 > 10 → the per-root $ accumulator (scope agentId=rootRunId) breaches.
    const exceeded = budget.reserveBudget("root-P", PRICED_PROVIDER, PRICED_MODEL, 7, 100);
    expect(exceeded.kind).toBe("exceeded");
    if (exceeded.kind === "exceeded") {
      expect(exceeded.error.capUsd).toBe(10);
    }
  });

  it("keeps two roots on independent token and dollar totals so one at its cap does not exhaust another", () => {
    const { budget } = makeBudget({ aggregateUsd: 10, tokens: 1000 });
    budget.registerRoot("root-A");
    budget.registerRoot("root-B");

    // root-A consumes its full token budget.
    expect(budget.reserveBudget("root-A", FREE_PROVIDER, FREE_MODEL, 0, 1000).kind).not.toBe("exceeded");
    expect(budget.reserveBudget("root-A", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).toBe("exceeded");

    // root-B is a DIFFERENT tree — its token + $ totals are untouched by A.
    const bOk: SpendGateOutcome = budget.reserveBudget("root-B", PRICED_PROVIDER, PRICED_MODEL, 4, 500);
    expect(bOk.kind).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // The per-root wall-clock anchor + token-total maps must
  // be evictable so a for(;;)spawn / cron storm of distinct roots does not grow
  // them without bound. evictRoot clears a completed root's accounting; a later
  // re-registration starts fresh.
  // -------------------------------------------------------------------------
  it("evictRoot clears a root's token total and wall-clock anchor so the maps do not grow unbounded", () => {
    const wallClockMs = 60_000;
    const { budget, clock } = makeBudget({ tokens: 1000, wallClockMs });
    budget.registerRoot("root-E");

    // Burn most of the token budget on this root.
    expect(budget.reserveBudget("root-E", FREE_PROVIDER, FREE_MODEL, 0, 900).kind).not.toBe("exceeded");
    // A second 900 would exceed (900 + 900 > 1000) — proves the running total is held.
    expect(budget.reserveBudget("root-E", FREE_PROVIDER, FREE_MODEL, 0, 900).kind).toBe("exceeded");

    // Evict the root (its tree completed) → token total + anchor dropped.
    budget.evictRoot("root-E");

    // A fresh registration of the SAME id starts with a clean token total: a 900
    // reserve now succeeds (it would have exceeded had the prior 900 survived).
    budget.registerRoot("root-E");
    expect(budget.reserveBudget("root-E", FREE_PROVIDER, FREE_MODEL, 0, 900).kind).not.toBe("exceeded");

    // The wall-clock anchor is also fresh: advancing just under the deadline from
    // the NEW registration does not trip (it would if the old anchor survived).
    clock.advance(wallClockMs - 1_000);
    expect(budget.reserveBudget("root-E", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).not.toBe("exceeded");
  });

  it("evictRoot is a no-op for an unknown root (never throws)", () => {
    const { budget } = makeBudget();
    expect(() => budget.evictRoot("never-seen")).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // The wall-clock limb must bound an UNREGISTERED root too
  // — the first reserve persists the anchor, so a later call past the deadline
  // trips. Without this, an unregistered root re-anchors at now() every call, so
  // the wall-clock limb stays permanently inert for it.
  // -------------------------------------------------------------------------
  it("anchors the wall-clock deadline on the FIRST reserve for an unregistered root so the limb can still fire", () => {
    const wallClockMs = 60_000;
    // NOTE: no registerRoot — the root is unregistered (e.g. holder absent at
    // resolver time). High token cap so ONLY the wall-clock limb can trip.
    const { budget, clock } = makeBudget({ tokens: 1_000_000, wallClockMs });

    // First reserve at t0 anchors the deadline here; within the window → ok.
    expect(budget.reserveBudget("root-U", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).not.toBe("exceeded");

    // Advance PAST the deadline measured from that first call.
    clock.advance(wallClockMs + 1);

    // The wall-clock limb now fires — without the persisted anchor each call
    // would re-anchor at now(), leaving elapsedMs ~0 and the limb inert.
    expect(budget.reserveBudget("root-U", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).toBe("exceeded");
  });

  // -------------------------------------------------------------------------
  // A PURE `remaining(rootRunId)` read accessor — the numbers the
  // `capabilities.introspect` / `whoami` RPC reports. The gate tracks
  // `tokenTotals`/`rootStartMs`/the per-root $ accumulator internally but
  // exposes NO write on this read path. `remaining` exposes the live remaining
  // token / wall-clock / $ headroom as a READ-ONLY view: no mutation, no anchor
  // write, no window reset. The $ limb is a REAL number from the SAME
  // `perRootUsdAccumulator` the gate enforces against (not null), so the read
  // matches the gate.
  // -------------------------------------------------------------------------
  it("remaining(rootRunId) reports tokens/wall-clock/$ remaining as live deltas after a priced reserve", () => {
    // aggregateUsd 10, tokens 1000, wallClock 60_000. A priced model so the $
    // accumulator records a real consumed amount (NOT free/unpriceable).
    const { budget, clock } = makeBudget({ aggregateUsd: 10, tokens: 1000, wallClockMs: 60_000 });
    budget.registerRoot("root-R");

    // Consume 100 tokens + $4 on a priced model.
    const ok = budget.reserveBudget("root-R", PRICED_PROVIDER, PRICED_MODEL, 4, 100);
    expect(ok.kind).toBe("ok");

    // Advance 10s into the wall-clock window.
    clock.advance(10_000);

    const r = budget.remaining("root-R");
    // Token limb: 1000 - 100 consumed.
    expect(r.tokensRemaining).toBe(900);
    // Wall-clock limb: 60_000 - 10_000 elapsed (FakeClock-driven).
    expect(r.wallClockMsRemaining).toBe(50_000);
    // $ limb: 10 - 4 consumed — a REAL number from the accumulator snapshot, NOT null.
    expect(r.usdRemaining).not.toBeNull();
    expect(r.usdRemaining).toBeCloseTo(6, 10);
  });

  it("exports and idempotently rehydrates absolute USD token and wall-clock state", () => {
    const first = makeBudget({ aggregateUsd: 10, tokens: 1000, wallClockMs: 60_000 });
    first.budget.registerRoot("root-restart");
    expect(first.budget.reserveBudget(
      "root-restart",
      PRICED_PROVIDER,
      PRICED_MODEL,
      4,
      100,
    ).kind).toBe("ok");
    first.clock.advance(10_000);
    const persisted = first.budget.exportState("root-restart");
    expect(persisted).toEqual({
      startedAtMs: 1_000_000,
      tokensConsumed: 100,
      usdConsumed: 4,
    });

    const resumed = makeBudget({ aggregateUsd: 10, tokens: 1000, wallClockMs: 60_000 });
    resumed.clock.advance(10_000);
    resumed.budget.rehydrate("root-restart", persisted);
    resumed.budget.rehydrate("root-restart", persisted);

    expect(resumed.budget.exportState("root-restart")).toEqual(persisted);
    expect(resumed.budget.remaining("root-restart")).toEqual({
      tokensRemaining: 900,
      wallClockMsRemaining: 50_000,
      usdRemaining: 6,
    });
    expect(resumed.budget.reserveBudget(
      "root-restart",
      PRICED_PROVIDER,
      PRICED_MODEL,
      7,
      1,
    ).kind).toBe("exceeded");
  });

  it("remaining() is a PURE read — it does not mutate the token total or anchor a window", () => {
    const wallClockMs = 60_000;
    const { budget, clock } = makeBudget({ tokens: 1000, wallClockMs });
    budget.registerRoot("root-PURE");

    // Consume 900 tokens.
    expect(budget.reserveBudget("root-PURE", FREE_PROVIDER, FREE_MODEL, 0, 900).kind).not.toBe("exceeded");

    // Call remaining() MANY times — a read must not advance the token total.
    for (let i = 0; i < 5; i++) budget.remaining("root-PURE");

    // A subsequent reserve behaves as if remaining() was never called: 900 + 900
    // > 1000 → exceeded (the read did NOT consume tokens, and did NOT reset the total).
    expect(budget.reserveBudget("root-PURE", FREE_PROVIDER, FREE_MODEL, 0, 900).kind).toBe("exceeded");

    // The wall-clock anchor is untouched by the reads: advancing past the
    // deadline still trips (a read must not re-anchor the window forward).
    clock.advance(wallClockMs + 1);
    for (let i = 0; i < 5; i++) budget.remaining("root-PURE");
    expect(budget.reserveBudget("root-PURE", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).toBe("exceeded");
  });

  it("remaining() for an UNREGISTERED root returns the full allowance without anchoring a window", () => {
    const wallClockMs = 60_000;
    const { budget, clock } = makeBudget({ aggregateUsd: 10, tokens: 1000, wallClockMs });

    // No registerRoot — the read reports the full token + wall-clock + $ allowance.
    const r = budget.remaining("root-NEVER");
    expect(r.tokensRemaining).toBe(1000);
    expect(r.wallClockMsRemaining).toBe(wallClockMs);
    expect(r.usdRemaining).not.toBeNull();
    expect(r.usdRemaining).toBeCloseTo(10, 10); // full aggregateUsd — nothing consumed

    // The read must NOT have anchored a wall-clock window: a FIRST reserve now
    // anchors at the advanced clock, so the deadline measures from HERE, not the
    // earlier read. Advance, then a first reserve is still within the window.
    clock.advance(wallClockMs - 1_000);
    expect(budget.reserveBudget("root-NEVER", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).not.toBe("exceeded");
  });
});
