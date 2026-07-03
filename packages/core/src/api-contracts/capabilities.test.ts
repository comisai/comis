// SPDX-License-Identifier: Apache-2.0
/**
 * Contract test for the capabilities-domain registry.
 *
 * `capabilities.introspect` is the read-only, agent-reachable RPC that returns the
 * run's resolved caps + remaining budgets/quotas (the `whoami` surface). Pins:
 *   - the method name + the `scopes:["rpc"]` posture (agent-reachable,
 *     NOT admin, NOT cap-gated — the read-only "ungated" class),
 *   - the request is self-scoped via the dispatcher-injected `_agentId` — the
 *     contract request is `{}` and declares NO internal `_X` key (never an
 *     arbitrary `agentId` param),
 *   - the response accepts the resolved caps + the optional remaining
 *     budget/quota shapes (budget.usdRemaining nullable for the honest-degrade
 *     case),
 *   - the contract is registered in the CAPABILITIES_CONTRACTS aggregator.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  CAPABILITIES_CONTRACTS,
  CapabilitiesIntrospectContract,
  INTERNAL_FIELD_NAMES,
} from "./index.js";

describe("CAPABILITIES_CONTRACTS aggregator", () => {
  it("contains the CapabilitiesIntrospectContract", () => {
    expect(CAPABILITIES_CONTRACTS).toContain(CapabilitiesIntrospectContract);
  });

  it("every contract carries exactly one scope (single-scope invariant)", () => {
    for (const c of CAPABILITIES_CONTRACTS) {
      expect(c.scopes.length, `${c.method} must have exactly one scope`).toBe(1);
    }
  });

  it("no contract request schema declares a dispatcher-injected internal field", () => {
    const internal = new Set<string>(INTERNAL_FIELD_NAMES);
    for (const c of CAPABILITIES_CONTRACTS) {
      // All capabilities contracts use a tight z.object request (not a loose
      // record), so .shape is available for the internal-field check.
      const shape = (c.request as { shape?: Record<string, unknown> }).shape;
      if (shape === undefined) continue;
      for (const key of Object.keys(shape)) {
        expect(internal.has(key), `${c.method} request must not declare internal "${key}"`).toBe(false);
      }
    }
  });
});

describe("CapabilitiesIntrospectContract", () => {
  it("declares method capabilities.introspect", () => {
    expect(CapabilitiesIntrospectContract.method).toBe("capabilities.introspect");
  });

  it("is scopes:['rpc'] — agent-reachable, NOT admin, NOT cap-gated", () => {
    expect(CapabilitiesIntrospectContract.scopes).toEqual(["rpc"]);
  });

  it("request is self-scoped: it parses {} (the _agentId rides in dispatcher-injected, NOT declared)", () => {
    expect(CapabilitiesIntrospectContract.request.parse({})).toEqual({});
  });

  it("response accepts the resolved caps + remaining budget/quota shape", () => {
    const ok = CapabilitiesIntrospectContract.response.parse({
      agentId: "agent-1",
      enabled: true,
      caps: ["orch:spawn", "orch:message"],
      budget: {
        tokensRemaining: 900,
        wallClockMsRemaining: 50_000,
        usdRemaining: 6,
      },
      outwardQuota: { perHourRemaining: 4 },
    });
    expect(ok.agentId).toBe("agent-1");
    expect(ok.enabled).toBe(true);
    expect(ok.caps).toEqual(["orch:spawn", "orch:message"]);
    expect(ok.budget?.usdRemaining).toBe(6);
    expect(ok.outwardQuota?.perHourRemaining).toBe(4);
  });

  it("response budget/outwardQuota are OPTIONAL (absent when no rootRunId is live, pre-spawn)", () => {
    const minimal = CapabilitiesIntrospectContract.response.parse({
      agentId: "agent-2",
      enabled: false,
      caps: [],
    });
    expect(minimal.agentId).toBe("agent-2");
    expect(minimal.enabled).toBe(false);
    expect(minimal.caps).toEqual([]);
    expect(minimal.budget).toBeUndefined();
    expect(minimal.outwardQuota).toBeUndefined();
  });

  it("response REQUIRES the enabled flag (a disabled/assistant agent gets {enabled:false}, not Unknown-method)", () => {
    // The handler is registered UNCONDITIONALLY (not gated on bounded-autonomy),
    // so the response always carries the caller's resolved autonomy.enabled — an
    // absent enabled is a contract violation, never a silent default.
    expect(
      CapabilitiesIntrospectContract.response.safeParse({
        agentId: "agent-x",
        caps: [],
      }).success,
    ).toBe(false);
  });

  it("response accepts a NULL usdRemaining (the honest-degrade unpriceable case)", () => {
    const degraded = CapabilitiesIntrospectContract.response.parse({
      agentId: "agent-3",
      enabled: true,
      caps: [],
      budget: {
        tokensRemaining: 1000,
        wallClockMsRemaining: 60_000,
        usdRemaining: null,
      },
    });
    expect(degraded.budget?.usdRemaining).toBeNull();
  });

  it("response REJECTS a non-array caps (a representative shape mismatch)", () => {
    expect(
      CapabilitiesIntrospectContract.response.safeParse({
        agentId: "agent-4",
        caps: "orch:spawn",
      }).success,
    ).toBe(false);
  });
});
