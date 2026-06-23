// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createOutwardQuota } from "./outward-quota.js";
import type { OutwardQuota } from "./outward-quota.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import type { FakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// QUOTA-01/02: outward is the irreversible-action gate. Origin-channel sends pass
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
});
