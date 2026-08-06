// SPDX-License-Identifier: Apache-2.0
/**
 * Fabricated run-identifier detection — a reply that hands the requester a
 * tracking id for work the execution never performed.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { assertsUnbackedRunIdentifier } from "./fabricated-run-identifier.js";

describe("assertsUnbackedRunIdentifier", () => {
  it("flags a run id asserted by an execution that ran no tools at all", () => {
    // The live shape: a scan request answered with an acknowledgement, a
    // promise of results "in about a minute", and a plausible-looking id —
    // produced by a single LLM call with toolCalls: 0.
    expect(
      assertsUnbackedRunIdentifier({
        response:
          "✓ <b>סריקה בעבודה</b>\n\n"
          + "Run ID: <code>c8a9f5d2-3e7e-4d5a-9b8f-2f1a9c3d5e7f</code>",
        toolCallCount: 0,
      }),
    ).toBe(true);
  });

  it("accepts the same claim once the execution actually ran a tool", () => {
    // With any tool call the id may legitimately come from a spawn receipt or
    // a status lookup, so this guard defers — the spawn-evidence guard owns it.
    expect(
      assertsUnbackedRunIdentifier({
        response: "Run ID: c8a9f5d2-3e7e-4d5a-9b8f-2f1a9c3d5e7f",
        toolCallCount: 1,
      }),
    ).toBe(false);
  });

  it("recognizes the common label spellings", () => {
    for (const label of ["Run ID", "run id", "runId", "run_id", "Run-ID"]) {
      expect(
        assertsUnbackedRunIdentifier({
          response: `${label}: 9dd4d66a-b07b-4bcf-afbf-5be8ea0b3cc7`,
          toolCallCount: 0,
        }),
      ).toBe(true);
    }
  });

  it("ignores a toolless reply that asserts no identifier", () => {
    expect(
      assertsUnbackedRunIdentifier({
        response: "I cannot scan anything right now — nothing was dispatched.",
        toolCallCount: 0,
      }),
    ).toBe(false);
  });

  it("ignores a run-id label with no identifier-shaped value behind it", () => {
    // Prose mentioning the concept is not a claim to a specific run.
    expect(
      assertsUnbackedRunIdentifier({
        response: "Every background run reports a run id when it starts.",
        toolCallCount: 0,
      }),
    ).toBe(false);
  });

  it("ignores a bare identifier with no run-id label", () => {
    // Requires BOTH the label and the value: a bare uuid may be any reference
    // (a trace, a session, a document) and is not a dispatch claim.
    expect(
      assertsUnbackedRunIdentifier({
        response: "the trace is c8a9f5d2-3e7e-4d5a-9b8f-2f1a9c3d5e7f",
        toolCallCount: 0,
      }),
    ).toBe(false);
  });

  it("sees through inline markup between the label and the identifier", () => {
    expect(
      assertsUnbackedRunIdentifier({
        response: "Run ID: <code>c8a9f5d2-3e7e-4d5a-9b8f-2f1a9c3d5e7f</code>",
        toolCallCount: 0,
      }),
    ).toBe(true);
  });

  it("accepts a short opaque identifier, not only a uuid", () => {
    expect(
      assertsUnbackedRunIdentifier({
        response: "Run ID: run_01JQXW7F8K",
        toolCallCount: 0,
      }),
    ).toBe(true);
  });
});
