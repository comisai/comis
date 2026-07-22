// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createLeaseManager } from "@comis/infra";
import {
  conversationScopeToSessionKey,
  formatSessionKey,
  tryGetContext,
  type AgentCapability,
} from "@comis/core";
import { bindSessionMutateHandlers } from "../api/session-handlers/session-mutate.js";
import type { SessionHandlerDeps } from "../api/session-handlers/session-helpers.js";
import { createCapabilityEndpoint } from "./setup-capability-endpoint.js";
import { dispatchValidatedLeaseRpc } from "./setup-capability-session-spawn.js";

describe("capability session.spawn strict-handler integration", () => {
  function authority(agentId: string, conversationId: string, threadId?: string) {
    const endpoint = {
      channelType: "telegram",
      channelInstanceId: "telegram-main",
      conversationId,
      ...(threadId === undefined ? {} : { threadId }),
      conversationKind: "direct" as const,
    };
    const turnScope = {
      conversation: {
        tenantId: "tenant-a",
        agentId,
        partition: {
          kind: "endpoint-conversation-principal" as const,
          endpoint,
          principalId: "user-a",
        },
      },
      principal: { principalId: "user-a" },
      endpoint,
    };
    const display = conversationScopeToSessionKey(turnScope.conversation);
    if (!display.ok) throw display.error;
    return { turnScope, sessionKey: formatSessionKey(display.value) };
  }

  it("strips a forged operation identity and injects the validated socket identity", async () => {
    const dispatch = vi.fn(async () => "ok");
    const resolved = authority("agent-a", "chat-a");
    const lease = {
      agentId: "agent-a",
      caps: ["orch:spawn"] as AgentCapability[],
      ...resolved,
      rootRunId: "root-a",
      leaseId: "lease-a",
      budgetRef: "budget-a",
      trustLevel: "user" as const,
      expiresAt: 2_000_000_000_000,
    } as never;

    await dispatchValidatedLeaseRpc({
      lease,
      params: { task: "bounded work", _outwardOperationId: "forged" },
      outwardOperationId: "socket-operation-1",
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      task: "bounded work",
      _outwardOperationId: "socket-operation-1",
      _callerConversationScope: resolved.turnScope.conversation,
    }));
  });

  it.each(["guest", "user", "admin"] as const)(
    "accepts only the lease-derived %s principal and ignores a forged trust parameter",
    async (trustLevel) => {
    const leaseManager = createLeaseManager({
      clock: { now: () => 1_700_000_000_000 },
    });
    let observedTrust: string | undefined;
    const spawn = vi.fn(() => {
      observedTrust = tryGetContext()?.trustLevel;
      return "run-child";
    });
    const handler = bindSessionMutateHandlers({
      defaultAgentId: "default-child",
      securityConfig: {
        agentToAgent: {
          enabled: true,
          waitTimeoutMs: 10,
        },
      },
      sessionStore: {
        loadByRef: vi.fn().mockReturnValue({ ok: true, value: undefined }),
      },
      subAgentRunner: {
        spawn,
        getRunStatus: vi.fn().mockReturnValue({ status: "running" }),
        getRunBySessionKey: vi.fn().mockReturnValue(undefined),
        lastSpawnDedupInfo: vi.fn().mockReturnValue(undefined),
      },
      crossSessionSender: { send: vi.fn() },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        audit: vi.fn(),
      },
    } as unknown as SessionHandlerDeps)["session.spawn"]!;
    const endpoint = createCapabilityEndpoint({
      leaseManager,
      rpcCall: async (method, params) => {
        expect(method).toBe("session.spawn");
        return handler(params);
      },
    });
    const deliveryOrigin = {
      channelType: "telegram",
      channelId: "parent-chat",
      userId: "user-a",
      tenantId: "tenant-a",
      threadId: "parent-topic",
    };
    const resolved = authority("socket-child", "parent-chat", "parent-topic");
    const { bearer } = leaseManager.mintLease({
      agentId: "socket-child",
      caps: ["orch:spawn"] as AgentCapability[],
      budgetRef: "budget-child",
      sessionKey: resolved.sessionKey,
      turnScope: resolved.turnScope,
      rootRunId: "root-child",
      trustLevel,
      deliveryOrigin,
    });

    await endpoint.handleCapCall(bearer, "session.spawn", {
      task: "spawn a bounded nested worker",
      agent: "nested-worker",
      _agentId: "forged-agent",
      _callerSessionKey: "forged:session:key",
      _callerChannelType: "discord",
      _callerChannelId: "forged-channel",
      _trustLevel: "admin",
    });

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      task: "spawn a bounded nested worker",
      agentId: "nested-worker",
      callerType: "agent",
      callerAgentId: "socket-child",
      callerSessionKey: resolved.sessionKey,
      announceChannelType: "telegram",
      announceChannelId: "parent-chat",
      requesterOrigin: deliveryOrigin,
    }));
    expect(observedTrust).toBe(trustLevel);
  });
});
