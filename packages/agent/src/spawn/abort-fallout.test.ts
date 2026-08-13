// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  conversationScopeToSessionKey,
  createConversationRef,
  formatSessionKey,
  type ConversationScope,
} from "@comis/core";
import {
  activelyAwaitedChildRunIds,
  selectOrphanedChildRuns,
  liveChildRunIds,
  promptTimeoutHint,
} from "./abort-fallout.js";

function routedAuthority() {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: "bot-a",
    conversationId: "conversation_a",
    conversationKind: "direct" as const,
  };
  const scope: ConversationScope = {
    tenantId: "default",
    agentId: "parent-agent",
    partition: { kind: "principal", principalId: "user_a" },
  };
  const conversationRef = createConversationRef(scope);
  const sessionKey = conversationScopeToSessionKey(scope);
  if (!conversationRef.ok || !sessionKey.ok) throw new Error("test route invalid");
  return {
    announceChannelType: endpoint.channelType,
    announceChannelId: endpoint.conversationId,
    requesterOrigin: {
      tenantId: "default",
      userId: "user_a",
      channelType: endpoint.channelType,
      channelId: endpoint.conversationId,
    },
    callerAgentId: scope.agentId,
    callerSessionKey: formatSessionKey(sessionKey.value),
    callerConversation: { conversationScope: scope, conversationRef: conversationRef.value },
    callerEndpoint: endpoint,
  };
}

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

  it("preserves only a child with authenticated independent route authority", () => {
    const routedAndUnrouted = [
      {
        runId: "routed-child",
        status: "running",
        parentRunId: "parent",
        ...routedAuthority(),
      },
      { runId: "unrouted-child", status: "running", parentRunId: "parent" },
    ];

    expect(selectOrphanedChildRuns("parent", "timeout", routedAndUnrouted))
      .toEqual(["unrouted-child"]);
  });

  it("cancels a nested child whose caller endpoint is synthetic", () => {
    const nested = {
      runId: "nested-child",
      status: "running",
      parentRunId: "parent",
      ...routedAuthority(),
      callerEndpoint: {
        channelType: "sub-agent",
        channelInstanceId: "runtime",
        conversationId: "run-parent",
        conversationKind: "direct" as const,
      },
    };

    expect(selectOrphanedChildRuns("parent", "timeout", [nested]))
      .toEqual(["nested-child"]);
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

  it("keeps the parent deadline binding when a routed child can announce independently", () => {
    const hint = promptTimeoutHint({
      awaitedChildRunIds: ["child-a"],
      routedChildRunIds: ["child-a"],
    } as never);

    expect(hint).toContain("parent deadline was binding");
    expect(hint).toContain("continue and announce independently");
    expect(hint).not.toContain("own deadline is not the binding constraint");
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

  it("labels only live children with active wait claims as awaited", () => {
    const runs = [
      { runId: "awaited", status: "running", parentRunId: "p" },
      { runId: "asynchronous", status: "running", parentRunId: "p" },
    ];

    expect(activelyAwaitedChildRunIds("p", runs, (runId) => runId === "awaited"))
      .toEqual(["awaited"]);
  });
});
