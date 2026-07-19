// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: orchestrator turn-scope routing — DM scope modes, thread
 * isolation, and tenant authority, exercised across the dist boundary.
 *
 * The inbound identity surface no longer exposes a `buildScopedSessionKey`
 * helper. Scoping is now two composable public primitives: the orchestrator's
 * `resolveRoutingPolicy` maps (tenant, agent, authenticated endpoint,
 * principal, DM-scope mode) to a canonical `ResolvedTurnScope`, and core's
 * `conversationScopeToSessionKey` / `createConversationRef` project that scope
 * into the human-readable session key and the opaque routing reference. This
 * suite proves the same guarantees the old builder covered — DM-scope
 * isolation modes, thread isolation, and tenant handling — through those public
 * exports, keeping the adversarial cross-tenant / cross-thread / cross-principal
 * / DM-vs-group isolation cases.
 *
 * The platform-metadata → threadId mapping (Slack `slackThreadTs`, Telegram
 * `telegramThreadId`, Teams `msteamsThreadId`, Discord `parentChannelId`) that
 * the old `extractThreadId` cases covered is the private thread-narrowing step
 * inside `resolveInboundTurnIdentity`; it is proven directly by the co-located
 * unit suite packages/orchestrator/src/inbound/inbound-turn-identity.test.ts.
 * Here we assert the layer below it: once a threadId is (or is not) present on
 * the endpoint, the resulting scope isolates accordingly.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { resolveRoutingPolicy } from "@comis/orchestrator";
import {
  conversationScopeToSessionKey,
  createConversationRef,
  AppConfigSchema,
  DmScopeConfigSchema,
  type ChannelEndpoint,
  type ConversationScope,
} from "@comis/core";

type DmScopeMode = "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";

function endpoint(overrides: Partial<ChannelEndpoint> = {}): ChannelEndpoint {
  return {
    channelType: overrides.channelType ?? "telegram",
    channelInstanceId: overrides.channelInstanceId ?? "bot-account",
    conversationId: overrides.conversationId ?? "conversation-1",
    conversationKind: overrides.conversationKind ?? "direct",
    ...(overrides.threadId === undefined ? {} : { threadId: overrides.threadId }),
  };
}

