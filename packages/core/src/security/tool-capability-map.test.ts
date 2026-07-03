// SPDX-License-Identifier: Apache-2.0
/**
 * Coverage tests for TOOL_CAPABILITY_MAP + TOOL_ROUTE_MAP (the single
 * source-of-truth for the `tool.invoke` surface).
 *
 * Pins the anchor tool→cap classifications, the default-deny-by-absence
 * invariant (an unmapped tool is `undefined`), the cap-map↔route-map
 * completeness, and the routing-class split (RPC-backed reads vs in-process
 * `{kind:"executor"}` builtins). The companion arch-tests
 * (`test/architecture/tool-invoke-cap-map.test.ts` + `tool-invoke-default-deny.test.ts`)
 * consume the SAME maps so the gate, the lease audience, the SDK codegen, and
 * the denylist-disjointness cannot drift.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { AGENT_CAPABILITIES, type AgentCapability } from "./capability.js";
import { SUB_AGENT_TOOL_DENYLIST } from "../domain/sub-agent-tool-denylist.js";
import {
  TOOL_CAPABILITY_MAP,
  TOOL_ROUTE_MAP,
  assertToolMapSoundness,
  type ToolName,
} from "./tool-capability-map.js";

const AGENT_CAP_SET = new Set<string>(AGENT_CAPABILITIES);

describe("TOOL_CAPABILITY_MAP", () => {
  it("maps the orch:read RPC-backed read tools to orch:read", () => {
    expect(TOOL_CAPABILITY_MAP.memory_search).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.memory_get).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.session_search).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.extract_document).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.sessions_list).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.session_status).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.sessions_history).toBe("orch:read");
  });

  it("maps the in-process builtin read tools to orch:read", () => {
    expect(TOOL_CAPABILITY_MAP.read).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.grep).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.find).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.ls).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.jq).toBe("orch:read");
  });

  it("maps the sql + jsonpath ResultRef query cores to orch:read (never write/admin/web)", () => {
    // sql (DuckDB-over-CSV/JSONL) + jsonpath (json_extract, no-eval) are
    // read-only slicers over a materialized results/ file — mirror jq.
    expect(TOOL_CAPABILITY_MAP.sql).toBe("orch:read");
    expect(TOOL_CAPABILITY_MAP.jsonpath).toBe("orch:read");
    // A query engine must NEVER carry a write/admin/web cap — confine it to the
    // read surface so the default-deny gate authorizes only an in-jail read.
    // orch:read / orch:web are the only two caps on this surface,
    // so "not orch:web" pins both off the write/web side.
    expect(TOOL_CAPABILITY_MAP.sql).not.toBe("orch:web");
    expect(TOOL_CAPABILITY_MAP.jsonpath).not.toBe("orch:web");
  });

  it("maps the daemon-side web tools to orch:web", () => {
    expect(TOOL_CAPABILITY_MAP.web_fetch).toBe("orch:web");
    expect(TOOL_CAPABILITY_MAP.web_search).toBe("orch:web");
  });

  it("never maps admin or denylisted tools (default-deny by absence)", () => {
    // Cast through `string` keys — these names are intentionally NOT ToolName
    // members, so the lookup is `undefined` (the dispatch's default-deny seam).
    const map = TOOL_CAPABILITY_MAP as Record<string, AgentCapability>;
    expect(map.mcp_manage).toBeUndefined();
    expect(map.mcp_login).toBeUndefined();
    expect(map.gateway).toBeUndefined();
    expect(map.agents_create).toBeUndefined();
    expect(map.definitely_not_a_tool).toBeUndefined();
  });

  it("only assigns real members of the AgentCapability union", () => {
    for (const cap of Object.values(TOOL_CAPABILITY_MAP)) {
      expect(AGENT_CAP_SET.has(cap)).toBe(true);
    }
  });

  it("uses only orch:read or orch:web on the curated read/web surface", () => {
    for (const cap of Object.values(TOOL_CAPABILITY_MAP)) {
      expect(["orch:read", "orch:web"]).toContain(cap);
    }
  });

  it("holds no tool that also appears in the sub-agent denylist", () => {
    for (const tool of Object.keys(TOOL_CAPABILITY_MAP)) {
      expect(SUB_AGENT_TOOL_DENYLIST.has(tool)).toBe(false);
    }
  });
});

describe("TOOL_ROUTE_MAP", () => {
  it("routes every capability-mapped tool to exactly one dispatch route", () => {
    for (const tool of Object.keys(TOOL_CAPABILITY_MAP)) {
      expect(tool in TOOL_ROUTE_MAP).toBe(true);
    }
    // and no extra route without a cap entry (the two tables stay in lockstep)
    for (const tool of Object.keys(TOOL_ROUTE_MAP)) {
      expect(tool in TOOL_CAPABILITY_MAP).toBe(true);
    }
  });

  it("routes RPC-backed reads to their registered contract methods", () => {
    expect(TOOL_ROUTE_MAP.memory_search).toEqual({ kind: "rpc", method: "memory.search_files" });
    expect(TOOL_ROUTE_MAP.memory_get).toEqual({ kind: "rpc", method: "memory.get_file" });
    expect(TOOL_ROUTE_MAP.extract_document).toEqual({ kind: "rpc", method: "media.extract_document" });
    expect(TOOL_ROUTE_MAP.session_search).toEqual({ kind: "rpc", method: "session.search" });
    expect(TOOL_ROUTE_MAP.sessions_list).toEqual({ kind: "rpc", method: "session.list" });
    expect(TOOL_ROUTE_MAP.session_status).toEqual({ kind: "rpc", method: "session.status" });
    expect(TOOL_ROUTE_MAP.sessions_history).toEqual({ kind: "rpc", method: "session.history" });
  });

  it("routes the in-process builtins to the executor kind", () => {
    expect(TOOL_ROUTE_MAP.read).toEqual({ kind: "executor" });
    expect(TOOL_ROUTE_MAP.grep).toEqual({ kind: "executor" });
    expect(TOOL_ROUTE_MAP.find).toEqual({ kind: "executor" });
    expect(TOOL_ROUTE_MAP.ls).toEqual({ kind: "executor" });
    expect(TOOL_ROUTE_MAP.jq).toEqual({ kind: "executor" });
    expect(TOOL_ROUTE_MAP.web_fetch).toEqual({ kind: "executor" });
    expect(TOOL_ROUTE_MAP.web_search).toEqual({ kind: "executor" });
  });

  it("routes the sql + jsonpath query cores to the executor kind (daemon-side like jq)", () => {
    // The cores run DAEMON-side (DuckDB via execFile), not as an RPC handler —
    // so they MUST route {kind:"executor"}; a {kind:"rpc"} route would 404 at
    // the sink (no registered sql/jsonpath method).
    expect(TOOL_ROUTE_MAP.sql).toEqual({ kind: "executor" });
    expect(TOOL_ROUTE_MAP.jsonpath).toEqual({ kind: "executor" });
  });

  it("never routes a builtin tool through a non-existent RPC method", () => {
    // session.get is NOT a registered RPC method — a regression to it (or any
    // builtin via {kind:"rpc"}) would 404 at the sink. The arch-test pins the
    // full registered-method membership; here we pin that builtins stay executor.
    const builtins: ToolName[] = ["read", "grep", "find", "ls", "jq", "sql", "jsonpath", "web_fetch", "web_search"];
    for (const tool of builtins) {
      expect(TOOL_ROUTE_MAP[tool].kind).toBe("executor");
    }
  });
});

describe("tool-capability-map module load", () => {
  it("imports without throwing (the soundness assertions pass at load)", async () => {
    // A clean import is itself the assertion: the module-load call throws if any
    // cap-mapped tool is denylisted or missing a route. Re-importing here
    // exercises that the shipped table satisfies its own invariants.
    await expect(import("./tool-capability-map.js")).resolves.toBeDefined();
  });
});

describe("assertToolMapSoundness", () => {
  it("passes for the real shipped tables (no throw)", () => {
    expect(() =>
      assertToolMapSoundness(TOOL_CAPABILITY_MAP, TOOL_ROUTE_MAP, SUB_AGENT_TOOL_DENYLIST),
    ).not.toThrow();
  });

  it("throws when a cap-mapped tool is in the denylist (disjointness fail-loud)", () => {
    // poison: a denylisted admin tool sneaks onto the curated surface.
    const poisonedCap = { ...TOOL_CAPABILITY_MAP, gateway: "orch:read" };
    const poisonedRoute = { ...TOOL_ROUTE_MAP, gateway: { kind: "executor" } };
    expect(() =>
      assertToolMapSoundness(poisonedCap, poisonedRoute, SUB_AGENT_TOOL_DENYLIST),
    ).toThrow(/SUB_AGENT_TOOL_DENYLIST/);
  });

  it("throws when a cap-mapped tool has no route entry (completeness)", () => {
    // poison: a cap-mapped tool with no TOOL_ROUTE_MAP route.
    const poisonedCap = { ...TOOL_CAPABILITY_MAP, orphan_tool: "orch:read" };
    expect(() =>
      assertToolMapSoundness(poisonedCap, TOOL_ROUTE_MAP, SUB_AGENT_TOOL_DENYLIST),
    ).toThrow(/no TOOL_ROUTE_MAP entry/);
  });
});
