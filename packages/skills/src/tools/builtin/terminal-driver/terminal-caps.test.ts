// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-session usage-cap primitive (terminal-caps.ts).
 *
 * `createSessionCaps(limits, nowMs)` is a pure, fully-injected factory closing over
 * a CLOSURE-local `Map<sessionId, CapState>` (no module-global mutable state) and an
 * INJECTED `nowMs` reader (no wall-clock global anywhere in the module under test). The
 * module never throws and never evicts — it returns a typed `{ breach }` discriminant
 * the tool/registry layer maps to a reject (`maxRequestsPerSession`) or
 * an eviction (`maxInteractions`/`wallClockMs`). These tests pin the FULL contract:
 *
 *   - `maxRequestsPerSession` trips on the Nth+1 request (breach
 *     "max_requests"); the counter increments only on ok, never on a breach.
 *   - `maxInteractions` trips on the Nth+1 interaction (breach
 *     "max_interactions").
 *   - `wallClockMs` trips when `nowMs() - startedAtMs` EXCEEDS the cap
 *     (breach "wall_clock") — read via the INJECTED clock, advanced by a mutable
 *     `let now` (no real time, no wall-clock global).
 *   - Undefined / empty limits ⇒ no cap ⇒ never breaches, however many calls.
 *   - Per-session isolation: two sessionIds never share a counter, and two distinct
 *     `createSessionCaps(...)` instances never share state (no module-global).
 *   - `forget(id)` clears a session's counters so a re-used id starts fresh (the
 *     registry calls this on every kill/evict so the map never leaks).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { createSessionCaps, type CapBreach } from "./terminal-caps.js";

const FIXED_NOW = 1_700_000_000_000;

describe("createSessionCaps — maxRequestsPerSession (REJECT)", () => {
  it("trips on the Nth+1 request and increments only on ok", () => {
    const caps = createSessionCaps({ maxRequestsPerSession: 2 }, () => FIXED_NOW);

    expect(caps.consumeRequest("s1")).toBeUndefined(); // 1st ok
    expect(caps.consumeRequest("s1")).toBeUndefined(); // 2nd ok (== cap)

    // 3rd is the Nth+1 → breach, with the typed reason.
    const breach = caps.consumeRequest("s1");
    expect(breach).toEqual<{ breach: CapBreach }>({ breach: "max_requests" });

    // The counter did NOT increment on the breach: still exactly at the cap, so a
    // re-check keeps breaching (it never silently leaks an extra allowance).
    expect(caps.consumeRequest("s1")).toEqual({ breach: "max_requests" });
  });
});

describe("createSessionCaps — maxInteractions (EVICT-driving)", () => {
  it("trips on the Nth+1 interaction", () => {
    const caps = createSessionCaps({ maxInteractions: 1 }, () => FIXED_NOW);

    expect(caps.consumeInteraction("s1")).toBeUndefined(); // 1st ok (== cap)
    expect(caps.consumeInteraction("s1")).toEqual<{ breach: CapBreach }>({
      breach: "max_interactions",
    });
  });
});

describe("createSessionCaps — wallClockMs (injected clock, EVICT-driving)", () => {
  it("trips once nowMs - startedAtMs EXCEEDS the cap, using the injected reader", () => {
    let now = 1_000_000;
    const caps = createSessionCaps({ wallClockMs: 1000 }, () => now);

    caps.startSession("s1"); // captures startedAt = 1_000_000

    // At startedAt the budget is fully available.
    expect(caps.checkWallClock("s1")).toBeUndefined();

    // Exactly at the cap boundary (elapsed == 1000) is NOT yet a breach (strict >).
    now += 1000;
    expect(caps.checkWallClock("s1")).toBeUndefined();

    // One ms past the cap → breach.
    now += 1;
    expect(caps.checkWallClock("s1")).toEqual<{ breach: CapBreach }>({
      breach: "wall_clock",
    });
  });
});

