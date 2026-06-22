// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for LeaseManager — the run-scoped, multi-use, revocable,
 * audience-bound capability lease (LEASE-01 / LEASE-02 / LEASE-03).
 *
 * RED-first TDD: written before `lease-manager.ts` exists, so the import
 * fails and the suite is RED on pre-patch code.
 *
 * Security invariants tested:
 *   - LEASE-01 multi-use: a minted lease validates more than once (NOT
 *     consumed on first use, unlike SessionManager).
 *   - LEASE-02 renew is clamped to maxExpiresAt; a renew at/past the ceiling
 *     is denied; revoke gates BOTH validate and renew.
 *   - LEASE-03 audience binding (RFC 8707): a captured lease replayed at a
 *     method whose cap it does not hold is denied.
 *   - timing-safe compare: empty / short / wrong-but-right-length bearers are
 *     rejected by the length-guarded timingSafeEqual without throwing.
 *   - lazy TTL: a lease past its hard expiry is evicted at validate time.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createLeaseManager } from "./lease-manager.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import type { AgentCapability } from "@comis/core";

const NOW0 = 1_700_000_000_000;

function makeDeps(overrides?: { defaultTtlMs?: number }) {
  const clock = createFakeClock(NOW0);
  return {
    clock,
    ...(overrides?.defaultTtlMs !== undefined
      ? { defaultTtlMs: overrides.defaultTtlMs }
      : {}),
  };
}

function baseInput(caps: readonly AgentCapability[]) {
  return {
    agentId: "agent-1",
    caps,
    budgetRef: "budget-1",
    sessionKey: "session-1",
    rootRunId: "run-1",
  };
}

