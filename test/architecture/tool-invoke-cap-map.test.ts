// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture gate: the `tool.invoke` capability-map ↔ denylist ↔ contract
 * registry invariants (the denylist and compile-time route-registration
 * catches).
 *
 * TOOL_CAPABILITY_MAP is the curated allow-list feeding FOUR consumers that
 * must never drift — the gate, the lease audience, the SDK codegen, and these
 * arch-tests. This test pins, against the COMPILED runtime values (the actual
 * `TOOL_CAPABILITY_MAP`/`TOOL_ROUTE_MAP`/`SUB_AGENT_TOOL_DENYLIST`/
 * `API_CONTRACTS_ORDERED` from `@comis/core`, NOT source AST):
 *
 *   (a) no capability-mapped tool is in `SUB_AGENT_TOOL_DENYLIST`
 *       (a denylisted admin/destructive tool must never reach the curated
 *       surface). The module-load assertion in `tool-capability-map.ts` also
 *       fails the build at import; this is the build-time tripwire.
 *   (b) `mcp_manage`/`mcp_login` are NOT cap-mapped (admin-ish → unreachable).
 *   (c) every capability-mapped tool has a `TOOL_ROUTE_MAP` route (completeness).
 *   (d) every `{kind:"rpc"}` route targets a REGISTERED contract method
 *       (a member of `API_CONTRACTS_ORDERED`). This converts a non-existent-method
 *       route (the `session.get` 404 class) from a VPS-only
 *       runtime failure into a `pnpm validate` BUILD failure.
 *
 * It imports the COMPILED `@comis/core` (vitest alias → core/dist) — same
 * rationale as `gated-handlers-require-capability.test.ts`: the contract
 * registry is a runtime closed set, not source AST.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  TOOL_CAPABILITY_MAP,
  TOOL_ROUTE_MAP,
  SUB_AGENT_TOOL_DENYLIST,
  API_CONTRACTS_ORDERED,
  RESULT_REF_THRESHOLDS,
  shouldMaterialize,
} from "@comis/core";
// The daemon-side tables the INV-3 keystone + the orch:mcp audit class read (the
// COMPILED @comis/daemon barrel — the cap socket's own closed-door source, so the
// proof can never drift from a hand-copied literal; same rationale as the
// @comis/core runtime-value imports above, and as comis-agent-same-gate's
// DENYLISTED_RPC_METHODS import). Named imports so the public-export-consumers gate
// sees these barrel exports have an in-repo consumer.
import { DENYLISTED_RPC_METHODS, CAPABILITY_ACTION_CLASS } from "@comis/daemon";

describe("tool.invoke capability-map ↔ denylist ↔ contract registry", () => {
  it("no capability-mapped tool appears in the sub-agent denylist", () => {
    const denylisted = Object.keys(TOOL_CAPABILITY_MAP).filter((tool) =>
      SUB_AGENT_TOOL_DENYLIST.has(tool),
    );
    expect(
      denylisted,
      `cap-mapped tools that are also denylisted (must never reach the curated surface): ${JSON.stringify(denylisted)}`,
    ).toEqual([]);
  });

  it("mcp_manage and mcp_login stay off the capability surface", () => {
    const map = TOOL_CAPABILITY_MAP as Record<string, unknown>;
    expect(map.mcp_manage).toBeUndefined();
    expect(map.mcp_login).toBeUndefined();
  });

  it("every capability-mapped tool has a dispatch route", () => {
    const route = TOOL_ROUTE_MAP as Record<string, unknown>;
    const missingRoute = Object.keys(TOOL_CAPABILITY_MAP).filter(
      (tool) => !(tool in route),
    );
    expect(
      missingRoute,
      `cap-mapped tools without a TOOL_ROUTE_MAP entry: ${JSON.stringify(missingRoute)}`,
    ).toEqual([]);
  });

  it("every rpc-routed tool targets a registered contract method", () => {
    const registered = new Set(API_CONTRACTS_ORDERED.map((c) => c.method));
    const rpcRoutes = Object.entries(TOOL_ROUTE_MAP)
      .filter(([, r]) => r.kind === "rpc")
      .map(([tool, r]) => [tool, (r as { method: string }).method] as const);
    // sanity: the curated surface actually carries rpc routes (so the assertion
    // below is not vacuously true).
    expect(rpcRoutes.length).toBeGreaterThan(0);
    const missing = rpcRoutes.filter(([, method]) => !registered.has(method));
    expect(
      missing,
      `rpc routes point at unregistered methods (the session.get 404 class): ${JSON.stringify(missing)}`,
    ).toEqual([]);
  });
});

