import { describe, it, expect, vi } from "vitest";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

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

  it("observability:latency delivers operation union", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    for (const operation of ["llm_call", "tool_execution", "memory_search"] as const) {
      const payload: EventMap["observability:latency"] = {
        operation,
        durationMs: 100,
        timestamp: Date.now(),
      };
      bus.on("observability:latency", handler);
      bus.emit("observability:latency", payload);
      bus.removeAllListeners("observability:latency");
    }

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0]![0].operation).toBe("llm_call");
    expect(handler.mock.calls[1]![0].operation).toBe("tool_execution");
    expect(handler.mock.calls[2]![0].operation).toBe("memory_search");
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
