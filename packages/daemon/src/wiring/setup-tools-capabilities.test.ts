// SPDX-License-Identifier: Apache-2.0
/**
 * Neighbor test for makeCreateAgentRpcCall (extracted from setup-tools.ts,
 * Phase 210 CAP-03 file-size cap). Asserts the agent-scoped rpcCall builder
 * injects _agentId + the resolved _capabilities (from resolveAutonomy) plus the
 * caller's session/delivery/channel context into every forwarded RPC call, and
 * resolves a zero-config agent through the default-agent fallback.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";

// Controllable AsyncLocalStorage context for the unit under test. Each test sets
// `currentCtx` before calling the agentRpc so the injection branches are driven.
let currentCtx: Record<string, unknown> | undefined;

vi.mock("@comis/core", () => ({
  tryGetContext: () => currentCtx,
  // Parse "tenantId:channelId:userId" — mirrors the real formatter used in tests.
  parseFormattedSessionKey: (k: string) => {
    const [tenantId, channelId, userId] = k.split(":");
    if (!tenantId || !channelId || !userId) return undefined;
    return { tenantId, channelId, userId };
  },
  // Stand-in autonomy resolver returning the `standard` floor capability set.
  // The real resolver is unit-tested against the schema in
  // schema-agent-autonomy.test.ts; here we only need a deterministic cap list.
  resolveAutonomy: vi.fn((_cfg?: unknown) => ({
    profile: "standard",
    capabilities: ["orch:spawn", "orch:graph", "orch:cron"],
  })),
}));

const { makeCreateAgentRpcCall } = await import("./setup-tools-capabilities.js");

describe("makeCreateAgentRpcCall — the agent-scoped rpcCall capability-injection builder", () => {
  it("injects _agentId and the resolved _capabilities into every forwarded rpcCall", async () => {
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    const agentRpc = create("agent-1");
    await agentRpc("session.spawn", { task: "do a thing" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._agentId).toBe("agent-1");
    expect(Array.isArray(forwarded._capabilities)).toBe(true);
    expect(forwarded._capabilities).toContain("orch:spawn");
    expect(forwarded._capabilities).toContain("orch:graph");
    expect(forwarded._capabilities).toContain("orch:cron");
    // Original params survive the merge.
    expect(forwarded.task).toBe("do a thing");
  });

  it("derives _callerSessionKey, _deliveryTarget, and caller channel metadata from the request context", async () => {
    currentCtx = {
      sessionKey: "tenant-x:chan-y:user-z",
      channelType: "telegram",
      deliveryOrigin: { channelType: "telegram", channelId: "chan-y" },
    };
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "agent-1": {} as never },
      defaultAgentId: "agent-1",
    });

    await create("agent-1")("cron.add", { schedule: "* * * * *" });

    const forwarded = rpcCall.mock.calls[0][1] as Record<string, unknown>;
    expect(forwarded._callerSessionKey).toBe("tenant-x:chan-y:user-z");
    expect(forwarded._deliveryTarget).toEqual({
      channelId: "chan-y",
      userId: "user-z",
      tenantId: "tenant-x",
      channelType: "telegram",
    });
    expect(forwarded._callerChannelType).toBe("telegram");
    expect(forwarded._callerChannelId).toBe("chan-y");
  });

  it("resolves a zero-config agentId through the default-agent fallback for capability resolution", async () => {
    currentCtx = undefined;
    const rpcCall = vi.fn(async () => "ok");
    const create = makeCreateAgentRpcCall({
      rpcCall,
      agents: { "default-agent": {} as never },
      defaultAgentId: "default-agent",
    });

    // "unknown-agent" is absent from `agents` — the builder must fall back to
    // the default agent's autonomy rather than crash, and still stamp the caps.
    const forwarded = await (async () => {
      await create("unknown-agent")("session.spawn", {});
      return rpcCall.mock.calls[0][1] as Record<string, unknown>;
    })();
    expect(forwarded._agentId).toBe("unknown-agent");
    expect(forwarded._capabilities).toContain("orch:spawn");
  });
});
