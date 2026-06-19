// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, expectTypeOf } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("AgentEvents payload structure", () => {
  it("skill:loaded delivers skillName, source, timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["skill:loaded"] = {
      skillName: "greet",
      source: "/skills/greet.md",
      timestamp: Date.now(),
    };

    bus.on("skill:loaded", handler);
    bus.emit("skill:loaded", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["skill:loaded"];
    expect(received.skillName).toBe("greet");
    expect(received.source).toBe("/skills/greet.md");
  });

  it("skill:executed delivers durationMs and success boolean", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["skill:executed"] = {
      skillName: "summarize",
      durationMs: 42,
      success: true,
      timestamp: Date.now(),
    };

    bus.on("skill:executed", handler);
    bus.emit("skill:executed", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["skill:executed"];
    expect(received.durationMs).toBe(42);
    expect(received.success).toBe(true);
  });

  it("skill:rejected delivers violations string array", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["skill:rejected"] = {
      skillName: "exploit",
      reason: "security scan failed",
      violations: ["eval() usage", "network access"],
      timestamp: Date.now(),
    };

    bus.on("skill:rejected", handler);
    bus.emit("skill:rejected", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["skill:rejected"];
    expect(received.violations).toEqual(["eval() usage", "network access"]);
  });

  it("skill:prompt_invoked delivers invokedBy union", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    for (const invokedBy of ["user", "model"] as const) {
      const payload: EventMap["skill:prompt_invoked"] = {
        skillName: "translate",
        invokedBy,
        args: "--lang=fr",
        timestamp: Date.now(),
      };
      bus.on("skill:prompt_invoked", handler);
      bus.emit("skill:prompt_invoked", payload);
      bus.removeAllListeners("skill:prompt_invoked");
    }

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]![0].invokedBy).toBe("user");
    expect(handler.mock.calls[1]![0].invokedBy).toBe("model");
  });

  it("tool:executed delivers required and optional fields", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    // With all optional fields
    const fullPayload: EventMap["tool:executed"] = {
      toolName: "bash",
      durationMs: 350,
      success: false,
      timestamp: Date.now(),
      toolCallId: "tc-full",
      userId: "user-1",
      traceId: "trace-abc",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      params: { command: "ls" },
      errorMessage: "Permission denied",
      errorKind: "internal",
      description: "Test run",
    };

    bus.on("tool:executed", handler);
    bus.emit("tool:executed", fullPayload);

    expect(handler).toHaveBeenCalledWith(fullPayload);
    const received = handler.mock.calls[0]![0] as EventMap["tool:executed"];
    expect(received.toolName).toBe("bash");
    expect(received.success).toBe(false);
    expect(received.errorMessage).toBe("Permission denied");
    expect(received.errorKind).toBe("internal");
    expect(received.userId).toBe("user-1");
    expect(received.traceId).toBe("trace-abc");
    expect(received.description).toBe("Test run");

    // With only required fields
    const minPayload: EventMap["tool:executed"] = {
      toolName: "file_ops",
      durationMs: 5,
      success: true,
      timestamp: Date.now(),
      toolCallId: "tc-min",
    };
    bus.emit("tool:executed", minPayload);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0].errorMessage).toBeUndefined();
  });

  it("tool:executed delivers truncation metadata fields", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    // With truncation metadata (per-tool or per-turn budget truncation)
    const truncatedPayload: EventMap["tool:executed"] = {
      toolName: "bash",
      durationMs: 150,
      success: true,
      timestamp: Date.now(),
      toolCallId: "tc-trunc",
      truncated: true,
      fullChars: 500_000,
      returnedChars: 200_000,
    };

    bus.on("tool:executed", handler);
    bus.emit("tool:executed", truncatedPayload);

    const received = handler.mock.calls[0]![0] as EventMap["tool:executed"];
    expect(received.truncated).toBe(true);
    expect(received.fullChars).toBe(500_000);
    expect(received.returnedChars).toBe(200_000);

    // Without truncation metadata (normal execution)
    const normalPayload: EventMap["tool:executed"] = {
      toolName: "read",
      durationMs: 10,
      success: true,
      timestamp: Date.now(),
      toolCallId: "tc-normal",
    };
    bus.emit("tool:executed", normalPayload);
    expect(handler).toHaveBeenCalledTimes(2);
    const normalReceived = handler.mock.calls[1]![0] as EventMap["tool:executed"];
    expect(normalReceived.truncated).toBeUndefined();
    expect(normalReceived.fullChars).toBeUndefined();
    expect(normalReceived.returnedChars).toBeUndefined();
  });

  it("tool:started delivers description field", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["tool:started"] = {
      toolName: "exec",
      toolCallId: "tc-desc",
      timestamp: Date.now(),
      agentId: "agent-1",
      description: "Installing packages",
    };

    bus.on("tool:started", handler);
    bus.emit("tool:started", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["tool:started"];
    expect(received.description).toBe("Installing packages");
  });

  it("audit:event delivers outcome union and optional metadata", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    for (const outcome of ["success", "failure", "denied"] as const) {
      const payload: EventMap["audit:event"] = {
        timestamp: Date.now(),
        agentId: "agent-1",
        tenantId: "tenant-1",
        actionType: "tool:execute",
        classification: "high-risk",
        outcome,
        metadata: outcome === "denied" ? { reason: "sandbox violation" } : undefined,
      };
      bus.on("audit:event", handler);
      bus.emit("audit:event", payload);
      bus.removeAllListeners("audit:event");
    }

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0]![0].outcome).toBe("success");
    expect(handler.mock.calls[2]![0].outcome).toBe("denied");
    expect(handler.mock.calls[2]![0].metadata).toEqual({ reason: "sandbox violation" });
  });

  it("observability:token_usage delivers nested tokens and cost objects", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["observability:token_usage"] = {
      timestamp: Date.now(),
      traceId: "trace-xyz",
      agentId: "agent-1",
      channelId: "c1",
      executionId: "exec-001",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      tokens: { prompt: 1000, completion: 500, total: 1500 },
      cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0, total: 0.018 },
      latencyMs: 2500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      sessionKey: "test-session",
      savedVsUncached: 0,
      cacheEligible: true,
    };

    bus.on("observability:token_usage", handler);
    bus.emit("observability:token_usage", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["observability:token_usage"];
    expect(received.tokens.prompt).toBe(1000);
    expect(received.tokens.completion).toBe(500);
    expect(received.tokens.total).toBe(1500);
    expect(received.cost.input).toBe(0.003);
    expect(received.cost.total).toBe(0.018);
  });

  it("model:fallback_attempt delivers fromProvider/toProvider and attemptNumber", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["model:fallback_attempt"] = {
      fromProvider: "anthropic",
      fromModel: "claude-sonnet-4-20250514",
      toProvider: "openai",
      toModel: "gpt-4",
      error: "Rate limit exceeded",
      attemptNumber: 2,
      timestamp: Date.now(),
    };

    bus.on("model:fallback_attempt", handler);
    bus.emit("model:fallback_attempt", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["model:fallback_attempt"];
    expect(received.fromProvider).toBe("anthropic");
    expect(received.toProvider).toBe("openai");
    expect(received.attemptNumber).toBe(2);
  });

  it("security:injection_detected delivers source union, patterns array, riskLevel union", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["security:injection_detected"] = {
      timestamp: Date.now(),
      source: "user_input",
      patterns: ["ignore previous instructions", "system prompt override"],
      riskLevel: "high",
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-sec",
    };

    bus.on("security:injection_detected", handler);
    bus.emit("security:injection_detected", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["security:injection_detected"];
    expect(received.source).toBe("user_input");
    expect(received.patterns).toEqual(["ignore previous instructions", "system prompt override"]);
    expect(received.riskLevel).toBe("high");
  });

  it("security:injection_detected accepts workspace_file source", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["security:injection_detected"] = {
      timestamp: Date.now(),
      source: "workspace_file",
      patterns: ["HTML_COMMENT_INJECTION"],
      riskLevel: "high",
      agentId: "agent-ws",
    };

    bus.on("security:injection_detected", handler);
    bus.emit("security:injection_detected", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["security:injection_detected"];
    expect(received.source).toBe("workspace_file");
  });

  it("graph:started delivers graphId, nodeCount, optional label", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    // With label
    const fullPayload: EventMap["graph:started"] = {
      graphId: "g-001",
      label: "My Pipeline",
      nodeCount: 5,
      timestamp: Date.now(),
    };

    bus.on("graph:started", handler);
    bus.emit("graph:started", fullPayload);

    expect(handler).toHaveBeenCalledWith(fullPayload);
    const received = handler.mock.calls[0]![0] as EventMap["graph:started"];
    expect(received.graphId).toBe("g-001");
    expect(received.label).toBe("My Pipeline");
    expect(received.nodeCount).toBe(5);

    // Without label
    const minPayload: EventMap["graph:started"] = {
      graphId: "g-002",
      nodeCount: 1,
      timestamp: Date.now(),
    };
    bus.emit("graph:started", minPayload);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0].label).toBeUndefined();
  });

  it("graph:node_updated delivers nodeId, status, optional durationMs and error", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    // Completed case (with durationMs)
    const completedPayload: EventMap["graph:node_updated"] = {
      graphId: "g-001",
      nodeId: "A",
      status: "completed",
      durationMs: 250,
      timestamp: Date.now(),
    };

    bus.on("graph:node_updated", handler);
    bus.emit("graph:node_updated", completedPayload);

    expect(handler).toHaveBeenCalledWith(completedPayload);
    const received = handler.mock.calls[0]![0] as EventMap["graph:node_updated"];
    expect(received.nodeId).toBe("A");
    expect(received.status).toBe("completed");
    expect(received.durationMs).toBe(250);
    expect(received.error).toBeUndefined();

    // Failed case (with error + durationMs)
    const failedPayload: EventMap["graph:node_updated"] = {
      graphId: "g-001",
      nodeId: "B",
      status: "failed",
      durationMs: 100,
      error: "Execution timeout",
      timestamp: Date.now(),
    };
    bus.emit("graph:node_updated", failedPayload);
    expect(handler).toHaveBeenCalledTimes(2);
    const failedReceived = handler.mock.calls[1]![0] as EventMap["graph:node_updated"];
    expect(failedReceived.status).toBe("failed");
    expect(failedReceived.error).toBe("Execution timeout");
    expect(failedReceived.durationMs).toBe(100);
  });

  it("graph:completed delivers status, durationMs, and node count breakdown", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["graph:completed"] = {
      graphId: "g-001",
      status: "completed",
      durationMs: 5000,
      nodeCount: 4,
      nodesCompleted: 3,
      nodesFailed: 0,
      nodesSkipped: 1,
      timestamp: Date.now(),
    };

    bus.on("graph:completed", handler);
    bus.emit("graph:completed", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["graph:completed"];
    expect(received.graphId).toBe("g-001");
    expect(received.status).toBe("completed");
    expect(received.durationMs).toBe(5000);
    expect(received.nodeCount).toBe(4);
    expect(received.nodesCompleted).toBe(3);
    expect(received.nodesFailed).toBe(0);
    expect(received.nodesSkipped).toBe(1);
  });

  it("type safety: @ts-expect-error for missing required fields", () => {
    const bus = new TypedEventBus();

    // @ts-expect-error - missing success in skill:executed
    bus.emit("skill:executed", { skillName: "x", durationMs: 10, timestamp: 1 });

    // @ts-expect-error - missing tokens, sessionKey, savedVsUncached, cacheEligible, cacheReadTokens, cacheWriteTokens
    bus.emit("observability:token_usage", {
      timestamp: 1, traceId: "t", agentId: "a", channelId: "c",
      executionId: "e", provider: "p", model: "m",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, latencyMs: 0,
    });
  });

  it("provider:degraded delivers provider, failingAgents, timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["provider:degraded"] = {
      provider: "anthropic",
      failingAgents: 2,
      timestamp: Date.now(),
    };

    bus.on("provider:degraded", handler);
    bus.emit("provider:degraded", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["provider:degraded"];
    expect(received.provider).toBe("anthropic");
    expect(received.failingAgents).toBe(2);
  });

  it("provider:recovered delivers provider, timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["provider:recovered"] = {
      provider: "anthropic",
      timestamp: Date.now(),
    };

    bus.on("provider:recovered", handler);
    bus.emit("provider:recovered", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["provider:recovered"];
    expect(received.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// tool:install_detour_detected -- type + privacy invariants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trajectory observability events:
// prompt:submitted, session:started, session:ended, memory:injected, tool:timeout
// ---------------------------------------------------------------------------

describe("Trajectory observability events", () => {
  it("prompt:submitted delivers digests, promptChars, messageCount, provider/model", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["prompt:submitted"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-prompt-001",
      promptChars: 12_345,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      messageCount: 7,
      systemDigest: "a".repeat(64),
      messagesDigest: "b".repeat(64),
      timestamp: Date.now(),
    };

    bus.on("prompt:submitted", handler);
    bus.emit("prompt:submitted", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["prompt:submitted"];
    expect(received.promptChars).toBe(12_345);
    expect(received.messageCount).toBe(7);
    expect(received.systemDigest.length).toBe(64);
    expect(received.messagesDigest.length).toBe(64);
    expect(received.provider).toBe("anthropic");
    expect(received.modelId).toBe("claude-sonnet-4-20250514");
  });

  it("session:started delivers channelType, channelId, optional accountId", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const withAccount: EventMap["session:started"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-sess-001",
      channelType: "telegram",
      channelId: "chan-123",
      accountId: "acct-7",
      timestamp: Date.now(),
    };

    bus.on("session:started", handler);
    bus.emit("session:started", withAccount);

    const r = handler.mock.calls[0]![0] as EventMap["session:started"];
    expect(r.channelType).toBe("telegram");
    expect(r.channelId).toBe("chan-123");
    expect(r.accountId).toBe("acct-7");

    // Without optional accountId
    const noAccount: EventMap["session:started"] = {
      agentId: "agent-1",
      traceId: "trace-sess-002",
      channelType: "discord",
      channelId: "guild-22",
      timestamp: Date.now(),
    };
    bus.emit("session:started", noAccount);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0].accountId).toBeUndefined();
  });

  it("session:ended delivers totalTurns, token totals, durationMs, exitReason", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["session:ended"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-end-001",
      totalTurns: 5,
      totalInputTokens: 12_000,
      totalOutputTokens: 3_500,
      durationMs: 18_750,
      exitReason: "completed",
      timestamp: Date.now(),
    };

    bus.on("session:ended", handler);
    bus.emit("session:ended", payload);

    const r = handler.mock.calls[0]![0] as EventMap["session:ended"];
    expect(r.totalTurns).toBe(5);
    expect(r.totalInputTokens).toBe(12_000);
    expect(r.totalOutputTokens).toBe(3_500);
    expect(r.durationMs).toBe(18_750);
    expect(r.exitReason).toBe("completed");
  });

  it("memory:injected delivers hitCount, charsInjected, trustTags array", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["memory:injected"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-mem-001",
      hitCount: 3,
      charsInjected: 512,
      trustTags: ["learned", "system"],
      timestamp: Date.now(),
    };

    bus.on("memory:injected", handler);
    bus.emit("memory:injected", payload);

    const r = handler.mock.calls[0]![0] as EventMap["memory:injected"];
    expect(r.hitCount).toBe(3);
    expect(r.charsInjected).toBe(512);
    expect(r.trustTags).toEqual(["learned", "system"]);
  });

  it("tool:timeout delivers toolName, timeoutMs, optional toolCallId for dedup with tool:executed", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const withCallId: EventMap["tool:timeout"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-tout-001",
      toolName: "bash",
      toolCallId: "tc-77",
      timeoutMs: 30_000,
      timestamp: Date.now(),
    };

    bus.on("tool:timeout", handler);
    bus.emit("tool:timeout", withCallId);

    const r = handler.mock.calls[0]![0] as EventMap["tool:timeout"];
    expect(r.toolName).toBe("bash");
    expect(r.toolCallId).toBe("tc-77");
    expect(r.timeoutMs).toBe(30_000);

    // toolCallId optional — bridge may omit when SDK didn't supply it
    const noCallId: EventMap["tool:timeout"] = {
      agentId: "agent-1",
      traceId: "trace-tout-002",
      toolName: "exec",
      timeoutMs: 60_000,
      timestamp: Date.now(),
    };
    bus.emit("tool:timeout", noCallId);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0].toolCallId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agent Transparency — EventBus payload contract widening