describe("createSessionCaps — no limit ⇒ never breaches", () => {
  it("returns undefined for every method when limits is undefined", () => {
    const caps = createSessionCaps(undefined, () => FIXED_NOW);
    caps.startSession("s1");

    for (let i = 0; i < 100; i++) {
      expect(caps.consumeRequest("s1")).toBeUndefined();
      expect(caps.consumeInteraction("s1")).toBeUndefined();
      expect(caps.checkWallClock("s1")).toBeUndefined();
    }
  });

  it("returns undefined for every method when limits is {} (no fields set)", () => {
    let now = FIXED_NOW;
    const caps = createSessionCaps({}, () => now);
    caps.startSession("s1");

    for (let i = 0; i < 100; i++) {
      now += 10_000; // even after a long wall-clock, an unset cap never trips
      expect(caps.consumeRequest("s1")).toBeUndefined();
      expect(caps.consumeInteraction("s1")).toBeUndefined();
      expect(caps.checkWallClock("s1")).toBeUndefined();
    }
  });
});

describe("createSessionCaps — per-session isolation (no bleed, no module-global)", () => {
  it("keeps each sessionId's counter independent within one instance", () => {
    const caps = createSessionCaps({ maxRequestsPerSession: 1 }, () => FIXED_NOW);

    expect(caps.consumeRequest("s1")).toBeUndefined(); // s1 spends its 1
    expect(caps.consumeRequest("s2")).toBeUndefined(); // s2 has its OWN counter

    // s1 is now at cap → breach; s2 is independent and still has nothing spent
    // beyond its own first call.
    expect(caps.consumeRequest("s1")).toEqual({ breach: "max_requests" });
    expect(caps.consumeRequest("s2")).toEqual({ breach: "max_requests" });
  });

  it("never shares state across two distinct createSessionCaps instances", () => {
    const a = createSessionCaps({ maxRequestsPerSession: 1 }, () => FIXED_NOW);
    const b = createSessionCaps({ maxRequestsPerSession: 1 }, () => FIXED_NOW);

    expect(a.consumeRequest("s1")).toBeUndefined();
    expect(a.consumeRequest("s1")).toEqual({ breach: "max_requests" }); // a is spent

    // The SAME sessionId on a fresh instance starts fresh — proves no module-global.
    expect(b.consumeRequest("s1")).toBeUndefined();
  });
});

describe("createSessionCaps — forget(id) on kill/evict", () => {
  it("clears a session's counters so a re-used id starts fresh", () => {
    let now = FIXED_NOW;
    const caps = createSessionCaps(
      { maxRequestsPerSession: 1, maxInteractions: 1, wallClockMs: 1000 },
      () => now,
    );

    caps.startSession("s1");
    expect(caps.consumeRequest("s1")).toBeUndefined();
    expect(caps.consumeInteraction("s1")).toBeUndefined();
    expect(caps.consumeRequest("s1")).toEqual({ breach: "max_requests" }); // at cap
    now += 2000;
    expect(caps.checkWallClock("s1")).toEqual({ breach: "wall_clock" }); // aged out

    // Kill/evict the session → forget its counters.
    caps.forget("s1");

    // A re-used id starts completely fresh: request + interaction budgets reset,
    // and the wall clock re-anchors on the next startSession.
    caps.startSession("s1");
    expect(caps.consumeRequest("s1")).toBeUndefined();
    expect(caps.consumeInteraction("s1")).toBeUndefined();
    expect(caps.checkWallClock("s1")).toBeUndefined();
  });

  it("is a no-op for an unknown session id (never throws)", () => {
    const caps = createSessionCaps({ maxRequestsPerSession: 1 }, () => FIXED_NOW);
    expect(() => caps.forget("never-seen")).not.toThrow();
  });
});

describe("createSessionCaps — startSession is idempotent (does not reset the wall clock)", () => {
  it("keeps the original startedAt when called twice", () => {
    let now = 1_000_000;
    const caps = createSessionCaps({ wallClockMs: 1000 }, () => now);

    caps.startSession("s1"); // startedAt = 1_000_000
    now += 1500; // already past the cap window

    // A re-call must NOT re-anchor startedAt to the later `now` (that would let a
    // long-lived session dodge the wall-clock cap forever).
    caps.startSession("s1");
    expect(caps.checkWallClock("s1")).toEqual({ breach: "wall_clock" });
  });
});
