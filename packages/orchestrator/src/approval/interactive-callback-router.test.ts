// SPDX-License-Identifier: Apache-2.0
/**
 * Security suite for the InteractiveCallbackRouter.
 *
 * The router is the single server-side authority that parses, looks-up-THEN-verifies,
 * and dispatches every approval callback to ApprovalGate.resolveApproval(). The lookup-FIRST
 * ordering + pending-table-removal-as-replay-guard are load-bearing:
 *
 *   1. parseCallbackData (strict regex)            → malformed
 *   2. gate.getRequestByShortId(shortId) FIRST     → unknown (covers replays)
 *   3. request session/agent ≠ inbound principal   → unknown (cross-principal guard)
 *   4. clock.now() >= createdAt + timeoutMs        → expired (derived expiresAt, injected clock)
 *   5. !verifyCallbackData(...)                     → invalid_signature (constant-time, no throw)
 *   6. details → details_requested (no resolve); approve/deny → resolveApproval + resolved
 *
 * Plain-text branch: pendingForSession + agent filter + case-insensitive verb (+ optional shortId
 * suffix); exactly-one → resolve; multiple-no-suffix → ambiguous; none → unknown. HMAC skipped
 * for this branch only; replay protection still from pending-table removal.
 */
import { describe, it, expect } from "vitest";
import { signCallbackData } from "@comis/core";
import type { ApprovalRequest, ApprovalGate, ClockPort } from "@comis/core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import {
  createInteractiveCallbackRouter,
  type GraphReportTargetStore,
  type InboundCallback,
} from "./interactive-callback-router.js";

const SECRET = "test-signing-secret-32-bytes-aaaaaaaaaaaa";
const SHORT_ID = "abc123XYZ789"; // 12 base62 chars
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_K = "tenant-a:user-a:chat-1:thread:thread-1";
const CREATED_AT = 1_000_000;
const TIMEOUT_MS = 300_000; // expiresAt = 1_300_000

interface ResolveCall {
  requestId: string;
  approved: boolean;
  approvedBy: string;
  reason?: string;
}

/**
 * Build a fake ApprovalGate seeded with `seed` pending requests, recording every
 * resolveApproval call and honouring the pending-table-removal replay guard: once a
 * requestId is resolved it is removed from both the by-shortId and by-requestId views,
 * so a replayed lookup returns undefined (mirrors the real gate).
 */
function makeFakeGate(seed: ApprovalRequest[]): {
  gate: ApprovalGate;
  resolveCalls: ResolveCall[];
} {
  const byShortId = new Map<string, ApprovalRequest>();
  const byRequestId = new Map<string, ApprovalRequest>();
  for (const r of seed) {
    byShortId.set(r.shortId, r);
    byRequestId.set(r.requestId, r);
  }
  const resolveCalls: ResolveCall[] = [];

  const gate: ApprovalGate = {
    requestApproval: () => {
      throw new Error("not used in router tests");
    },
    resolveApproval: (requestId, approved, approvedBy, reason) => {
      resolveCalls.push({ requestId, approved, approvedBy, reason });
      // Pending-table removal IS the replay guard: drop from both views.
      const req = byRequestId.get(requestId);
      if (req) {
        byRequestId.delete(requestId);
        byShortId.delete(req.shortId);
      }
    },
    pending: () => Array.from(byRequestId.values()),
    getRequest: (requestId) => byRequestId.get(requestId),
    getRequestByShortId: (shortId) => byShortId.get(shortId),
    pendingForSession: (sessionKey) =>
      Array.from(byRequestId.values()).filter((r) => r.sessionKey === sessionKey),
    clearDenialCache: () => {},
    clearApprovalCache: () => {},
    serializePending: () => [],
    restorePending: () => 0,
    serializeApprovalCache: () => [],
    restoreApprovalCache: () => 0,
    dispose: () => {},
  };

  return { gate, resolveCalls };
}

