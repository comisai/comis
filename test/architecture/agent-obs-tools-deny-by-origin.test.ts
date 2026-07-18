// SPDX-License-Identifier: Apache-2.0
/**
 * The agent's SELF-OBSERVABILITY backing RPC methods must be
 * AGENT-REACHABLE (`scopes:["rpc"]`, i.e. NOT in the deny-by-origin admin set),
 * or the `obs_query` tool's self-diagnose action is denied at the
 * `assertNotAgentOrigin` chokepoint before the tool ever runs.
 *
 * Regression this guards: asking the agent
 * "why did this session degrade?" failed with
 *   "Control-plane method obs.explain is not reachable from an agent origin"
 * (`capability_denied`). The `obs_query` tool's explain/session_report path calls
 * `obs.explain`/`obs.diagnostics`, but both were `scopes:["admin"]` → in
 * `ADMIN_METHODS` (rpc-dispatch.ts, derived via `scopes.includes("admin")`) → the
 * deny-by-origin chokepoint threw for the `_agentId`-bearing call. Yet CLAUDE.md
 * documents "the obs_query agent explain/session_report actions" as an agent
 * capability. The reports are READ-ONLY + scrubbed/digest-only (a residency
 * sweep proved zero secret residency in the trajectory `obs.explain` reads) and
 * the daemon is single-tenant — so self-observability is a safe agent-self read.
 * Same re-scope class as `memory.store` (admin→rpc).
 *
 * Scope note: only the SELF-observability methods are agent-reachable. The
 * DAEMON-WIDE / sensitive obs methods (`obs.system.health`, `obs.audit.query`,
 * billing/channels/delivery aggregates) INTENTIONALLY stay `["admin"]` — an
 * agent must not read cross-session daemon health or the security audit trail.
 * This test pins ONLY the self-diagnose pair.
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { API_CONTRACTS_ORDERED } from "@comis/core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const OBS_QUERY_TOOL = resolve(REPO_ROOT, "packages/skills/src/platform-tools/tools/obs-query-tool.ts");

/** The agent self-observability methods obs_query uses to diagnose the agent's OWN sessions. */
const SELF_OBS_METHODS = ["obs.explain", "obs.diagnostics"] as const;

/** The admin deny set, derived the SAME way the rpc-dispatch chokepoint derives it. */
const ADMIN_METHODS: ReadonlySet<string> = new Set(
  API_CONTRACTS_ORDERED.filter((c) => c.scopes.includes("admin")).map((c) => c.method),
);

describe("agent self-observability methods are agent-reachable (not deny-by-origin)", () => {
  it("obs.explain / obs.diagnostics are NOT in the admin deny set (else obs_query self-diagnose is denied)", () => {
    const violations: string[] = [];
    for (const method of SELF_OBS_METHODS) {
      if (ADMIN_METHODS.has(method)) {
        violations.push(
          `"${method}" is scopes:["admin"] → in the deny-by-origin set → an agent-origin obs_query call is ` +
            `denied at assertNotAgentOrigin BEFORE the tool runs ("Control-plane method ${method} is not ` +
            `reachable from an agent origin"). Re-scope its contract to ["rpc"] (read-only, scrubbed, single-tenant).`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("non-vacuity: obs_query actually calls obs.explain + obs.diagnostics, and the admin set is populated", () => {
    expect(ADMIN_METHODS.size, "the admin deny set must be non-trivial").toBeGreaterThan(20);
    const src = readFileSync(OBS_QUERY_TOOL, "utf8");
    for (const method of SELF_OBS_METHODS) {
      expect(src, `obs-query-tool.ts must call rpcCall("${method}") — tool refactored? update this guard.`).toContain(
        `rpcCall("${method}"`,
      );
    }
  });

  it("the DAEMON-WIDE obs methods INTENTIONALLY stay admin (not widened by this fix)", () => {
    // Inverse guard: self-observability ≠ daemon-wide. An agent must NOT read cross-session
    // system health or the security audit trail — those stay in the deny-by-origin set.
    for (const method of ["obs.system.health", "obs.audit.query"]) {
      expect(ADMIN_METHODS.has(method), `${method} must stay scopes:["admin"] (daemon-wide/sensitive)`).toBe(true);
    }
  });
});