//
// These cases pin the §16.11 amendment table for tool:* and model:* payloads.
// Each fails to compile on the pre-patch event-bus types (RED proof):
//   - tool:executed without toolCallId (now required) → tsc error
//   - tool:executed with errorKind "badkind" (now closed ErrorKind union) → tsc error
//   - tool:started with action/params → field does not exist on pre-patch type
//   - model:* with agentId/sessionKey/traceId → fields do not exist on pre-patch type
// ---------------------------------------------------------------------------

describe("tool:* payload widening", () => {
  it("tool:executed requires toolCallId and accepts a closed-union errorKind", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    // errorKind is now the closed ErrorKind union — "precondition" is a member.
    const payload: EventMap["tool:executed"] = {
      toolName: "mcp_manage",
      durationMs: 12,
      success: false,
      timestamp: Date.now(),
      toolCallId: "tc1",
      errorKind: "precondition",
    };

    bus.on("tool:executed", handler);
    bus.emit("tool:executed", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["tool:executed"];
    expect(received.toolCallId).toBe("tc1");
    expect(received.errorKind).toBe("precondition");
  });

  it("tool:executed rejects an out-of-union errorKind at the type level", () => {
    const bus = new TypedEventBus();
    const bad: EventMap["tool:executed"] = {
      toolName: "bash",
      durationMs: 1,
      success: false,
      timestamp: 1,
      toolCallId: "tc-bad",
      // @ts-expect-error - "badkind" is not a member of the closed ErrorKind union
      errorKind: "badkind",
    };
    void bad;

    // @ts-expect-error - toolCallId is now required on tool:executed
    bus.emit("tool:executed", {
      toolName: "bash",
      durationMs: 1,
      success: true,
      timestamp: 1,
    });
  });

  it("tool:started accepts action and sanitised params", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["tool:started"] = {
      toolName: "mcp_manage",
      toolCallId: "tc-start",
      timestamp: Date.now(),
      agentId: "agent-1",
      action: "set",
      params: { key: "feature.flag", value: "on" },
    };

    bus.on("tool:started", handler);
    bus.emit("tool:started", payload);

    const received = handler.mock.calls[0]![0] as EventMap["tool:started"];
    expect(received.action).toBe("set");
    expect(received.params).toEqual({ key: "feature.flag", value: "on" });
  });

  it("tool:policy_filtered entries carry an optional per-entry toolCallId", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["tool:policy_filtered"] = {
      profile: "specialist",
      agentId: "agent-1",
      filtered: [
        { toolName: "shell", reason: "denied by profile", toolCallId: "tc2" },
        { toolName: "browser", reason: "denied by profile" },
      ],
      timestamp: Date.now(),
    };

    bus.on("tool:policy_filtered", handler);
    bus.emit("tool:policy_filtered", payload);

    const received = handler.mock.calls[0]![0] as EventMap["tool:policy_filtered"];
    expect(received.filtered[0]?.toolCallId).toBe("tc2");
    expect(received.filtered[1]?.toolCallId).toBeUndefined();
  });

  it("tool:timeout still accepts its existing shape (no-op widening)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["tool:timeout"] = {
      agentId: "agent-1",
      traceId: "trace-timeout",
      toolName: "bash",
      toolCallId: "tc-tmo",
      timeoutMs: 30_000,
      timestamp: Date.now(),
    };

    bus.on("tool:timeout", handler);
    bus.emit("tool:timeout", payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });
});