describe("LeaseManager — mintLease (LEASE-01 record shape)", () => {
  it("returns an IssuedLease carrying a leaseId and a non-empty base64url bearer", () => {
    const mgr = createLeaseManager(makeDeps());
    const issued = mgr.mintLease(baseInput(["orch:read"]));
    expect(issued).toHaveProperty("leaseId");
    expect(issued).toHaveProperty("bearer");
    expect(issued.bearer).toBeTruthy();
    expect(issued.bearer).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("mints distinct leaseIds and distinct bearers across two calls", () => {
    const mgr = createLeaseManager(makeDeps());
    const a = mgr.mintLease(baseInput(["orch:read"]));
    const b = mgr.mintLease(baseInput(["orch:graph"]));
    expect(a.leaseId).not.toBe(b.leaseId);
    expect(a.bearer).not.toBe(b.bearer);
  });

  it("validate returns a LeaseInfo projection exposing leaseId, agentId, caps and rootRunId", () => {
    const mgr = createLeaseManager(makeDeps());
    const issued = mgr.mintLease({
      ...baseInput(["orch:graph"]),
      parentLeaseId: "parent-1",
    });
    const info = mgr.validate(issued.bearer, "graph.execute");
    expect(info).not.toBeNull();
    expect(info?.leaseId).toBe(issued.leaseId);
    expect(info?.agentId).toBe("agent-1");
    expect(info?.caps).toEqual(["orch:graph"]);
    expect(info?.rootRunId).toBe("run-1");
    expect(info?.budgetRef).toBe("budget-1");
    expect(info?.sessionKey).toBe("session-1");
    expect(info?.parentLeaseId).toBe("parent-1");
  });
});

describe("LeaseManager — multi-use semantics (LEASE-01)", () => {
  it("validate succeeds a SECOND time with the same bearer (lease is not consumed)", () => {
    const mgr = createLeaseManager(makeDeps());
    const { bearer } = mgr.mintLease(baseInput(["orch:message"]));
    const first = mgr.validate(bearer, "message.send");
    const second = mgr.validate(bearer, "message.send");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.agentId).toBe("agent-1");
  });
});

describe("LeaseManager — audience binding (LEASE-03)", () => {
  it("denies a method whose required cap is outside the lease audience", () => {
    const mgr = createLeaseManager(makeDeps());
    // caps grant orch:read only; message.send maps to orch:message ∉ caps.
    const { bearer } = mgr.mintLease(baseInput(["orch:read"]));
    expect(mgr.validate(bearer, "message.send")).toBeNull();
  });

  it("allows a method whose required cap is held in the lease audience", () => {
    const mgr = createLeaseManager(makeDeps());
    const { bearer } = mgr.mintLease(baseInput(["orch:graph"]));
    expect(mgr.validate(bearer, "graph.execute")).not.toBeNull();
  });

  it("denies a deny-by-origin classified method even with broad caps", () => {
    const mgr = createLeaseManager(makeDeps());
    // session.delete is "deny-by-origin" (not an orch:* cap) → never in audience.
    const { bearer } = mgr.mintLease(baseInput(["orch:spawn"]));
    expect(mgr.validate(bearer, "session.delete")).toBeNull();
  });

  it("denies an ungated read-only method (no orch cap → outside audience)", () => {
    const mgr = createLeaseManager(makeDeps());
    // graph.list is "ungated" — not cap-valued, so it is not lease-grantable.
    const { bearer } = mgr.mintLease(baseInput(["orch:graph"]));
    expect(mgr.validate(bearer, "graph.list")).toBeNull();
  });

  it("denies an entirely unknown method that is absent from the capability map", () => {
    const mgr = createLeaseManager(makeDeps());
    const { bearer } = mgr.mintLease(baseInput(["orch:graph"]));
    expect(mgr.validate(bearer, "totally.unknown.method")).toBeNull();
  });
});

describe("LeaseManager — timing-safe rejection (no throw)", () => {
  it("validate with an empty bearer returns null and does not throw", () => {
    const mgr = createLeaseManager(makeDeps());
    mgr.mintLease(baseInput(["orch:read"]));
    expect(() => mgr.validate("", "session.spawn")).not.toThrow();
    expect(mgr.validate("", "session.spawn")).toBeNull();
  });

  it("validate with a SHORTER bearer returns null via the length-guard (no throw)", () => {
    const mgr = createLeaseManager(makeDeps());
    mgr.mintLease(baseInput(["orch:read"]));
    expect(() => mgr.validate("abc", "session.spawn")).not.toThrow();
    expect(mgr.validate("abc", "session.spawn")).toBeNull();
  });

  it("validate with a LONGER bearer returns null via the length-guard (no throw)", () => {
    const mgr = createLeaseManager(makeDeps());
    mgr.mintLease(baseInput(["orch:read"]));
    const long = "A".repeat(128);
    expect(() => mgr.validate(long, "session.spawn")).not.toThrow();
    expect(mgr.validate(long, "session.spawn")).toBeNull();
  });

  it("validate with a wrong-but-right-length bearer returns null without throwing", () => {
    const mgr = createLeaseManager(makeDeps());
    const { bearer } = mgr.mintLease(baseInput(["orch:read"]));
    // Same character length as a real 48-byte base64url bearer, but never minted.
    const forged = "A".repeat(bearer.length);
    expect(() => mgr.validate(forged, "session.spawn")).not.toThrow();
    expect(mgr.validate(forged, "session.spawn")).toBeNull();
  });
});

describe("LeaseManager — revocation gates both paths (LEASE-02)", () => {
  it("denies the next validate after revoke(leaseId)", () => {
    const mgr = createLeaseManager(makeDeps());
    const { leaseId, bearer } = mgr.mintLease(baseInput(["orch:read"]));
    // sanity: valid before revoke
    expect(mgr.validate(bearer, "session.spawn")).toBeNull(); // read cap, not spawn
    const readMethodLease = mgr.mintLease(baseInput(["orch:spawn"]));
    expect(mgr.validate(readMethodLease.bearer, "session.spawn")).not.toBeNull();
    mgr.revoke(leaseId);
    expect(mgr.validate(bearer, "session.spawn")).toBeNull();
  });

  it("validate is denied after the lease that authorized it is revoked", () => {
    const mgr = createLeaseManager(makeDeps());
    const { leaseId, bearer } = mgr.mintLease(baseInput(["orch:graph"]));
    expect(mgr.validate(bearer, "graph.execute")).not.toBeNull();
    mgr.revoke(leaseId);
    expect(mgr.validate(bearer, "graph.execute")).toBeNull();
  });

  it("denies renew after revoke (revocation gates renew, not only validate)", () => {
    const mgr = createLeaseManager(makeDeps());
    const { leaseId } = mgr.mintLease(baseInput(["orch:graph"]));
    mgr.revoke(leaseId);
    expect(mgr.renew(leaseId)).toBeNull();
  });

  it("revoke on an unknown leaseId is a no-op and does not throw", () => {
    const mgr = createLeaseManager(makeDeps());
    expect(() => mgr.revoke("no-such-lease")).not.toThrow();
  });
});

describe("LeaseManager — renew clamps to maxExpiresAt (LEASE-02)", () => {
  it("renew clamps the new expiry to maxExpiresAt when now+ttl would exceed it", () => {
    const deps = makeDeps({ defaultTtlMs: 1000 });
    const mgr = createLeaseManager(deps);
    // ttl 1000, maxTtl 1500 → maxExpiresAt = NOW0 + 1500.
    const { leaseId } = mgr.mintLease({
      ...baseInput(["orch:graph"]),
      ttlMs: 1000,
      maxTtlMs: 1500,
    });
    deps.clock.advance(800); // now = NOW0 + 800; candidate = now + 1000 = NOW0 + 1800 > max
    const renewed = mgr.renew(leaseId);
    expect(renewed).not.toBeNull();
    expect(renewed?.expiresAtMs).toBe(NOW0 + 1500); // clamped to maxExpiresAt
  });

  it("renew sets the new expiry to now+ttl when that is below maxExpiresAt", () => {
    const deps = makeDeps({ defaultTtlMs: 1000 });
    const mgr = createLeaseManager(deps);
    const { leaseId } = mgr.mintLease({
      ...baseInput(["orch:graph"]),
      ttlMs: 500,
      maxTtlMs: 10_000,
    });
    deps.clock.advance(200); // now = NOW0 + 200; candidate = now + 1000 = NOW0 + 1200 < max
    const renewed = mgr.renew(leaseId);
    expect(renewed?.expiresAtMs).toBe(NOW0 + 1200);
  });

  it("denies renew once the clock is at/past maxExpiresAt", () => {
    const deps = makeDeps({ defaultTtlMs: 1000 });
    const mgr = createLeaseManager(deps);
    const { leaseId } = mgr.mintLease({
      ...baseInput(["orch:graph"]),
      ttlMs: 500,
      maxTtlMs: 1000,
    });
    deps.clock.advance(1000); // now === maxExpiresAt
    expect(mgr.renew(leaseId)).toBeNull();
  });

  it("denies renew on an unknown leaseId (returns null)", () => {
    const mgr = createLeaseManager(makeDeps());
    expect(mgr.renew("no-such-lease")).toBeNull();
  });
});

describe("LeaseManager — expiry, lazy TTL eviction and renew-revival", () => {
  it("denies validate once the lease is past its (soft) expiry", () => {
    const deps = makeDeps({ defaultTtlMs: 1000 });
    const mgr = createLeaseManager(deps);
    const { bearer } = mgr.mintLease({
      ...baseInput(["orch:graph"]),
      ttlMs: 1000,
      maxTtlMs: 10_000,
    });
    deps.clock.advance(1001); // past expiresAt, before maxExpiresAt
    expect(mgr.validate(bearer, "graph.execute")).toBeNull();
  });

  it("validates a lease one tick BEFORE its expiry (still live)", () => {
    const deps = makeDeps({ defaultTtlMs: 1000 });
    const mgr = createLeaseManager(deps);
    const { bearer } = mgr.mintLease({
      ...baseInput(["orch:graph"]),
      ttlMs: 1000,
      maxTtlMs: 10_000,
    });
    deps.clock.advance(999);
    expect(mgr.validate(bearer, "graph.execute")).not.toBeNull();
  });

  it("renew before maxExpiresAt revives a soft-expired lease so validate succeeds again", () => {
    const deps = makeDeps({ defaultTtlMs: 1000 });
    const mgr = createLeaseManager(deps);
    const { leaseId, bearer } = mgr.mintLease({
      ...baseInput(["orch:graph"]),
      ttlMs: 1000,
      maxTtlMs: 10_000,
    });
    deps.clock.advance(1500); // soft-expired
    expect(mgr.validate(bearer, "graph.execute")).toBeNull();
    const renewed = mgr.renew(leaseId); // now + 1000 = NOW0 + 2500 < max
    expect(renewed?.expiresAtMs).toBe(NOW0 + 2500);
    expect(mgr.validate(bearer, "graph.execute")).not.toBeNull();
  });

  it("evicts a hard-expired lease at validate time so renew can no longer find it", () => {
    const deps = makeDeps({ defaultTtlMs: 1000 });
    const mgr = createLeaseManager(deps);
    const { leaseId, bearer } = mgr.mintLease({
      ...baseInput(["orch:graph"]),
      ttlMs: 1000,
      maxTtlMs: 2000,
    });
    deps.clock.advance(2001); // past maxExpiresAt — hard expiry
    expect(mgr.validate(bearer, "graph.execute")).toBeNull();
    // The lazy-TTL reaper deleted the entry → renew finds nothing.
    expect(mgr.renew(leaseId)).toBeNull();
  });
});
