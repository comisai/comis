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
  resolveAutonomy,
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

describe("MCP-01: the dynamic mcp tool is cap-mapped + executor-routed", () => {
  it("maps the fixed literal `mcp` tool to orch:mcp (the {server,tool} ride inside args)", () => {
    // The wire tool name is the fixed literal "mcp"; the dynamic {server,tool} pair
    // is DATA inside args, never a new cap-map key — one entry governs the whole
    // runtime-dynamic namespace.
    expect((TOOL_CAPABILITY_MAP as Record<string, unknown>).mcp).toBe("orch:mcp");
  });

  it("routes `mcp` to the daemon-side executor (net-needing, mirrors web_fetch)", () => {
    // The jail stays --unshare-net; the MCP call runs daemon-side like web_fetch.
    expect((TOOL_ROUTE_MAP as Record<string, unknown>).mcp).toEqual({ kind: "executor" });
  });

  it("keeps cap-map ↔ route ↔ denylist soundness with mcp present (the import-time assertion held)", () => {
    // assertToolMapSoundness runs at module import; a throw would have failed this
    // whole file's import. Re-pin the invariant it guards for `mcp`: it is cap-mapped,
    // has exactly one route, and is NOT on the admin/destructive denylist.
    const cap = TOOL_CAPABILITY_MAP as Record<string, unknown>;
    const route = TOOL_ROUTE_MAP as Record<string, unknown>;
    expect("mcp" in cap && "mcp" in route).toBe(true);
    expect(SUB_AGENT_TOOL_DENYLIST.has("mcp")).toBe(false);
  });
});

describe("MUT-01: the write tool is cap-mapped + executor-routed (the first mutating builtin)", () => {
  it("maps the `write` tool to orch:write (the dispatch shape that did not exist before)", () => {
    // At HEAD orch:write was cap-ONLY (a union member + toggle + floor + audit
    // class) with NO tool dispatching it. This entry CREATES the dispatch shape:
    // the endpoint gates the write tool on requireCapability(orch:write).
    expect((TOOL_CAPABILITY_MAP as Record<string, unknown>).write).toBe("orch:write");
  });

  it("routes `write` to the daemon-side executor (the workspace-confined write core, mirrors the file builtins)", () => {
    // The write core runs daemon-side over the lease's resolved workspace, path-
    // confined by safePath — NOT an RPC method. Same route kind as read/grep/jq.
    expect((TOOL_ROUTE_MAP as Record<string, unknown>).write).toEqual({ kind: "executor" });
  });

  it("keeps cap-map ↔ route ↔ denylist soundness with write present (the import-time assertion held)", () => {
    // assertToolMapSoundness runs at import; a throw would have failed this file's
    // import. Re-pin the invariant for `write`: cap-mapped, exactly one route, and
    // NOT on the admin/destructive denylist (a write core is reversible-ish + jailed).
    const cap = TOOL_CAPABILITY_MAP as Record<string, unknown>;
    const route = TOOL_ROUTE_MAP as Record<string, unknown>;
    expect("write" in cap && "write" in route).toBe(true);
    expect(SUB_AGENT_TOOL_DENYLIST.has("write")).toBe(false);
  });
});

