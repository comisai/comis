// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the FORGET-03 corroboration gate (`failureCorroborated`) — extracted from
 * setup-learning.ts into its own leaf to keep that file under the 800-line cap. The
 * gate logic is byte-identical to the pre-extraction code; these tests pin its branches.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  failureCorroborated,
  CORROBORATION_MIN_INDEPENDENT,
  MAX_TRACKED_FAILURE_MEMORIES,
} from "./setup-learning-corroboration.js";

describe("failureCorroborated — FORGET-03 anti-induced-eviction gate", () => {
  it("corroborates immediately on a DETERMINISTIC source (one tool/pipeline failure suffices)", () => {
    const tally = new Map<string, Set<string>>();
    expect(failureCorroborated("mem-1", "session-a", ["tool"], tally)).toBe(true);
    expect(failureCorroborated("mem-2", "session-a", ["pipeline"], tally)).toBe(true);
  });

  it("does NOT corroborate a single NON-deterministic (reaction/correction/external) failure", () => {
    const tally = new Map<string, Set<string>>();
    expect(failureCorroborated("mem-1", "session-a", ["reaction"], tally)).toBe(false);
  });

  it("corroborates a non-deterministic failure once ≥2 DISTINCT sessions are seen", () => {
    const tally = new Map<string, Set<string>>();
    expect(failureCorroborated("mem-1", "session-a", ["correction"], tally)).toBe(false);
    // Same session repeated does NOT add a distinct count → still below the floor.
    expect(failureCorroborated("mem-1", "session-a", ["correction"], tally)).toBe(false);
    // A second DISTINCT session reaches CORROBORATION_MIN_INDEPENDENT.
    expect(failureCorroborated("mem-1", "session-b", ["correction"], tally)).toBe(true);
  });

  it("stops growing the inner distinct-session set at CORROBORATION_MIN_INDEPENDENT (WR-01)", () => {
    const tally = new Map<string, Set<string>>();
    for (let i = 0; i < 10; i++) failureCorroborated("mem-hot", `session-${i}`, ["reaction"], tally);
    expect(tally.get("mem-hot")!.size).toBeLessThanOrEqual(CORROBORATION_MIN_INDEPENDENT);
    // Still corroborated (the floor was reached).
    expect(failureCorroborated("mem-hot", "session-final", ["reaction"], tally)).toBe(true);
  });

  it("caps the outer tally Map and evicts the OLDEST-touched memoryId (WR-01 bound)", () => {
    const tally = new Map<string, Set<string>>();
    const maxTracked = 3;
    for (let i = 0; i < 5; i++) {
      failureCorroborated(`mem-${i}`, "session-x", ["reaction"], tally, maxTracked);
    }
    expect(tally.size).toBeLessThanOrEqual(maxTracked);
    // The earliest ids were evicted; the most-recent remain.
    expect(tally.has("mem-4")).toBe(true);
    expect(tally.has("mem-0")).toBe(false);
  });

  it("exposes the documented constant defaults", () => {
    expect(CORROBORATION_MIN_INDEPENDENT).toBe(2);
    expect(MAX_TRACKED_FAILURE_MEMORIES).toBe(50_000);
  });
});
