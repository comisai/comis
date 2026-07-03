// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { cosine } from "./cosine.js";

// cosine is a rag-local util; its coverage lives here so the recall hot-path
// proximity util stays no-mock tested.
describe("cosine — pure vector proximity", () => {
  it("computes parallel=1, orthogonal=0, and guards a zero-norm vector to 0 (no NaN)", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 on a length mismatch or empty vector (no neighbour, never NaN)", () => {
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});