function makeRequest(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: REQUEST_ID,
    shortId: SHORT_ID,
    toolName: "shell",
    action: "shell.exec",
    params: {},
    agentId: "agent-1",
    sessionKey: SESSION_K,
    trustLevel: "untrusted",
    callbackOwner: {
      tenantId: "tenant-a",
      userId: "user-a",
      channelType: "telegram",
      channelKey: "chat-1",
      threadId: "thread-1",
    },
    createdAt: CREATED_AT,
    timeoutMs: TIMEOUT_MS,
    ...over,
  } as ApprovalRequest;
}

/** Compose a valid signed wire payload for the seeded request. */
function signedPayload(choice: "approve" | "deny" | "details", shortId = SHORT_ID): string {
  const hmac = signCallbackData(SECRET, choice, shortId);
  return `v1.${choice}.${shortId}.${hmac}`;
}

function inbound(rawData: string, over: Partial<InboundCallback> = {}): InboundCallback {
  return {
    channelType: "telegram",
    channelKey: "chat-1",
    agentId: "agent-1",
    sessionKey: SESSION_K,
    rawData,
    inboundUserId: "user-a",
    tenantId: "tenant-a",
    threadId: "thread-1",
    ...over,
  } as InboundCallback;
}

function makeRouter(
  seed: ApprovalRequest[],
  clock?: ClockPort,
  graphReportStore?: GraphReportTargetStore,
) {
  const { gate, resolveCalls } = makeFakeGate(seed);
  const router = createInteractiveCallbackRouter({
    gate,
    getSecret: () => SECRET,
    clock: clock ?? createFakeClock(CREATED_AT), // before expiry
    ...(graphReportStore === undefined ? {} : { graphReportStore }),
  });
  return { router, resolveCalls, gate };
}