describe("model:* turn-scoping", () => {
  it("model:fallback_attempt carries agentId, sessionKey, traceId", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["model:fallback_attempt"] = {
      fromProvider: "anthropic",
      fromModel: "claude-sonnet-4-20250514",
      toProvider: "openai",
      toModel: "gpt-4",
      error: "Rate limit exceeded",
      attemptNumber: 2,
      timestamp: Date.now(),
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-fb",
    };

    bus.on("model:fallback_attempt", handler);
    bus.emit("model:fallback_attempt", payload);

    const r = handler.mock.calls[0]![0] as EventMap["model:fallback_attempt"];
    expect(r.agentId).toBe("agent-1");
    expect(r.sessionKey).toBe("t1:u1:c1");
    expect(r.traceId).toBe("trace-fb");
  });

  it("model:fallback_exhausted accepts the turn-scoping ids", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["model:fallback_exhausted"] = {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      totalAttempts: 3,
      timestamp: Date.now(),
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-ex",
    };

    bus.on("model:fallback_exhausted", handler);
    bus.emit("model:fallback_exhausted", payload);
    expect(handler.mock.calls[0]![0].traceId).toBe("trace-ex");
  });

  it("model:lkw_fallback_attempt accepts the turn-scoping ids", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["model:lkw_fallback_attempt"] = {
      fromProvider: "anthropic",
      fromModel: "claude-opus-4",
      toProvider: "anthropic",
      toModel: "claude-sonnet-4",
      timestamp: Date.now(),
      agentId: "agent-1",
      traceId: "trace-lkw",
    };

    bus.on("model:lkw_fallback_attempt", handler);
    bus.emit("model:lkw_fallback_attempt", payload);
    expect(handler.mock.calls[0]![0].agentId).toBe("agent-1");
  });

  it("model:auth_cooldown accepts the turn-scoping ids", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["model:auth_cooldown"] = {
      keyName: "anthropic:default",
      provider: "anthropic",
      cooldownMs: 60_000,
      failureCount: 3,
      timestamp: Date.now(),
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-cd",
    };

    bus.on("model:auth_cooldown", handler);
    bus.emit("model:auth_cooldown", payload);
    expect(handler.mock.calls[0]![0].sessionKey).toBe("t1:u1:c1");
  });
});

