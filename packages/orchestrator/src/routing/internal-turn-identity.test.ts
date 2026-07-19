// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolveInternalTurnIdentity } from "./internal-turn-identity.js";
import { resolveRoutingPolicy, type DmScopeMode } from "./routing-policy-resolver.js";

describe("internal turn identity normalization", () => {
  it("returns scheduler authority and a display-only session projection", () => {
    const resolved = resolveInternalTurnIdentity({
      tenantId: "tenant_a",
      agentId: "agent_a",
      originKind: "scheduler",
      instanceId: "heartbeat",
      conversationId: "agent_a",
      principalId: "scheduler_agent_a",
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.turnScope).toMatchObject({
      conversation: { tenantId: "tenant_a", agentId: "agent_a" },
      principal: { principalId: "scheduler_agent_a" },
      endpoint: {
        channelType: "scheduler",
        channelInstanceId: "heartbeat",
        conversationId: "agent_a",
        conversationKind: "direct",
      },
    });
    expect(resolved.value.displaySessionKey).toMatchObject({
      tenantId: "tenant_a",
      agentId: "agent_a",
      userId: "scheduler_agent_a",
    });
  });

  it("rejects an internal origin without explicit tenant authority", () => {
    const resolved = resolveInternalTurnIdentity({
      tenantId: "",
      agentId: "agent_a",
      originKind: "durable-resume",
      instanceId: "resume",
      conversationId: "run_a",
      principalId: "resume_agent_a",
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.errorKind).toBe("validation");
  });

  it("rejects a direct-message mode outside the closed routing policy union", () => {
    const resolved = resolveRoutingPolicy({
      tenantId: "tenant_a",
      agentId: "agent_a",
      endpoint: {
        channelType: "control-plane",
        channelInstanceId: "rpc",
        conversationId: "request_a",
        conversationKind: "direct",
      },
      principal: { principalId: "operator_a" },
      dmScopeMode: "unsupported" as DmScopeMode,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.message).toMatch(/unsupported/i);
  });
});
