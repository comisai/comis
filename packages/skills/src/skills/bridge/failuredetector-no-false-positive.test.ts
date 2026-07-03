// SPDX-License-Identifier: Apache-2.0
/**
 * Shrink-only arch invariant: no registered failureDetector may flag a
 * status:200 + no-error result (the codified c53ab0f invariant).
 *
 * c53ab0f fixed two web tools (web_search / web_fetch) whose body-substring
 * detectors mis-flagged a HTTP-200 success — e.g. a share price
 * "403.92999267578" matched `/403/`, then the retry-breaker stopped the tool.
 * This test generalizes that fix to ALL registered detectors (present AND
 * future) at static/CI time: it iterates every `getAllToolMetadata()` entry
 * with a `failureDetector`, probes it with a `{status:200, text:…}` /
 * no-error result, and asserts NONE flags it. Paired with the runtime
 * guard (defense in depth: this static gate + a live net at the chokepoint).
 *
 * Shrink-only: the violation set may only DECREASE (it is empty today and the
 * assertion is `toEqual([])`). A `>1 detector` sanity guard prevents a vacuous
 * pass if `registerAllToolMetadata()` failed to populate the singleton Map.
 * Co-located in `@comis/skills` for a DIRECT source
 * import of `registerAllToolMetadata` — no `pnpm build` / dist-alias step.
 *
 * @module
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getAllToolMetadata } from "@comis/core";
import { registerAllToolMetadata } from "./tool-metadata-registry.js";

beforeAll(() => {
  registerAllToolMetadata();
});

// A canonical HTTP-200 SUCCESS result: a numeric `status` of 200 and NO
// `error` key, whose body (`text`) contains tokens that legitimately appear in
// data ("403", "blocked", "timeout") — exactly the c53ab0f false-positive
// trigger. A correct detector classifies off STRUCTURED fields only and never
// reads the body, so it returns false here.
const SUCCESS_RESULT = {
  status: 200,
  text: "share price 403.92999267578; not blocked; no timeout — legitimate body content",
} as const;

// A detector "flags" a failure when it returns `true` or an object verdict.
// `false` / `undefined` mean "not a failure" — the only acceptable outcome
// for a status:200 + no-error result. The return type is widened to include
// `undefined` to defend against a future detector with an early `return;`.
function isFlagged(detected: boolean | object | undefined): boolean {
  return detected !== false && detected !== undefined;
}

describe("failureDetector no-false-positive invariant", () => {
  it("never flags a status:200 + no-error result for any registered detector (the codified c53ab0f invariant)", () => {
    const violations: string[] = [];
    for (const [name, meta] of getAllToolMetadata()) {
      if (meta.failureDetector === undefined) continue;
      const detected = meta.failureDetector(SUCCESS_RESULT, false);
      if (isFlagged(detected)) {
        violations.push(name);
      }
    }
    expect(
      violations,
      `Detectors that wrongly flag a status:200 + no-error result (must classify off structured fields, never the body): ${violations.join(", ")}`,
    ).toEqual([]);
  });

  it("iterates more than one registered detector so the invariant is not a vacuous pass", () => {
    let count = 0;
    for (const [, meta] of getAllToolMetadata()) {
      if (meta.failureDetector !== undefined) count++;
    }
    expect(
      count,
      "sanity: registerAllToolMetadata() must populate >1 failureDetector (else the invariant above passes vacuously — RESEARCH Pitfall 6)",
    ).toBeGreaterThan(1);
  });
});