// ---------------------------------------------------------------------------
// Memory recall/rerank/entity-link observability events.
//
// Counts/booleans ONLY closed-union payloads. These fail to compile on the
// pre-patch event-bus types (RED proof): EventMap has no "memory:recalled",
// "memory:reranked", or "memory:entities_linked" key yet. The shape
// assertions double as the no-body invariant (the type carries no content /
// query text / entity-name field; a source-grep test below re-proves it).
// ---------------------------------------------------------------------------

describe("memory:* recall observability events", () => {
  it("memory:recalled delivers per-lane candidate counts, finalCount, rerankerAvailable, durationMs", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["memory:recalled"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-recall-001",
      lanes: 3,
      ftsCandidates: 12,
      vectorCandidates: 8,
      entityCandidates: 4,
      finalCount: 6,
      rerankerAvailable: true,
      durationMs: 47,
      timestamp: Date.now(),
    };

    bus.on("memory:recalled", handler);
    bus.emit("memory:recalled", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["memory:recalled"];
    expect(r.lanes).toBe(3);
    expect(r.ftsCandidates).toBe(12);
    expect(r.vectorCandidates).toBe(8);
    expect(r.entityCandidates).toBe(4);
    expect(r.finalCount).toBe(6);
    expect(r.rerankerAvailable).toBe(true);
    expect(r.durationMs).toBe(47);

    // sessionKey is optional — bridge may omit it for non-session recalls.
    const noSession: EventMap["memory:recalled"] = {
      agentId: "agent-1",
      traceId: "trace-recall-002",
      lanes: 1,
      ftsCandidates: 5,
      vectorCandidates: 0,
      entityCandidates: 0,
      finalCount: 0,
      rerankerAvailable: false,
      durationMs: 3,
      timestamp: Date.now(),
    };
    bus.emit("memory:recalled", noSession);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0].sessionKey).toBeUndefined();
  });

  it("memory:reranked delivers candidate/hit counts plus timedOut/fellBack outcome flags", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["memory:reranked"] = {
      agentId: "agent-1",
      traceId: "trace-rerank-001",
      candidateCount: 20,
      hitCount: 6,
      rerankerAvailable: true,
      timedOut: false,
      fellBack: false,
      durationMs: 31,
      timestamp: Date.now(),
    };

    bus.on("memory:reranked", handler);
    bus.emit("memory:reranked", payload);

    const r = handler.mock.calls[0]![0] as EventMap["memory:reranked"];
    expect(r.candidateCount).toBe(20);
    expect(r.hitCount).toBe(6);
    expect(r.rerankerAvailable).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.fellBack).toBe(false);
    expect(r.durationMs).toBe(31);
  });

  it("memory:entities_linked delivers entityCount, newEntities, durationMs", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["memory:entities_linked"] = {
      agentId: "agent-1",
      entityCount: 5,
      newEntities: 2,
      durationMs: 9,
      timestamp: Date.now(),
    };

    bus.on("memory:entities_linked", handler);
    bus.emit("memory:entities_linked", payload);

    const r = handler.mock.calls[0]![0] as EventMap["memory:entities_linked"];
    expect(r.entityCount).toBe(5);
    expect(r.newEntities).toBe(2);
    expect(r.durationMs).toBe(9);
  });

  it("type safety: @ts-expect-error rejects content/query/entity-name on the counts-only payloads", () => {
    const bus = new TypedEventBus();

    bus.emit("memory:recalled", {
      agentId: "a",
      traceId: "t",
      lanes: 1,
      ftsCandidates: 1,
      vectorCandidates: 0,
      entityCandidates: 0,
      finalCount: 1,
      rerankerAvailable: false,
      durationMs: 1,
      timestamp: 1,
      // @ts-expect-error - query text is a forbidden field on the counts-only payload
      queryText: "who is alice",
    });

    bus.emit("memory:entities_linked", {
      agentId: "a",
      entityCount: 1,
      newEntities: 0,
      durationMs: 1,
      timestamp: 1,
      // @ts-expect-error - entity names must never ride on the payload
      entityNames: ["Alice"],
    });

    // @ts-expect-error - missing required finalCount on memory:recalled
    bus.emit("memory:recalled", {
      agentId: "a",
      traceId: "t",
      lanes: 1,
      ftsCandidates: 1,
      vectorCandidates: 0,
      entityCandidates: 0,
      rerankerAvailable: false,
      durationMs: 1,
      timestamp: 1,
    });
  });

  it("payload types carry no content/query/entity-name field (counts-only source invariant)", () => {
    // Source-grep the three memory recall event blocks for forbidden privacy-leak
    // keys. The closed shapes MUST carry counts/booleans/ids only — never
    // query text, memory bodies, or entity names (AGENTS.md §2.7).
    const src = readFileSync(resolve(here, "./events-agent.ts"), "utf8");
    for (const key of ["memory:recalled", "memory:reranked", "memory:entities_linked"]) {
      const match = src.match(
        new RegExp(`"${key}":\\s*\\{[\\s\\S]*?\\n\\s*\\};`),
      );
      expect(match, `${key} event block must exist`).toBeTruthy();
      const block = match![0];
      expect(block, `${key}: no raw content field`).not.toMatch(/^\s*content[?]?:/m);
      expect(block, `${key}: no query/queryText field`).not.toMatch(/^\s*query(?:Text)?[?]?:/m);
      expect(block, `${key}: no entityName(s)/names field`).not.toMatch(
        /^\s*(?:entityNames?|names)[?]?:/m,
      );
      expect(block, `${key}: no memory body field`).not.toMatch(/^\s*body[?]?:/m);
    }
  });
});

