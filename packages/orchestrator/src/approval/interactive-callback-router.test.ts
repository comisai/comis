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
 *   3. req.sessionKey !== inbound.sessionKey       → unknown (cross-session guard)
 *   4. clock.now() >= createdAt + timeoutMs        → expired (derived expiresAt, injected clock)
 *   5. !verifyCallbackData(...)                     → invalid_signature (constant-time, no throw)
 *   6. details → details_requested (no resolve); approve/deny → resolveApproval + resolved
 *
 * Plain-text branch: pendingForSession + case-insensitive verb (+ optional shortId
 * suffix); exactly-one → resolve; multiple-no-suffix → ambiguous; none → unknown. HMAC skipped
 * for this branch only; replay protection still from pending-table removal.
 */
import { describe, it, expect } from "vitest";
import { signCallbackData } from "@comis/core";
import type { ApprovalRequest, ApprovalGate, ClockPort } from "@comis/core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import {
  createInteractiveCallbackRouter,
  type InboundCallback,
} from "./interactive-callback-router.js";

const SECRET = "test-signing-secret-32-bytes-aaaaaaaaaaaa";
const SHORT_ID = "abc123XYZ789"; // 12 base62 chars
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_K = "telegram:123:456";
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
    createdAt: CREATED_AT,
    timeoutMs: TIMEOUT_MS,
    ...over,
  };
}

/** Compose a valid signed wire payload for the seeded request. */
function signedPayload(choice: "approve" | "deny" | "details", shortId = SHORT_ID): string {
  const hmac = signCallbackData(SECRET, choice, shortId);
  return `v1.${choice}.${shortId}.${hmac}`;
}

function inbound(rawData: string, over: Partial<InboundCallback> = {}): InboundCallback {
  return {
    channelType: "telegram",
    channelKey: "telegram:123:456",
    agentId: "agent-1",
    sessionKey: SESSION_K,
    rawData,
    inboundUserId: "chat:operator",
    ...over,
  };
}

function makeRouter(seed: ApprovalRequest[], clock?: ClockPort) {
  const { gate, resolveCalls } = makeFakeGate(seed);
  const router = createInteractiveCallbackRouter({
    gate,
    getSecret: () => SECRET,
    clock: clock ?? createFakeClock(CREATED_AT), // before expiry
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
      { requestId: REQUEST_ID, approved: true, approvedBy: "chat:operator", reason: undefined },
    ]);
  });

  it("resolved deny: valid callback → {kind:'resolved', requestId, choice:'deny'} with resolveApproval(requestId, false, inboundUserId)", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound(signedPayload("deny")));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "deny" });
    expect(resolveCalls).toEqual([
      { requestId: REQUEST_ID, approved: false, approvedBy: "chat:operator", reason: undefined },
    ]);
  });

  it("resolved: falls back to 'chat:unknown' approvedBy when inboundUserId is absent", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound(signedPayload("approve"), { inboundUserId: undefined }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });
    expect(resolveCalls[0]?.approvedBy).toBe("chat:unknown");
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

describe("InteractiveCallbackRouter — plain-text branch", () => {
  it("exactly-one pending in session + 'approve' → resolved (HMAC skipped)", async () => {
    const { router, resolveCalls } = makeRouter([makeRequest()]);
    const res = await router.route(inbound("approve"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ kind: "resolved", requestId: REQUEST_ID, choice: "approve" });
    expect(resolveCalls).toEqual([
      { requestId: REQUEST_ID, approved: true, approvedBy: "chat:operator", reason: undefined },
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
      { requestId: REQUEST_ID, approved: true, approvedBy: "chat:operator", reason: undefined },
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
