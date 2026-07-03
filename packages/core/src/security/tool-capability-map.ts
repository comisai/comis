// SPDX-License-Identifier: Apache-2.0
/**
 * `TOOL_CAPABILITY_MAP` + `TOOL_ROUTE_MAP` — the curated tool→cap allow-list
 * and tool→route table; the SINGLE source for the `tool.invoke` gate, the
 * lease audience, and the `comis_tools` SDK codegen. Default-deny: a tool
 * absent from this map is undispatchable. Defined in @comis/core so daemon +
 * the codegen import it without a package cycle (NO imports from
 * @comis/skills / @comis/agent / @comis/daemon — pure static data, mirroring
 * `sub-agent-tool-denylist.ts` and `handler-capability-map.ts`).
 *
 * This is the read/web tool-surface completion of the sibling
 * `HANDLER_CAPABILITY_MAP` (which classifies the orchestration-CORE RPC
 * methods). Both use the same `as const satisfies` discipline so the literal
 * cap strings stay exact at the type level. Four consumers must never drift
 * from this one table — the gate, the lease audience, the SDK codegen, and the
 * arch-tests (`tool-invoke-cap-map.test.ts` / `tool-invoke-default-deny.test.ts`).
 *
 * Two route kinds (the load-bearing split):
 *   - `{kind:"rpc", method}` — the tool maps to an EXISTING registered RPC
 *     handler (`memory.*`, `media.extract_document`, `session.*`). The dispatch
 *     strips-then-injects `_agentId`/`_capabilities` and forwards to the sink;
 *     the shipped per-handler `requireCapability` fires. Only REGISTERED method
 *     names appear here — `tool-invoke-cap-map.test.ts` asserts every
 *     `{kind:"rpc"}` method is a member of `API_CONTRACTS_ORDERED`, so a
 *     non-existent-method route (the `session.get` 404 class) is a BUILD
 *     failure, not a VPS-only runtime 404.
 *   - `{kind:"executor"}` — the tool is an in-process AgentTool with NO RPC
 *     registration (`read`/`grep`/`find`/`ls`/`jq`/`sql`/`jsonpath`, the
 *     daemon-side `web_search`/`web_fetch`). The daemon-side executor runs it
 *     under the agent's jailed workspace (DNS-pinned for the web pair).
 *
 * @allow-throw: module-load invariant (mirrors handler-capability-map.ts +
 * setup-capability-endpoint.ts:171-177). The assertion block below throws at
 * import if a cap-mapped tool is denylisted (fail-loud) or missing a route —
 * a fail-fast that the arch-tests also pin at build time.
 *
 * @module
 */
import type { AgentCapability } from "./capability.js";
import { SUB_AGENT_TOOL_DENYLIST } from "../domain/sub-agent-tool-denylist.js";

/**
 * Tool name → required {@link AgentCapability}. The curated allow-list: a tool
 * absent from this map has NO capability and is undispatchable
 * (default-deny by absence). `as const satisfies Record<string, AgentCapability>`
 * keeps the literal cap strings exact at the type level (the no-typo'd-cap
 * invariant) while typing the whole table.
 *
 * SCOPE: the read/web surface only — `orch:read` (RPC-backed reads +
 * in-process workspace builtins) and `orch:web` (daemon-side, DNS-pinned).
 * Admin/management tools (`mcp_manage`, `gateway`, `agents_create`, …) are
 * NEVER mapped: they stay unreachable via this curated surface, and the
 * deny-by-origin chokepoint covers the control plane.
 */
export const TOOL_CAPABILITY_MAP = {
  // orch:read — RPC-backed reads (route → an existing registered handler)
  memory_search: "orch:read",
  memory_get: "orch:read",
  session_search: "orch:read",
  extract_document: "orch:read",
  sessions_list: "orch:read",
  session_status: "orch:read",
  sessions_history: "orch:read",
  // orch:read — in-process builtins (route → daemon-side executor; jailed workspace)
  read: "orch:read",
  grep: "orch:read",
  find: "orch:read",
  ls: "orch:read",
  jq: "orch:read",
  // orch:read — the full ResultRef query engine: DuckDB-SQL over
  // CSV/JSONL + JSONPath over JSON, run DAEMON-side (like jq) over the
  // run-scoped results/ file; only the slice re-enters context. Read-only —
  // the daemon-side DuckDB is CONFINED to the run's workspace
  // (allowed_directories=[<ws>] + enable_external_access=false +
  // lock_configuration, set before the model query) and hardened
  // (--readonly :memory:, no autoload, INSTALL/LOAD/ATTACH/COPY/EXPORT, the
  // pure-exfil readers read_text/read_blob/glob/getenv, and url-readers
  // rejected before spawn) so this cap can never read a host file outside the
  // workspace or become an SSRF/exfil egress.
  sql: "orch:read",
  jsonpath: "orch:read",
  // orch:web — daemon-side, DNS-pinned (the jail stays --unshare-net)
  web_search: "orch:web",
  web_fetch: "orch:web",
} as const satisfies Record<string, AgentCapability>;

