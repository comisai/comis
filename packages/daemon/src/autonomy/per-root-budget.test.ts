// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first contract for the per-`rootRunId` aggregate budget meter (Phase 213-04,
 * BUDGET-01/02/03).
 *
 * The cost-bound limb of the bounded-autonomy floor: three limbs that abort a
 * self-spawning loop on ANY of $ / token / wall-clock. The $-limb REUSES the
 * shipped v2.28 3-state pricing gate (`checkSpendCeiling` + `resolvePricingState`)
 * VERBATIM — re-scoped to the `rootRunId` (scope `{ tenantId: "_root", agentId:
 * rootRunId }`) — so BUDGET-02 (unknown=uncountable, not $0) + BUDGET-03 (the
 * $-cap REFUSES on unknown pricing, fail-closed) are inherited, not re-implemented.
 * The NET-NEW value is (a) the per-root scope, (b) a token limb, (c) a per-root
 * wall-clock deadline — the three that bite a zero-price (subscription/Codex)
 * native-provider loop where the $-cap cannot.
 *
 * Pins:
 *   - the token limb accumulates per root and trips when the running total exceeds
 *     `tokens`,
 *   - the wall-clock limb anchors at `registerRoot` and trips when
 *     `clock.now() - startMs > wallClockMs` (FakeClock-driven, no Date.now),
 *   - the zero-price model (anthropic native + no catalog entry → "unknown"):
 *     the $-limb returns `unpriceable` (NOT $0), AND the token/wall-clock limbs
 *     STILL enforce — the BUDGET-02 invariant,
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
//   anthropic + a no-catalog model → "unknown" (the ffe11736 zero-price chimera)
//   ollama + anything             → "free" (gateway/local — $0 is honest)
//   anthropic + a catalog model    → "priced"
const ZERO_PRICE_PROVIDER = "anthropic";
const ZERO_PRICE_MODEL = "zzz-nonexistent-model-xyz"; // no catalog entry → "unknown"
const FREE_PROVIDER = "ollama";
const FREE_MODEL = "llama3";
const PRICED_PROVIDER = "anthropic";
const PRICED_MODEL = "claude-3-5-sonnet-20241022"; // catalog-priced

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

describe("per-root-budget — $/token/wall-clock limbs reusing the 3-state gate (BUDGET-01/02/03)", () => {
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

  it("surfaces unpriceable for a zero-price native model while the token and wall-clock limbs still enforce (BUDGET-02/03)", () => {
    // The ffe11736 case: a native provider with no catalog entry burning tokens.
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
  // WR-05 (213-REVIEW): the per-root wall-clock anchor + token-total maps must
  // be evictable so a for(;;)spawn / cron storm of distinct roots does not grow
  // them without bound. evictRoot clears a completed root's accounting; a later
  // re-registration starts fresh.
  // -------------------------------------------------------------------------
  it("evictRoot clears a root's token total and wall-clock anchor so the maps do not grow unbounded (WR-05)", () => {
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
  // IN-02 (213-REVIEW): the wall-clock limb must bound an UNREGISTERED root too
  // — the first reserve persists the anchor, so a later call past the deadline
  // trips. Pre-fix, an unregistered root re-anchored at now() every call, so the
  // wall-clock limb was permanently inert for it.
  // -------------------------------------------------------------------------
  it("anchors the wall-clock deadline on the FIRST reserve for an unregistered root so the limb can still fire (IN-02)", () => {
    const wallClockMs = 60_000;
    // NOTE: no registerRoot — the root is unregistered (e.g. holder absent at
    // resolver time). High token cap so ONLY the wall-clock limb can trip.
    const { budget, clock } = makeBudget({ tokens: 1_000_000, wallClockMs });

    // First reserve at t0 anchors the deadline here; within the window → ok.
    expect(budget.reserveBudget("root-U", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).not.toBe("exceeded");

    // Advance PAST the deadline measured from that first call.
    clock.advance(wallClockMs + 1);

    // The wall-clock limb now fires (it would NOT have, pre-fix, because each
    // call re-anchored at now() leaving elapsedMs ~0).
    expect(budget.reserveBudget("root-U", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).toBe("exceeded");
  });
});
