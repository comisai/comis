// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first contract for the daemon-wide spend accumulator (Phase 177-01, WS3).
 *
 * The load-bearing correctness piece of the spend kill-switch: a single
 * daemon-wide accumulator with a SYNCHRONOUS atomic `checkAndReserve` that closes
 * the `summarizer-spend-breaker` non-atomic `canSpend`→`await`→`record` race.
 *
 * Pins:
 *   - rehydrate() seeds per-(tenant,agent)/per-tenant/global running totals from
 *     boot cost rows; a subsequent near-ceiling reserve errs,
 *   - recordSpend() increments live (the next checkAndReserve sees it — no re-sum),
 *   - per-agent / global ceilings err at the limit,
 *   - per-tenant ISOLATION (SPEND-04 cross-tenant-DoS): A's breach leaves B ok,
 *   - warn precedes exceeded (warnAtFraction 0.8),
 *   - reconcile() settles an estimate to the actual billed amount (releases headroom),
 *   - **THE load-bearing DISCRIMINATING K-parallel test**: K synchronous reserves
 *     near the ceiling admit exactly EXPECTED_ADMITS (< K) AND the final total
 *     overshoots by at most a SINGLE in-flight turn (configured + perTurnMax),
 *     NOT K×perTurnMax.
 *
 * All time is driven by `createFakeClock` (no raw Date/timer — the globals gate).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import {
  createSpendAccumulator,
  type SpendAccumulator,
  type SpendScope,
  type SpendCeilings,
} from "./spend-accumulator.js";

const SCOPE: SpendScope = { tenantId: "t", agentId: "a" };

/** Build the SUT with sane defaults; each test overrides the ceilings it needs. */
function makeAccumulator(overrides: Partial<SpendCeilings> = {}): {
  acc: SpendAccumulator;
  clock: ReturnType<typeof createFakeClock>;
} {
  const clock = createFakeClock(1_000_000);
  const ceilings: SpendCeilings = {
    perAgentUsd: overrides.perAgentUsd ?? null,
    perTenantUsd: overrides.perTenantUsd ?? null,
    daemonGlobalUsd: overrides.daemonGlobalUsd ?? null,
    warnAtFraction: overrides.warnAtFraction ?? 0.8,
  };
  const acc = createSpendAccumulator({ clock, ceilings });
  return { acc, clock };
}

