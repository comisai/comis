// SPDX-License-Identifier: Apache-2.0
/**
 * SubagentSteerContract response union.
 *
 * The steer response is a discriminated union on `status`:
 *   - `{ status: "steered", oldRunId, newRunId }`   — flag-off kill+respawn
 *   - `{ status: "steered_inject", runId }`          — flag-on live inject
 * Both shapes must parse; a cross-shaped object (wrong discriminant payload)
 * must be rejected so the union stays exhaustive — every discriminant maps to
 * exactly one payload shape.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { SubagentSteerContract } from "./subagent-handlers.js";

describe("SubagentSteerContract.response — discriminated union on status", () => {
  it("parses the flag-off kill+respawn shape {status:'steered', oldRunId, newRunId}", () => {
    const parsed = SubagentSteerContract.response.parse({
      status: "steered",
      oldRunId: "run-1",
      newRunId: "run-2",
    });
    expect(parsed).toEqual({ status: "steered", oldRunId: "run-1", newRunId: "run-2" });
  });

  it("parses the flag-on inject shape {status:'steered_inject', runId}", () => {
    const parsed = SubagentSteerContract.response.parse({
      status: "steered_inject",
      runId: "run-1",
    });
    expect(parsed).toEqual({ status: "steered_inject", runId: "run-1" });
  });

  it("rejects a cross-shaped payload (steered_inject discriminant with oldRunId/newRunId)", () => {
    expect(() =>
      SubagentSteerContract.response.parse({
        status: "steered_inject",
        oldRunId: "run-1",
        newRunId: "run-2",
      }),
    ).toThrow();
  });

  it("rejects an unknown status discriminant", () => {
    expect(() =>
      SubagentSteerContract.response.parse({ status: "steered_somehow", runId: "run-1" }),
    ).toThrow();
  });
});
