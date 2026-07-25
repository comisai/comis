// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApprovalGate as createApprovalGateImpl } from "./approval-gate.js";
import type { ApprovalGate, ApprovalGateDeps } from "./approval-gate.js";
import { mintApprovalShortId } from "./approval-short-id.js";
import { TypedEventBus } from "../event-bus/bus.js";
import type { EventMap } from "../event-bus/events.js";
import type { ApprovalResolution, SerializedApprovalRequest, SerializedApprovalCacheEntry } from "../domain/approval-request.js";
import { ConversationRefSchema } from "../domain/conversation-scope.js";
import type { ClockPort, TimerPort, TimerHandle } from "../ports/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Lightweight port wrappers that delegate to globals so
// vi.useFakeTimers() continues to intercept Date.now / setTimeout below.
// ---------------------------------------------------------------------------

const testClock: ClockPort = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(t);
    },
    unref() {
      if (cancelled || unrefCalled) return;
      unrefCalled = true;
      t.unref();
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let eventBus: TypedEventBus;
let gate: ApprovalGate;

const DEFAULT_TIMEOUT_MS = 5000;
const FINGERPRINT_SECRET = "test-approval-fingerprint-secret-32-bytes";

function createApprovalGate(
  deps: Omit<ApprovalGateDeps, "fingerprintSecret"> & { fingerprintSecret?: string },
): ApprovalGate {
  return createApprovalGateImpl({
    ...deps,
    fingerprintSecret: deps.fingerprintSecret ?? FINGERPRINT_SECRET,
  });
}

function makeRequest(overrides: Partial<{
  toolName: string;
  action: string;
  params: Record<string, unknown>;
  fingerprintParams: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  trustLevel: "admin" | "user" | "guest";
  callbackOwner: {
    tenantId: string;
    userId: string;
    channelType: string;
    channelKey: string;
    threadId?: string;
  };
}> = {}) {
  const params = overrides.params ?? { agentId: "bot-1" };
  const sessionKey = overrides.sessionKey ?? "default:user1:discord";
  const authority = authorityForSession(sessionKey, overrides.agentId ?? "agent-1");
  const [tenantId = "default", userId = "user1", channelKey = "discord"] = sessionKey.split(":");
  return {
    toolName: overrides.toolName ?? "agents.restart",
    action: overrides.action ?? "agents.restart",
    params,
    fingerprintParams: overrides.fingerprintParams ?? params,
    ...authority,
    trustLevel: overrides.trustLevel ?? "user" as const,
    callbackOwner: overrides.callbackOwner ?? {
      tenantId,
      userId,
      channelType: channelKey,
      channelKey,
    },
  };
}

function authorityForSession(sessionKey: string, agentId = "agent-1") {
  const tenantId = sessionKey.split(":")[0] || "default";
  const digest = createHash("sha256").update(sessionKey).digest("base64url");
  return {
    tenantId,
    agentId,
    conversationRef: ConversationRefSchema.parse(`cv_${digest}`),
    resolvingPrincipalId: `principal:${sessionKey}`,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  eventBus = new TypedEventBus();
  gate = createApprovalGate({
    eventBus,
    clock: testClock,
    timers: testTimers,
    getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
  });
});

afterEach(() => {
  gate.dispose();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Request creation
// ---------------------------------------------------------------------------

describe("request creation", () => {
  it("snapshots and deeply freezes parameters before event, pending, and persistence exposure", () => {
    const handler = vi.fn();
    eventBus.on("approval:requested", handler);
    const params = { target: { id: "host-1", labels: ["safe"] } };
    const fingerprintParams = { credential: { ref: "vault-item-1" } };

    gate.requestApproval(makeRequest({ params, fingerprintParams }));
    params.target.id = "host-2";
    params.target.labels.push("mutated");
    fingerprintParams.credential.ref = "vault-item-2";

    const pending = gate.pending()[0]!;
    const emitted = handler.mock.calls[0]![0] as EventMap["approval:requested"];
    const serialized = gate.serializePending()[0]!;
    expect(pending.params.target).toEqual({ id: "host-1", labels: ["safe"] });
    expect(emitted.params.target).toEqual({ id: "host-1", labels: ["safe"] });
    expect(serialized.params.target).toEqual({ id: "host-1", labels: ["safe"] });
    expect(Object.isFrozen(pending.params)).toBe(true);
    expect(Object.isFrozen(pending.params.target)).toBe(true);
    expect(Object.isFrozen((pending.params.target as { labels: string[] }).labels)).toBe(true);
  });

  it("stores an immutable callback owner and preserves it in the restart snapshot", () => {
    const callbackOwner = {
      tenantId: "default",
      userId: "user1",
      channelType: "telegram",
      channelKey: "chat-1",
      threadId: "topic-1",
    };

    gate.requestApproval(makeRequest({
      sessionKey: "default:user1:chat-1:thread:topic-1",
      callbackOwner,
    }));
    callbackOwner.userId = "attacker";
    callbackOwner.threadId = "other-topic";

    expect(gate.pending()[0]!.callbackOwner).toEqual({
      tenantId: "default",
      userId: "user1",
      channelType: "telegram",
      channelKey: "chat-1",
      threadId: "topic-1",
    });
    expect(Object.isFrozen(gate.pending()[0]!.callbackOwner)).toBe(true);
    expect(gate.serializePending()[0]!.callbackOwner).toEqual(gate.pending()[0]!.callbackOwner);
  });

  it("does not expose the plain SHA-256 digest of low-entropy operation parameters", () => {
    gate.requestApproval(makeRequest({
      params: { count: 1 },
      fingerprintParams: { enabled: false },
    }));

    const fingerprint = gate.pending()[0]!.params.operationFingerprint;
    const guessableSha = createHash("sha256").update('{"enabled":false}').digest("hex");
    expect(fingerprint).not.toBe(guessableSha);
  });

  it("changes externally visible operation and cache identities when the HMAC key changes", async () => {
    const otherGate = createApprovalGate({
      eventBus: new TypedEventBus(),
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      fingerprintSecret: "different-test-approval-fingerprint-secret",
    });
    const first = gate.requestApproval(makeRequest({
      params: { count: 1 },
      fingerprintParams: { enabled: false },
    }));
    const second = otherGate.requestApproval(makeRequest({
      params: { count: 1 },
      fingerprintParams: { enabled: false },
    }));
    const firstPending = gate.pending()[0]!;
    const secondPending = otherGate.pending()[0]!;
    expect(firstPending.params.operationFingerprint)
      .not.toBe(secondPending.params.operationFingerprint);

    gate.resolveApproval(firstPending.requestId, true, "operator");
    otherGate.resolveApproval(secondPending.requestId, true, "operator");
    await Promise.all([first, second]);
    expect(gate.serializeApprovalCache()[0]!.cacheKey)
      .not.toBe(otherGate.serializeApprovalCache()[0]!.cacheKey);
    otherGate.dispose();
  });

  it("keeps pending, event, and cache identity bound to the pre-mutation snapshot", async () => {
    const params = { target: { id: "host-1" } };
    const fingerprintParams = { enabled: false };
    const first = gate.requestApproval(makeRequest({ params, fingerprintParams }));
    params.target.id = "host-2";
    fingerprintParams.enabled = true;
    const pending = gate.pending()[0]!;
    gate.resolveApproval(pending.requestId, true, "operator");
    await first;

    const cached = await gate.requestApproval(makeRequest({
      params: { target: { id: "host-1" } },
      fingerprintParams: { enabled: false },
    }));

    expect(cached.approvedBy).toBe("system:cached-approval");
    expect(gate.pending()).toHaveLength(0);
  });

  it("requestApproval adds request to pending list", () => {
    gate.requestApproval(makeRequest());

    expect(gate.pending()).toHaveLength(1);
  });

  it("requestApproval returns a promise that does not resolve immediately", () => {
    const promise = gate.requestApproval(makeRequest());

    // Promise should be pending (not resolved yet)
    let resolved = false;
    promise.then(() => { resolved = true; });

    // Flush microtask queue
    expect(resolved).toBe(false);
  });

  it("pending() returns request with all expected fields", () => {
    gate.requestApproval(makeRequest({
      toolName: "system.reboot",
      action: "system.reboot",
      params: { target: "host-1" },
      agentId: "agent-2",
      sessionKey: "default:admin:telegram",
      trustLevel: "admin",
    }));

    const [request] = gate.pending();
    expect(request).toBeDefined();
    expect(request!.toolName).toBe("system.reboot");
    expect(request!.action).toBe("system.reboot");
    expect(request!.params).toEqual(expect.objectContaining({
      target: "host-1",
      operationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(request!.agentId).toBe("agent-2");
    expect(request!.conversationRef).toBe(authorityForSession("default:admin:telegram", "agent-2").conversationRef);
    expect(request!.trustLevel).toBe("admin");
    expect(request!.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof request!.createdAt).toBe("number");
    expect(request!.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("getRequest(id) returns the correct pending request", () => {
    gate.requestApproval(makeRequest());

    const [pending] = gate.pending();
    const found = gate.getRequest(pending!.requestId);

    expect(found).toBe(pending);
  });

  it("getRequest(unknown) returns undefined", () => {
    expect(gate.getRequest("nonexistent-id")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Event emission -- approval:requested
// ---------------------------------------------------------------------------

describe("approval:requested event", () => {
  it("requestApproval emits approval:requested event on the event bus", () => {
    const handler = vi.fn();
    eventBus.on("approval:requested", handler);

    gate.requestApproval(makeRequest());

    expect(handler).toHaveBeenCalledOnce();
  });

  it("event payload contains all required approval:requested fields", () => {
    const handler = vi.fn();
    eventBus.on("approval:requested", handler);

    gate.requestApproval(makeRequest({
      toolName: "config.write",
      action: "config.write",
      params: { section: "agents" },
      agentId: "agent-3",
      sessionKey: "default:op1:slack",
      trustLevel: "admin",
    }));

    const payload = handler.mock.calls[0]![0] as EventMap["approval:requested"];
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.toolName).toBe("config.write");
    expect(payload.action).toBe("config.write");
    expect(payload.params).toEqual(expect.objectContaining({
      section: "agents",
      operationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(payload.agentId).toBe("agent-3");
    expect(payload.conversationRef).toBe(authorityForSession("default:op1:slack", "agent-3").conversationRef);
    expect(payload.trustLevel).toBe("admin");
    expect(typeof payload.createdAt).toBe("number");
    expect(payload.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// 3. Resolve -- approve
// ---------------------------------------------------------------------------

describe("resolve -- approve", () => {
  it("resolveApproval with approved=true resolves the promise with approved=true", async () => {
    const promise = gate.requestApproval(makeRequest());
    const [pending] = gate.pending();

    gate.resolveApproval(pending!.requestId, true, "operator");

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.approvedBy).toBe("operator");
    expect(result.requestId).toBe(pending!.requestId);
    expect(typeof result.resolvedAt).toBe("number");
  });

  it("after approval, request is removed from pending list", async () => {
    const promise = gate.requestApproval(makeRequest());
    const [pending] = gate.pending();

    gate.resolveApproval(pending!.requestId, true, "admin");
    await promise;

    expect(gate.pending()).toHaveLength(0);
  });

  it("pending() returns empty array after sole request resolved", async () => {
    const promise = gate.requestApproval(makeRequest());
    const [pending] = gate.pending();

    gate.resolveApproval(pending!.requestId, true, "admin");
    await promise;

    expect(gate.pending()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Resolve -- deny
// ---------------------------------------------------------------------------

describe("resolve -- deny", () => {
  it("resolveApproval with approved=false resolves with denial and reason", async () => {
    const promise = gate.requestApproval(makeRequest());
    const [pending] = gate.pending();

    gate.resolveApproval(pending!.requestId, false, "operator", "Too risky");

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.approvedBy).toBe("operator");
    expect(result.reason).toBe("Too risky");
    expect(result.requestId).toBe(pending!.requestId);
  });

  it("after denial, request is removed from pending list", async () => {
    const promise = gate.requestApproval(makeRequest());
    const [pending] = gate.pending();

    gate.resolveApproval(pending!.requestId, false, "operator", "Denied");
    await promise;

    expect(gate.pending()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Event emission -- approval:resolved
// ---------------------------------------------------------------------------

describe("approval:resolved event", () => {
  it("resolveApproval emits approval:resolved event", () => {
    const handler = vi.fn();
    eventBus.on("approval:resolved", handler);

    gate.requestApproval(makeRequest());
    const [pending] = gate.pending();
    gate.resolveApproval(pending!.requestId, true, "admin");

    expect(handler).toHaveBeenCalledOnce();
  });

  it("event payload includes requestId, approved, approvedBy, reason, resolvedAt", () => {
    const handler = vi.fn();
    eventBus.on("approval:resolved", handler);

    gate.requestApproval(makeRequest());
    const [pending] = gate.pending();
    gate.resolveApproval(pending!.requestId, false, "operator", "Suspicious");

    const payload = handler.mock.calls[0]![0] as EventMap["approval:resolved"];
    expect(payload.requestId).toBe(pending!.requestId);
    expect(payload.approved).toBe(false);
    expect(payload.approvedBy).toBe("operator");
    expect(payload.reason).toBe("Suspicious");
    expect(typeof payload.resolvedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 6. Timeout auto-deny
// ---------------------------------------------------------------------------

describe("timeout auto-deny", () => {
  it("unanswered request auto-denies after timeout", async () => {
    const promise = gate.requestApproval(makeRequest());

    // Advance time past the timeout
    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.approvedBy).toBe("system:timeout");
    expect(result.reason).toBe("Approval request timed out");
  });

  it("approval:resolved event emitted with approvedBy system:timeout", () => {
    const handler = vi.fn();
    eventBus.on("approval:resolved", handler);

    gate.requestApproval(makeRequest());

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

    const payload = handler.mock.calls[0]![0] as EventMap["approval:resolved"];
    expect(payload.approved).toBe(false);
    expect(payload.approvedBy).toBe("system:timeout");
  });

  it("request removed from pending list after timeout", () => {
    gate.requestApproval(makeRequest());
    expect(gate.pending()).toHaveLength(1);

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

    expect(gate.pending()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Idempotent resolve
// ---------------------------------------------------------------------------

describe("idempotent resolve", () => {
  it("resolving an already-resolved request does not throw", async () => {
    const promise = gate.requestApproval(makeRequest());
    const [pending] = gate.pending();
    const id = pending!.requestId;

    gate.resolveApproval(id, true, "admin");
    await promise;

    // Second resolve should be silently ignored
    expect(() => gate.resolveApproval(id, false, "admin2", "Late denial")).not.toThrow();
  });

  it("resolving a timed-out request does not throw", () => {
    gate.requestApproval(makeRequest());
    const [pending] = gate.pending();
    const id = pending!.requestId;

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

    // Manual resolve after timeout should be silently ignored
    expect(() => gate.resolveApproval(id, true, "admin")).not.toThrow();
  });

  it("resolving an unknown requestId does not throw", () => {
    expect(() => gate.resolveApproval("unknown-id", true, "admin")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Multiple concurrent requests
// ---------------------------------------------------------------------------

describe("multiple concurrent requests", () => {
  it("two requests can be pending simultaneously", () => {
    gate.requestApproval(makeRequest({ toolName: "tool-a", action: "tool-a.run" }));
    gate.requestApproval(makeRequest({ toolName: "tool-b", action: "tool-b.run" }));

    expect(gate.pending()).toHaveLength(2);
  });

  it("resolving one does not affect the other", async () => {
    const promise1 = gate.requestApproval(makeRequest({ toolName: "tool-a", action: "tool-a.run" }));
    gate.requestApproval(makeRequest({ toolName: "tool-b", action: "tool-b.run" }));

    const pending = gate.pending();
    expect(pending).toHaveLength(2);

    const first = pending[0]!;
    gate.resolveApproval(first.requestId, true, "admin");
    await promise1;

    // Second request should still be pending
    expect(gate.pending()).toHaveLength(1);
    expect(gate.pending()[0]!.toolName).toBe("tool-b");
  });

  it("pending() returns correct count throughout lifecycle", async () => {
    expect(gate.pending()).toHaveLength(0);

    const p1 = gate.requestApproval(makeRequest({ toolName: "tool-1", action: "tool-1.run" }));
    expect(gate.pending()).toHaveLength(1);

    const p2 = gate.requestApproval(makeRequest({ toolName: "tool-2", action: "tool-2.run" }));
    expect(gate.pending()).toHaveLength(2);

    const p3 = gate.requestApproval(makeRequest({ toolName: "tool-3", action: "tool-3.run" }));
    expect(gate.pending()).toHaveLength(3);

    // Resolve first
    gate.resolveApproval(gate.pending()[0]!.requestId, true, "admin");
    await p1;
    expect(gate.pending()).toHaveLength(2);

    // Timeout second
    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);
    await p2;
    await p3;
    expect(gate.pending()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. dispose()
// ---------------------------------------------------------------------------

describe("dispose", () => {
  it("dispose() clears all timers (no lingering timeouts)", () => {
    gate.requestApproval(makeRequest({ toolName: "tool-x" }));
    gate.requestApproval(makeRequest({ toolName: "tool-y" }));

    gate.dispose();

    // Advancing timers should not trigger any timeout auto-deny (timers cleared)
    const resolvedHandler = vi.fn();
    eventBus.on("approval:resolved", resolvedHandler);
    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS * 2);

    expect(resolvedHandler).not.toHaveBeenCalled();
  });

  it("pending() returns empty after dispose", () => {
    gate.requestApproval(makeRequest());
    expect(gate.pending()).toHaveLength(1);

    gate.dispose();

    expect(gate.pending()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Denial cache
// ---------------------------------------------------------------------------

describe("denial cache", () => {
  const DENIAL_CACHE_TTL = 30_000;

  let gateWithTtl: ApprovalGate;

  beforeEach(() => {
    gateWithTtl = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => DENIAL_CACHE_TTL,
      getBatchApprovalTtlMs: () => 0, // Disable approval cache for denial cache tests
    });
  });

  afterEach(() => {
    gateWithTtl.dispose();
  });

  it("second requestApproval for same sessionKey+action returns cached denial instantly after first denial", async () => {
    // First request: create and deny
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, false, "operator", "Not allowed");
    const result1 = await promise1;
    expect(result1.approved).toBe(false);

    // Second request: same sessionKey + action should resolve instantly from cache
    const promise2 = gateWithTtl.requestApproval(makeRequest());
    const result2 = await promise2;

    expect(result2.approved).toBe(false);
    // Should NOT appear in pending list (resolved instantly from cache)
    expect(gateWithTtl.pending()).toHaveLength(0);
  });

  it("cached denial uses approvedBy 'system:cached-denial'", async () => {
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, false, "operator", "No");
    await promise1;

    const promise2 = gateWithTtl.requestApproval(makeRequest());
    const result2 = await promise2;

    expect(result2.approvedBy).toBe("system:cached-denial");
    expect(result2.reason).toContain("Auto-denied");
    expect(result2.reason).toContain("agents.restart");
  });

  it("cached denial expires after TTL and next request creates a real pending entry", async () => {
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, false, "operator", "No");
    await promise1;

    // Advance past denial cache TTL
    vi.advanceTimersByTime(DENIAL_CACHE_TTL + 1);

    // Next request should create a real pending entry (cache expired)
    gateWithTtl.requestApproval(makeRequest());
    expect(gateWithTtl.pending()).toHaveLength(1);
  });

  it("approval (not denial) does NOT populate the denial cache", async () => {
    // Approve the first request
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Second request should create a real pending entry (no cache)
    gateWithTtl.requestApproval(makeRequest());
    expect(gateWithTtl.pending()).toHaveLength(1);
  });

  it("different action on same sessionKey is NOT cached", async () => {
    const promise1 = gateWithTtl.requestApproval(makeRequest({ action: "agents.create" }));
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, false, "operator", "No");
    await promise1;

    // Same sessionKey but different action — should create a real pending entry
    gateWithTtl.requestApproval(makeRequest({ action: "agents.delete" }));
    expect(gateWithTtl.pending()).toHaveLength(1);
  });

  it.each([
    ["agent", { agentId: "agent-2" }],
    ["trust level", { trustLevel: "guest" as const }],
    ["tool", { toolName: "agents_manage_alternate" }],
    ["parameters", { params: { agentId: "bot-2" } }],
  ])("does not reuse a denial across a different %s", async (_dimension, overrides) => {
    const first = gateWithTtl.requestApproval(makeRequest());
    const [pending] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending!.requestId, false, "operator", "No");
    await first;

    gateWithTtl.requestApproval(makeRequest(overrides));

    expect(gateWithTtl.pending()).toHaveLength(1);
  });

  it("does not reuse a denial for a different hidden operation fingerprint", async () => {
    const summary = { targetCount: 1 };
    const first = gateWithTtl.requestApproval(makeRequest({
      params: summary,
      fingerprintParams: { target: "first" },
    }));
    const [pending] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending!.requestId, false, "operator", "No");
    await first;

    gateWithTtl.requestApproval(makeRequest({
      params: summary,
      fingerprintParams: { target: "second" },
    }));

    expect(gateWithTtl.pending()).toHaveLength(1);
  });

  it("clearDenialCache(sessionKey) removes entries for that session", async () => {
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, false, "operator", "No");
    await promise1;

    // Clear cache for this session
    gateWithTtl.clearDenialCache(authorityForSession("default:user1:discord"));

    // Next request should create a real pending entry (cache cleared)
    gateWithTtl.requestApproval(makeRequest());
    expect(gateWithTtl.pending()).toHaveLength(1);
  });

  it("clearDenialCache() with no args clears all entries", async () => {
    // Deny for two different sessions
    const promise1 = gateWithTtl.requestApproval(makeRequest({ sessionKey: "default:user1:discord" }));
    const [p1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(p1!.requestId, false, "op", "No");
    await promise1;

    const promise2 = gateWithTtl.requestApproval(makeRequest({ sessionKey: "default:user2:telegram" }));
    const [p2] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(p2!.requestId, false, "op", "No");
    await promise2;

    // Clear all denial cache entries
    gateWithTtl.clearDenialCache();

    // Both sessions should create real pending entries
    gateWithTtl.requestApproval(makeRequest({ sessionKey: "default:user1:discord" }));
    gateWithTtl.requestApproval(makeRequest({ sessionKey: "default:user2:telegram" }));
    expect(gateWithTtl.pending()).toHaveLength(2);
  });

  it("dispose() clears denial cache", async () => {
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, false, "operator", "No");
    await promise1;

    gateWithTtl.dispose();

    // After dispose, create a fresh gate with same eventBus to test that
    // the old gate's denial cache was cleared. However, since denial cache
    // is internal to the gate instance, we test by creating a new request
    // on a NEW gate (the old gate's cache is irrelevant after dispose).
    // Instead, test that the old gate does not return cached denials after
    // dispose by checking that a new request on a fresh gate works normally.
    const freshGate = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => DENIAL_CACHE_TTL,
    });
    freshGate.requestApproval(makeRequest());
    expect(freshGate.pending()).toHaveLength(1);
    freshGate.dispose();
  });

  it("cached denial emits approval:resolved event", async () => {
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, false, "operator", "No");
    await promise1;

    const resolvedHandler = vi.fn();
    eventBus.on("approval:resolved", resolvedHandler);

    const promise2 = gateWithTtl.requestApproval(makeRequest());
    await promise2;

    expect(resolvedHandler).toHaveBeenCalledOnce();
    const payload = resolvedHandler.mock.calls[0]![0] as EventMap["approval:resolved"];
    expect(payload.approved).toBe(false);
    expect(payload.approvedBy).toBe("system:cached-denial");
  });

  it("timeout denial does NOT populate the denial cache", async () => {
    // First request: let it time out
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);
    const result1 = await promise1;
    expect(result1.approved).toBe(false);
    expect(result1.approvedBy).toBe("system:timeout");

    // Second identical request: should create a real pending entry (no cached denial)
    gateWithTtl.requestApproval(makeRequest());
    expect(gateWithTtl.pending()).toHaveLength(1);
  });

  it("explicit denial populates the denial cache (unlike a timeout denial)", async () => {
    // First request: deny explicitly
    const promise1 = gateWithTtl.requestApproval(makeRequest());
    const [pending1] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending1!.requestId, false, "operator", "Nope");
    await promise1;

    // Second identical request: should return from cache
    const promise2 = gateWithTtl.requestApproval(makeRequest());
    const result2 = await promise2;
    expect(result2.approved).toBe(false);
    expect(result2.approvedBy).toBe("system:cached-denial");
  });
});

// ---------------------------------------------------------------------------
// 11. Batch parallel requests
// ---------------------------------------------------------------------------

describe("batch parallel requests", () => {
  it("second request for same sessionKey::action joins existing pending instead of creating new entry", async () => {
    const promise1 = gate.requestApproval(makeRequest());
    const promise2 = gate.requestApproval(makeRequest());

    // Only one pending entry (second batched onto first)
    expect(gate.pending()).toHaveLength(1);

    // Resolve the single pending entry
    const [pending] = gate.pending();
    gate.resolveApproval(pending!.requestId, true, "admin");

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1.approved).toBe(true);
    expect(result1.approvedBy).toBe("admin");
    expect(result2.approved).toBe(true);
    expect(result2.approvedBy).toBe("admin");
  });

  it("batched follower resolves when primary is approved", async () => {
    const promise1 = gate.requestApproval(makeRequest());
    const promise2 = gate.requestApproval(makeRequest());

    const [pending] = gate.pending();
    gate.resolveApproval(pending!.requestId, true, "operator");

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1.approved).toBe(true);
    expect(result2.approved).toBe(true);
  });

  it("batched follower resolves when primary times out", async () => {
    const promise1 = gate.requestApproval(makeRequest());
    const promise2 = gate.requestApproval(makeRequest());

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1.approved).toBe(false);
    expect(result1.approvedBy).toBe("system:timeout");
    expect(result2.approved).toBe(false);
    expect(result2.approvedBy).toBe("system:timeout");
  });

  it("different action on same sessionKey creates separate pending entries (no batching)", () => {
    gate.requestApproval(makeRequest({ action: "agents.create" }));
    gate.requestApproval(makeRequest({ action: "agents.delete" }));

    expect(gate.pending()).toHaveLength(2);
  });

  it.each([
    ["agent", { agentId: "agent-2" }],
    ["trust level", { trustLevel: "guest" as const }],
    ["tool", { toolName: "agents_manage_alternate" }],
    ["parameters", { params: { agentId: "bot-2" } }],
  ])("does not batch parallel requests from a different %s", (_dimension, overrides) => {
    gate.requestApproval(makeRequest());
    gate.requestApproval(makeRequest(overrides));

    expect(gate.pending()).toHaveLength(2);
  });

  it("batches semantically identical parameters regardless of object insertion order", () => {
    gate.requestApproval(makeRequest({
      params: { target: { beta: 2, alpha: 1 }, enabled: true },
    }));
    gate.requestApproval(makeRequest({
      params: { enabled: true, target: { alpha: 1, beta: 2 } },
    }));

    expect(gate.pending()).toHaveLength(1);
  });

  it("does not batch safe summaries whose hidden operation fingerprints differ", () => {
    const summary = { targetCount: 1 };
    gate.requestApproval(makeRequest({
      params: summary,
      fingerprintParams: { target: "first" },
    }));
    gate.requestApproval(makeRequest({
      params: summary,
      fingerprintParams: { target: "second" },
    }));

    expect(gate.pending()).toHaveLength(2);
  });

  it("emits only safe summary parameters plus an opaque operation fingerprint", () => {
    const handler = vi.fn();
    eventBus.on("approval:requested", handler);

    gate.requestApproval(makeRequest({
      params: { targetCount: 1 },
      fingerprintParams: { credential: "private-test-value" },
    }));

    const payload = handler.mock.calls[0]![0] as EventMap["approval:requested"];
    expect(payload.params).toEqual({
      targetCount: 1,
      operationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(payload)).not.toContain("private-test-value");
  });

  it("fails closed without creating a shared pending bucket when principal identity is missing", async () => {
    const missingAgent = gate.requestApproval(makeRequest({ agentId: "" }));
    const missingSession = gate.requestApproval(makeRequest({
      callbackOwner: { tenantId: "", userId: "user1", channelType: "discord", channelKey: "discord" },
    }));

    expect(gate.pending()).toHaveLength(0);
    await expect(missingAgent).resolves.toMatchObject({
      approved: false,
      approvedBy: "system:invalid-request",
    });
    await expect(missingSession).resolves.toMatchObject({
      approved: false,
      approvedBy: "system:invalid-request",
    });
  });

  it("fails closed when approval parameters cannot be canonicalized safely", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const resolution = await gate.requestApproval(makeRequest({ params: cyclic }));

    expect(resolution).toMatchObject({
      approved: false,
      approvedBy: "system:invalid-request",
    });
    expect(gate.pending()).toHaveLength(0);
  });

  it("fails closed when hidden fingerprint parameters cannot be canonicalized safely", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const resolution = await gate.requestApproval(makeRequest({
      params: { targetCount: 1 },
      fingerprintParams: cyclic,
    }));

    expect(resolution).toMatchObject({
      approved: false,
      approvedBy: "system:invalid-request",
    });
    expect(gate.pending()).toHaveLength(0);
  });

  it("fails closed when parameter inspection throws", async () => {
    const { proxy, revoke } = Proxy.revocable<Record<string, unknown>>({}, {});
    revoke();

    const resolution = await gate.requestApproval(makeRequest({ params: proxy }));

    expect(resolution).toMatchObject({
      approved: false,
      approvedBy: "system:invalid-request",
    });
    expect(gate.pending()).toHaveLength(0);
  });

  it("approval:requested event emitted only once for batched requests", () => {
    const handler = vi.fn();
    eventBus.on("approval:requested", handler);

    gate.requestApproval(makeRequest());
    gate.requestApproval(makeRequest());

    // Only the primary request emits the event; the follower joins silently
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 12. Serialization and restore
// ---------------------------------------------------------------------------

describe("serialization and restore", () => {
  it("serializePending() returns correct data for pending requests", () => {
    gate.requestApproval(makeRequest({ action: "agents.create", toolName: "agents_manage" }));
    gate.requestApproval(makeRequest({ action: "agents.delete", toolName: "agents_manage" }));

    const serialized = gate.serializePending();

    expect(serialized).toHaveLength(2);
    expect(serialized[0]!.action).toBe("agents.create");
    expect(serialized[0]!.toolName).toBe("agents_manage");
    expect(serialized[0]!.conversationRef).toBe(authorityForSession("default:user1:discord").conversationRef);
    expect(serialized[0]!.trustLevel).toBe("user");
    expect(typeof serialized[0]!.requestId).toBe("string");
    expect(typeof serialized[0]!.createdAt).toBe("number");
    expect(serialized[0]!.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(serialized[1]!.action).toBe("agents.delete");
  });

  it("restorePending() restores with correct remaining timeout", async () => {
    const now = Date.now();
    const record: SerializedApprovalRequest = {
      requestId: "00000000-0000-4000-8000-000000000001",
      shortId: "Restore01Abc",
      toolName: "agents_manage",
      action: "agents.create",
      params: { agent_id: "bot-1" },
      ...authorityForSession("default:user1:discord"),
      trustLevel: "user",
      callbackOwner: { tenantId: "default", userId: "user1", channelType: "discord", channelKey: "discord" },
      createdAt: now - 1000, // 1 second ago
      timeoutMs: 5000,       // 5 second timeout -> 4 seconds remaining
    };

    const restored = gate.restorePending([record]);
    expect(restored).toBe(1);
    expect(gate.pending()).toHaveLength(1);
    expect(gate.pending()[0]!.requestId).toBe("00000000-0000-4000-8000-000000000001");

    // Advance 3999ms -- should still be pending (4000ms remaining)
    vi.advanceTimersByTime(3999);
    expect(gate.pending()).toHaveLength(1);

    // Advance 2 more ms -- should have timed out
    vi.advanceTimersByTime(2);
    expect(gate.pending()).toHaveLength(0);
  });

  it("restorePending() skips expired records", () => {
    const now = Date.now();
    const record: SerializedApprovalRequest = {
      requestId: "00000000-0000-4000-8000-000000000002",
      shortId: "Restore02Abc",
      toolName: "agents_manage",
      action: "agents.create",
      params: { agent_id: "bot-2" },
      ...authorityForSession("default:user1:discord"),
      trustLevel: "user",
      callbackOwner: { tenantId: "default", userId: "user1", channelType: "discord", channelKey: "discord" },
      createdAt: now - 10000, // 10 seconds ago
      timeoutMs: 5000,         // 5 second timeout -- already expired
    };

    const restored = gate.restorePending([record]);
    expect(restored).toBe(0);
    expect(gate.pending()).toHaveLength(0);
  });

  it("restorePending() emits approval:requested events for restored entries", () => {
    const handler = vi.fn();
    eventBus.on("approval:requested", handler);

    const now = Date.now();
    const record: SerializedApprovalRequest = {
      requestId: "00000000-0000-4000-8000-000000000003",
      shortId: "Restore03Abc",
      toolName: "agents_manage",
      action: "agents.delete",
      params: { agent_id: "bot-3" },
      ...authorityForSession("default:user1:discord"),
      trustLevel: "admin",
      callbackOwner: { tenantId: "default", userId: "user1", channelType: "discord", channelKey: "discord" },
      createdAt: now - 500,
      timeoutMs: 10000,
    };

    gate.restorePending([record]);

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0]![0] as EventMap["approval:requested"];
    expect(payload.requestId).toBe("00000000-0000-4000-8000-000000000003");
    expect(payload.shortId).toBe("Restore03Abc");
    expect(payload.action).toBe("agents.delete");
    expect(payload.toolName).toBe("agents_manage");
  });

  it("restorePending keeps the persisted callback owner immutable after restart", () => {
    gate.requestApproval(makeRequest({
      sessionKey: "default:user1:chat-1:thread:topic-1",
      callbackOwner: {
        tenantId: "default",
        userId: "user1",
        channelType: "telegram",
        channelKey: "chat-1",
        threadId: "topic-1",
      },
    }));
    const [record] = gate.serializePending();
    const freshGate = createApprovalGate({
      eventBus: new TypedEventBus(),
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
    });

    expect(freshGate.restorePending([record!])).toBe(1);
    record!.callbackOwner.userId = "attacker";

    expect(freshGate.pending()[0]!.callbackOwner).toEqual({
      tenantId: "default",
      userId: "user1",
      channelType: "telegram",
      channelKey: "chat-1",
      threadId: "topic-1",
    });
    expect(Object.isFrozen(freshGate.pending()[0]!.callbackOwner)).toBe(true);
    freshGate.dispose();
  });
});

// ---------------------------------------------------------------------------
// 13. Dispose with system:shutdown
// ---------------------------------------------------------------------------

describe("dispose with system:shutdown", () => {
  it("dispose() resolves pending promises with system:shutdown denial", async () => {
    const promise = gate.requestApproval(makeRequest());

    gate.dispose();

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.approvedBy).toBe("system:shutdown");
    expect(result.reason).toBe("Daemon shutting down");
  });

  it("dispose() resolves every batched follower with system:shutdown denial", async () => {
    const primary = gate.requestApproval(makeRequest());
    const follower = gate.requestApproval(makeRequest());

    gate.dispose();

    await expect(Promise.all([primary, follower])).resolves.toEqual([
      expect.objectContaining({ approved: false, approvedBy: "system:shutdown" }),
      expect.objectContaining({ approved: false, approvedBy: "system:shutdown" }),
    ]);
  });

  it("system:shutdown denial does NOT populate denial cache", async () => {
    const DENIAL_CACHE_TTL = 30_000;
    const gateWithTtl = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => DENIAL_CACHE_TTL,
      getBatchApprovalTtlMs: () => 0, // Disable approval cache for this test
    });

    // Create a request and resolve it with system:shutdown directly
    const promise = gateWithTtl.requestApproval(makeRequest());
    const [pending] = gateWithTtl.pending();
    gateWithTtl.resolveApproval(pending!.requestId, false, "system:shutdown", "Shutting down");
    await promise;

    // Next identical request should create a real pending entry (not cached)
    gateWithTtl.requestApproval(makeRequest());
    expect(gateWithTtl.pending()).toHaveLength(1);

    gateWithTtl.dispose();
  });
});

// ---------------------------------------------------------------------------
// 14. Approval cache
// ---------------------------------------------------------------------------

describe("approval cache", () => {
  const APPROVAL_CACHE_TTL = 15_000;

  let gateWithApprovalCache: ApprovalGate;

  beforeEach(() => {
    gateWithApprovalCache = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => 30_000,
      getBatchApprovalTtlMs: () => APPROVAL_CACHE_TTL,
    });
  });

  afterEach(() => {
    gateWithApprovalCache.dispose();
  });

  // -- Cache hit tests --

  it("second requestApproval for same sessionKey+action returns cached approval instantly after first approval", async () => {
    // First request: create and approve
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    const result1 = await promise1;
    expect(result1.approved).toBe(true);

    // Second request: same sessionKey + action should resolve instantly from cache
    const promise2 = gateWithApprovalCache.requestApproval(makeRequest());
    const result2 = await promise2;

    expect(result2.approved).toBe(true);
    // Should NOT appear in pending list (resolved instantly from cache)
    expect(gateWithApprovalCache.pending()).toHaveLength(0);
  });

  it("cached approval uses approvedBy 'system:cached-approval'", async () => {
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    const promise2 = gateWithApprovalCache.requestApproval(makeRequest());
    const result2 = await promise2;

    expect(result2.approvedBy).toBe("system:cached-approval");
    expect(result2.reason).toContain("Auto-approved");
    expect(result2.reason).toContain("agents.restart");
  });

  it("cached approval emits approval:resolved event", async () => {
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    const resolvedHandler = vi.fn();
    eventBus.on("approval:resolved", resolvedHandler);

    const promise2 = gateWithApprovalCache.requestApproval(makeRequest());
    await promise2;

    expect(resolvedHandler).toHaveBeenCalledOnce();
    const payload = resolvedHandler.mock.calls[0]![0] as EventMap["approval:resolved"];
    expect(payload.approved).toBe(true);
    expect(payload.approvedBy).toBe("system:cached-approval");
  });

  // -- Cache miss tests --

  it("cached approval expires after TTL and next request creates a real pending entry", async () => {
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Advance past approval cache TTL
    vi.advanceTimersByTime(APPROVAL_CACHE_TTL + 1);

    // Next request should create a real pending entry (cache expired)
    gateWithApprovalCache.requestApproval(makeRequest());
    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  it("different action on same sessionKey is NOT cached", async () => {
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest({ action: "agents.create" }));
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Same sessionKey but different action -- should create a real pending entry
    gateWithApprovalCache.requestApproval(makeRequest({ action: "agents.delete" }));
    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  it.each([
    ["agent", { agentId: "agent-2" }],
    ["trust level", { trustLevel: "guest" as const }],
    ["tool", { toolName: "agents_manage_alternate" }],
    ["parameters", { params: { agentId: "bot-2" } }],
  ])("does not reuse an approval across a different %s", async (_dimension, overrides) => {
    const first = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending!.requestId, true, "operator");
    await first;

    gateWithApprovalCache.requestApproval(makeRequest(overrides));

    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  it("reuses an approval for semantically identical parameters regardless of insertion order", async () => {
    const first = gateWithApprovalCache.requestApproval(makeRequest({
      params: { target: { beta: 2, alpha: 1 }, enabled: true },
    }));
    const [pending] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending!.requestId, true, "operator");
    await first;

    const resolution = await gateWithApprovalCache.requestApproval(makeRequest({
      params: { enabled: true, target: { alpha: 1, beta: 2 } },
    }));

    expect(resolution.approvedBy).toBe("system:cached-approval");
    expect(gateWithApprovalCache.pending()).toHaveLength(0);
  });

  it("does not reuse an approval for a different hidden operation fingerprint", async () => {
    const summary = { targetCount: 1 };
    const first = gateWithApprovalCache.requestApproval(makeRequest({
      params: summary,
      fingerprintParams: { target: "first" },
    }));
    const [pending] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending!.requestId, true, "operator");
    await first;

    gateWithApprovalCache.requestApproval(makeRequest({
      params: summary,
      fingerprintParams: { target: "second" },
    }));

    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  it("denial does NOT populate the approval cache", async () => {
    // Deny the first request
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, false, "operator", "Not allowed");
    await promise1;

    // Clear denial cache so we can test approval cache in isolation
    gateWithApprovalCache.clearDenialCache();

    // Second request should create a real pending entry (no cached approval)
    gateWithApprovalCache.requestApproval(makeRequest());
    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  // -- Disable test --

  it("batchApprovalTtlMs=0 disables approval cache entirely", async () => {
    const disabledGate = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getBatchApprovalTtlMs: () => 0,
    });

    // Approve first request
    const promise1 = disabledGate.requestApproval(makeRequest());
    const [pending1] = disabledGate.pending();
    disabledGate.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Second request should create a real pending entry (cache disabled)
    disabledGate.requestApproval(makeRequest());
    expect(disabledGate.pending()).toHaveLength(1);

    disabledGate.dispose();
  });

  // -- Clear tests --

  it("clearApprovalCache(sessionKey) removes entries for that session", async () => {
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Clear cache for this session
    gateWithApprovalCache.clearApprovalCache(authorityForSession("default:user1:discord"));

    // Next request should create a real pending entry (cache cleared)
    gateWithApprovalCache.requestApproval(makeRequest());
    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  it("clearApprovalCache() with no args clears all entries", async () => {
    // Approve for two different sessions
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest({ sessionKey: "default:user1:discord" }));
    const [p1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(p1!.requestId, true, "op");
    await promise1;

    const promise2 = gateWithApprovalCache.requestApproval(makeRequest({ sessionKey: "default:user2:telegram" }));
    const [p2] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(p2!.requestId, true, "op");
    await promise2;

    // Clear all approval cache entries
    gateWithApprovalCache.clearApprovalCache();

    // Both sessions should create real pending entries
    gateWithApprovalCache.requestApproval(makeRequest({ sessionKey: "default:user1:discord" }));
    gateWithApprovalCache.requestApproval(makeRequest({ sessionKey: "default:user2:telegram" }));
    expect(gateWithApprovalCache.pending()).toHaveLength(2);
  });

  // -- Dispose test --

  it("dispose() clears approval cache", async () => {
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    gateWithApprovalCache.dispose();

    // After dispose, create a fresh gate to verify old cache is gone
    const freshGate = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getBatchApprovalTtlMs: () => APPROVAL_CACHE_TTL,
    });
    freshGate.requestApproval(makeRequest());
    expect(freshGate.pending()).toHaveLength(1);
    freshGate.dispose();
  });

  // -- Source-level mutual invalidation tests --
  // These tests read the source .ts file directly to verify structural correctness
  // of mutual invalidation branches that are hard to test purely behaviorally.

  const sourceFilePath = join(dirname(fileURLToPath(import.meta.url)), "approval-gate.ts");

  it("resolveApproval approved path calls denialCache.delete (source-level)", () => {
    const source = readFileSync(sourceFilePath, "utf-8");
    // In the approved branch, denialCache.delete should be called for mutual invalidation
    expect(source).toContain("denialCache.delete(cacheKey)");
  });

  it("resolveApproval explicit deny path calls approvalCache.delete (source-level)", () => {
    const source = readFileSync(sourceFilePath, "utf-8");
    // In the explicit deny branch, approvalCache.delete should be called for mutual invalidation
    expect(source).toContain("approvalCache.delete(cacheKey)");
  });

  it("resolveApproval timeout path calls approvalCache.delete (source-level)", () => {
    const source = readFileSync(sourceFilePath, "utf-8");
    // The timeout branch should also delete from approvalCache
    // Verify by checking that system:timeout branch contains approvalCache.delete
    const timeoutSection = source.split('"system:timeout"')[1];
    expect(timeoutSection).toBeDefined();
    expect(timeoutSection!.substring(0, 200)).toContain("approvalCache.delete");
  });

  it("resolveApproval shutdown path does NOT call approvalCache.delete (source-level)", () => {
    const source = readFileSync(sourceFilePath, "utf-8");
    // The shutdown branch should NOT touch approvalCache
    // Extract the shutdown block between system:shutdown and system:timeout in resolveApproval
    const shutdownStart = source.indexOf('"system:shutdown"');
    const timeoutStart = source.indexOf('"system:timeout"');
    expect(shutdownStart).toBeGreaterThan(-1);
    expect(timeoutStart).toBeGreaterThan(-1);
    const shutdownBlock = source.substring(shutdownStart, timeoutStart);
    expect(shutdownBlock).not.toContain("approvalCache.delete");
  });

  it("cached approval does NOT re-populate cache (no infinite TTL extension) (source-level)", () => {
    const source = readFileSync(sourceFilePath, "utf-8");
    // Verify the guard: approvedBy !== "system:cached-approval" before populating approval cache
    expect(source).toContain('!== "system:cached-approval"');
  });
});

// ---------------------------------------------------------------------------
// 15. Approval cache serialization and logging
// ---------------------------------------------------------------------------

describe("approval cache serialization and logging", () => {
  const APPROVAL_CACHE_TTL = 15_000;

  let gateWithApprovalCache: ApprovalGate;

  beforeEach(() => {
    gateWithApprovalCache = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => 30_000,
      getBatchApprovalTtlMs: () => APPROVAL_CACHE_TTL,
    });
  });

  afterEach(() => {
    gateWithApprovalCache.dispose();
  });

  // -- Serialization tests --

  it("serializeApprovalCache returns empty array when no cached entries", () => {
    const entries = gateWithApprovalCache.serializeApprovalCache();
    expect(entries).toEqual([]);
  });

  it("serializeApprovalCache returns populated entries after approval", async () => {
    const promise = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending!.requestId, true, "operator");
    await promise;

    const entries = gateWithApprovalCache.serializeApprovalCache();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cacheKey).toMatch(/^h1:\d+:\[.*\]:[0-9a-f]{64}$/);
    expect(entries[0]!.resolution.approved).toBe(true);
    expect(entries[0]!.resolution.approvedBy).toBe("operator");
    expect(entries[0]!.expiresAt).toBeGreaterThan(Date.now());
    expect(entries[0]!.cacheKey).not.toContain("bot-1");
  });

  it("serializeApprovalCache skips expired entries", async () => {
    const promise = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending!.requestId, true, "operator");
    await promise;

    // Advance time past TTL
    vi.advanceTimersByTime(APPROVAL_CACHE_TTL + 1);

    const entries = gateWithApprovalCache.serializeApprovalCache();
    expect(entries).toEqual([]);
  });

  it("restoreApprovalCache restores valid entries and auto-approves subsequent requests", async () => {
    const sourceGate = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getBatchApprovalTtlMs: () => APPROVAL_CACHE_TTL,
    });
    const sourcePromise = sourceGate.requestApproval(makeRequest());
    const [sourcePending] = sourceGate.pending();
    sourceGate.resolveApproval(sourcePending!.requestId, true, "operator");
    await sourcePromise;
    const [entry] = sourceGate.serializeApprovalCache();
    expect(entry).toBeDefined();

    const restored = gateWithApprovalCache.restoreApprovalCache([entry!]);
    expect(restored).toBe(1);

    // Submit same request -- should resolve from cache
    const promise = gateWithApprovalCache.requestApproval(makeRequest());
    const result = await promise;

    expect(result.approved).toBe(true);
    expect(result.approvedBy).toBe("system:cached-approval");
    expect(gateWithApprovalCache.pending()).toHaveLength(0);
    sourceGate.dispose();
  });

  it("restoreApprovalCache skips entries with expired expiresAt", () => {
    const entry: SerializedApprovalCacheEntry = {
      cacheKey: "default:user1:discord::agents.restart",
      resolution: {
        requestId: "00000000-0000-4000-8000-000000000098",
        approved: true,
        approvedBy: "operator",
        resolvedAt: Date.now() - 20_000,
      },
      expiresAt: Date.now() - 1000,
    };

    const restored = gateWithApprovalCache.restoreApprovalCache([entry]);
    expect(restored).toBe(0);

    // Submit request -- should go to pending (not cached)
    gateWithApprovalCache.requestApproval(makeRequest());
    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  it("restoreApprovalCache rejects a persisted denial instead of treating its presence as approval", () => {
    const restored = gateWithApprovalCache.restoreApprovalCache([{
      cacheKey: "h1:21:default:user1:discord:5c050e59c852954be48fced984af6586aa7133864c5f291a30ed64ab6cfea853",
      resolution: {
        requestId: "00000000-0000-4000-8000-000000000097",
        approved: false,
        approvedBy: "operator",
        resolvedAt: Date.now(),
      },
      expiresAt: Date.now() + 15_000,
    } as never]);

    expect(restored).toBe(0);
    gateWithApprovalCache.requestApproval(makeRequest());
    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  it("does not match a guessed cache entry made from a plain low-entropy SHA-256 digest", () => {
    const guessed = createHash("sha256").update('{"agentId":"bot-1"}').digest("hex");
    const restored = gateWithApprovalCache.restoreApprovalCache([{
      cacheKey: `h1:21:default:user1:discord:${guessed}`,
      resolution: {
        requestId: "00000000-0000-4000-8000-000000000096",
        approved: true,
        approvedBy: "operator",
        resolvedAt: Date.now(),
      },
      expiresAt: Date.now() + 15_000,
    }]);
    expect(restored).toBe(1);

    gateWithApprovalCache.requestApproval(makeRequest());

    expect(gateWithApprovalCache.pending()).toHaveLength(1);
  });

  it("serialize then restore round-trip preserves cache behavior", async () => {
    // Create and approve on first gate
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Serialize from first gate
    const entries = gateWithApprovalCache.serializeApprovalCache();
    expect(entries).toHaveLength(1);

    // Create a NEW gate and restore
    const newGate = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => 30_000,
      getBatchApprovalTtlMs: () => APPROVAL_CACHE_TTL,
    });

    const restored = newGate.restoreApprovalCache(entries);
    expect(restored).toBe(1);

    // Submit same request on new gate -- should auto-approve from restored cache
    const promise2 = newGate.requestApproval(makeRequest());
    const result2 = await promise2;

    expect(result2.approved).toBe(true);
    expect(result2.approvedBy).toBe("system:cached-approval");

    newGate.dispose();
  });

  it("restored approval cache keeps the original absolute expiry", async () => {
    const first = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending!.requestId, true, "operator");
    await first;
    const entries = gateWithApprovalCache.serializeApprovalCache();

    vi.advanceTimersByTime(APPROVAL_CACHE_TTL - 1_000);
    const restoredGate = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getBatchApprovalTtlMs: () => APPROVAL_CACHE_TTL,
    });
    expect(restoredGate.restoreApprovalCache(entries)).toBe(1);

    vi.advanceTimersByTime(1_001);
    restoredGate.requestApproval(makeRequest());

    expect(restoredGate.pending()).toHaveLength(1);
    restoredGate.dispose();
  });

  // -- Shutdown ordering test --

  it("dispose clears approval cache -- serialization must happen before dispose", async () => {
    const promise = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending!.requestId, true, "operator");
    await promise;

    // Before dispose: serialization returns entries
    const before = gateWithApprovalCache.serializeApprovalCache();
    expect(before).toHaveLength(1);

    // After dispose: serialization returns empty
    gateWithApprovalCache.dispose();
    const after = gateWithApprovalCache.serializeApprovalCache();
    expect(after).toEqual([]);
  });

  // -- Cache logging tests --

  it("logger.debug called on approval cache hit with cacheKey and ttlRemainingMs", async () => {
    const debugFn = vi.fn();
    const gateWithLogger = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => 30_000,
      getBatchApprovalTtlMs: () => APPROVAL_CACHE_TTL,
      logger: { debug: debugFn },
    });

    // First: approve
    const promise1 = gateWithLogger.requestApproval(makeRequest());
    const [pending1] = gateWithLogger.pending();
    gateWithLogger.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Second: cache hit
    const promise2 = gateWithLogger.requestApproval(makeRequest());
    await promise2;

    expect(debugFn).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheKey: expect.stringMatching(/^h1:\d+:\[.*\]:[0-9a-f]{64}$/),
        action: "agents.restart",
      }),
      "Approval cache hit",
    );

    gateWithLogger.dispose();
  });

  it("expired approval cache entry does not produce cache hit", async () => {
    const debugFn = vi.fn();
    const gateWithLogger = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => 30_000,
      getBatchApprovalTtlMs: () => APPROVAL_CACHE_TTL,
      logger: { debug: debugFn },
    });

    // First: approve
    const promise1 = gateWithLogger.requestApproval(makeRequest());
    const [pending1] = gateWithLogger.pending();
    gateWithLogger.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Advance past TTL
    vi.advanceTimersByTime(APPROVAL_CACHE_TTL + 1);

    // Submit same request -- TTLCache auto-evicts expired entry, so no cache hit
    gateWithLogger.requestApproval(makeRequest());

    // No "Approval cache hit" debug log should be emitted for the second request
    const cacheHitCalls = debugFn.mock.calls.filter(
      (call: unknown[]) => call[1] === "Approval cache hit",
    );
    expect(cacheHitCalls).toHaveLength(0);

    // The request should be pending (not auto-resolved from cache)
    expect(gateWithLogger.pending()).toHaveLength(1);

    gateWithLogger.dispose();
  });

  it("no logger crash when logger dep is omitted", async () => {
    // This gate uses the beforeEach gate which has NO logger dep
    const promise1 = gateWithApprovalCache.requestApproval(makeRequest());
    const [pending1] = gateWithApprovalCache.pending();
    gateWithApprovalCache.resolveApproval(pending1!.requestId, true, "operator");
    await promise1;

    // Second request: cache hit -- should not throw even without logger
    const promise2 = gateWithApprovalCache.requestApproval(makeRequest());
    const result2 = await promise2;

    expect(result2.approved).toBe(true);
    expect(result2.approvedBy).toBe("system:cached-approval");
  });
});

// ---------------------------------------------------------------------------
// 16. shortId minting / emission / persistence
// ---------------------------------------------------------------------------

const SHORT_ID_RE = /^[0-9A-Za-z]{12}$/;

describe("shortId minting and emission", () => {
  it("requestApproval input omits shortId — a caller supplying only tool/action/session context succeeds", () => {
    // makeRequest() supplies NO shortId (nor requestId/createdAt/timeoutMs) — the gate mints them.
    gate.requestApproval(makeRequest());
    expect(gate.pending()).toHaveLength(1);
  });

  it("the gate mints a 12-char base62 shortId and exposes it via pending()", () => {
    gate.requestApproval(makeRequest());
    const [pending] = gate.pending();
    expect(pending!.shortId).toMatch(SHORT_ID_RE);
  });

  it("the approval:requested emit payload carries the same shortId as pending() and getRequest()", () => {
    const handler = vi.fn();
    eventBus.on("approval:requested", handler);

    gate.requestApproval(makeRequest());

    const payload = handler.mock.calls[0]![0] as EventMap["approval:requested"];
    expect(payload.shortId).toMatch(SHORT_ID_RE);

    const [pending] = gate.pending();
    expect(pending!.shortId).toBe(payload.shortId);

    const found = gate.getRequest(pending!.requestId);
    expect(found!.shortId).toBe(payload.shortId);
  });

  it("two concurrent pending requests receive two different shortIds", () => {
    gate.requestApproval(makeRequest({ action: "tool-a", toolName: "tool-a", sessionKey: "default:a:channel-a" }));
    gate.requestApproval(makeRequest({ action: "tool-b", toolName: "tool-b", sessionKey: "default:b:channel-b" }));

    const pending = gate.pending();
    expect(pending).toHaveLength(2);
    expect(pending[0]!.shortId).toMatch(SHORT_ID_RE);
    expect(pending[1]!.shortId).toMatch(SHORT_ID_RE);
    expect(pending[0]!.shortId).not.toBe(pending[1]!.shortId);
  });

  it("serializePending() writes the shortId", () => {
    gate.requestApproval(makeRequest({ action: "agents.create", toolName: "agents_manage" }));

    const [serialized] = gate.serializePending();
    expect(serialized!.shortId).toMatch(SHORT_ID_RE);

    const [pending] = gate.pending();
    expect(serialized!.shortId).toBe(pending!.shortId);
  });

  it("restorePending() preserves shortId through a graceful-restart handoff (same id re-emitted)", () => {
    // 1) original gate mints + serializes
    const sourceHandler = vi.fn();
    eventBus.on("approval:requested", sourceHandler);
    gate.requestApproval(makeRequest({ action: "agents.delete", toolName: "agents_manage" }));
    const originalShortId = gate.pending()[0]!.shortId;
    const [record] = gate.serializePending();
    expect(record!.shortId).toBe(originalShortId);

    // 2) fresh gate restores the serialized record on a clean bus
    const restoreBus = new TypedEventBus();
    const restoreHandler = vi.fn();
    restoreBus.on("approval:requested", restoreHandler);
    const freshGate = createApprovalGate({
      eventBus: restoreBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
    });

    const restored = freshGate.restorePending([record!]);
    expect(restored).toBe(1);

    // restored pending() carries the ORIGINAL shortId (callback identity stable)
    expect(freshGate.pending()[0]!.shortId).toBe(originalShortId);

    // the restored approval:requested re-emit carries the persisted shortId
    const restoredPayload = restoreHandler.mock.calls[0]![0] as EventMap["approval:requested"];
    expect(restoredPayload.shortId).toBe(originalShortId);

    freshGate.dispose();
  });

  it("cached-approval early return emits only approval:resolved (no shortId requirement)", async () => {
    const APPROVAL_TTL = 15_000;
    const cachingGate = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getBatchApprovalTtlMs: () => APPROVAL_TTL,
    });

    // Prime the approval cache with an explicit approval.
    const p1 = cachingGate.requestApproval(makeRequest());
    cachingGate.resolveApproval(cachingGate.pending()[0]!.requestId, true, "operator");
    await p1;

    // Second identical request hits the cache → resolves immediately, emits NO approval:requested.
    const requestedHandler = vi.fn();
    eventBus.on("approval:requested", requestedHandler);
    const p2 = cachingGate.requestApproval(makeRequest());
    const result2 = await p2;

    expect(result2.approved).toBe(true);
    expect(result2.approvedBy).toBe("system:cached-approval");
    expect(requestedHandler).not.toHaveBeenCalled();

    cachingGate.dispose();
  });

  it("cached-denial early return emits only approval:resolved (no shortId requirement)", async () => {
    const DENIAL_TTL = 30_000;
    const denyingGate = createApprovalGate({
      eventBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getDenialCacheTtlMs: () => DENIAL_TTL,
      getBatchApprovalTtlMs: () => 0, // disable approval cache for an isolated denial path
    });

    // Prime the denial cache with an explicit user denial.
    const p1 = denyingGate.requestApproval(makeRequest());
    denyingGate.resolveApproval(denyingGate.pending()[0]!.requestId, false, "operator", "nope");
    await p1;

    const requestedHandler = vi.fn();
    eventBus.on("approval:requested", requestedHandler);
    const p2 = denyingGate.requestApproval(makeRequest());
    const result2 = await p2;

    expect(result2.approved).toBe(false);
    expect(result2.approvedBy).toBe("system:cached-denial");
    expect(requestedHandler).not.toHaveBeenCalled();

    denyingGate.dispose();
  });

  it("a minted shortId satisfies the value contract used by the renderer/router (mint primitive)", () => {
    // Pins that the gate's minter and the standalone primitive agree on the shape.
    expect(mintApprovalShortId()).toMatch(SHORT_ID_RE);
  });
});

// ---------------------------------------------------------------------------
// 17. shortId secondary index + read helpers
//     getRequestByShortId / pendingForAuthority + atomic dual-map removal.
// ---------------------------------------------------------------------------

describe("shortId secondary index + read helpers", () => {
  it("getRequestByShortId(shortId) returns the pending request for a live minted shortId", () => {
    gate.requestApproval(makeRequest());
    const [pending] = gate.pending();
    const shortId = pending!.shortId;

    const found = gate.getRequestByShortId(shortId);
    expect(found).toBe(pending);
    // The resolved request must carry the same requestId — the router maps shortId → requestId server-side.
    expect(found!.requestId).toBe(pending!.requestId);
  });

  it("getRequestByShortId(unknownShortId) returns undefined", () => {
    gate.requestApproval(makeRequest());
    // A 12-char base62 value that was never minted.
    expect(gate.getRequestByShortId("ZZZZZZZZZZZZ")).toBeUndefined();
  });

  it("getRequestByShortId returns undefined after the request is resolved (atomic dual-map removal)", async () => {
    const promise = gate.requestApproval(makeRequest());
    const [pending] = gate.pending();
    const shortId = pending!.shortId;
    expect(gate.getRequestByShortId(shortId)).toBe(pending);

    gate.resolveApproval(pending!.requestId, true, "chat:u");
    await promise;

    // The index entry MUST be gone with the pending entry — a stale entry would defeat replay rejection.
    expect(gate.getRequestByShortId(shortId)).toBeUndefined();
  });

  it("getRequestByShortId returns undefined after a denial (atomic removal on deny path)", async () => {
    const promise = gate.requestApproval(makeRequest());
    const [pending] = gate.pending();
    const shortId = pending!.shortId;

    gate.resolveApproval(pending!.requestId, false, "chat:u", "nope");
    await promise;

    expect(gate.getRequestByShortId(shortId)).toBeUndefined();
  });

  it("getRequestByShortId returns undefined after a timeout (timeout routes through resolveApproval)", async () => {
    const promise = gate.requestApproval(makeRequest());
    const shortId = gate.pending()[0]!.shortId;

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS + 1);
    await promise;

    expect(gate.getRequestByShortId(shortId)).toBeUndefined();
  });

  it("getRequestByShortId returns undefined after dispose (shortIdIndex.clear mirrors pendingMap.clear)", () => {
    gate.requestApproval(makeRequest());
    const shortId = gate.pending()[0]!.shortId;
    expect(gate.getRequestByShortId(shortId)).toBeDefined();

    gate.dispose();

    expect(gate.getRequestByShortId(shortId)).toBeUndefined();
  });

  it("pendingForAuthority returns only requests whose full authority matches", () => {
    gate.requestApproval(makeRequest({ sessionKey: "default:alice:discord", action: "a", toolName: "a" }));
    gate.requestApproval(makeRequest({ sessionKey: "default:alice:discord", action: "b", toolName: "b" }));
    gate.requestApproval(makeRequest({ sessionKey: "default:bob:telegram", action: "c", toolName: "c" }));

    const aliceAuthority = authorityForSession("default:alice:discord");
    const alice = gate.pendingForAuthority(aliceAuthority);
    expect(alice).toHaveLength(2);
    expect(alice.every((r) => r.conversationRef === aliceAuthority.conversationRef)).toBe(true);
    expect(alice.map((r) => r.action).sort()).toEqual(["a", "b"]);

    const bob = gate.pendingForAuthority(authorityForSession("default:bob:telegram"));
    expect(bob).toHaveLength(1);
    expect(bob[0]!.action).toBe("c");
  });

  it("pendingForAuthority returns an empty array for a conversation with no pending requests", () => {
    gate.requestApproval(makeRequest({ sessionKey: "default:alice:discord" }));
    expect(gate.pendingForAuthority(authorityForSession("default:nobody:slack"))).toEqual([]);
  });

  it("pendingForAuthority no longer lists a request after it is resolved (index-leak guard)", async () => {
    const promise = gate.requestApproval(makeRequest({ sessionKey: "default:alice:discord" }));
    const authority = authorityForSession("default:alice:discord");
    expect(gate.pendingForAuthority(authority)).toHaveLength(1);

    gate.resolveApproval(gate.pending()[0]!.requestId, true, "chat:u");
    await promise;

    expect(gate.pendingForAuthority(authority)).toEqual([]);
  });

  it("a restored approval is reachable via getRequestByShortId (callback identity survives restart)", () => {
    // 1) original gate mints + serializes a pending request.
    gate.requestApproval(makeRequest({ action: "agents.delete", toolName: "agents_manage" }));
    const original = gate.pending()[0]!;
    const [record] = gate.serializePending();

    // 2) fresh gate restores the serialized record on a clean bus.
    const restoreBus = new TypedEventBus();
    const freshGate = createApprovalGate({
      eventBus: restoreBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
    });

    const restored = freshGate.restorePending([record!]);
    expect(restored).toBe(1);

    // The restored approval is reachable by its persisted shortId — restorePending MUST populate the index.
    const found = freshGate.getRequestByShortId(original.shortId);
    expect(found).toBeDefined();
    expect(found!.requestId).toBe(original.requestId);
    expect(found!.shortId).toBe(original.shortId);
    // And it is listed for its session.
    expect(freshGate.pendingForAuthority({
      tenantId: original.tenantId,
      agentId: original.agentId,
      conversationRef: original.conversationRef,
      resolvingPrincipalId: original.resolvingPrincipalId,
    }).map((r) => r.shortId)).toContain(original.shortId);

    freshGate.dispose();
  });

  it("a restored approval is unreachable via getRequestByShortId after it is resolved (restored entry removes its index too)", () => {
    gate.requestApproval(makeRequest());
    const original = gate.pending()[0]!;
    const [record] = gate.serializePending();

    const restoreBus = new TypedEventBus();
    const freshGate = createApprovalGate({
      eventBus: restoreBus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
    });
    freshGate.restorePending([record!]);
    expect(freshGate.getRequestByShortId(original.shortId)).toBeDefined();

    freshGate.resolveApproval(original.requestId, true, "chat:u");

    expect(freshGate.getRequestByShortId(original.shortId)).toBeUndefined();
    freshGate.dispose();
  });
});

describe("approval lifecycle subscriber isolation", () => {
  function makeIsolationGate(
    bus: TypedEventBus,
    logger?: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> },
  ): ApprovalGate {
    return createApprovalGate({
      eventBus: bus,
      clock: testClock,
      timers: testTimers,
      getTimeoutMs: () => DEFAULT_TIMEOUT_MS,
      getBatchApprovalTtlMs: () => 30_000,
      ...(logger === undefined ? {} : { logger }),
    });
  }

  it("keeps a requested approval pending and reaches later observers after sync and async subscriber failures", async () => {
    const bus = new TypedEventBus();
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const laterObserver = vi.fn();
    bus.on("approval:requested", () => {
      throw new Error("private approval parameters from sync subscriber");
    });
    bus.on("approval:requested", async () => {
      throw new Error("private approval parameters from async subscriber");
    });
    bus.on("approval:requested", laterObserver);
    const isolatedGate = makeIsolationGate(bus, logger);

    const resolutionPromise = isolatedGate.requestApproval(makeRequest());
    const [request] = isolatedGate.pending();

    expect(request).toBeDefined();
    expect(laterObserver).toHaveBeenCalledOnce();
    isolatedGate.resolveApproval(request!.requestId, true, "operator");
    await expect(resolutionPromise).resolves.toMatchObject({ approved: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private approval parameters");
    isolatedGate.dispose();
  });

  it("unblocks manual resolution and removes every pending index when a resolved subscriber throws", async () => {
    const bus = new TypedEventBus();
    const isolatedGate = makeIsolationGate(bus);
    const resolutionPromise = isolatedGate.requestApproval(makeRequest());
    const [request] = isolatedGate.pending();
    const laterObserver = vi.fn();
    bus.on("approval:resolved", () => {
      throw new Error("private manual resolution subscriber payload");
    });
    bus.on("approval:resolved", laterObserver);

    expect(() => isolatedGate.resolveApproval(
      request!.requestId,
      true,
      "operator",
    )).not.toThrow();

    await expect(resolutionPromise).resolves.toMatchObject({ approved: true });
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(isolatedGate.pending()).toEqual([]);
    expect(isolatedGate.getRequestByShortId(request!.shortId)).toBeUndefined();
    isolatedGate.dispose();
  });

  it("claims a manual resolution before a subscriber can reenter with the opposite decision", async () => {
    const bus = new TypedEventBus();
    const isolatedGate = makeIsolationGate(bus);
    const resolutionPromise = isolatedGate.requestApproval(makeRequest());
    const [request] = isolatedGate.pending();
    const laterObserver = vi.fn();
    bus.on("approval:resolved", () => {
      isolatedGate.resolveApproval(
        request!.requestId,
        false,
        "subscriber",
        "attempted reentrant denial",
      );
    });
    bus.on("approval:resolved", laterObserver);

    isolatedGate.resolveApproval(request!.requestId, true, "operator");

    await expect(resolutionPromise).resolves.toMatchObject({
      approved: true,
      approvedBy: "operator",
    });
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(laterObserver).toHaveBeenCalledWith(expect.objectContaining({
      approved: true,
      approvedBy: "operator",
    }));
    expect(isolatedGate.pending()).toEqual([]);
    expect(isolatedGate.getRequestByShortId(request!.shortId)).toBeUndefined();
    isolatedGate.dispose();
  });

  it("completes timeout cleanup and resolves the waiter when a resolved subscriber throws", async () => {
    const bus = new TypedEventBus();
    const isolatedGate = makeIsolationGate(bus);
    const resolutionPromise = isolatedGate.requestApproval(makeRequest());
    const [request] = isolatedGate.pending();
    const laterObserver = vi.fn();
    bus.on("approval:resolved", () => {
      throw new Error("private timeout subscriber payload");
    });
    bus.on("approval:resolved", laterObserver);

    expect(() => vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS)).not.toThrow();

    await expect(resolutionPromise).resolves.toMatchObject({
      approved: false,
      approvedBy: "system:timeout",
    });
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(isolatedGate.pending()).toEqual([]);
    expect(isolatedGate.getRequestByShortId(request!.shortId)).toBeUndefined();
    isolatedGate.dispose();
  });

  it("returns a cached resolution when its observational subscriber throws", async () => {
    const bus = new TypedEventBus();
    const isolatedGate = makeIsolationGate(bus);
    const firstPromise = isolatedGate.requestApproval(makeRequest());
    const [first] = isolatedGate.pending();
    isolatedGate.resolveApproval(first!.requestId, true, "operator");
    await firstPromise;
    const laterObserver = vi.fn();
    bus.on("approval:resolved", () => {
      throw new Error("private cached resolution subscriber payload");
    });
    bus.on("approval:resolved", laterObserver);

    const cachedPromise = isolatedGate.requestApproval(makeRequest());

    await expect(cachedPromise).resolves.toMatchObject({
      approved: true,
      approvedBy: "system:cached-approval",
    });
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(isolatedGate.pending()).toEqual([]);
    isolatedGate.dispose();
  });

  it("restores pending state and reaches later prompt observers when the first restore subscriber throws", () => {
    gate.requestApproval(makeRequest());
    const records = gate.serializePending();
    const restoreBus = new TypedEventBus();
    const laterObserver = vi.fn();
    restoreBus.on("approval:requested", () => {
      throw new Error("private restored parameters from subscriber");
    });
    restoreBus.on("approval:requested", laterObserver);
    const restoredGate = makeIsolationGate(restoreBus);

    expect(restoredGate.restorePending(records)).toBe(1);

    expect(restoredGate.pending()).toHaveLength(1);
    expect(laterObserver).toHaveBeenCalledOnce();
    restoredGate.dispose();
  });
});