describe("InteractiveCallbackRouter — signed branch", () => {
  it("malformed: a v1-prefixed payload that fails the strict regex → {kind:'malformed'} (a corrupted signed attempt must NOT fall through to the unauthenticated plain-text branch)", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    // The signed-format marker `v1.` is present but the body is garbage.
    const res = await router.route(inbound("v1.not-a-valid-callback-payload"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "malformed" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("malformed: a v1-prefixed but structurally invalid payload (bad shortId, missing hmac) → {kind:'malformed'}", async () => {
    const { router } = makeRouter([makeRequest()]);
    // bad shortId length + missing hmac segment
    const res = await router.route(inbound("v1.approve.short"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "malformed" });
  });

  it("malformed: a wrong-version prefix (v2.) is NOT treated as signed → plain-text branch → {kind:'unknown'}", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    // Only `v1.` is the signed marker; a different version is not a signed attempt.
    const res = await router.route(inbound("v2.approve.abc123XYZ789.deadbeefdeadbeef"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("unknown: well-formed v1 whose shortId is NOT in the pending table → {kind:'unknown'}", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const otherShort = "zzzzzzzzzzzz";
    const res = await router.route(inbound(signedPayload("approve", otherShort)));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("cross-session: inbound sessionKey ≠ the pending entry's sessionKey → {kind:'unknown'} and NOT resolved", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    // room B presents room A's shortId
    const res = await router.route(
      inbound(signedPayload("approve"), { sessionKey: "telegram:999:888" }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("cross-agent: a signed callback cannot resolve another agent's request in the same session", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest({ agentId: "agent-1" })]);

    const res = await router.route(inbound(signedPayload("approve"), { agentId: "agent-2" }));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("cross-user: a signed callback cannot resolve another user's request in the same channel", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);

    const res = await router.route(inbound(signedPayload("approve"), { inboundUserId: "user-b" }));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("cross-thread: a signed callback cannot resolve another thread's request", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);

    const res = await router.route(inbound(signedPayload("approve"), {
      threadId: "thread-2",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-2",
    } as Partial<InboundCallback>));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("expired: clock.now() >= createdAt + timeoutMs → {kind:'expired'} and NOT resolved", async () => {
    const expiredClock = createFakeClock(CREATED_AT + TIMEOUT_MS); // exactly at expiry
    const { router, resolveCalls } = makeRouter([makeRequest()], expiredClock);
    const res = await router.route(inbound(signedPayload("approve")));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "expired" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("expiry boundary: one ms before createdAt + timeoutMs still resolves (not expired)", async () => {
    const liveClock = createFakeClock(CREATED_AT + TIMEOUT_MS - 1);
    const { router, resolveCalls } = makeRouter([makeRequest()], liveClock);
    const res = await router.route(inbound(signedPayload("approve")));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });
    expect(resolveCalls).toHaveLength(1);
  });

  it("invalid_signature (equal length): a 16-char HMAC computed with the WRONG secret → {kind:'invalid_signature'}", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const wrongHmac = signCallbackData("a-different-wrong-secret", "approve", SHORT_ID);
    const res = await router.route(inbound(`v1.approve.${SHORT_ID}.${wrongHmac}`));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "invalid_signature" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("invalid_signature (wrong choice, equal length): HMAC for 'deny' presented on an 'approve' payload → {kind:'invalid_signature'}", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    // valid-length tag, but signed over the wrong choice — verify must reject
    const denyHmac = signCallbackData(SECRET, "deny", SHORT_ID);
    const res = await router.route(inbound(`v1.approve.${SHORT_ID}.${denyHmac}`));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "invalid_signature" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("invalid_signature: verifyCallbackData does NOT throw on an unequal-length tag (length-guard-first contract)", () => {
    // parseCallbackData enforces a 16-char hmac, so the unequal-length path is asserted
    // directly against the primitive the router calls (the 'no throw' contract).
    const shortTag = "short";
    const longTag = "waytoolongtagvaluethatexceeds16chars";
    expect(() => signCallbackData(SECRET, "approve", SHORT_ID)).not.toThrow();
    // The router delegates verification to verifyCallbackData, which length-guards
    // before timingSafeEqual; a length mismatch must return false, never throw.
    // Re-import lazily to keep this assertion co-located with the router contract.
    return import("@comis/core").then(({ verifyCallbackData }) => {
      expect(() => verifyCallbackData(SECRET, "approve", SHORT_ID, shortTag)).not.toThrow();
      expect(verifyCallbackData(SECRET, "approve", SHORT_ID, shortTag)).toBe(false);
      expect(() => verifyCallbackData(SECRET, "approve", SHORT_ID, longTag)).not.toThrow();
      expect(verifyCallbackData(SECRET, "approve", SHORT_ID, longTag)).toBe(false);
    });
  });

  it("resolved approve: valid callback → {kind:'resolved', requestId, choice:'approve'} with resolveApproval(requestId, true, inboundUserId)", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound(signedPayload("approve")));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });
    expect(resolveCalls).toEqual([
      { requestId: REQUEST_ID, approved: true, approvedBy: "user-a", reason: undefined },
    ]);
  });

  it("resolved deny: valid callback → {kind:'resolved', requestId, choice:'deny'} with resolveApproval(requestId, false, inboundUserId)", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound(signedPayload("deny")));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "deny" });
    expect(resolveCalls).toEqual([
      { requestId: REQUEST_ID, approved: false, approvedBy: "user-a", reason: undefined },
    ]);
  });

  it("fails closed when the inbound callback has no user principal", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound(
      signedPayload("approve"),
      { inboundUserId: undefined } as unknown as Partial<InboundCallback>,
    ));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("details: valid v1.details.<shortId>.<hmac> → {kind:'details_requested', requestId}; pending entry intact; NOT resolved", async () => {
    const { router, resolveCalls, gate } = makeRouter([makeRequest()]);
    const res = await router.route(inbound(signedPayload("details")));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "details_requested", requestId: REQUEST_ID });
    expect(resolveCalls).toHaveLength(0);
    // pending entry still present
    expect(gate.getRequestByShortId(SHORT_ID)?.requestId).toBe(REQUEST_ID);
  });

  it("replay-after-resolve: first valid callback resolves; the SAME callback again → {kind:'unknown'} and resolveApproval called exactly ONCE total", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const payload = signedPayload("approve");

    const first = await router.route(inbound(payload));
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });

    const second = await router.route(inbound(payload));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toEqual({ kind: "unknown" });

    // pending-table removal IS the replay guard — exactly one resolve, no separate replay store.
    expect(resolveCalls).toHaveLength(1);
  });
});

