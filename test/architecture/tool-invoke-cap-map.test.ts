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
} from "@comis/core";

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