/** Resolve a scope through the public routing policy, asserting success. */
function scopeOf(input: {
  tenantId?: string;
  agentId?: string;
  endpoint?: Partial<ChannelEndpoint>;
  principalId?: string;
  dmScopeMode?: DmScopeMode;
}): ConversationScope {
  const resolved = resolveRoutingPolicy({
    tenantId: input.tenantId ?? "tenant-a",
    agentId: input.agentId ?? "agent-a",
    endpoint: endpoint(input.endpoint),
    principal: { principalId: input.principalId ?? "principal-1" },
    dmScopeMode: input.dmScopeMode ?? "per-channel-peer",
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(`routing policy rejected: ${resolved.error.message}`);
  return resolved.value.conversation;
}

/** Opaque canonical routing reference — the true isolation identity. */
function refOf(scope: ConversationScope): string {
  const ref = createConversationRef(scope);
  expect(ref.ok).toBe(true);
  if (!ref.ok) throw new Error(ref.error.message);
  return ref.value;
}

describe("INTEGRATION: orchestrator turn-scope routing — DM scope + thread isolation", () => {
  it("per-channel-peer DM produces a SessionKey scoped by tenant/principal/channel", () => {
    const scope = scopeOf({
      tenantId: "test-tenant",
      principalId: "principal-42",
      endpoint: { channelType: "echo", conversationKind: "direct" },
      dmScopeMode: "per-channel-peer",
    });
    const key = conversationScopeToSessionKey(scope);
    expect(key.ok).toBe(true);
    if (!key.ok) throw new Error(key.error.message);
    expect(key.value.tenantId).toBe("test-tenant");
    expect(key.value.agentId).toBe("agent-a");
    // per-channel-peer keys DMs by channel type + resolved principal.
    expect(key.value.channelId).toBe("echo");
    expect(key.value.userId).toBe("principal-42");
    expect(typeof key.value.channelId).toBe("string");
    expect(typeof key.value.userId).toBe("string");
  });

  it("main DM scope collapses every peer into one agent session", () => {
    const alice = scopeOf({ principalId: "alice", dmScopeMode: "main" });
    const bob = scopeOf({ principalId: "bob", dmScopeMode: "main" });
    // Distinct peers share the single main session under 'main'.
    expect(refOf(alice)).toBe(refOf(bob));
    const key = conversationScopeToSessionKey(alice);
    expect(key.ok && key.value.userId).toBe("main");
    expect(key.ok && key.value.channelId).toBe("dm");
  });

  it("per-peer DM scope isolates distinct principals but spans channels", () => {
    const aliceTelegram = scopeOf({ principalId: "alice", endpoint: { channelType: "telegram" }, dmScopeMode: "per-peer" });
    const bobTelegram = scopeOf({ principalId: "bob", endpoint: { channelType: "telegram" }, dmScopeMode: "per-peer" });
    const aliceSlack = scopeOf({ principalId: "alice", endpoint: { channelType: "slack" }, dmScopeMode: "per-peer" });
    // Different principals -> different sessions (cross-user isolation).
    expect(refOf(aliceTelegram)).not.toBe(refOf(bobTelegram));
    // Same principal across channels -> one session (per-peer is channel-agnostic).
    expect(refOf(aliceTelegram)).toBe(refOf(aliceSlack));
  });

  it("per-channel-peer DM scope isolates the same principal across channels", () => {
    const telegram = scopeOf({ principalId: "alice", endpoint: { channelType: "telegram" }, dmScopeMode: "per-channel-peer" });
    const slack = scopeOf({ principalId: "alice", endpoint: { channelType: "slack" }, dmScopeMode: "per-channel-peer" });
    expect(refOf(telegram)).not.toBe(refOf(slack));
  });

  it("thread isolation splits a shared conversation by threadId", () => {
    const base = { conversationId: "channel-general", conversationKind: "shared" as const };
    const noThread = scopeOf({ endpoint: base });
    const threadA = scopeOf({ endpoint: { ...base, threadId: "thread-A" } });
    const threadAAgain = scopeOf({ endpoint: { ...base, threadId: "thread-A" } });
    const threadB = scopeOf({ endpoint: { ...base, threadId: "thread-B" } });
    // Different threads -> isolated sessions.
    expect(refOf(threadA)).not.toBe(refOf(threadB));
    // A threaded turn is isolated from the un-threaded conversation root.
    expect(refOf(threadA)).not.toBe(refOf(noThread));
    // Same thread -> same session (deterministic).
    expect(refOf(threadA)).toBe(refOf(threadAAgain));
    // The threadId rides through onto the projected session key.
    const key = conversationScopeToSessionKey(threadA);
    expect(key.ok && key.value.threadId).toBe("thread-A");
  });

  it("thread isolation splits a per-account-channel-peer DM by threadId", () => {
    const base = { conversationId: "dm-1", conversationKind: "direct" as const };
    const threadA = scopeOf({ endpoint: { ...base, threadId: "t-A" }, dmScopeMode: "per-account-channel-peer" });
    const threadB = scopeOf({ endpoint: { ...base, threadId: "t-B" }, dmScopeMode: "per-account-channel-peer" });
    expect(refOf(threadA)).not.toBe(refOf(threadB));
    const key = conversationScopeToSessionKey(threadA);
    expect(key.ok && key.value.threadId).toBe("t-A");
  });

  it("a direct message and a shared conversation on the same id are isolated", () => {
    const direct = scopeOf({ endpoint: { conversationId: "room-9", conversationKind: "direct" }, dmScopeMode: "per-channel-peer" });
    const shared = scopeOf({ endpoint: { conversationId: "room-9", conversationKind: "shared" } });
    expect(refOf(direct)).not.toBe(refOf(shared));
  });

  it("identical turns in different tenants never share a session", () => {
    const shared = { conversationId: "channel-general", conversationKind: "shared" as const };
    const tenantA = scopeOf({ tenantId: "tenant-a", endpoint: shared });
    const tenantB = scopeOf({ tenantId: "tenant-b", endpoint: shared });
    expect(refOf(tenantA)).not.toBe(refOf(tenantB));
  });

  it("rejects routing when explicit tenant authority is empty", () => {
    // Tenant defaulting no longer lives in the scope builder — the routing
    // policy requires an explicit non-empty tenant so an unset tenant can never
    // silently collapse cross-tenant traffic into one scope.
    const rejected = resolveRoutingPolicy({
      tenantId: "",
      agentId: "agent-a",
      endpoint: endpoint(),
      principal: { principalId: "principal-1" },
      dmScopeMode: "per-channel-peer",
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.errorKind).toBe("validation");
  });

  it("tenant and DM-scope defaults are now supplied by config parsing", () => {
    // The old builder's defaults (tenant 'default', 'per-channel-peer' DM
    // scope, thread isolation on) migrated to the config layer.
    expect(AppConfigSchema.parse({}).tenantId).toBe("default");
    expect(DmScopeConfigSchema.parse({})).toEqual({
      mode: "per-channel-peer",
      threadIsolation: true,
    });
  });
});