/** The tool-name keys of {@link TOOL_CAPABILITY_MAP} (mirrors `GatedMethodName`). */
export type ToolName = keyof typeof TOOL_CAPABILITY_MAP;

/** A single dispatch route: a registered RPC method, or the in-process executor. */
export type ToolRoute = { kind: "rpc"; method: string } | { kind: "executor" };

/**
 * Tool name → dispatch route. Every {@link ToolName} has exactly one entry (the
 * module-load assertion + the arch-test pin completeness). The `{kind:"rpc"}`
 * methods are ALL registered `API_CONTRACTS_ORDERED` members:
 *   - `session.status` IS the registered, ungated, self-`agentId`-scoped status
 *     read (contract `api-contracts/sessions.ts:110`, classified `ungated` at
 *     `handler-capability-map.ts:81`, implemented in `session-handlers/session-read.ts`).
 *   - `session.get` is NOT registered (only `action-classifier.ts` + a test
 *     mock) — routing to it would 404 at the sink's `!handler` throw.
 *     Do NOT route a builtin via `{kind:"rpc"}`.
 */
export const TOOL_ROUTE_MAP = {
  memory_search: { kind: "rpc", method: "memory.search_files" },
  memory_get: { kind: "rpc", method: "memory.get_file" },
  extract_document: { kind: "rpc", method: "media.extract_document" },
  session_search: { kind: "rpc", method: "session.search" },
  sessions_list: { kind: "rpc", method: "session.list" },
  session_status: { kind: "rpc", method: "session.status" },
  sessions_history: { kind: "rpc", method: "session.history" },
  read: { kind: "executor" },
  grep: { kind: "executor" },
  find: { kind: "executor" },
  ls: { kind: "executor" },
  jq: { kind: "executor" },
  sql: { kind: "executor" },
  jsonpath: { kind: "executor" },
  web_search: { kind: "executor" },
  web_fetch: { kind: "executor" },
} as const satisfies Record<ToolName, ToolRoute>;

// ---------------------------------------------------------------------------
// Module-load soundness assertions (denylist disjointness + route completeness).
// Mirrors handler-capability-map.ts's discipline + setup-capability-endpoint.ts:171-177:
// assert-at-load so a denylist rename or a missing route fails LOUD at import,
// not silently at the VPS. The arch-tests pin the same invariants at build time.
// ---------------------------------------------------------------------------

/**
 * Assert the cap-map ↔ denylist ↔ route-map soundness invariants (denylist
 * disjointness + route completeness). Pure: takes the three tables explicitly so the invariant
 * is independently unit-testable over a poisoned copy (the throw branches are
 * the security fail-loud paths — they MUST be covered). Throws a descriptive
 * `Error` on the first violation.
 *
 * @allow-throw: module-load invariant (mirrors handler-capability-map.ts). Called
 * once at import below with the real tables; the throw aborts module load.
 */
export function assertToolMapSoundness(
  capMap: Readonly<Record<string, unknown>>,
  routeMap: Readonly<Record<string, unknown>>,
  denylist: ReadonlySet<string>,
): void {
  for (const tool of Object.keys(capMap)) {
    if (denylist.has(tool)) {
      throw new Error(
        `TOOL_CAPABILITY_MAP invariant violated: "${tool}" is in SUB_AGENT_TOOL_DENYLIST — ` +
          `a denylisted (admin/destructive) tool must never be on the curated tool.invoke surface (DISPATCH-03).`,
      );
    }
    if (!(tool in routeMap)) {
      throw new Error(
        `TOOL_CAPABILITY_MAP invariant violated: "${tool}" has no TOOL_ROUTE_MAP entry — ` +
          `every capability-mapped tool must declare exactly one dispatch route.`,
      );
    }
  }
}

// Run the invariant at module load with the real tables (fail-loud at import).
assertToolMapSoundness(TOOL_CAPABILITY_MAP, TOOL_ROUTE_MAP, SUB_AGENT_TOOL_DENYLIST);
