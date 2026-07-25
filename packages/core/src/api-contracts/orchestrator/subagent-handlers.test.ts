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
import {
  SubagentListContract,
  SubagentPauseContract,
  SubagentResumeContract,
  SubagentStatusContract,
  SubagentSteerContract,
  SubagentWaitContract,
} from "./subagent-handlers.js";

describe("SubagentWaitContract — bounded mixed per-run outcomes", () => {
  it("accepts at most 32 requested ids and clamps the wait deadline", () => {
    expect(SubagentWaitContract.request.parse({
      runIds: ["run-1", "run-1", "run-2"],
      timeoutMs: 30_000,
    })).toEqual({ runIds: ["run-1", "run-1", "run-2"], timeoutMs: 30_000 });
    expect(() => SubagentWaitContract.request.parse({
      runIds: Array.from({ length: 33 }, (_, index) => `run-${index}`),
    })).toThrow();
    expect(() => SubagentWaitContract.request.parse({ timeoutMs: 300_001 })).toThrow();
  });

  it("parses completed failed timeout denied and cancelled waiter outcomes", () => {
    const results = [
      {
        runId: "run-complete",
        status: "completed",
        completion: {
          endReason: "completed",
          completedAtMs: 123,
          summary: "bounded result",
        },
      },
      {
        runId: "run-failed",
        status: "completed",
        completion: {
          endReason: "failed",
          completedAtMs: 124,
          errorKind: "dependency",
        },
      },
      { runId: "run-timeout", status: "timeout" },
      { runId: "run-private", status: "denied_unknown" },
      { runId: "run-cancelled", status: "cancelled" },
    ];
    expect(SubagentWaitContract.response.parse({ results })).toEqual({ results });
  });

  it("rejects raw provider output and mismatched completion discriminants", () => {
    expect(() => SubagentWaitContract.response.parse({
      results: [{
        runId: "run-1",
        status: "completed",
        completion: {
          endReason: "completed",
          completedAtMs: 123,
          errorKind: "internal",
          response: "must not cross the boundary",
        },
      }],
    })).toThrow();
  });
});

describe("subagent spawn admission control contracts", () => {
  it("keeps pause, resume, and status on the operator admin route", () => {
    for (const contract of [SubagentPauseContract, SubagentResumeContract, SubagentStatusContract]) {
      expect(contract.request.parse({})).toEqual({});
      expect(contract.scopes).toEqual(["admin"]);
    }
  });

  it("requires explicit process-lifetime state in every response", () => {
    const state = { paused: true, acceptingSpawns: true, resetsOnRestart: true as const };
    expect(SubagentStatusContract.response.parse(state)).toEqual(state);
    expect(SubagentPauseContract.response.parse({ ...state, changed: true })).toEqual({
      ...state,
      changed: true,
    });
    expect(() => SubagentResumeContract.response.parse({
      paused: false,
      acceptingSpawns: true,
      changed: true,
      resetsOnRestart: false,
    })).toThrow();
  });
});

describe("SubagentListContract.request — explicit operator selectors", () => {
  it("parses bounded recent time with optional agent and tree selectors", () => {
    expect(SubagentListContract.request.parse({
      recentMinutes: 45,
      agentId: "researcher",
      rootRunId: "root-run-1",
    })).toEqual({ recentMinutes: 45, agentId: "researcher", rootRunId: "root-run-1" });
  });

  it("rejects nonpositive or unbounded recent time", () => {
    expect(() => SubagentListContract.request.parse({ recentMinutes: 0 })).toThrow();
    expect(() => SubagentListContract.request.parse({ recentMinutes: 10_081 })).toThrow();
  });
});

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
