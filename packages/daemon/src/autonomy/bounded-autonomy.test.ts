// SPDX-License-Identifier: Apache-2.0
/**
 * Contract for the `createBoundedAutonomy` composite.
 *
 * The single chokepoint: ONE typed service that composes
 * the five mechanism modules —
 *   - the per-`rootRunId` spawn semaphore (`createRootRunSemaphore`),
 *   - the per-`rootRunId` $/token/wall-clock budget meter
 *     (`createPerRootBudget`),
 *   - the per-key sliding-window call-rate limiter + connection-churn cap
 *     (`createCallRateLimiter`),
 *   - the outward quota (`createOutwardQuota`),
 * plus the `registerRoot` rootRunId↔leaseId correlation index and the
 * `cronCount` delegate (the named cron-cap count source the cap endpoint reaches
 * THROUGH this service — it has no cron store of its own).
 *
 * Every numeric cap is sourced from a single `ResolvedAutonomy` (no hard-coded
 * numbers); the service NEVER throws (it composes Result/union-returning
 * modules); all time is the injected `ClockPort`/`TimerPort` (no Date.now).
 * Every bound decision is auditable from this one seam.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { resolveAutonomy, type ResolvedAutonomy } from "@comis/core";
import type { LeaseManager } from "@comis/infra";
import {
  createFakeClock,
  type FakeClock,
} from "../../../../test/support/fake-clock.js";
import {
  createFakeTimers,
  type FakeTimers,
} from "../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  createBoundedAutonomy,
  type BoundedAutonomy,
} from "./bounded-autonomy.js";

// A free (local/gateway) model so the budget $-limb never trips — the token +
// wall-clock limbs are the ones the composite tests exercise.
const FREE_PROVIDER = "ollama";
const FREE_MODEL = "llama3";

/**
 * A minimal LeaseManager stub. The composite holds the LeaseManager for the
 * registerRoot correlation seam (and the later cascade) but its build-time
 * behavior under test does not drive it; the daemon revoke/kill RPC
 * is the path that calls the revoke fan-outs.
 */
function fakeLeaseManager(): LeaseManager {
  return {
    mintLease: () => ({ leaseId: "L", bearer: "b" }),
    validate: () => null,
    renew: () => null,
    revoke: () => {},
    cascadeRevoke: () => {},
    revokeByRootRun: () => ({ revoked: 0 }),
  };
}

interface Harness {
  clock: FakeClock;
  timers: FakeTimers;
  config: ResolvedAutonomy;
  service: BoundedAutonomy;
}

function makeService(
  overrides: {
    cronJobCount?: (agentId: string) => number;
    config?: ResolvedAutonomy;
  } = {},
): Harness {
  const clock = createFakeClock(1_000_000);
  const timers = createFakeTimers(1_000_000);
  // The resolved STANDARD posture — one config source, no hard-coded numbers.
  const config = overrides.config ?? resolveAutonomy();
  const service = createBoundedAutonomy({
    clock,
    timers,
    leaseManager: fakeLeaseManager(),
    config,
    ...(overrides.cronJobCount !== undefined ? { cronJobCount: overrides.cronJobCount } : {}),
    logger: createMockLogger(),
  });
  return { clock, timers, config, service };
}

