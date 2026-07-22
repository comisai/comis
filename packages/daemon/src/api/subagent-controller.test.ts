// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  resolveSubagentController,
  subagentControllerOwnsRun,
} from "./subagent-controller.js";

const CALLER_SCOPE = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: { kind: "principal" as const, principalId: "user_a" },
};

describe("subagent controller authority resolution", () => {
  it("derives caller authority from the matching agent and strict conversation scope", () => {
    const controller = resolveSubagentController({
      _agentId: "agent_a",
      _callerConversationScope: CALLER_SCOPE,
      _rootRunId: "root_a",
      _trustLevel: "admin",
    });

    expect(controller).toMatchObject({
      kind: "caller",
      agentId: "agent_a",
      rootRunId: "root_a",
      conversation: { conversationScope: CALLER_SCOPE },
    });
  });

  it("accepts operator authority only when no agent-origin residue is present", () => {
    expect(resolveSubagentController({
      _trustLevel: "admin",
      agentId: "agent_a",
    })).toEqual({ kind: "admin", agentId: "agent_a" });

    for (const residue of [
      { _agentId: "agent_a" },
      { _callerConversationScope: CALLER_SCOPE },
      { _rootRunId: "root_a" },
      { _callerSessionKey: "tenant_a:user_a:channel_a" },
    ]) {
      expect(() => resolveSubagentController({
        _trustLevel: "admin",
        ...residue,
      })).toThrow("Sub-agent controller authority is invalid");
    }
  });

  it("rejects mismatched caller agent and conversation authority", () => {
    expect(() => resolveSubagentController({
      _agentId: "agent_b",
      _callerConversationScope: CALLER_SCOPE,
    })).toThrow("Sub-agent controller authority is invalid");
    expect(() => resolveSubagentController({
      _agentId: "agent_a",
      _callerConversationScope: { ...CALLER_SCOPE, extra: true },
    })).toThrow("Sub-agent controller authority is invalid");
  });

  it("requires exact caller agent and conversation ownership for a run", () => {
    const controller = resolveSubagentController({
      _agentId: "agent_a",
      _callerConversationScope: CALLER_SCOPE,
    });
    if (controller.kind !== "caller") throw new Error("Expected caller controller");
    const owned = {
      runId: "run_a",
      status: "running",
      agentId: "worker_a",
      task: "inspect",
      sessionKey: "tenant_a:worker_a:subagent",
      startedAt: 1,
      callerAgentId: "agent_a",
      callerConversation: controller.conversation,
    } as never;

    expect(subagentControllerOwnsRun(controller, owned)).toBe(true);
    expect(subagentControllerOwnsRun(controller, {
      ...owned,
      callerAgentId: "agent_b",
    })).toBe(false);
    expect(subagentControllerOwnsRun(controller, {
      ...owned,
      callerConversation: {
        ...controller.conversation,
        conversationRef: "conversation:foreign",
      },
    })).toBe(false);
  });
});
