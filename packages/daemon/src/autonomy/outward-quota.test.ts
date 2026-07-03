// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createOutwardQuota } from "./outward-quota.js";
import type { OutwardQuota } from "./outward-quota.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import type { FakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Outward is the irreversible-action gate. Origin-channel sends pass
// under a per-hour quota; a NEW target needs an explicit per-target grant; a
// high-volume / mass-recipient send is gated even to origin. Clock is INJECTED.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

interface Harness {
  clock: FakeClock;
  quota: OutwardQuota;
}

function makeQuota(
  config: Partial<Parameters<typeof createOutwardQuota>[0]["config"]> = {},
): Harness {
  const clock = createFakeClock(1_000_000);
  const quota = createOutwardQuota({
    clock,
    config: {
      originOnly: true,
      perTargetGrants: [],
      volumeCap: 100,
      maxPerHour: 3,
      ...config,
    },
    logger: createMockLogger(),
  });
  return { clock, quota };
}

describe("createOutwardQuota", () => {
  it("exposes tryOutward on the returned quota guard", () => {
    const { quota } = makeQuota();
    expect(typeof quota.tryOutward).toBe("function");
  });

  it("allows origin-channel sends up to the per-hour cap then denies with reason per_hour", () => {
    const { clock, quota } = makeQuota({ maxPerHour: 3 });
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);

    const denied = quota.tryOutward("agentA", "chan-origin", true, 10);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.reason).toBe("per_hour");

    // A fresh rolling hour resets the per-(agent,channel) window.
    clock.advance(HOUR_MS + 1);
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
  });

  it("denies a new non-origin target without an explicit per-target grant with reason no_grant", () => {
    const { quota } = makeQuota({ perTargetGrants: [] });
    const result = quota.tryOutward("agentA", "chan-NEW", false, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("no_grant");
  });

  it("allows a new non-origin target when it is in the per-target grant list", () => {
    const { quota } = makeQuota({ perTargetGrants: ["chan-NEW"] });
    expect(quota.tryOutward("agentA", "chan-NEW", false, 10).ok).toBe(true);
  });

  it("gates a high-volume send over the volume cap even to the origin channel with reason volume", () => {
    const { quota } = makeQuota({ volumeCap: 100 });
    const result = quota.tryOutward("agentA", "chan-origin", true, 101);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("volume");
  });

  it("keys the per-hour window per agent and channel so distinct keys do not share quota", () => {
    const { quota } = makeQuota({
      maxPerHour: 1,
      perTargetGrants: ["chan-B"],
    });
    // agentA consumes its single per-hour slot to chan-origin.
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    const reExhausted = quota.tryOutward("agentA", "chan-origin", true, 10);
    expect(reExhausted.ok).toBe(false);

    // A different agent to the same channel has its own slot.
    expect(quota.tryOutward("agentB", "chan-origin", true, 10).ok).toBe(true);
    // The same agent to a DIFFERENT (granted) channel has its own slot.
    expect(quota.tryOutward("agentA", "chan-B", false, 10).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // A PURE `remaining(agentId, channelId)` read — the per-hour headroom the
  // `capabilities.introspect` / `whoami` RPC reports. The gate tracks the
  // rolling-hour `counters` internally but exposes NO write on this read path.
  // `remaining` reports `maxPerHour - count` for the LIVE window as a READ-ONLY
  // view — it must NOT reset/advance the window: the load-bearing invariant is
  // no `counters.set`.
  // -------------------------------------------------------------------------
  it("remaining(agentId, channelId) reports maxPerHour minus the count consumed in the live window", () => {
    const { quota } = makeQuota({ maxPerHour: 3 });

    // Fresh key → full allowance.
    expect(quota.remaining("agentA", "chan-origin").perHourRemaining).toBe(3);

    // Consume 2 sends → 1 remaining.
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    expect(quota.remaining("agentA", "chan-origin").perHourRemaining).toBe(1);

    // Consume the last slot → 0 remaining (clamped, never negative).
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    expect(quota.remaining("agentA", "chan-origin").perHourRemaining).toBe(0);
  });

  it("remaining() returns the full allowance for an unseen key OR an expired window", () => {
    const { clock, quota } = makeQuota({ maxPerHour: 3 });

    // Unseen key → full allowance.
    expect(quota.remaining("agentX", "chan-unseen").perHourRemaining).toBe(3);

    // Consume the window, then let it expire → the read reports the full allowance
    // again (the expired window is treated as fresh — same as tryOutward's reset).
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    expect(quota.remaining("agentA", "chan-origin").perHourRemaining).toBe(1);
    clock.advance(HOUR_MS + 1);
    expect(quota.remaining("agentA", "chan-origin").perHourRemaining).toBe(3);
  });

  it("remaining() is a PURE read — it does NOT reset/advance the window (T-215-05: no counters.set side effect)", () => {
    const { quota } = makeQuota({ maxPerHour: 2 });

    // Consume 1 of 2 slots.
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);

    // Call remaining() MANY times — a read must not reset the window. If it did
    // (counters.set), the count would drop to 0 and the next two sends would pass.
    for (let i = 0; i < 5; i++) {
      expect(quota.remaining("agentA", "chan-origin").perHourRemaining).toBe(1);
    }

    // The window is UNCHANGED by the reads: the second send still passes (slot 2),
    // and the THIRD is denied — exactly as if remaining() was never called.
    expect(quota.tryOutward("agentA", "chan-origin", true, 10).ok).toBe(true);
    const denied = quota.tryOutward("agentA", "chan-origin", true, 10);
    expect(denied.ok).toBe(false);
  });
});