describe("RESUME-01: checkpoint/resume are cap-mapped to the FLOOR caps + executor-routed (no new cap)", () => {
  it("maps `checkpoint` to orch:write and `resume` to orch:read (REUSE the floor caps, adopted Open Q1)", () => {
    // The durable specialized writing pair reuses the existing floor caps rather
    // than minting an orch:checkpoint cap (avoids the 5-consumer fan-out); the
    // authoritative gate is the daemon-side orchestrateResumeEnabled surface
    // predicate (default-off autonomy.durability.orchestrateResume), NOT the cap.
    const cap = TOOL_CAPABILITY_MAP as Record<string, unknown>;
    expect(cap.checkpoint).toBe("orch:write");
    expect(cap.resume).toBe("orch:read");
  });

  it("routes `checkpoint` and `resume` to the daemon-side executor (mirrors the file builtins / write)", () => {
    const route = TOOL_ROUTE_MAP as Record<string, unknown>;
    expect(route.checkpoint).toEqual({ kind: "executor" });
    expect(route.resume).toEqual({ kind: "executor" });
  });

  it("keeps cap-map ↔ route ↔ denylist soundness with checkpoint/resume present (the import-time assertion held)", () => {
    // assertToolMapSoundness runs at import; a throw would have failed this file's
    // import. Re-pin the invariant for the pair: cap-mapped, exactly one route each,
    // and NEITHER on the admin/destructive denylist.
    const cap = TOOL_CAPABILITY_MAP as Record<string, unknown>;
    const route = TOOL_ROUTE_MAP as Record<string, unknown>;
    expect("checkpoint" in cap && "checkpoint" in route).toBe(true);
    expect("resume" in cap && "resume" in route).toBe(true);
    expect(SUB_AGENT_TOOL_DENYLIST.has("checkpoint")).toBe(false);
    expect(SUB_AGENT_TOOL_DENYLIST.has("resume")).toBe(false);
  });

  it("does NOT introduce a new orch:checkpoint capability (floor-cap reuse; no AGENT_CAPABILITIES churn)", () => {
    // Correctness pin for the adopted Open Q1 recommendation: the pair reuses
    // orch:write/orch:read, so no cap-map VALUE is a non-existent "orch:checkpoint".
    const values = new Set(Object.values(TOOL_CAPABILITY_MAP));
    expect(values.has("orch:checkpoint" as unknown as string)).toBe(false);
  });
});

describe("MUT-01: the typed write SURFACE is default-off (write toggle), even though orch:write is a floor cap", () => {
  // The honest framing (correction #2): orch:write is NOT a new default-off CAP —
  // it is a FLOOR cap granted in standard+. What P3 adds is the typed SDK SURFACE
  // (comis_tools.write). Reachability is gated at the endpoint by the held cap, and
  // the `write` per-surface toggle is the enable signal for an agent that lacks the
  // floor grant. Proven end-to-end via the real resolveAutonomy resolver.
  it("the write tool requires exactly orch:write (the endpoint gate)", () => {
    expect((TOOL_CAPABILITY_MAP as Record<string, unknown>).write).toBe("orch:write");
  });

  it("an agent WITHOUT the write toggle (assistant, no floor caps) does NOT hold orch:write — the typed method is inert", () => {
    const caps = resolveAutonomy({ profile: "assistant" }).capabilities;
    expect(caps).not.toContain("orch:write");
  });

  it("the `write` toggle is the enable signal: assistant + write:true DOES hold orch:write", () => {
    const caps = resolveAutonomy({ profile: "assistant", write: true }).capabilities;
    expect(caps).toContain("orch:write");
  });

  it("honest framing: orch:write is a FLOOR cap — standard+ holds it (so the CAP is not default-off; only the typed SURFACE is new)", () => {
    const caps = resolveAutonomy({ profile: "standard" }).capabilities;
    expect(caps).toContain("orch:write");
  });
});

describe("INV-3: the MCP control plane stays unreachable through the cap surface", () => {
  it("mcp_manage and mcp_login (the control plane) stay absent from TOOL_CAPABILITY_MAP", () => {
    // AUTHORITATIVE gate: default-deny by absence. The admin/destructive control-plane
    // tools have no cap to resolve and cannot be rendered by the SDK — so the control
    // plane is undispatchable through the endpoint regardless of any lease.
    // NB: the fixed literal "mcp" tool (the dynamic DATA-plane surface) IS now born —
    // cap-mapped to orch:mcp with an executor route (see the MCP-01 block above). Its
    // {server,tool} ride inside args, so admitting it never makes the control plane
    // (mcp.connect / mcp.oauth_login) reachable.
    const map = TOOL_CAPABILITY_MAP as Record<string, unknown>;
    for (const name of ["mcp_manage", "mcp_login"]) {
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
