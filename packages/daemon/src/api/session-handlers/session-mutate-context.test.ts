// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  createDeliveryOrigin,
  runWithContext,
  type RequestContext,
} from "@comis/core";
import { bindSessionMutateHandlers } from "./session-mutate.js";
import type { SessionHandlerDeps } from "./session-helpers.js";

function createDeps(): {
  deps: SessionHandlerDeps;
  spawn: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  loadByFormattedKey: ReturnType<typeof vi.fn>;
  getRunBySessionKey: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn().mockReturnValue("run_a");
  const send = vi.fn().mockResolvedValue({ sent: true });
  const loadByFormattedKey = vi.fn().mockReturnValue(undefined);
  const getRunBySessionKey = vi.fn().mockReturnValue(undefined);
  const audit = vi.fn();
  const warn = vi.fn();
  const deps = {
    defaultAgentId: "child-agent",
    securityConfig: {
      agentToAgent: {
        enabled: true,
        waitTimeoutMs: 10,
      },
    },
    sessionStore: {
      loadByFormattedKey,
    },
    subAgentRunner: {
      spawn,
      getRunStatus: vi.fn().mockReturnValue({ status: "running" }),
      getRunBySessionKey,
      lastSpawnDedupInfo: vi.fn().mockReturnValue(undefined),
    },
    crossSessionSender: { send },
    logger: {
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
      audit,
    },
  } as unknown as SessionHandlerDeps;
  return { deps, spawn, send, loadByFormattedKey, getRunBySessionKey, audit, warn };
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    traceId: "40000000-0000-4000-8000-000000000004",
    tenantId: "tenant_a",
    userId: "user_a",
    sessionKey: "tenant_a:user_a:chat_a",
    agentId: "parent-agent",
    startedAt: 1,
    trustLevel: "user",
    channelType: "telegram",
    ...overrides,
  };
}

function spawnParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: "inspect the service",
    _capabilities: ["orch:spawn"],
    _agentId: "parent-agent",
    _callerSessionKey: "tenant_a:user_a:chat_a",
    _callerChannelType: "telegram",
    _callerChannelId: "chat_a",
    ...overrides,
  };
}

function sendParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_key: "tenant_a:user_a:target_chat",
    text: "send this safely",
    _agentId: "parent-agent",
    _callerSessionKey: "tenant_a:user_a:chat_a",
    _callerChannelType: "telegram",
    _callerChannelId: "chat_a",
    _outwardOperationId: "sessions-send-call-1",
    ...overrides,
  };
}

