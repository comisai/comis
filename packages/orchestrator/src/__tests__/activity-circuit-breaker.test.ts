// SPDX-License-Identifier: Apache-2.0
/**
 * activity-circuit-breaker.test.
 *
 * The auto-managed per-agent×channel breaker classifies on the
 * `ActivityRenderError.kind` union (NOT the `ErrorKind` log union):
 *   • permission            → ×3 consecutive, STICKY (reset only on config reload),
 *   • internal | transient_network → ×5 consecutive, half-open probe after 5 min,
 *   • rate_limited | not_supported → NON-tripping (debounce/drop handles them).
 *
 * Timing is clock-delta only (`clock.now()` comparisons) — there is no
 * setTimeout/setInterval anywhere (AGENTS.md §2.5). The harness mirrors
 * agent/src/safety/circuit-breaker.test.ts: process-global fake timers + a
 * testClock that delegates to Date.now().
 */
import type { ActivityRenderError, ClockPort } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createActivityCircuitBreaker } from "../execution/activity-circuit-breaker.js";

// ---------------------------------------------------------------------------
// Harness — delegate the injected clock to the (faked) Date.now wall clock so
// vi.advanceTimersByTime drives clock.now() deltas, exactly like the agent
// breaker test (circuit-breaker.test.ts:6-7).
// ---------------------------------------------------------------------------

const testClock: ClockPort = { now: () => Date.now(), nowDate: () => new Date() };

const HALF_OPEN_MS = 300_000; // 5 minutes — the default transient probe delay.

const KEY_A = { agentId: "agent-1", channelKey: "discord-chan" } as const;
const KEY_B = { agentId: "agent-1", channelKey: "slack-chan" } as const;

const PERMISSION: ActivityRenderError = { kind: "permission", detail: "forbidden" };
const INTERNAL: ActivityRenderError = { kind: "internal", cause: new Error("boom") };
const TRANSIENT: ActivityRenderError = { kind: "transient_network", cause: new Error("net") };
const RATE_LIMITED: ActivityRenderError = { kind: "rate_limited", retryAfterMs: 500 };
const NOT_SUPPORTED: ActivityRenderError = { kind: "not_supported", capability: "edit" };

const FAIL = (e: ActivityRenderError): Result<void, ActivityRenderError> => err(e);
const OK: Result<void, ActivityRenderError> = ok(undefined);

