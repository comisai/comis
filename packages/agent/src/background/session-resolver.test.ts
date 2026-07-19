// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationRef } from "@comis/core";
import { createActiveRunRegistry, type RunHandle } from "../executor/active-run-registry.js";
import { createBackgroundSessionResolver } from "./session-resolver.js";

function makeConversationRef(tenantId: string, agentId: string, conversationId: string) {
  const result = createConversationRef({
    tenantId,
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      endpoint: {
        channelType: "telegram",
        channelInstanceId: "test-instance",
        conversationId,
        conversationKind: "direct",
      },
      principalId: "user_a",
    },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function makeRunHandle(name = "run"): RunHandle {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    isStreaming: vi.fn().mockReturnValue(false),
    isCompacting: vi.fn().mockReturnValue(false),
    _name: name,
  } as RunHandle & { _name: string };
}

describe("BackgroundSessionResolver", () => {
  let registry: ReturnType<typeof createActiveRunRegistry>;

  beforeEach(() => {
    registry = createActiveRunRegistry();
  });

  it("resolves the live handle by canonical conversation authority", () => {
    const conversationRef = makeConversationRef("tenant_a", "agent_a", "chat_a");
    const handle = makeRunHandle();
    registry.register(conversationRef, handle);

    const resolver = createBackgroundSessionResolver({ activeRunRegistry: registry });

    expect(resolver.resolveActiveSession(conversationRef)).toBe(handle);
    expect(resolver.hasActiveSession(conversationRef)).toBe(true);
  });

  it("returns no handle for an unregistered conversation authority", () => {
    const resolver = createBackgroundSessionResolver({ activeRunRegistry: registry });

    expect(
      resolver.resolveActiveSession(makeConversationRef("tenant_a", "agent_a", "missing")),
    ).toBeUndefined();
  });

  it("isolates identical platform conversations across tenants and agents", () => {
    const firstRef = makeConversationRef("tenant_a", "agent_a", "shared_chat");
    const secondRef = makeConversationRef("tenant_a", "agent_b", "shared_chat");
    const thirdRef = makeConversationRef("tenant_b", "agent_a", "shared_chat");
    const first = makeRunHandle("first");
    const second = makeRunHandle("second");
    const third = makeRunHandle("third");
    registry.register(firstRef, first);
    registry.register(secondRef, second);
    registry.register(thirdRef, third);
    const resolver = createBackgroundSessionResolver({ activeRunRegistry: registry });

    expect(resolver.resolveActiveSession(firstRef)).toBe(first);
    expect(resolver.resolveActiveSession(secondRef)).toBe(second);
    expect(resolver.resolveActiveSession(thirdRef)).toBe(third);
  });
});