describe("createSpendAccumulator", () => {
  it("rehydrate seeds per-(tenant,agent)/global totals so a near-ceiling reserve errs", () => {
    const { acc } = makeAccumulator({ perAgentUsd: 10, daemonGlobalUsd: 100 });
    // Seed this (tenant,agent) to $9.50 of its $10 cap.
    acc.rehydrate([{ agentId: "a", tenantId: "t", costUsd: 9.5 }]);

    // A $1 reserve would push 9.5 + 1 = 10.5 > 10 → err (per-agent).
    const r = acc.checkAndReserve(SCOPE, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.scope).toBe("agent");
      expect(r.error.capUsd).toBe(10);
    }

    // A $0.25 reserve fits (9.5 + 0.25 = 9.75 ≤ 10) → ok.
    const r2 = acc.checkAndReserve(SCOPE, 0.25);
    expect(r2.ok).toBe(true);
  });

  it("recordSpend increments live so the next checkAndReserve sees the accrued spend (no re-sum)", () => {
    const { acc } = makeAccumulator({ perAgentUsd: 10 });
    // No history; live-record $9.80, then a $0.50 reserve breaches (9.8 + 0.5 > 10).
    acc.recordSpend(SCOPE, 9.8);
    const r = acc.checkAndReserve(SCOPE, 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.scope).toBe("agent");
  });

  it("per-agent ceiling aborts a reserve past perAgentUsd", () => {
    const { acc } = makeAccumulator({ perAgentUsd: 5 });
    acc.recordSpend(SCOPE, 4.9);
    const r = acc.checkAndReserve(SCOPE, 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.scope).toBe("agent");
      expect(r.error.currentUsd).toBeCloseTo(4.9);
      expect(r.error.estUsd).toBe(0.5);
    }
  });

  it("global (daemonGlobalUsd) ceiling aborts even when per-agent has headroom", () => {
    // Per-agent is generous; the GLOBAL cap is what trips. Two different agents'
    // spend accrues into the single global counter.
    const { acc } = makeAccumulator({ perAgentUsd: 100, daemonGlobalUsd: 10 });
    acc.recordSpend({ tenantId: "t", agentId: "a1" }, 6);
    acc.recordSpend({ tenantId: "t", agentId: "a2" }, 3.8);
    // a1 reserve $0.5: per-agent ok (6.5 ≤ 100) but global 9.8 + 0.5 > 10 → err(global).
    const r = acc.checkAndReserve({ tenantId: "t", agentId: "a1" }, 0.5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.scope).toBe("global");
  });

  it("isolates tenants — tenant-a breaching its perTenantUsd does not abort tenant-b (SPEND-04 cross-tenant-DoS)", () => {
    const { acc } = makeAccumulator({ perTenantUsd: 5 });
    const scopeA: SpendScope = { tenantId: "tenant-a", agentId: "agent-x" };
    const scopeB: SpendScope = { tenantId: "tenant-b", agentId: "agent-y" };

    // Push tenant-a over its per-tenant cap.
    acc.recordSpend(scopeA, 4.9);
    const ra = acc.checkAndReserve(scopeA, 0.5);
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.error.scope).toBe("tenant");

    // Tenant-b's counter is independent → its reserve is still ok.
    const rb = acc.checkAndReserve(scopeB, 0.5);
    expect(rb.ok).toBe(true);
  });

  it("warning precedes exceeded — at warnAtFraction (0.8) of a ceiling the reserve is ok WITH warn:true, then errs at the cap", () => {
    const { acc } = makeAccumulator({ perAgentUsd: 10, warnAtFraction: 0.8 });
    // Reserve $8 from empty: post-reserve total 8 / cap 10 = 0.8 ≥ warnAt → ok + warn.
    const r = acc.checkAndReserve(SCOPE, 8);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.warn).toBe(true);

    // A small reserve below the warn line stays ok WITHOUT warn (fresh agent).
    const r2 = makeAccumulator({ perAgentUsd: 10, warnAtFraction: 0.8 }).acc.checkAndReserve(
      SCOPE,
      1,
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.warn).toBe(false);

    // Continue past the cap on the warned accumulator → err.
    const r3 = acc.checkAndReserve(SCOPE, 2.5);
    expect(r3.ok).toBe(false);
  });

  it("reconcile settles an estimate to the actual billed amount, releasing over-reserved headroom", () => {
    const { acc } = makeAccumulator({ perAgentUsd: 10 });
    // Reserve a conservative $5 estimate.
    const r = acc.checkAndReserve(SCOPE, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The turn actually billed only $1 → reconcile releases $4 of headroom.
    acc.reconcile(r.value, 1);

    // Now $9 should fit (1 actual + 9 = 10 ≤ 10); without reconcile the stale $5
    // reservation would have left only $5 of room and this would err.
    const r2 = acc.checkAndReserve(SCOPE, 9);
    expect(r2.ok).toBe(true);
  });

  it("a null ceiling is OFF — reserves never trip that dimension (opt-in)", () => {
    // All ceilings null → unlimited; even a huge reserve is ok.
    const { acc } = makeAccumulator();
    acc.recordSpend(SCOPE, 1_000_000);
    const r = acc.checkAndReserve(SCOPE, 1_000_000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.warn).toBe(false);
  });

  // -------------------------------------------------------------------------
  // THE load-bearing DISCRIMINATING K-parallel concurrency test (SPEND-02).
  //
  // WHY the OLD form `NEAR_CEILING + Σreserved <= CONFIGURED + K*PER_TURN_MAX`
  // was VACUOUS: it reduces algebraically to `NEAR_CEILING <= CONFIGURED` (always
  // true here), because the `K*PER_TURN_MAX` slack on the RHS is EXACTLY the racy
  // overshoot — so it PASSES on the racy read→await→write baseline and verifies
  // nothing about atomicity.
  //
  // WHY the NEW form DISCRIMINATES: the atomic synchronous reserve mutates the
  // running total BEFORE returning, so each of the K event-loop-concurrent callers
  // sees the prior reservation → only EXPECTED_ADMITS = ceil((CONFIGURED -
  // NEAR_CEILING)/PER_TURN_MAX) admit (chosen strictly < K) and the final total
  // overshoots by at most a SINGLE in-flight turn (CONFIGURED + PER_TURN_MAX). The
  // racy split admits ALL K (count == K, finalTotal == NEAR_CEILING + K*PER_TURN_MAX).
  // -------------------------------------------------------------------------
  const CONFIGURED = 10;
  const NEAR_CEILING = 8;
  const PER_TURN_MAX = 1;
  const K = 8;
  const EXPECTED_ADMITS = Math.ceil((CONFIGURED - NEAR_CEILING) / PER_TURN_MAX); // = 2, strictly < K

  it("admits only the headroom: K parallel reservations bounded to a SINGLE in-flight turn's overshoot", () => {
    expect(EXPECTED_ADMITS).toBeLessThan(K); // the discriminator only bites when this holds

    const { acc } = makeAccumulator({ perAgentUsd: CONFIGURED });
    acc.rehydrate([{ agentId: "a", tenantId: "t", costUsd: NEAR_CEILING }]);

    // K SYNCHRONOUS reserves through the SAME accumulator (plain in-loop calls —
    // NO Promise.all over real I/O; Pitfall 5). Each sees the prior reservation.
    const results = Array.from({ length: K }, () => acc.checkAndReserve(SCOPE, PER_TURN_MAX));
    const admitted = results.filter((r) => r.ok);
    const finalTotal =
      NEAR_CEILING + admitted.reduce((s, r) => (r.ok ? s + r.value.reservedUsd : s), 0);

    // (a) admitted COUNT === EXPECTED_ADMITS, strictly < K — the discriminator.
    expect(admitted.length).toBe(EXPECTED_ADMITS);
    // (b) single-turn overshoot — NOT K×PER_TURN_MAX (the vacuous bound).
    expect(finalTotal).toBeLessThanOrEqual(CONFIGURED + PER_TURN_MAX);
  });

  // -------------------------------------------------------------------------
  // RED-PROOF (mandatory, executable): the SAME discriminating bounds applied to
  // a deliberately NON-ATOMIC read→await→write reserve admit ALL K and overshoot
  // by K×PER_TURN_MAX — i.e. the test above is genuinely RED on the racy baseline
  // and GREEN only because the shipped checkAndReserve is synchronous-atomic.
  //
  // This local racy stub replicates the `summarizer-spend-breaker` two-step
  // (read the headroom, yield the microtask, THEN write). Driving the K calls
  // needs awaiting, so Promise.all is acceptable HERE (throwaway proof only).
  // -------------------------------------------------------------------------
  it("RED-PROOF: a non-atomic read→await→write reserve admits ALL K and overshoots by K×perTurnMax", async () => {
    let runningTotal = NEAR_CEILING;
    const racyReserve = async (estUsd: number): Promise<{ ok: boolean; reservedUsd: number }> => {
      const current = runningTotal; // READ
      await Promise.resolve(); // ← AWAIT between read and write: the race
      if (current + estUsd > CONFIGURED) return { ok: false, reservedUsd: 0 };
      runningTotal = current + estUsd; // WRITE (every caller read the same `current`)
      return { ok: true, reservedUsd: estUsd };
    };

    const results = await Promise.all(
      Array.from({ length: K }, () => racyReserve(PER_TURN_MAX)),
    );
    const admitted = results.filter((r) => r.ok);
    const finalTotal = NEAR_CEILING + admitted.reduce((s, r) => s + r.reservedUsd, 0);

    // The racy baseline VIOLATES BOTH discriminating bounds:
    expect(admitted.length).toBe(K); // (a) all K admit — NOT EXPECTED_ADMITS
    expect(admitted.length).not.toBe(EXPECTED_ADMITS);
    expect(finalTotal).toBe(NEAR_CEILING + K * PER_TURN_MAX); // = 16
    expect(finalTotal).toBeGreaterThan(CONFIGURED + PER_TURN_MAX); // 16 > 11 — (b) violated
  });
});
