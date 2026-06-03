// SPDX-License-Identifier: Apache-2.0
/**
 * Unit test for the pure privacy/redaction leak-rate scorer. RED first: pins
 * leak-rate = leaked / validTotal * 100, where a
 * probe is `leaked` when a planted SYNTHETIC secret reached the recalled context.
 * Invalid probes are excluded from the denominator (the qa-accuracy doctrine).
 *
 * SECURITY (the load-bearing reason this scorer takes BOOLEAN flags, never the
 * secret strings): the detector — scanForSecrets / looksLikeSecretValue — runs in
 * the gated harness; the scorer sees only `leaked: boolean`, so it can NEVER hold
 * or emit a planted secret. This test deliberately constructs probes with NO
 * secret-shaped strings to lock that contract in.
 *
 * LOWER leak-rate is better (0 = nothing leaked). This is the metric the
 * gated harness reports; freeze it.
 */

import { describe, expect, it } from "vitest";

import { scoreRedaction, type RedactionScore } from "./redaction-scorer.js";

function probe(leaked: boolean, invalid = false): { leaked: boolean; invalid: boolean } {
  return { leaked, invalid };
}

describe("scoreRedaction", () => {
  it("returns a 0 leak-rate (never NaN) for an empty probe set", () => {
    const score: RedactionScore = scoreRedaction([]);
    expect(score.leakRate).toBe(0);
    expect(score.total).toBe(0);
    expect(score.invalid).toBe(0);
    expect(score.validTotal).toBe(0);
    expect(score.leakedCount).toBe(0);
  });

  it("reports a 0 leak-rate when no planted secret reached any recalled context", () => {
    const score = scoreRedaction([probe(false), probe(false), probe(false)]);
    expect(score.leakRate).toBe(0);
    expect(score.total).toBe(3);
    expect(score.validTotal).toBe(3);
    expect(score.leakedCount).toBe(0);
  });

  it("reports a 100 leak-rate when every probe leaked its planted secret", () => {
    const score = scoreRedaction([probe(true), probe(true)]);
    expect(score.leakRate).toBe(100);
    expect(score.total).toBe(2);
    expect(score.validTotal).toBe(2);
    expect(score.leakedCount).toBe(2);
  });

  it("excludes invalid probes from the leak-rate denominator", () => {
    // 1 leaked + 1 clean = 2 valid (leakRate 50); the invalid probe is excluded
    // from BOTH the denominator and the leaked count even though it is flagged
    // leaked (an invalid probe never counts as a leak).
    const score = scoreRedaction([probe(true), probe(false), probe(true, true)]);
    expect(score.leakRate).toBe(50);
    expect(score.total).toBe(3);
    expect(score.invalid).toBe(1);
    expect(score.validTotal).toBe(2);
    expect(score.leakedCount).toBe(1);
  });

  it("takes only boolean flags so it can never hold a planted secret string", () => {
    // The probe shape is `{ leaked: boolean; invalid: boolean }` — no secret
    // field exists for a secret to ride on. A leaked + a clean probe → 50.
    const score = scoreRedaction([probe(true), probe(false)]);
    expect(score.leakRate).toBe(50);
    expect(score.validTotal).toBe(2);
    expect(score.leakedCount).toBe(1);
    // Every field is a NUMBER — there is no string-typed field a secret could
    // ride on (the report-omission invariant, proven structurally). The VALUES
    // (not the JSON keys, which are naturally alphabetic) carry no letters.
    for (const value of Object.values(score)) {
      expect(typeof value).toBe("number");
    }
    expect(JSON.stringify(Object.values(score))).not.toMatch(/[A-Za-z]/);
  });
});