describe("session.send target principal authorization", () => {
  it("allows a same-tenant same-user session owned by the calling agent", async () => {
    const { deps, send, loadByFormattedKey } = createDeps();
    loadByFormattedKey.mockReturnValue({
      messages: [],
      metadata: { agentId: "parent-agent" },
      createdAt: 1,
      updatedAt: 1,
    });
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(runWithContext(context(), () => handler(sendParams())))
      .resolves.toEqual({ sent: true });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionKey: "tenant_a:user_a:target_chat",
      callerSessionKey: "tenant_a:user_a:chat_a",
      agentId: "parent-agent",
      announceOperationId: "sessions-send-call-1",
    }));
  });

  it("rejects an agent-origin send to a different tenant", async () => {
    const { deps, send, loadByFormattedKey } = createDeps();
    loadByFormattedKey.mockReturnValue({
      messages: [],
      metadata: { agentId: "parent-agent" },
      createdAt: 1,
      updatedAt: 1,
    });
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(runWithContext(context(), () => handler(sendParams({
      session_key: "tenant_b:user_a:target_chat",
    })))).rejects.toThrow(/target tenant.*request principal/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("audits a denial without recording message content or target identifiers", async () => {
    const { deps, audit, warn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;
    const plantedMessage = "private-message-content-must-not-enter-security-logs";
    const plantedTarget = "private-target-identifier";

    await expect(runWithContext(context(), () => handler(sendParams({
      session_key: `tenant_b:user_a:${plantedTarget}`,
      text: plantedMessage,
    })))).rejects.toThrow(/target tenant.*request principal/i);

    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "session.send",
      outcome: "denied",
      agentId: "parent-agent",
    }), "session.send target principal denied");
    const securityLogs = JSON.stringify({ audit: audit.mock.calls, warn: warn.mock.calls });
    expect(securityLogs).not.toContain(plantedMessage);
    expect(securityLogs).not.toContain(plantedTarget);
  });

  it("rejects an agent-origin send to a different user", async () => {
    const { deps, send, loadByFormattedKey } = createDeps();
    loadByFormattedKey.mockReturnValue({
      messages: [],
      metadata: { agentId: "parent-agent" },
      createdAt: 1,
      updatedAt: 1,
    });
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(runWithContext(context(), () => handler(sendParams({
      session_key: "tenant_a:other_user:target_chat",
    })))).rejects.toThrow(/target user.*request principal/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a target owned by another agent without an exact spawn delegation", async () => {
    const { deps, send, loadByFormattedKey } = createDeps();
    loadByFormattedKey.mockReturnValue({
      messages: [],
      metadata: { agentId: "other-agent" },
      createdAt: 1,
      updatedAt: 1,
    });
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(runWithContext(context(), () => handler(sendParams())))
      .rejects.toThrow(/target agent.*request principal/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("allows an exact persisted child delegation after the live run is gone", async () => {
    const { deps, send, loadByFormattedKey } = createDeps();
    loadByFormattedKey.mockReturnValue({
      messages: [],
      metadata: {
        agentId: "child-agent",
        spawnedByAgent: "parent-agent",
        parentSessionKey: "tenant_a:user_a:chat_a",
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(runWithContext(context(), () => handler(sendParams())))
      .resolves.toEqual({ sent: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ agentId: "child-agent" }));
  });

  it("rejects an agent-origin send when no live request context exists", async () => {
    const { deps, send } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(handler(sendParams())).rejects.toThrow(/request context.*required/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an injected caller agent that differs from the live request principal", async () => {
    const { deps, send } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(runWithContext(context(), () => handler(sendParams({
      _agentId: "other-agent",
    })))).rejects.toThrow(/caller agent.*request principal/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an injected caller session that differs from the live request principal", async () => {
    const { deps, send } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(runWithContext(context(), () => handler(sendParams({
      _callerSessionKey: "tenant_a:user_a:other_chat",
    })))).rejects.toThrow(/caller session.*request principal/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a target whose agent ownership cannot be proven", async () => {
    const { deps, send, loadByFormattedKey } = createDeps();
    loadByFormattedKey.mockReturnValue({
      messages: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    });
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(runWithContext(context(), () => handler(sendParams())))
      .rejects.toThrow(/target agent ownership.*required/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the no-agent control-plane path explicit and unchanged", async () => {
    const { deps, send } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.send"]!;

    await expect(handler({
      session_key: "tenant_b:operator_target:chat_b",
      text: "operator-directed message",
      agent_id: "operator-selected-agent",
    })).resolves.toEqual({ sent: true });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionKey: "tenant_b:operator_target:chat_b",
      agentId: "operator-selected-agent",
    }));
  });
});

describe("session.spawn caller context", () => {
  it("forwards the authoritative ALS delivery origin to the child", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      threadId: "topic_a",
      tenantId: "tenant_a",
    });

    await runWithContext(context({ deliveryOrigin }), () => handler(spawnParams()));

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      callerAgentId: "parent-agent",
      callerSessionKey: "tenant_a:user_a:chat_a",
      announceChannelType: "telegram",
      announceChannelId: "chat_a",
      requesterOrigin: deliveryOrigin,
    }));
  });

  it("inherits the live parent run's own lease and attenuated capabilities for a descendant", async () => {
    const { deps, spawn, getRunBySessionKey } = createDeps();
    getRunBySessionKey.mockReturnValue({
      rootRunId: "root-live-parent",
      parentLeaseId: "lease-grandparent",
      leaseId: "lease-live-parent",
      caps: ["orch:spawn", "orch:read"],
    });
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });

    await runWithContext(context({ deliveryOrigin }), () => handler(spawnParams({
      _rootRunId: "root-config-session",
      _leaseId: "lease-config-session",
      _capabilities: ["orch:spawn", "orch:read", "orch:write"],
    })));

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      rootRunId: "root-live-parent",
      parentLeaseId: "lease-live-parent",
      caps: ["orch:spawn", "orch:read"],
    }));
  });

  it("rejects a descendant spawn when config injection exceeds the live parent capability ceiling", async () => {
    const { deps, spawn, getRunBySessionKey } = createDeps();
    getRunBySessionKey.mockReturnValue({
      rootRunId: "root-live-parent",
      leaseId: "lease-live-parent",
      caps: ["orch:read"],
    });
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });

    await expect(runWithContext(context({ deliveryOrigin }), () => handler(spawnParams({
      _capabilities: ["orch:spawn", "orch:read"],
    })))).rejects.toThrow(/orch:spawn/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects injected route identity when ALS has no resolved delivery origin", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;

    await expect(runWithContext(context(), () => handler(spawnParams())))
      .rejects.toThrow(/resolved principal|delivery origin/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a caller session that disagrees with the live ALS principal", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;

    await expect(runWithContext(context(), () => handler(spawnParams({
      _callerSessionKey: "tenant_a:other_user:other_chat",
    })))).rejects.toThrow(/caller session.*request context/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("audits a caller denial without recording injected session or route identifiers", async () => {
    const { deps, spawn, audit, warn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const plantedSession = "private-forged-session";
    const plantedRoute = "private-forged-route";
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });

    await expect(runWithContext(context({ deliveryOrigin }), () => handler(spawnParams({
      _callerSessionKey: `tenant_a:user_a:${plantedSession}`,
      _callerChannelId: plantedRoute,
    })))).rejects.toThrow(/caller session.*request context/i);

    expect(spawn).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "session.spawn",
      outcome: "denied",
      mismatchField: "session",
    }), "session.spawn caller principal denied");
    const securityLogs = JSON.stringify({ audit: audit.mock.calls, warn: warn.mock.calls });
    expect(securityLogs).not.toContain(plantedSession);
    expect(securityLogs).not.toContain(plantedRoute);
  });

  it("rejects a caller agent that disagrees with the live ALS principal", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;

    await expect(runWithContext(context(), () => handler(spawnParams({
      _agentId: "other-agent",
    })))).rejects.toThrow(/caller agent.*request context/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a delivery origin tenant that disagrees with the live ALS tenant", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_b",
    });

    await expect(runWithContext(context({ deliveryOrigin }), () => (
      handler(spawnParams())
    ))).rejects.toThrow(/delivery origin tenant.*request context/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a caller session whose parsed tenant differs from the ALS principal", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_b",
    });

    await expect(runWithContext(context({
      tenantId: "tenant_b",
      deliveryOrigin,
    }), () => handler(spawnParams())))
      .rejects.toThrow(/session identity|resolved principal/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a delivery origin user that disagrees with the live ALS user", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "other_user",
      tenantId: "tenant_a",
    });

    await expect(runWithContext(context({ deliveryOrigin }), () => handler(spawnParams())))
      .rejects.toThrow(/delivery origin user|resolved principal/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects partial injected caller identity even when ALS is complete", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });

    await expect(runWithContext(context({ deliveryOrigin }), () => handler({
      task: "inspect the service",
      _capabilities: ["orch:spawn"],
      _agentId: "parent-agent",
    }))).rejects.toThrow(/caller session|resolved principal/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a model-supplied announcement route outside the requester origin", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });

    await expect(runWithContext(context({ deliveryOrigin }), () => handler(spawnParams({
      announce_channel_type: "telegram",
      announce_channel_id: "attacker_chat",
    })))).rejects.toThrow(/announcement route.*request context/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts a model-supplied announcement route only when it matches the requester origin", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;
    const deliveryOrigin = createDeliveryOrigin({
      channelType: "telegram",
      channelId: "chat_a",
      userId: "user_a",
      tenantId: "tenant_a",
    });

    await runWithContext(context({ deliveryOrigin }), () => handler(spawnParams({
      announce_channel_type: "telegram",
      announce_channel_id: "chat_a",
    })));

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      announceChannelType: "telegram",
      announceChannelId: "chat_a",
      requesterOrigin: deliveryOrigin,
    }));
  });

  it("rejects injected caller identity outside a request context", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;

    await expect(handler(spawnParams())).rejects.toThrow(/request context/i);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps the authenticated control-plane path without caller identity unchanged", async () => {
    const { deps, spawn } = createDeps();
    const handler = bindSessionMutateHandlers(deps)["session.spawn"]!;

    await handler({
      task: "operator-directed inspection",
      _capabilities: ["orch:spawn"],
      announce_channel_type: "telegram",
      announce_channel_id: "operator_chat",
    });

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      requesterOrigin: undefined,
      callerType: "control-plane",
      callerAgentId: undefined,
      callerSessionKey: undefined,
      announceChannelType: "telegram",
      announceChannelId: "operator_chat",
    }));
  });
});