describe("InteractiveCallbackRouter — graph report callbacks", () => {
  const reportOwner = {
    graphId: "11111111-2222-4333-8444-555555555555",
    tenantId: "tenant-a",
    userId: "user-a",
    sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
    agentId: "agent-1",
    channelType: "telegram",
    channelKey: "chat-1",
    expiresAt: CREATED_AT + TIMEOUT_MS,
  };

  it("recreates the same signed report callback after router restart", () => {
    const first = makeRouter([]).router.registerGraphReport(reportOwner);
    const restarted = makeRouter([]).router.registerGraphReport(reportOwner);

    expect(first.ok).toBe(true);
    expect(restarted.ok).toBe(true);
    if (!first.ok || !restarted.ok) return;
    expect(restarted.value).toBe(first.value);
  });

  it("restores and durably consumes a report callback across router restarts", async () => {
    let records: readonly unknown[] = [];
    const store = {
      load: () => ({ ok: true as const, value: records }),
      replace: (next: readonly unknown[]) => {
        records = structuredClone(next);
        return { ok: true as const, value: undefined };
      },
    };
    const first = makeRouter([], undefined, store).router;
    const registered = first.registerGraphReport(reportOwner);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const restarted = makeRouter([], undefined, store).router;
    const delivered = await restarted.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
      inboundUserId: "user-a",
    }));
    expect(delivered).toEqual({
      ok: true,
      value: { kind: "graph_report_requested", graphId: reportOwner.graphId },
    });

    const afterConsumptionRestart = makeRouter([], undefined, store).router;
    const replay = await afterConsumptionRestart.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
      inboundUserId: "user-a",
    }));
    expect(replay).toEqual({ ok: true, value: { kind: "unknown" } });
  });

  it("blocks report registration when the restored durable snapshot is malformed", () => {
    const store: GraphReportTargetStore = {
      load: () => ({ ok: true, value: [{ graphId: "missing-owner-fields" }] }),
      replace: () => ({ ok: true, value: undefined }),
    };

    const registered = makeRouter([], undefined, store).router.registerGraphReport(reportOwner);

    expect(registered).toEqual({ ok: false, error: { kind: "unavailable" } });
  });

  it("adopts a visible consumption snapshot without delivering before durability", async () => {
    let records: readonly unknown[] = [];
    let failConsumption = false;
    const store: GraphReportTargetStore = {
      load: () => ({ ok: true, value: records }),
      replace: (next) => {
        records = structuredClone(next);
        if (failConsumption && next.length === 0) {
          return {
            ok: false,
            error: { cause: new Error("directory fsync failed"), snapshot: "visible" },
          };
        }
        return { ok: true, value: undefined };
      },
    };
    const router = makeRouter([], undefined, store).router;
    const registered = router.registerGraphReport(reportOwner);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    failConsumption = true;

    const unresolved = await router.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
      inboundUserId: "user-a",
    }));
    expect(unresolved).toEqual({ ok: true, value: { kind: "unknown" } });

    const replayAfterRestart = await makeRouter([], undefined, store).router.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
      inboundUserId: "user-a",
    }));
    expect(replayAfterRestart).toEqual({ ok: true, value: { kind: "unknown" } });
  });

  it("idempotently refreshes an identical report target without changing its callback", async () => {
    const clock = createFakeClock(CREATED_AT);
    const { router } = makeRouter([], clock);
    const first = router.registerGraphReport(reportOwner);
    const refreshed = router.registerGraphReport({
      ...reportOwner,
      expiresAt: reportOwner.expiresAt + TIMEOUT_MS,
    });

    expect(first.ok).toBe(true);
    expect(refreshed.ok).toBe(true);
    if (!first.ok || !refreshed.ok) return;
    expect(refreshed.value).toBe(first.value);

    clock.advance(TIMEOUT_MS + 1);
    const routed = await router.route(inbound(refreshed.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
      inboundUserId: "user-a",
    }));
    expect(routed).toEqual({
      ok: true,
      value: {
        kind: "graph_report_requested",
        graphId: reportOwner.graphId,
      },
    });
  });

  it("fails closed when the deterministic report id conflicts with an approval id", () => {
    const first = makeRouter([]).router.registerGraphReport(reportOwner);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const shortId = first.value.split(".").at(2);
    expect(shortId).toMatch(/^[0-9A-Za-z]{12}$/);
    if (shortId === undefined) return;
    const { router } = makeRouter([makeRequest({ shortId })]);

    const conflicted = router.registerGraphReport(reportOwner);

    expect(conflicted).toEqual({ ok: false, error: { kind: "collision" } });
  });

  it("routes a registered signed report callback only for its exact owner and consumes it", async () => {
    const { router } = makeRouter([]);
    const registered = router.registerGraphReport(reportOwner);

    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value).toMatch(/^v1\.details\.[0-9A-Za-z]{12}\.[A-Za-z0-9_-]{16}$/);

    const first = await router.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
      inboundUserId: "user-a",
    }));
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value).toEqual({
        kind: "graph_report_requested",
        graphId: reportOwner.graphId,
      });
    }

    const replay = await router.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
    }));
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value).toEqual({ kind: "unknown" });
  });

  it.each([
    ["sender", {
      sessionKey: "tenant-a:other-user:chat-1:thread:thread-1",
      inboundUserId: "other-user",
    }],
    ["agent", { agentId: "agent-2" }],
    ["channel type", { channelType: "discord" }],
    ["channel route", {
      channelKey: "chat-2",
      sessionKey: "tenant-a:user-a:chat-2:thread:thread-1",
    }],
    ["thread", {
      threadId: "thread-2",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-2",
    }],
  ])("rejects an otherwise valid report callback from the wrong %s", async (_label, override) => {
    const { router } = makeRouter([]);
    const registered = router.registerGraphReport(reportOwner);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    const rejected = await router.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
      ...override,
    }));

    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).toEqual({ kind: "unknown" });

    const ownerRetry = await router.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
    }));
    expect(ownerRetry.ok).toBe(true);
    if (ownerRetry.ok) expect(ownerRetry.value.kind).toBe("graph_report_requested");
  });

  it("expires a registered report target using the injected clock", async () => {
    const clock = createFakeClock(CREATED_AT);
    const { router } = makeRouter([], clock);
    const registered = router.registerGraphReport(reportOwner);
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    clock.advance(TIMEOUT_MS);

    const result = await router.route(inbound(registered.value, {
      channelType: "telegram",
      channelKey: "chat-1",
      sessionKey: "tenant-a:user-a:chat-1:thread:thread-1",
      agentId: "agent-1",
    }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ kind: "expired" });
  });

  it("rejects registration when the route differs from the canonical owner session", () => {
    const { router } = makeRouter([]);

    const result = router.registerGraphReport({
      ...reportOwner,
      channelKey: "other-chat",
    });

    expect(result).toEqual({ ok: false, error: { kind: "invalid_owner" } });
  });
});