describe("orch:mcp cap birth: ResultRef offload threshold + audit action class", () => {
  it("registers an mcp ResultRef threshold at 15_000 bytes", () => {
    // A large/hostile MCP return must offload to a handle rather than blow context.
    expect(RESULT_REF_THRESHOLDS.mcp).toBe(15_000);
  });

  it("offloads an over-threshold MCP return but keeps an at-threshold one inline (strict >)", () => {
    expect(shouldMaterialize("mcp", 15_001)).toBe(true);
    expect(shouldMaterialize("mcp", 15_000)).toBe(false);
  });

  it("classifies orch:mcp as a 'read' action in CAPABILITY_ACTION_CLASS", () => {
    // The Record<AgentCapability,…> is exhaustive, so a new union member is a
    // COMPILE-visible gap here; this pins the resolved class (MCP calls observe).
    expect(CAPABILITY_ACTION_CLASS["orch:mcp"]).toBe("read");
  });
});

describe("INV-3: the MCP control plane stays unreachable through the cap surface", () => {
  it("mcp_manage, mcp_login, and the bare 'mcp' control name are absent from TOOL_CAPABILITY_MAP", () => {
    // AUTHORITATIVE gate: default-deny by absence. A tool absent from the curated
    // allow-list has no cap to resolve and cannot be rendered by the SDK — so the
    // control plane is undispatchable through the endpoint regardless of any lease.
    // NB: the fixed literal "mcp" tool (the dynamic MCP surface) is NOT born in
    // this plan — its cap-map entry + executor route arrive with the dispatch shape
    // later; until then it too must stay unreachable by absence.
    const map = TOOL_CAPABILITY_MAP as Record<string, unknown>;
    for (const name of ["mcp_manage", "mcp_login", "mcp"]) {
      expect(
        map[name],
        `${name} must NOT be a TOOL_CAPABILITY_MAP key (default-deny by absence)`,
      ).toBeUndefined();
    }
  });

  it("mcp_manage AND mcp_login are both in SUB_AGENT_TOOL_DENYLIST (defense-in-depth)", () => {
    expect(SUB_AGENT_TOOL_DENYLIST.has("mcp_manage")).toBe(true);
    expect(SUB_AGENT_TOOL_DENYLIST.has("mcp_login")).toBe(true);
  });

  it("the mcp.* control-plane methods are denylisted and each maps to a denylisted tool", () => {
    // DEFENSE-IN-DEPTH: the RPC pre-check denies these methods BEFORE lease validate.
    // The module-load soundness loop already guarantees every VALUE is a denylist
    // member; this re-proves the mcp.* rows exist and point at the owning tool.
    const expected: Readonly<Record<string, string>> = {
      "mcp.connect": "mcp_manage",
      "mcp.disconnect": "mcp_manage",
      "mcp.reconnect": "mcp_manage",
      "mcp.oauth_login": "mcp_login",
    };
    for (const [method, owningTool] of Object.entries(expected)) {
      const mapped = DENYLISTED_RPC_METHODS[method];
      expect(mapped, `${method} must be a DENYLISTED_RPC_METHODS key`).toBe(owningTool);
      expect(
        SUB_AGENT_TOOL_DENYLIST.has(mapped ?? ""),
        `${method} → ${mapped} must be a SUB_AGENT_TOOL_DENYLIST member (soundness)`,
      ).toBe(true);
    }
  });
});