describe("createBoundedAutonomy — the single composite chokepoint", () => {
  // -------------------------------------------------------------------------
  // Test 1: composes the 5 mechanisms + exposes the typed surface
  // -------------------------------------------------------------------------
  it("returns the composed surface and the sub-modules behave (semaphore caps over the limit, budget token limb trips)", () => {
    // A tiny config so the limbs are easy to drive deterministically.
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      spawn: { maxConcurrentSelfAgents: 2, maxSpawnDepth: 3, maxChildrenPerAgent: 5 },
      budget: { aggregateUsd: 100, tokens: 1000, wallClockMs: 3_600_000 },
    };
    const { service } = makeService({ config });

    // The typed surface is present.
    for (const m of [
      "tryAcquireSpawn",
      "releaseSpawn",
      "tryCall",
      "tryChurn",
      "reserveBudget",
      "tryOutward",
      "registerRoot",
      "leaseIdsForRoot",
      "cronCount",
      "destroy",
    ] as const) {
      expect(typeof service[m]).toBe("function");
    }

    // The semaphore limb: admit up to maxConcurrentSelfAgents then deny on concurrency.
    expect(service.tryAcquireSpawn("root-1", 0, 0)).toEqual({ ok: true });
    expect(service.tryAcquireSpawn("root-1", 0, 0)).toEqual({ ok: true });
    expect(service.tryAcquireSpawn("root-1", 0, 0)).toEqual({ ok: false, reason: "concurrency" });

    // The budget token limb: 600 + 600 > 1000 → the second reserve is exceeded.
    service.registerRoot("root-1", "lease-1");
    const first = service.reserveBudget("root-1", FREE_PROVIDER, FREE_MODEL, 0, 600);
    expect(first.kind).not.toBe("exceeded");
    const second = service.reserveBudget("root-1", FREE_PROVIDER, FREE_MODEL, 0, 600);
    expect(second.kind).toBe("exceeded");

    service.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 2: registerRoot anchors the budget AND records the lease correlation
  // -------------------------------------------------------------------------
  it("registerRoot anchors the budget wall-clock AND records the rootRunId↔leaseId correlation", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      budget: { aggregateUsd: 100, tokens: 1_000_000, wallClockMs: 60_000 },
    };
    const { service, clock } = makeService({ config });

    // Register the root → anchors the wall-clock deadline at clock.now().
    service.registerRoot("root-W", "lease-A", "lease-parent");
    // A second lease of the same root correlates too.
    service.registerRoot("root-W", "lease-B");

    // The lease correlation index returns the set of leaseIds for the root.
    const leaseIds = service.leaseIdsForRoot("root-W");
    expect(leaseIds.has("lease-A")).toBe(true);
    expect(leaseIds.has("lease-B")).toBe(true);
    expect(leaseIds.size).toBe(2);
    // An unknown root → an empty set (never throws).
    expect(service.leaseIdsForRoot("root-UNKNOWN").size).toBe(0);

    // The wall-clock anchor measures from the FIRST registration: under the
    // deadline now, exceeded after the clock advances past it.
    expect(service.reserveBudget("root-W", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).not.toBe("exceeded");
    clock.advance(60_001);
    expect(service.reserveBudget("root-W", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).toBe("exceeded");

    service.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 3: every cap comes from the resolved ResolvedAutonomy (no hard-coded)
  // -------------------------------------------------------------------------
  it("reads every cap from the resolved config — the spawn fanout/depth, the rate cap, and the outward origin-only posture", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      spawn: { maxConcurrentSelfAgents: 10, maxSpawnDepth: 2, maxChildrenPerAgent: 3 },
      rate: { perRootCallsPerSec: 2, perSocketCallsPerSec: 2, connectionChurnPerMin: 60 },
      outward: { originOnly: true, perTargetGrants: [], volumeCap: 4000 },
      message: { channels: ["origin"], maxPerHour: 20 },
    };
    const { service } = makeService({ config });

    // spawn.maxSpawnDepth = 2 → a spawn at depth 2 is denied "depth".
    expect(service.tryAcquireSpawn("root-D", 2, 0)).toEqual({ ok: false, reason: "depth" });
    // spawn.maxChildrenPerAgent = 3 → fanout 3 is denied "fanout".
    expect(service.tryAcquireSpawn("root-D", 0, 3)).toEqual({ ok: false, reason: "fanout" });

    // rate.perRootCallsPerSec = 2 → the 3rd call in the window denies "rate".
    expect(service.tryCall("root-R", "socket-1")).toEqual({ ok: true });
    expect(service.tryCall("root-R", "socket-1")).toEqual({ ok: true });
    expect(service.tryCall("root-R", "socket-1")).toEqual({ ok: false, reason: "rate" });

    // outward.originOnly + no grant → a non-origin send is denied "no_grant".
    const nonOrigin = service.tryOutward("agent-1", "stranger-channel", /* isOrigin */ false, 1);
    expect(nonOrigin.ok).toBe(false);
    // …and the origin send is allowed.
    const origin = service.tryOutward("agent-1", "own-channel", /* isOrigin */ true, 1);
    expect(origin.ok).toBe(true);

    service.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 3b: perSocketCallsPerSec is a DISTINCT limit from
  // perRootCallsPerSec — a single socket exceeding its own per-socket cap is
  // denied even while well under the per-root cap. If tryCall applied the
  // per-ROOT limiter to BOTH keys, perSocketCallsPerSec would be dead config.
  // -------------------------------------------------------------------------
  it("enforces perSocketCallsPerSec independently of perRootCallsPerSec", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      // Socket cap (2) STRICTLY below the root cap (10) so the socket limit is
      // the binding bound for a single socket — it cannot be the root cap in
      // disguise.
      rate: { perRootCallsPerSec: 10, perSocketCallsPerSec: 2, connectionChurnPerMin: 60 },
    };
    const { service } = makeService({ config });

    // One socket: 2 calls allowed, the 3rd denied by the SOCKET cap — even though
    // only 3 calls have hit the root (cap 10, far from binding).
    expect(service.tryCall("root-1", "socket-A")).toEqual({ ok: true });
    expect(service.tryCall("root-1", "socket-A")).toEqual({ ok: true });
    expect(service.tryCall("root-1", "socket-A")).toEqual({ ok: false, reason: "rate" });

    // A DIFFERENT socket under the SAME root still has its own fresh per-socket
    // budget (the deny above was per-socket, not per-root): 2 more allowed.
    expect(service.tryCall("root-1", "socket-B")).toEqual({ ok: true });
    expect(service.tryCall("root-1", "socket-B")).toEqual({ ok: true });
    // socket-B's 3rd is denied by its own socket cap too.
    expect(service.tryCall("root-1", "socket-B")).toEqual({ ok: false, reason: "rate" });

    service.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 3c: the per-ROOT cap still binds the whole tree's aggregate
  // across many sockets — each socket under its own cap, but the root cap trips.
  // -------------------------------------------------------------------------
  it("the per-root cap binds the aggregate across sockets even when each socket is under its socket cap", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      // Root cap (3) BELOW socket cap (10): the root is the binding bound across
      // many one-call sockets.
      rate: { perRootCallsPerSec: 3, perSocketCallsPerSec: 10, connectionChurnPerMin: 60 },
    };
    const { service } = makeService({ config });

    // Three distinct sockets, one call each — each well under the socket cap (10)
    // but together they reach the root cap (3).
    expect(service.tryCall("root-agg", "s1")).toEqual({ ok: true });
    expect(service.tryCall("root-agg", "s2")).toEqual({ ok: true });
    expect(service.tryCall("root-agg", "s3")).toEqual({ ok: true });
    // The 4th distinct socket's first call trips the per-ROOT cap.
    expect(service.tryCall("root-agg", "s4")).toEqual({ ok: false, reason: "rate" });

    service.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 3d: releaseSpawn to zero evicts ALL per-root state at the
  // composite — the semaphore slot, the budget token/wall-clock anchor, AND the
  // leaseId correlation index — so a storm of completed roots does not grow any
  // sibling map without bound.
  // -------------------------------------------------------------------------
  it("releaseSpawn to zero evicts the per-root budget + lease-index state at the composite", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      spawn: { maxConcurrentSelfAgents: 4, maxSpawnDepth: 3, maxChildrenPerAgent: 5 },
      budget: { aggregateUsd: 100, tokens: 1000, wallClockMs: 3_600_000 },
    };
    const { service } = makeService({ config });

    // Acquire one slot + register the root with a lease + burn most token budget.
    expect(service.tryAcquireSpawn("root-EV", 1, 0)).toEqual({ ok: true });
    service.registerRoot("root-EV", "lease-EV");
    expect(service.leaseIdsForRoot("root-EV").has("lease-EV")).toBe(true);
    expect(service.reserveBudget("root-EV", "ollama", "llama3", 0, 900).kind).not.toBe("exceeded");

    // Release the only slot → active hits 0 → all per-root state is evicted.
    service.releaseSpawn("root-EV");

    // The lease index for the root is now empty.
    expect(service.leaseIdsForRoot("root-EV").size).toBe(0);

    // The budget token total reset: a fresh registration + a 900 reserve
    // succeeds (it would have been exceeded if the prior 900 survived).
    service.registerRoot("root-EV", "lease-EV2");
    expect(service.reserveBudget("root-EV", "ollama", "llama3", 0, 900).kind).not.toBe("exceeded");

    service.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 3e: the per-turn re-anchor for an interactive SESSION root.
  // A `root-session-*` root acquires NO spawn slot, so releaseSpawn → evictRoot
  // NEVER fires for it; its wall-clock + token anchors accumulate across the
  // WHOLE conversation, and a session alive > wallClockMs falsely aborts every
  // subsequent turn (observed live: elapsedMs 2052386 > capMs 1800000).
  // `evictRootIfIdle` re-anchors an IDLE root at the turn boundary (next turn
  // measures from its own start) but is a NO-OP on a root with a LIVE spawn — so
  // the genuine runaway-TREE backstop is preserved. The $ aggregate is untouched
  // either way (evictRoot does not prune the $ accumulator → session spend cap).
  // -------------------------------------------------------------------------
  it("evictRootIfIdle re-anchors an IDLE session root per turn but preserves a LIVE spawn's wall-clock backstop", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      spawn: { maxConcurrentSelfAgents: 4, maxSpawnDepth: 3, maxChildrenPerAgent: 5 },
      budget: { aggregateUsd: 100, tokens: 1_000_000, wallClockMs: 1_800_000 }, // explicit per-test ceilings (30-min wall-clock)
    };
    const { service, clock } = makeService({ config });

    // ── IDLE root (an interactive session root: NO spawn slot acquired). ──
    service.registerRoot("root-session-IDLE", "lease-1");
    expect(service.reserveBudget("root-session-IDLE", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).not.toBe("exceeded");
    clock.advance(1_800_001); // the conversation ages past the 30-min wall-clock cap.
    // The bug: the next turn trips the wall-clock limb (elapsed > capMs) despite no runaway.
    expect(service.reserveBudget("root-session-IDLE", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).toBe("exceeded");
    // The fix: at the turn boundary, evictRootIfIdle drops the stale anchor (idle →
    // activeCount 0) so the NEXT turn re-anchors fresh and does NOT falsely abort.
    service.evictRootIfIdle("root-session-IDLE");
    expect(service.reserveBudget("root-session-IDLE", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).not.toBe("exceeded");

    // ── ACTIVE root (a LIVE spawn tree): evictRootIfIdle must be a NO-OP. ──
    service.tryAcquireSpawn("root-spawn-LIVE", 1, 0);
    service.registerRoot("root-spawn-LIVE", "lease-2");
    expect(service.reserveBudget("root-spawn-LIVE", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).not.toBe("exceeded");
    clock.advance(1_800_001); // a spawn tree genuinely running > the cap — a real runaway.
    service.evictRootIfIdle("root-spawn-LIVE"); // activeCount > 0 → must NOT reset.
    expect(service.reserveBudget("root-spawn-LIVE", FREE_PROVIDER, FREE_MODEL, 0, 1).kind).toBe("exceeded");

    service.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 4: idempotent construction + destroy() tears down the rate timers
  // -------------------------------------------------------------------------
  it("constructs sub-modules once and destroy() cancels the rate limiter's scheduled timers", () => {
    const { service, timers } = makeService();

    // Drive a call so the rate limiter schedules a TTL timer.
    service.tryCall("root-X", "socket-X");
    const before = timers.unrefRecord();
    expect(before.length).toBeGreaterThan(0);

    service.destroy();

    // After destroy() every timer the composite scheduled is cancelled.
    const after = timers.unrefRecord();
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((e) => e.cancelled)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: cronCount delegates to the injected provider (the cron-cap count source)
  // -------------------------------------------------------------------------
  it("cronCount delegates to the injected cronJobCount provider, and returns 0 when no provider is wired", () => {
    // With a provider: the count comes THROUGH the service from the provider.
    const withProvider = makeService({
      cronJobCount: (agentId) => (agentId === "a1" ? 3 : 0),
    });
    expect(withProvider.service.cronCount("a1")).toBe(3);
    expect(withProvider.service.cronCount("a2")).toBe(0);
    withProvider.service.destroy();

    // With NO provider wired (a non-daemon/test construction): cronCount is 0
    // (fail-open on this single limb — the endpoint gates origin/scope first).
    const noProvider = makeService();
    expect(noProvider.service.cronCount("a1")).toBe(0);
    noProvider.service.destroy();
  });

  // -------------------------------------------------------------------------
  // Test 6: snapshot(rootRunId, agentId, channelId)
  // composes the two per-module remaining() accessors + leaseIdsForRoot
  // into the read surface `capabilities.introspect`/`whoami` reports. It is a
  // PURE read (no gate mutation) and delegates — the composite already
  // holds the budget + quota sub-modules.
  // -------------------------------------------------------------------------
  it("snapshot() composes the per-root budget remaining + outward-quota remaining + leaseIds for the root", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      budget: { aggregateUsd: 10, tokens: 1000, wallClockMs: 60_000 },
      outward: { originOnly: true, perTargetGrants: ["chan-1"], volumeCap: 4000 },
      message: { channels: ["origin"], maxPerHour: 5 },
    };
    const { service, clock } = makeService({ config });

    // Register the root with a lease + consume some budget and one outward send.
    service.registerRoot("root-S", "lease-S1", "lease-parent");
    service.registerRoot("root-S", "lease-S2");
    expect(service.reserveBudget("root-S", FREE_PROVIDER, FREE_MODEL, 0, 100).kind).not.toBe("exceeded");
    expect(service.tryOutward("agent-S", "chan-1", false, 1).ok).toBe(true);
    clock.advance(10_000);

    const snap = service.snapshot("root-S", "agent-S", "chan-1");

    // budget limb — the PerRootBudget.remaining shape (token + wall-clock deltas;
    // $ untouched here since the free model records no priced spend → full cap).
    expect(snap.budget.tokensRemaining).toBe(900);
    expect(snap.budget.wallClockMsRemaining).toBe(50_000);
    expect(snap.budget.usdRemaining).not.toBeNull();
    expect(snap.budget.usdRemaining).toBeCloseTo(10, 10);

    // outwardQuota limb — the OutwardQuota.remaining shape (maxPerHour 5 - 1 used).
    expect(snap.outwardQuota.perHourRemaining).toBe(4);

    // leaseIds — the rootRunId↔leaseId correlation, as an array.
    expect([...snap.leaseIds].sort()).toEqual(["lease-S1", "lease-S2"]);

    service.destroy();
  });

  it("snapshot() is a PURE read — it does not mutate any gate (a subsequent reserve/send behaves as if snapshot was never called)", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      budget: { aggregateUsd: 10, tokens: 1000, wallClockMs: 60_000 },
      outward: { originOnly: true, perTargetGrants: [], volumeCap: 4000 },
      message: { channels: ["origin"], maxPerHour: 2 },
    };
    const { service } = makeService({ config });

    service.registerRoot("root-PS", "lease-PS");
    // Consume 900 tokens + 1 of 2 outward slots.
    expect(service.reserveBudget("root-PS", FREE_PROVIDER, FREE_MODEL, 0, 900).kind).not.toBe("exceeded");
    expect(service.tryOutward("agent-PS", "chan-origin", true, 1).ok).toBe(true);

    // Call snapshot() MANY times — a read must not consume budget or send slots.
    for (let i = 0; i < 5; i++) service.snapshot("root-PS", "agent-PS", "chan-origin");

    // The token total is untouched: 900 + 900 > 1000 → exceeded.
    expect(service.reserveBudget("root-PS", FREE_PROVIDER, FREE_MODEL, 0, 900).kind).toBe("exceeded");
    // The outward window is untouched: slot 2 passes, the 3rd is denied.
    expect(service.tryOutward("agent-PS", "chan-origin", true, 1).ok).toBe(true);
    expect(service.tryOutward("agent-PS", "chan-origin", true, 1).ok).toBe(false);

    service.destroy();
  });

  it("snapshot() for an unknown root returns full budget/quota allowance and an empty leaseIds (never throws)", () => {
    const config: ResolvedAutonomy = {
      ...resolveAutonomy(),
      budget: { aggregateUsd: 10, tokens: 1000, wallClockMs: 60_000 },
      message: { channels: ["origin"], maxPerHour: 5 },
    };
    const { service } = makeService({ config });

    const snap = service.snapshot("root-NONE", "agent-NONE", "chan-NONE");
    expect(snap.budget.tokensRemaining).toBe(1000);
    expect(snap.budget.wallClockMsRemaining).toBe(60_000);
    expect(snap.outwardQuota.perHourRemaining).toBe(5);
    expect([...snap.leaseIds]).toEqual([]);

    service.destroy();
  });
});
