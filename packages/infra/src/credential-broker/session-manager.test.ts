// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for SessionManager — token lifecycle.
 *
 * RED-first TDD: these tests are written before the implementation.
 * Security invariants tested: single-use semantics, timing-safe comparison
 * (length-guard prevents throw), endSession invalidation, TTL reaper.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createSessionManager } from "./session-manager.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

function makeDeps(overrides?: { sessionTtlMs?: number }) {
  const clock = createFakeClock(1_700_000_000_000);
  return {
    clock,
    ...(overrides?.sessionTtlMs !== undefined ? { sessionTtlMs: overrides.sessionTtlMs } : {}),
  };
}

describe("SessionManager — token issuance", () => {
  it("issueToken returns an object with sessionId and proxyToken fields", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    const issued = mgr.issueToken("agent-1");
    expect(issued).toHaveProperty("sessionId");
    expect(issued).toHaveProperty("proxyToken");
  });

  it("proxyToken is a non-empty base64url string (no padding, URL-safe chars only)", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    const { proxyToken } = mgr.issueToken("agent-1");
    expect(proxyToken).toBeTruthy();
    expect(typeof proxyToken).toBe("string");
    // base64url: only A-Z a-z 0-9 - _  (no + / = padding)
    expect(proxyToken).toMatch(/^[A-Za-z0-9\-_]+$/);
    // 48 bytes → 64 base64url chars (no padding)
    expect(proxyToken.length).toBe(64);
  });

  it("two issueToken calls return different sessionIds and different proxyTokens", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    const first = mgr.issueToken("agent-1");
    const second = mgr.issueToken("agent-2");
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.proxyToken).not.toBe(second.proxyToken);
  });
});

describe("SessionManager — consumeToken happy path", () => {
  it("consumeToken returns SessionInfo with sessionId and agentId after issueToken", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    const { sessionId, proxyToken } = mgr.issueToken("agent-1");
    const result = mgr.consumeToken(proxyToken);
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(sessionId);
    expect(result?.agentId).toBe("agent-1");
  });
});

describe("SessionManager — consumeToken security invariants", () => {
  it("consumeToken with empty string returns null and does not throw", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    mgr.issueToken("agent-1");
    expect(() => mgr.consumeToken("")).not.toThrow();
    expect(mgr.consumeToken("")).toBeNull();
  });

  it("consumeToken with a forged token (different random bytes) returns null", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    mgr.issueToken("agent-1");
    // A fresh token from issueToken is guaranteed distinct from the stored one
    const { proxyToken: forgery } = mgr.issueToken("attacker");
    // Now remove the attacker session so that only agent-1's session remains,
    // and try to use attacker's token against agent-1's slot — it must fail
    const forgedResult = mgr.consumeToken(forgery);
    // The forged token might match the attacker session (which is valid) — the point
    // is that a completely random 48-byte forgery against a *consumed* / *nonexistent*
    // session returns null.  Use a truly random token that was never issued:
    const neverIssued =
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(mgr.consumeToken(neverIssued)).toBeNull();
    void forgedResult; // suppress unused
  });

  it("consumeToken with a SHORTER token returns null and does not throw (length-guard before timingSafeEqual)", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    mgr.issueToken("agent-1");
    const shortToken = "abc"; // far shorter than 64-char base64url
    expect(() => mgr.consumeToken(shortToken)).not.toThrow();
    expect(mgr.consumeToken(shortToken)).toBeNull();
  });

  it("consumeToken with a LONGER token returns null and does not throw (length-guard before timingSafeEqual)", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    mgr.issueToken("agent-1");
    // 128 base64url chars — double-length
    const longToken = "A".repeat(128);
    expect(() => mgr.consumeToken(longToken)).not.toThrow();
    expect(mgr.consumeToken(longToken)).toBeNull();
  });
});

describe("SessionManager — single-use semantics", () => {
  it("consumeToken with the correct token a second time returns null (already consumed)", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    const { proxyToken } = mgr.issueToken("agent-1");
    const first = mgr.consumeToken(proxyToken);
    expect(first).not.toBeNull();
    const second = mgr.consumeToken(proxyToken);
    expect(second).toBeNull();
  });

  it("consumeToken after endSession returns null (token invalidated)", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    const { sessionId, proxyToken } = mgr.issueToken("agent-1");
    mgr.endSession(sessionId);
    expect(mgr.consumeToken(proxyToken)).toBeNull();
  });
});

describe("SessionManager — endSession", () => {
  it("endSession with an unknown sessionId does nothing and does not throw", () => {
    const deps = makeDeps();
    const mgr = createSessionManager(deps);
    expect(() => mgr.endSession("no-such-session-id")).not.toThrow();
  });
});

describe("SessionManager — TTL reaper (lazy eviction at consumeToken time)", () => {
  it("consumeToken with a valid token JUST BEFORE TTL elapsed returns SessionInfo (still valid)", () => {
    const deps = makeDeps({ sessionTtlMs: 1000 });
    const mgr = createSessionManager(deps);
    const { proxyToken } = mgr.issueToken("agent-1");
    deps.clock.advance(999); // 1 ms before expiry
    const result = mgr.consumeToken(proxyToken);
    expect(result).not.toBeNull();
  });

  it("consumeToken with a valid token AFTER TTL elapsed returns null (expired)", () => {
    const deps = makeDeps({ sessionTtlMs: 1000 });
    const mgr = createSessionManager(deps);
    const { proxyToken } = mgr.issueToken("agent-1");
    deps.clock.advance(1001); // 1 ms past expiry
    expect(mgr.consumeToken(proxyToken)).toBeNull();
  });

  it("clock.advance(ttlMs + 1) triggers eviction; advance(ttlMs - 1) does not", () => {
    const ttlMs = 500;
    // Case A: exactly ttlMs - 1 → valid
    const depsA = makeDeps({ sessionTtlMs: ttlMs });
    const mgrA = createSessionManager(depsA);
    const { proxyToken: tokenA } = mgrA.issueToken("agent-a");
    depsA.clock.advance(ttlMs - 1);
    expect(mgrA.consumeToken(tokenA)).not.toBeNull();

    // Case B: ttlMs + 1 → evicted
    const depsB = makeDeps({ sessionTtlMs: ttlMs });
    const mgrB = createSessionManager(depsB);
    const { proxyToken: tokenB } = mgrB.issueToken("agent-b");
    depsB.clock.advance(ttlMs + 1);
    expect(mgrB.consumeToken(tokenB)).toBeNull();
  });
});
