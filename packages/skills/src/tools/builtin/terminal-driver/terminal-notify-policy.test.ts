// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the pure NOTIFY-01 drive.notify gate
 * (terminal-notify-policy.ts) — design §4 Phase D, CONTEXT I4.
 *
 * RED-first: `terminal-notify-policy.ts` does not exist when this file is first
 * committed — the import fails, every case is RED. The production module turns them
 * GREEN. (Mirrors terminal-spend-ceiling.test.ts:1-9 — the "module does not exist on
 * first commit" banner.)
 *
 * `shouldNotifyOutcome(outcome, policy)` answers ONE question: should this terminal
 * outcome reach the USER, given the `drive.notify` policy?
 *
 *   - outcome === "needs-you" → ALWAYS true (I4 — an escalation is a security signal that
 *     notifies even under "none"; the load-bearing cell). RED-pin under EVERY policy.
 *   - else (done/failed)      → policy !== "none" (suppressed ONLY under "none"; fire under
 *     "terminal"/"all").
 *
 * Pitfall 1 (I4 regression): the escalation must NOT be routable through a uniform
 * suppression — `needs-you` under `none` is the canary cell. Pinned both ways below.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { shouldNotifyOutcome, type NotifyPolicy } from "./terminal-notify-policy.js";

describe("shouldNotifyOutcome — needs-you ALWAYS fires (I4 — even under 'none')", () => {
  it("needs-you under 'none' → true (the load-bearing I4 cell — an escalation is never silenced)", () => {
    expect(shouldNotifyOutcome("needs-you", "none")).toBe(true);
  });

  it("needs-you under 'terminal' → true", () => {
    expect(shouldNotifyOutcome("needs-you", "terminal")).toBe(true);
  });

  it("needs-you under 'all' → true", () => {
    expect(shouldNotifyOutcome("needs-you", "all")).toBe(true);
  });
});

describe("shouldNotifyOutcome — done/failed gated by policy (suppressed only under 'none')", () => {
  it("done under 'terminal' → true", () => {
    expect(shouldNotifyOutcome("done", "terminal")).toBe(true);
  });

  it("done under 'all' → true", () => {
    expect(shouldNotifyOutcome("done", "all")).toBe(true);
  });

  it("done under 'none' → false (suppressed)", () => {
    expect(shouldNotifyOutcome("done", "none")).toBe(false);
  });

  it("failed under 'none' → false (suppressed)", () => {
    expect(shouldNotifyOutcome("failed", "none")).toBe(false);
  });

  it("failed under 'terminal' → true", () => {
    expect(shouldNotifyOutcome("failed", "terminal")).toBe(true);
  });

  it("failed under 'all' → true", () => {
    expect(shouldNotifyOutcome("failed", "all")).toBe(true);
  });
});

describe("shouldNotifyOutcome — TOTAL (never throws)", () => {
  it("never throws on any outcome/policy pair", () => {
    const policies: NotifyPolicy[] = ["terminal", "all", "none"];
    for (const p of policies) {
      expect(() => shouldNotifyOutcome("done", p)).not.toThrow();
      expect(() => shouldNotifyOutcome("needs-you", p)).not.toThrow();
      expect(() => shouldNotifyOutcome("failed", p)).not.toThrow();
    }
  });
});
