// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { selectOrphanedChildRuns, liveChildRunIds, promptTimeoutHint } from "./abort-fallout.js";

/**
 * Live incident: a delegated market scan timed out at 241s. Its parent run died
 * at 17:28:46 while awaiting three children; two of them kept running to
 * 17:29:12 and 17:29:31 -- 26s and 46s of work (1.33M tokens, $1.80 on one
 * alone) whose results no longer had a consumer. Nothing cancelled them.
 */
describe("selectOrphanedChildRuns", () => {
  const runs = [
    { runId: "parent", status: "failed" },
    { runId: "child-running", status: "running", parentRunId: "parent" },
    { runId: "child-queued", status: "queued", parentRunId: "parent" },
    { runId: "child-done", status: "completed", parentRunId: "parent" },
    { runId: "other-agents-child", status: "running", parentRunId: "someone-else" },
    { runId: "unparented", status: "running" },
  ];

  it("cancels running and queued children of an abnormally-terminated parent", () => {
    expect(selectOrphanedChildRuns("parent", "timeout", runs).sort())
      .toEqual(["child-queued", "child-running"]);
  });

  it("never touches another parent's children or unparented runs", () => {
    const selected = selectOrphanedChildRuns("parent", "timeout", runs);
    expect(selected).not.toContain("other-agents-child");
    expect(selected).not.toContain("unparented");
  });

  it("never re-cancels a child that already reached a terminal state", () => {
    expect(selectOrphanedChildRuns("parent", "timeout", runs)).not.toContain("child-done");
  });

  it("leaves children alone when the parent completed cleanly", () => {
    // Background delegation is a legitimate pattern: a child that announces to
    // its own channel outlives a parent that finished its turn normally.
    expect(selectOrphanedChildRuns("parent", "completed", runs)).toEqual([]);
  });

  it("cancels on every abnormal end reason", () => {
    for (const endReason of ["timeout", "killed", "error", "max_steps", "budget_exceeded"]) {
      expect(selectOrphanedChildRuns("parent", endReason, runs).length, endReason).toBe(2);
    }
  });

  it("preserves a routed child while cancelling a child with no announcement route", () => {
    const routedAndUnrouted = [
      {
        runId: "routed-child",
        status: "running",
        parentRunId: "parent",
        announceChannelType: "gateway",
        announceChannelId: "conversation_a",
      },
      { runId: "unrouted-child", status: "running", parentRunId: "parent" },
    ];

    expect(selectOrphanedChildRuns("parent", "timeout", routedAndUnrouted))
      .toEqual(["unrouted-child"]);
  });
});

/**
 * The same incident: the parent aborted with
 * "Increase agents.<id>.operationModels.subagent.timeout or reduce the task scope".
 * It had burned 208 of its 241s blocked in `subagents wait`, on children doomed
 * by a tool-reachability rejection that had already opened the sessions_spawn
 * breaker. Raising the timeout would only have bought more waiting -- and the
 * hint's "reduce the task scope" is what the agent relayed to the user as its
 * own diagnosis.
 */
describe("promptTimeoutHint", () => {
  it("points at the children when the run died awaiting delegation", () => {
    const hint = promptTimeoutHint({ awaitedChildRunIds: ["child-a", "child-b"] });

    expect(hint).toContain("2");
    expect(hint).toContain("comis explain");
    expect(hint).not.toContain("operationModels.subagent.timeout");
    expect(hint).not.toContain("reduce the task scope");
  });

  it("names the first child so the next call is copy-pasteable", () => {
    expect(promptTimeoutHint({ awaitedChildRunIds: ["child-a"] })).toContain("child-a");
  });

  it("keeps the timeout-knob hint when the run genuinely just ran long", () => {
    const hint = promptTimeoutHint(undefined);

    expect(hint).toContain("operationModels.subagent.timeout");
  });

  it("keeps the timeout-knob hint when evidence is present but empty", () => {
    const hint = promptTimeoutHint({ awaitedChildRunIds: [] });

    expect(hint).toContain("operationModels.subagent.timeout");
  });
});

describe("liveChildRunIds", () => {
  it("is the same set the orphan cascade cancels, so wait-evidence and cancellation agree", () => {
    const runs = [
      { runId: "a", status: "running", parentRunId: "p" },
      { runId: "b", status: "completed", parentRunId: "p" },
    ];

    expect(liveChildRunIds("p", runs)).toEqual(selectOrphanedChildRuns("p", "timeout", runs));
  });
});