// ---------------------------------------------------------------------------
// memory:recall_used recall-usage attribution event.
//
// Counts + memory IDS only. Fails to compile on the pre-patch event-bus types
// (RED proof): EventMap has no "memory:recall_used" key yet. The shape
// assertion doubles as the no-body invariant (the type carries no content /
// response / query field; the source-grep test below re-proves it).
// ---------------------------------------------------------------------------

describe("memory:recall_used recall-usage attribution event", () => {
  it("delivers usedIds/ignoredIds (string[]) + usedCount/ignoredCount + agentId/traceId/timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["memory:recall_used"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-recall-used-001",
      usedIds: ["m-aaa", "m-bbb"],
      ignoredIds: ["m-ccc"],
      usedCount: 2,
      ignoredCount: 1,
      timestamp: Date.now(),
    };

    bus.on("memory:recall_used", handler);
    bus.emit("memory:recall_used", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["memory:recall_used"];
    expect(r.usedIds).toEqual(["m-aaa", "m-bbb"]);
    expect(r.ignoredIds).toEqual(["m-ccc"]);
    expect(r.usedCount).toBe(2);
    expect(r.ignoredCount).toBe(1);
    expect(r.agentId).toBe("agent-1");
    expect(r.traceId).toBe("trace-recall-used-001");

    // sessionKey is optional — non-session recalls may omit it.
    const noSession: EventMap["memory:recall_used"] = {
      agentId: "agent-1",
      traceId: "trace-recall-used-002",
      usedIds: [],
      ignoredIds: ["m-x"],
      usedCount: 0,
      ignoredCount: 1,
      timestamp: Date.now(),
    };
    bus.emit("memory:recall_used", noSession);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0].sessionKey).toBeUndefined();
  });

  it("type safety: @ts-expect-error rejects content/response/query and missing required counts", () => {
    const bus = new TypedEventBus();

    bus.emit("memory:recall_used", {
      agentId: "a",
      traceId: "t",
      usedIds: [],
      ignoredIds: [],
      usedCount: 0,
      ignoredCount: 0,
      timestamp: 1,
      // @ts-expect-error - memory content must never ride on the counts+ids payload
      content: "the recalled memory body",
    });

    bus.emit("memory:recall_used", {
      agentId: "a",
      traceId: "t",
      usedIds: [],
      ignoredIds: [],
      usedCount: 0,
      ignoredCount: 0,
      timestamp: 1,
      // @ts-expect-error - the agent response text must never ride on the payload
      response: "the agent reply",
    });

    // @ts-expect-error - missing required usedCount on memory:recall_used
    bus.emit("memory:recall_used", {
      agentId: "a",
      traceId: "t",
      usedIds: [],
      ignoredIds: [],
      ignoredCount: 0,
      timestamp: 1,
    });
  });

  it("payload type carries no content/response/query field (counts+ids-only source invariant)", () => {
    // Source-grep the memory:recall_used event block for forbidden privacy-leak
    // keys. The closed shape MUST carry counts/ids only — never memory content,
    // the agent response, or the query text (AGENTS.md §2.7).
    const src = readFileSync(resolve(here, "./events-agent.ts"), "utf8");
    const match = src.match(/"memory:recall_used":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "memory:recall_used event block must exist").toBeTruthy();
    const block = match![0];
    expect(block, "no raw content field").not.toMatch(/^\s*content[?]?:/m);
    expect(block, "no response field").not.toMatch(/^\s*response[?]?:/m);
    expect(block, "no query/queryText field").not.toMatch(/^\s*query(?:Text)?[?]?:/m);
    expect(block, "no preview field").not.toMatch(/^\s*preview[?]?:/m);
    expect(block, "no memory body field").not.toMatch(/^\s*body[?]?:/m);
    // The counts+ids payload fields MUST be present.
    expect(block, "usedIds present").toMatch(/^\s*usedIds:/m);
    expect(block, "ignoredIds present").toMatch(/^\s*ignoredIds:/m);
  });
});

// ---------------------------------------------------------------------------
// The optional intent on memory:recall_used.
//
// Additive + forward-only: the payload gains an OPTIONAL `intent?: string` (the
// deterministic classifyIntent bucket for the recall that produced these ids).
// When present the daemon write-back records the per-intent bucket; when OMITTED
// it records the GLOBAL bucket — byte-identical to the prior behaviour, so today's two emit
// sites compile unchanged. The intent string is metadata (a closed-union
// factual|temporal|preference|enumeration), NOT memory content — ids/counts/
// intent ONLY ever cross the bus (AGENTS.md §2.7), never bodies/query/response.
// ---------------------------------------------------------------------------