describe("createActivityCircuitBreaker — dual-threshold per agent×channel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Permission threshold — ×3, STICKY
  // -------------------------------------------------------------------------

  it("stays closed below the permission threshold of three consecutive errors", () => {
    const cb = createActivityCircuitBreaker(testClock);
    expect(cb.record(KEY_A, FAIL(PERMISSION)).tripped).toBe(false);
    expect(cb.record(KEY_A, FAIL(PERMISSION)).tripped).toBe(false);
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  it("trips on the third consecutive permission error and reports reason permission", () => {
    const cb = createActivityCircuitBreaker(testClock);
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    const third = cb.record(KEY_A, FAIL(PERMISSION));
    expect(third.tripped).toBe(true);
    expect(third.reason).toBe("permission");
    expect(cb.isTripped(KEY_A)).toBe(true);
  });

  it("reports a fresh permission trip exactly once, not on each subsequent failure", () => {
    const cb = createActivityCircuitBreaker(testClock);
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    expect(cb.record(KEY_A, FAIL(PERMISSION)).tripped).toBe(true);
    // Already-open: further records must NOT re-report a fresh trip.
    expect(cb.record(KEY_A, FAIL(PERMISSION)).tripped).toBe(false);
    expect(cb.record(KEY_A, FAIL(PERMISSION)).tripped).toBe(false);
  });

  it("keeps a sticky permission trip open after advancing the clock by any amount", () => {
    const cb = createActivityCircuitBreaker(testClock);
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    expect(cb.isTripped(KEY_A)).toBe(true);

    // STICKY: the clock-based half-open NEVER applies to a permission trip.
    vi.advanceTimersByTime(HALF_OPEN_MS * 100);
    expect(cb.isTripped(KEY_A)).toBe(true);
  });

  it("clears a sticky permission trip only via reset (the config-reload path)", () => {
    const cb = createActivityCircuitBreaker(testClock);
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    expect(cb.isTripped(KEY_A)).toBe(true);

    cb.reset(KEY_A);
    expect(cb.isTripped(KEY_A)).toBe(false);
    // After reset, the consecutive counter is cleared — needs a full three again.
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  it("resets the permission counter on an intervening successful record", () => {
    const cb = createActivityCircuitBreaker(testClock);
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, OK); // success resets the consecutive count
    cb.record(KEY_A, FAIL(PERMISSION));
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Transient threshold — ×5, half-open after 5 min
  // -------------------------------------------------------------------------

  it("trips on the fifth consecutive internal error with reason transient", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 4; i++) expect(cb.record(KEY_A, FAIL(INTERNAL)).tripped).toBe(false);
    const fifth = cb.record(KEY_A, FAIL(INTERNAL));
    expect(fifth.tripped).toBe(true);
    expect(fifth.reason).toBe("transient");
    expect(cb.isTripped(KEY_A)).toBe(true);
  });

  it("trips on five consecutive transient_network errors", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 4; i++) cb.record(KEY_A, FAIL(TRANSIENT));
    expect(cb.record(KEY_A, FAIL(TRANSIENT)).tripped).toBe(true);
    expect(cb.isTripped(KEY_A)).toBe(true);
  });

  it("keeps a transient trip open until five minutes elapse on the clock", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 5; i++) cb.record(KEY_A, FAIL(INTERNAL));
    expect(cb.isTripped(KEY_A)).toBe(true);

    vi.advanceTimersByTime(HALF_OPEN_MS - 1);
    expect(cb.isTripped(KEY_A)).toBe(true);
  });

  it("allows a half-open probe after five minutes elapse on the clock", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 5; i++) cb.record(KEY_A, FAIL(INTERNAL));
    expect(cb.isTripped(KEY_A)).toBe(true);

    vi.advanceTimersByTime(HALF_OPEN_MS);
    // Half-open: the gate now allows one probe through.
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  it("closes a half-open transient breaker on a successful probe", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 5; i++) cb.record(KEY_A, FAIL(INTERNAL));
    vi.advanceTimersByTime(HALF_OPEN_MS);
    expect(cb.isTripped(KEY_A)).toBe(false); // half-open probe allowed

    cb.record(KEY_A, OK); // probe succeeds → closed
    expect(cb.isTripped(KEY_A)).toBe(false);
    // Closed: a single fresh failure must not re-trip immediately.
    cb.record(KEY_A, FAIL(INTERNAL));
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  it("re-opens a half-open transient breaker on a failed probe", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 5; i++) cb.record(KEY_A, FAIL(INTERNAL));
    vi.advanceTimersByTime(HALF_OPEN_MS);
    expect(cb.isTripped(KEY_A)).toBe(false); // half-open probe allowed

    const reopen = cb.record(KEY_A, FAIL(INTERNAL)); // probe fails → re-open
    expect(reopen.tripped).toBe(true);
    expect(cb.isTripped(KEY_A)).toBe(true);
    // Re-opened: still tripped until the next half-open window elapses.
    vi.advanceTimersByTime(HALF_OPEN_MS - 1);
    expect(cb.isTripped(KEY_A)).toBe(true);
  });

  it("resets the transient counter on an intervening successful record", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 4; i++) cb.record(KEY_A, FAIL(INTERNAL));
    cb.record(KEY_A, OK); // success resets the consecutive count
    cb.record(KEY_A, FAIL(INTERNAL));
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Dual-counter independence (permission vs transient do not bleed)
  // -------------------------------------------------------------------------

  it("does not let permission and transient counters bleed into each other", () => {
    const cb = createActivityCircuitBreaker(testClock);
    // Two permission + four transient — neither reaches its own threshold.
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(TRANSIENT));
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(TRANSIENT));
    cb.record(KEY_A, FAIL(TRANSIENT));
    cb.record(KEY_A, FAIL(TRANSIENT));
    // permission=2 (<3), transient=4 (<5) → still closed.
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  it("treats a transient error as breaking the consecutive permission streak", () => {
    const cb = createActivityCircuitBreaker(testClock);
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(TRANSIENT)); // a different tripping kind breaks the permission streak
    cb.record(KEY_A, FAIL(PERMISSION));
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Non-tripping kinds
  // -------------------------------------------------------------------------

  it("never trips on rate_limited or not_supported errors", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 10; i++) {
      expect(cb.record(KEY_A, FAIL(RATE_LIMITED)).tripped).toBe(false);
      expect(cb.record(KEY_A, FAIL(NOT_SUPPORTED)).tripped).toBe(false);
    }
    expect(cb.isTripped(KEY_A)).toBe(false);
  });

  it("treats a non-tripping error as not resetting the tripping counters", () => {
    const cb = createActivityCircuitBreaker(testClock);
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(RATE_LIMITED)); // ignored — does NOT reset like a success
    expect(cb.record(KEY_A, FAIL(PERMISSION)).tripped).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Per-key isolation
  // -------------------------------------------------------------------------

  it("isolates each agent×channel key so tripping one leaves another closed", () => {
    const cb = createActivityCircuitBreaker(testClock);
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    expect(cb.isTripped(KEY_A)).toBe(true);
    expect(cb.isTripped(KEY_B)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // getTripped snapshot
  // -------------------------------------------------------------------------

  it("getTripped returns the currently tripped keys with their reason", () => {
    const cb = createActivityCircuitBreaker(testClock);
    expect(cb.getTripped()).toEqual([]);

    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    cb.record(KEY_A, FAIL(PERMISSION));
    for (let i = 0; i < 5; i++) cb.record(KEY_B, FAIL(INTERNAL));

    const tripped = cb.getTripped();
    expect(tripped).toContainEqual({ agentId: "agent-1", channelKey: "discord-chan", reason: "permission" });
    expect(tripped).toContainEqual({ agentId: "agent-1", channelKey: "slack-chan", reason: "transient" });
    expect(tripped.length).toBe(2);
  });

  it("getTripped omits a transient key once its half-open window has elapsed", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 5; i++) cb.record(KEY_A, FAIL(INTERNAL));
    expect(cb.getTripped().length).toBe(1);

    vi.advanceTimersByTime(HALF_OPEN_MS);
    // Half-open is no longer "tripped" for gating purposes — drop it from the snapshot.
    expect(cb.getTripped()).toEqual([]);
  });

  it("getTripped still lists a sticky permission key after the clock advances", () => {
    const cb = createActivityCircuitBreaker(testClock);
    for (let i = 0; i < 3; i++) cb.record(KEY_A, FAIL(PERMISSION));
    vi.advanceTimersByTime(HALF_OPEN_MS * 10);
    expect(cb.getTripped()).toContainEqual({
      agentId: "agent-1",
      channelKey: "discord-chan",
      reason: "permission",
    });
  });

  it("getTripped reports the exact agentId and channelKey when the agentId itself contains the separator", () => {
    // Agent IDs are unvalidated free-form strings (config schema:
    // z.record(z.string().min(1), …) — no charset restriction), so an id may
    // contain the `::` composite-key separator. The internal Map key is
    // `${agentId}::${channelKey}`; getTripped() must round-trip the ORIGINAL
    // fields, not re-split the string on the first/any `::`.
    const cb = createActivityCircuitBreaker(testClock);
    const COLON_KEY = { agentId: "tenant::a1", channelKey: "discord-chan" } as const;
    for (let i = 0; i < 3; i++) cb.record(COLON_KEY, FAIL(PERMISSION));
    expect(cb.isTripped(COLON_KEY)).toBe(true);

    expect(cb.getTripped()).toContainEqual({
      agentId: "tenant::a1",
      channelKey: "discord-chan",
      reason: "permission",
    });
  });

  it("getTripped reports the exact channelKey when the channelKey itself contains the separator", () => {
    // The channelKey is equally unrestricted; a `::` inside it must not bleed
    // into the reported agentId either.
    const cb = createActivityCircuitBreaker(testClock);
    const COLON_CHAN = { agentId: "agent-1", channelKey: "discord::guild::42" } as const;
    for (let i = 0; i < 5; i++) cb.record(COLON_CHAN, FAIL(INTERNAL));
    expect(cb.isTripped(COLON_CHAN)).toBe(true);

    expect(cb.getTripped()).toContainEqual({
      agentId: "agent-1",
      channelKey: "discord::guild::42",
      reason: "transient",
    });
  });

  // -------------------------------------------------------------------------
  // Custom thresholds
  // -------------------------------------------------------------------------

  it("honours custom permission and transient thresholds and half-open delay", () => {
    const cb = createActivityCircuitBreaker(testClock, {
      permissionThreshold: 1,
      transientThreshold: 2,
      halfOpenMs: 1_000,
    });
    expect(cb.record(KEY_A, FAIL(PERMISSION)).tripped).toBe(true);

    cb.record(KEY_B, FAIL(INTERNAL));
    expect(cb.record(KEY_B, FAIL(INTERNAL)).tripped).toBe(true);
    vi.advanceTimersByTime(999);
    expect(cb.isTripped(KEY_B)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cb.isTripped(KEY_B)).toBe(false);
  });
});