describe("InteractiveCallbackRouter — plain-text branch", () => {
  it("plain text cannot resolve a request owned by another user in the same channel", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);

    const res = await router.route(inbound("approve", { inboundUserId: "user-b" }));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("exactly-one pending in session + 'approve' → resolved (HMAC skipped)", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound("approve"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });
    expect(resolveCalls).toEqual([
      { requestId: REQUEST_ID, approved: true, approvedBy: "user-a", reason: undefined },
    ]);
  });

  it("exactly-one pending + 'deny' → resolved deny", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound("deny"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "deny" });
    expect(resolveCalls[0]?.approved).toBe(false);
  });

  it("case-insensitive + trimmed: '  Approve  ' resolves the sole pending request", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound("  Approve  "));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });
    expect(resolveCalls).toHaveLength(1);
  });

  it("multiple pending + 'approve' (no shortId suffix) → {kind:'ambiguous', count}", async () => {
    const second = makeRequest({ requestId: "22222222-2222-4222-8222-222222222222", shortId: "second000000" });
    const { router, resolveCalls } = makeRouter([makeRequest(), second]);
    const res = await router.route(inbound("approve"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "ambiguous", count: 2 });
    expect(resolveCalls).toHaveLength(0);
  });

  it("multiple pending + 'approve <shortId>' → resolves the matching one only", async () => {
    const second = makeRequest({ requestId: "22222222-2222-4222-8222-222222222222", shortId: "second000000" });
    const { router, resolveCalls } = makeRouter([makeRequest(), second]);
    const res = await router.route(inbound(`approve ${SHORT_ID}`));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });
    expect(resolveCalls).toEqual([
      { requestId: REQUEST_ID, approved: true, approvedBy: "user-a", reason: undefined },
    ]);
  });

  it("'approve <shortId>' whose shortId is not pending in this session → {kind:'unknown'}", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound("approve zzzzzzzzzzzz"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("none pending in session + 'approve' → {kind:'unknown'}", async () => {
    const { router, resolveCalls } = makeRouter([]);
    const res = await router.route(inbound("approve"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("'details' on the sole pending → {kind:'details_requested', requestId}; keeps pending; NOT resolved", async () => {
    const { router, resolveCalls, gate } = makeRouter([makeRequest()]);
    const res = await router.route(inbound("details"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "details_requested", requestId: REQUEST_ID });
    expect(resolveCalls).toHaveLength(0);
    expect(gate.getRequestByShortId(SHORT_ID)?.requestId).toBe(REQUEST_ID);
  });

  it("plain-text scoping: pending in ANOTHER session is not visible → 'approve' → {kind:'unknown'}", async () => {
    const otherSession = makeRequest({ sessionKey: "telegram:777:777" });
    const { router, resolveCalls } = makeRouter([otherSession]);
    const res = await router.route(inbound("approve")); // inbound sessionKey = SESSION_K
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("plain-text scoping excludes another agent's sole request in the same session", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest({ agentId: "agent-2" })]);

    const res = await router.route(inbound("approve", { agentId: "agent-1" }));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });

  it("plain-text ambiguity counts only requests owned by the inbound agent", async () => {
    const otherAgent = makeRequest({
      requestId: "22222222-2222-4222-8222-222222222222",
      shortId: "second000000",
      agentId: "agent-2",
    });
    const { router, resolveCalls } = makeRouter([makeRequest({ agentId: "agent-1" }), otherAgent]);

    const res = await router.route(inbound("approve", { agentId: "agent-1" }));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]?.requestId).toBe(REQUEST_ID);
  });

  it("rejects an unrecognized plain-text verb → {kind:'unknown'} (not a command)", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound("hello there"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "unknown" });
    expect(resolveCalls).toHaveLength(0);
  });
});

describe("InteractiveCallbackRouter — render() delegates to the core primitive", () => {
  it("render(choice, shortId) returns the v1 wire string from renderCallbackData", () => {
    const { router } = makeRouter([makeRequest()]);
    const res = router.render("approve", SHORT_ID);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const expectedHmac = signCallbackData(SECRET, "approve", SHORT_ID);
      expect(res.value).toBe(`v1.approve.${SHORT_ID}.${expectedHmac}`);
    }
  });

  it("render() surfaces the core CallbackRenderError for an invalid shortId (no duplicated crypto)", () => {
    const { router } = makeRouter([makeRequest()]);
    const res = router.render("approve", "bad shortId!");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ kind: "invalid_short_id" });
  });
});