describe("memory:recall_used optional intent (write bucket)", () => {
  it("accepts a payload WITH intent:'temporal' AND one WITHOUT intent (additive/byte-identity)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    const withIntent: EventMap["memory:recall_used"] = {
      agentId: "agent-1",
      sessionKey: "t1:u1:c1",
      traceId: "trace-recall-used-intent-001",
      usedIds: ["m-aaa"],
      ignoredIds: ["m-bbb"],
      usedCount: 1,
      ignoredCount: 1,
      timestamp: Date.now(),
      intent: "temporal",
    };
    bus.on("memory:recall_used", handler);
    bus.emit("memory:recall_used", withIntent);
    expect(handler).toHaveBeenCalledWith(withIntent);
    const r = handler.mock.calls[0]![0] as EventMap["memory:recall_used"];
    expect(r.intent).toBe("temporal");
    expectTypeOf(r.intent).toEqualTypeOf<string | undefined>();

    // intent is OPTIONAL — omitting it is byte-identical to the prior behaviour (today's emit
    // sites compile unchanged; the daemon write-back records the global bucket).
    const noIntent: EventMap["memory:recall_used"] = {
      agentId: "agent-1",
      traceId: "trace-recall-used-intent-002",
      usedIds: ["m-ccc"],
      ignoredIds: [],
      usedCount: 1,
      ignoredCount: 0,
      timestamp: Date.now(),
    };
    bus.emit("memory:recall_used", noIntent);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0].intent).toBeUndefined();
  });

  it("payload still rejects content/response/query (the new intent stays ids/counts/intent-only)", () => {
    const bus = new TypedEventBus();
    // Source-grep the memory:recall_used block: the new optional intent field is
    // present AND documented ids/counts (§2.7), and no body/content/response/
    // query leaks in alongside it.
    const src = readFileSync(resolve(here, "./events-agent.ts"), "utf8");
    const match = src.match(/"memory:recall_used":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "memory:recall_used event block must exist").toBeTruthy();
    const block = match![0];
    // RED: fails on the pre-patch event (no optional intent field yet).
    expect(block, "optional intent?: string present on the payload").toMatch(
      /^\s*intent\?:\s*string\b/m,
    );
    // The §2.7 counts-only discipline is documented on/near the new field.
    expect(block, "the ids/counts discipline is documented").toMatch(/ids\/counts|§2\.7/);
    // No body/content leaks alongside the new metadata field.
    expect(block, "no raw content field").not.toMatch(/^\s*content[?]?:/m);
    expect(block, "no response field").not.toMatch(/^\s*response[?]?:/m);
    expect(block, "no query/queryText field").not.toMatch(/^\s*query(?:Text)?[?]?:/m);

    // Type safety: the intent must be a string, never an object carrying a body.
    bus.emit("memory:recall_used", {
      agentId: "a",
      traceId: "t",
      usedIds: [],
      ignoredIds: [],
      usedCount: 0,
      ignoredCount: 0,
      timestamp: 1,
      // @ts-expect-error - intent is a closed-union string, never a content-bearing object
      intent: { body: "the recalled memory body" },
    });
  });
});

describe("tool:install_detour_detected event type", () => {
  it("type-checks against the closed shape", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const sample: EventMap["tool:install_detour_detected"] = {
      packageManager: "pip",
      commandDigest: "abc123def456",
      packages: [{ normalizedName: "market-data-lib", ecosystem: "python" }],
      overlaps: [
        {
          packageName: "market-data-lib",
          sourceType: "mcp",
          sourceName: "finance-data",
          reason: "mcp-operator-alias",
        },
      ],
      mode: "advise",
      action: "hinted",
      timestamp: Date.now(),
    };

    bus.on("tool:install_detour_detected", handler);
    bus.emit("tool:install_detour_detected", sample);

    expect(handler).toHaveBeenCalledWith(sample);
    const received =
      handler.mock.calls[0]![0] as EventMap["tool:install_detour_detected"];
    expect(received.packageManager).toBe("pip");
    expect(received.commandDigest).toBe("abc123def456");
    expect(received.mode).toBe("advise");
    expect(received.action).toBe("hinted");
    expect(received.packages[0]?.normalizedName).toBe("market-data-lib");
    expect(received.overlaps[0]?.reason).toBe("mcp-operator-alias");
  });

  it("payload type contains no forbidden privacy-leak fields", () => {
    // Source-grep the install-detour event block for forbidden keys.
    // The closed shape MUST NOT include raw command text, shell fragments,
    // URLs, VCS specs, local paths, registry credentials, stdout, or stderr.
    // Only `commandDigest` (a stable, non-reversible hash) is permitted.
    const src = readFileSync(resolve(here, "./events-agent.ts"), "utf8");
    // Extract the install-detour block (between the event-key line and the
    // first `};` that closes it).
    const match = src.match(
      /"tool:install_detour_detected":\s*\{[\s\S]*?\n\s*\};/,
    );
    expect(match, "install-detour event block must exist").toBeTruthy();
    const block = match![0];

    // Forbidden keys:
    expect(block, "no raw `command:` field").not.toMatch(/^\s*(?:readonly\s+)?command:/m);
    expect(block, "no `rawCommand:` field").not.toMatch(/^\s*(?:readonly\s+)?rawCommand:/m);
    expect(block, "no `stdout:` field").not.toMatch(/^\s*(?:readonly\s+)?stdout:/m);
    expect(block, "no `stderr:` field").not.toMatch(/^\s*(?:readonly\s+)?stderr:/m);
    expect(block, "no `commandPrefix:` field").not.toMatch(/^\s*(?:readonly\s+)?commandPrefix:/m);
    // Required field present:
    expect(block, "commandDigest must be present").toMatch(
      /^\s*readonly commandDigest:\s*string;/m,
    );
  });
});

// ---------------------------------------------------------------------------
// subagent:budget_exceeded + enriched graph:node_updated (BUDGET-03).
// Counts/ids-only event mirroring memory:consolidated; the hygiene pin keeps
// task/output/body fields off the breach payload (AGENTS.md §2.7).
// ---------------------------------------------------------------------------

describe("subagent:budget_exceeded event type", () => {
  it("type-checks and round-trips with ids + the two token numbers only", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["subagent:budget_exceeded"] = {
      graphId: "graph-1",
      nodeId: "node-a",
      agentId: "agent-1",
      tokenBudget: 50_000,
      tokensUsed: 51_234,
      timestamp: Date.now(),
    };

    bus.on("subagent:budget_exceeded", handler);
    bus.emit("subagent:budget_exceeded", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["subagent:budget_exceeded"];
    expect(r.graphId).toBe("graph-1");
    expect(r.nodeId).toBe("node-a");
    expect(r.agentId).toBe("agent-1");
    expect(r.tokenBudget).toBe(50_000);
    expect(r.tokensUsed).toBe(51_234);
  });

  it("payload carries exactly the 6 counts/ids keys — no body/task/output", () => {
    const payload: EventMap["subagent:budget_exceeded"] = {
      graphId: "g",
      nodeId: "n",
      agentId: "a",
      tokenBudget: 1,
      tokensUsed: 2,
      timestamp: 3,
    };
    expect(Object.keys(payload).sort()).toEqual(
      ["agentId", "graphId", "nodeId", "timestamp", "tokenBudget", "tokensUsed"].sort(),
    );

    // Source-grep the breach event block for forbidden body fields (counts-only
    // contract — never task text, output, or response bodies; AGENTS.md §2.7).
    // The block lives in events-orchestration.ts (extracted from AgentEvents).
    const src = readFileSync(resolve(here, "./events-orchestration.ts"), "utf8");
    const match = src.match(/"subagent:budget_exceeded":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "subagent:budget_exceeded event block must exist").toBeTruthy();
    const block = match![0];
    for (const forbidden of ["task", "output", "response", "body", "content", "result"]) {
      expect(block, `no \`${forbidden}:\` field`).not.toMatch(
        new RegExp(`^\\s*(?:readonly\\s+)?${forbidden}\\??:`, "m"),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// subagent:delivery_retried + subagent:delivery_deadlettered (DELIVERY-02/03).
// Counts/ids-only events mirroring subagent:budget_exceeded — ids + attempt
// count + a closed-union `transient` tag + timestamp ONLY. The hygiene pin
// keeps announcement text / error strings / bodies off the payload (§2.7).
// ---------------------------------------------------------------------------

describe("subagent:delivery_retried event type", () => {
  it("type-checks and round-trips with runId + channelType + attempt + transient + timestamp", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["subagent:delivery_retried"] = {
      runId: "run-1",
      channelType: "discord",
      attempt: 2,
      transient: true,
      timestamp: Date.now(),
    };

    bus.on("subagent:delivery_retried", handler);
    bus.emit("subagent:delivery_retried", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["subagent:delivery_retried"];
    expect(r.runId).toBe("run-1");
    expect(r.channelType).toBe("discord");
    expect(r.attempt).toBe(2);
    // Closed-union literal: a retry is always for a transient failure.
    expect(r.transient).toBe(true);
  });

  it("payload carries exactly the 5 counts/ids keys — no body/text/error", () => {
    const payload: EventMap["subagent:delivery_retried"] = {
      runId: "r",
      channelType: "telegram",
      attempt: 1,
      transient: true,
      timestamp: 3,
    };
    expect(Object.keys(payload).sort()).toEqual(
      ["attempt", "channelType", "runId", "timestamp", "transient"].sort(),
    );

    const src = readFileSync(resolve(here, "./events-orchestration.ts"), "utf8");
    const match = src.match(/"subagent:delivery_retried":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "subagent:delivery_retried event block must exist").toBeTruthy();
    const block = match![0];
    for (const forbidden of ["announcementText", "text", "err", "error", "lastError", "body", "content", "response", "result"]) {
      expect(block, `no \`${forbidden}:\` field`).not.toMatch(
        new RegExp(`^\\s*(?:readonly\\s+)?${forbidden}\\??:`, "m"),
      );
    }
  });
});

describe("subagent:delivery_deadlettered event type", () => {
  it("type-checks and round-trips; transient is a boolean (transient retries-exhausted OR permanent immediate)", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["subagent:delivery_deadlettered"] = {
      runId: "run-9",
      channelType: "slack",
      attempt: 3,
      transient: false,
      timestamp: Date.now(),
    };

    bus.on("subagent:delivery_deadlettered", handler);
    bus.emit("subagent:delivery_deadlettered", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["subagent:delivery_deadlettered"];
    expect(r.runId).toBe("run-9");
    expect(r.attempt).toBe(3);
    expect(r.transient).toBe(false);
  });

  it("payload carries exactly the 5 counts/ids keys — no body/text/error", () => {
    const payload: EventMap["subagent:delivery_deadlettered"] = {
      runId: "r",
      channelType: "irc",
      attempt: 0,
      transient: true,
      timestamp: 7,
    };
    expect(Object.keys(payload).sort()).toEqual(
      ["attempt", "channelType", "runId", "timestamp", "transient"].sort(),
    );

    const src = readFileSync(resolve(here, "./events-orchestration.ts"), "utf8");
    const match = src.match(/"subagent:delivery_deadlettered":\s*\{[\s\S]*?\n\s*\};/);
    expect(match, "subagent:delivery_deadlettered event block must exist").toBeTruthy();
    const block = match![0];
    for (const forbidden of ["announcementText", "text", "err", "error", "lastError", "body", "content", "response", "result"]) {
      expect(block, `no \`${forbidden}:\` field`).not.toMatch(
        new RegExp(`^\\s*(?:readonly\\s+)?${forbidden}\\??:`, "m"),
      );
    }
  });
});

describe("graph:node_updated enriched with tokensUsed/cost (BUDGET-03)", () => {
  it("carries optional tokensUsed and cost and a listener reads them", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["graph:node_updated"] = {
      graphId: "graph-1",
      nodeId: "node-a",
      status: "completed",
      durationMs: 1200,
      tokensUsed: 8_192,
      cost: 0.0123,
      timestamp: Date.now(),
    };

    bus.on("graph:node_updated", handler);
    bus.emit("graph:node_updated", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const r = handler.mock.calls[0]![0] as EventMap["graph:node_updated"];
    expect(r.tokensUsed).toBe(8_192);
    expect(r.cost).toBeCloseTo(0.0123);
  });

  it("still type-checks when tokensUsed/cost are omitted (byte-identical when absent)", () => {
    const payload: EventMap["graph:node_updated"] = {
      graphId: "graph-1",
      nodeId: "node-a",
      status: "running",
      timestamp: Date.now(),
    };
    expect(payload.tokensUsed).toBeUndefined();
    expect(payload.cost).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// security:sandbox_downgrade_refused (SANDBOX-03). A fail-closed spawn refusal
// emits this typed event carrying BOTH postures as enum tuples + the violated
// dimensions + agent ids — labels only, NO secrets (no paths/hosts/uids-as-
// values/credentials). Mirrors the security:injection_detected family shape and
// the tool:install_detour_detected §2.7 no-secrets discipline.
// ---------------------------------------------------------------------------

describe("security:sandbox_downgrade_refused event type", () => {
  it("round-trips both postures as enum tuples + violated dimensions + ids only", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["security:sandbox_downgrade_refused"] = {
      timestamp: Date.now(),
      parentAgentId: "parent-agent",
      childAgentId: "child-agent",
      violatedDimensions: ["exec", "network"],
      parentPosture: { exec: "always", network: "none" },
      childPosture: { exec: "never", network: "full" },
    };

    bus.on("security:sandbox_downgrade_refused", handler);
    bus.emit("security:sandbox_downgrade_refused", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received =
      handler.mock.calls[0]![0] as EventMap["security:sandbox_downgrade_refused"];
    expect(received.parentAgentId).toBe("parent-agent");
    expect(received.childAgentId).toBe("child-agent");
    expect(received.violatedDimensions).toEqual(["exec", "network"]);
    expect(received.parentPosture.exec).toBe("always");
    expect(received.childPosture.exec).toBe("never");
  });

  it("accepts every closed-union posture enum label across all four dimensions", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["security:sandbox_downgrade_refused"] = {
      timestamp: Date.now(),
      parentAgentId: "p",
      childAgentId: "c",
      violatedDimensions: ["exec", "filesystem", "network", "uid"],
      parentPosture: {
        exec: "always",
        filesystem: "workspace",
        network: "none",
        uid: "dedicated",
      },
      childPosture: {
        exec: "never",
        filesystem: "full",
        network: "listed-hosts",
        uid: "daemon",
      },
    };

    bus.on("security:sandbox_downgrade_refused", handler);
    bus.emit("security:sandbox_downgrade_refused", payload);

    const received =
      handler.mock.calls[0]![0] as EventMap["security:sandbox_downgrade_refused"];
    expect(received.childPosture.filesystem).toBe("full");
    expect(received.childPosture.uid).toBe("daemon");
  });

  it("runtime payload exposes ONLY enum labels + ids + timestamp — every posture value is an allowed enum label and no key is secret-shaped", () => {
    // Runtime structural no-secrets assertion (the §2.7 discipline, mirroring
    // the 170/171 events). Serialize the payload and assert (a) no key matches
    // a secret-shaped name, and (b) every posture value is one of the allowed
    // closed-union enum labels — never a path/host/uid value.
    const payload: EventMap["security:sandbox_downgrade_refused"] = {
      timestamp: Date.now(),
      parentAgentId: "parent-agent",
      childAgentId: "child-agent",
      violatedDimensions: ["exec"],
      parentPosture: { exec: "always", filesystem: "workspace", network: "none", uid: "dedicated" },
      childPosture: { exec: "never", filesystem: "home", network: "listed-hosts", uid: "daemon" },
    };

    const allKeys = new Set<string>();
    const collectKeys = (obj: unknown): void => {
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          allKeys.add(k);
          collectKeys(v);
        }
      }
    };
    collectKeys(payload);

    // Forbidden = key names that would carry operator topology / credentials.
    // The four dimension KEYS (`exec`/`filesystem`/`network`/`uid`) are the
    // spec'd closed-union enum-tuple field names and are explicitly allowed —
    // the value-allowlist check below proves each carries only an enum LABEL,
    // never the underlying path/host/uid-number that would leak the topology.
    const allowedKeys = new Set<string>([
      "timestamp", "parentAgentId", "childAgentId", "violatedDimensions",
      "parentPosture", "childPosture",
      "exec", "filesystem", "network", "uid",
    ]);
    const secretShaped = /paths?|hosts?|credential|token|secret|password|url|cwd|dir|value|prefix|body|content/i;
    for (const key of allKeys) {
      expect(allowedKeys.has(key), `unexpected key "${key}" in refusal payload`).toBe(true);
      expect(secretShaped.test(key), `key "${key}" must not be secret-shaped`).toBe(false);
    }

    // Every posture value must be one of the allowed enum labels for its
    // dimension — proving the postures carry LABELS, never operator topology.
    const allowed = new Set<string>([
      "always", "never",
      "workspace", "listed-paths", "home", "full",
      "none", "listed-hosts",
      "dedicated", "daemon",
    ]);
    for (const posture of [payload.parentPosture, payload.childPosture]) {
      for (const value of Object.values(posture)) {
        expect(allowed.has(value), `posture value "${value}" must be an allowed enum label`).toBe(true);
      }
    }
    for (const dim of payload.violatedDimensions) {
      expect(["exec", "filesystem", "network", "uid"]).toContain(dim);
    }
  });

  it("payload type contains no forbidden privacy-leak fields", () => {
    // Source-grep the event block: the closed shape MUST NOT carry raw paths,
    // hosts, credential values, or any free-form value field — only the
    // posture enum tuples + agent ids + timestamp (AGENTS.md §2.7).
    const src = readFileSync(resolve(here, "./events-agent.ts"), "utf8");
    const match = src.match(
      /"security:sandbox_downgrade_refused":\s*\{[\s\S]*?\n {2}\};/,
    );
    expect(match, "sandbox-downgrade-refused event block must exist").toBeTruthy();
    const block = match![0];

    expect(block, "no `paths:` field").not.toMatch(/^\s*(?:readonly\s+)?paths:/m);
    expect(block, "no `hosts:` field").not.toMatch(/^\s*(?:readonly\s+)?hosts:/m);
    expect(block, "no `allowedPaths:` field").not.toMatch(/^\s*(?:readonly\s+)?allowedPaths:/m);
    expect(block, "no `credentialPaths:` field").not.toMatch(/^\s*(?:readonly\s+)?credentialPaths:/m);
    expect(block, "no `uidValue:`/`uid:` numeric field").not.toMatch(/^\s*(?:readonly\s+)?uid(?:Value)?:\s*number/m);
    // Required structural fields present (postures as enum tuples + ids):
    expect(block, "parentPosture present").toMatch(/parentPosture:/);
    expect(block, "childPosture present").toMatch(/childPosture:/);
    expect(block, "violatedDimensions present").toMatch(/violatedDimensions:/);
  });
});
