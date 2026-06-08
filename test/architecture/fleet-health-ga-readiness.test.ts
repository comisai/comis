// SPDX-License-Identifier: Apache-2.0
/**
 * v2.15 FLEET-HEALTH GA-READINESS — the milestone's terminal shrink-only checklist.
 *
 * This is the Phase-162 P2 durable marker (the analog of v2.14's
 * `glass-box-ga-readiness.test.ts`). It does NOT re-run the architecture
 * suite — that is `pnpm test:architecture`'s job (the auto-discovery enforcers:
 * api-contracts-bidirectional, mcp-export-policy, cli-uses-typed-rpc,
 * log-payload-checker, trajectory-event-types-known, contract-codegen-drift,
 * no-prod-datadir-in-tests). Instead it asserts the v2.15 "Fleet Health Lens"
 * SURFACE ANCHORS are still in place, so a future PR that silently drops the
 * `obs.fleet.health` contract, downgrades the `obs_fleet_health` MCP export
 * policy, removes the `comis fleet` CLI, un-maps the `fleet_health` agent
 * action, drops the 162-01 daemon barrel re-export, deletes the RE-PROVE
 * scenario / RUNBOOK, removes the D9 no-prod-datadir write-guard, or
 * reintroduces the `includeSynthetic` opt-in fails THIS test loudly
 * (deterministic, cheap — fs/string reads only, NO runtime path).
 *
 * Why a checklist-as-test (not a full-suite shell-out): the underlying gates
 * already enforce every anchor below via AST/auto-discovery; this file is
 * belt-and-suspenders — a single human-readable GA record that pins the
 * surface-level shape of the milestone. It is SHRINK-ONLY: it registers no new
 * event/tool/contract; every assertion is a presence check that can only hold
 * or grow. Keeping it free of any child-process / shell-out (fs reads ONLY,
 * mirroring glass-box-ga-readiness.test.ts) keeps it immune to the known
 * macOS-only O_NOFOLLOW flakes elsewhere — Linux CI is the authoritative green
 * for the full suite.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/** Read a repo-relative source file as UTF-8 (anchors are static, committed source). */
function readSource(relPath: string): string {
  const abs = resolve(REPO_ROOT, relPath);
  expect(
    existsSync(abs),
    `expected the GA-anchor file ${relPath} to exist on disk`,
  ).toBe(true);
  return readFileSync(abs, "utf8");
}

describe("v2.15 Fleet-Health GA-readiness — the milestone surfaces are present + gated", () => {
  it("registers the obs.fleet.health admin-scoped RPC contract in the observability barrel", () => {
    // The fleet-lens centerpiece contract lives in fleet-health-report.ts and is
    // re-exported through the observability api-contracts barrel; the
    // bidirectional gate keys off the `method: "obs.fleet.health"` literal, and
    // the admin scope is the cross-session privilege boundary (operators only).
    const fleetReport = readSource(
      "packages/core/src/api-contracts/fleet-health-report.ts",
    );
    expect(
      fleetReport,
      'ObsFleetHealthContract must declare `method: "obs.fleet.health"` (the bidirectional gate\'s discovery key)',
    ).toContain('method: "obs.fleet.health"');
    expect(
      fleetReport,
      'ObsFleetHealthContract must declare `scopes: ["admin"]` (the cross-session privilege boundary)',
    ).toContain('scopes: ["admin"]');

    const obsBarrel = readSource(
      "packages/core/src/api-contracts/observability.ts",
    );
    expect(
      obsBarrel,
      "the observability api-contracts barrel must re-export ObsFleetHealthContract (so it is in the bidirectional contract set)",
    ).toContain("ObsFleetHealthContract");
  });

  it("registers the obs_fleet_health MCP tool as permission-gated (the mcp-export-policy registry)", () => {
    // never-inject-admin: obs_fleet_health reaches the FleetHealthReport via the
    // direct assembler closure under daemon authority (NOT the admin-gated
    // obs.fleet.health RPC), and the tool is registered `permission-gated`
    // (allowlist is the grant, never auto-exported). The mcp-export-policy gate
    // walks this registry; the policy + name are on the SAME registerToolMetadata
    // line, so the gate must bind them together via a regex.
    const registry = readSource(
      "packages/skills/src/skills/bridge/tool-metadata-registry.ts",
    );
    expect(
      registry,
      'the tool-metadata registry must register obs_fleet_health with mcpExportPolicy: "permission-gated"',
    ).toMatch(
      /registerToolMetadata\(\s*"obs_fleet_health"[\s\S]*?mcpExportPolicy:\s*"permission-gated"/,
    );

    // The MCP server-handler dispatch routes obs_fleet_health to the direct
    // assembler closure (NOT the admin RPC) — the never-inject-admin anchor.
    const mcpHandlers = readSource(
      "packages/daemon/src/api/mcp-server-handlers.ts",
    );
    expect(
      mcpHandlers,
      "the MCP server handlers must dispatch the obs_fleet_health tool (direct-assembler, not the admin RPC)",
    ).toContain('toolName === "obs_fleet_health"');
  });

  it("exposes the obs_query `fleet_health` action (the platform-tool surface for the FleetHealthReport)", () => {
    const obsQueryTool = readSource(
      "packages/skills/src/platform-tools/tools/obs-query-tool.ts",
    );
    expect(
      obsQueryTool,
      'obs_query VALID_ACTIONS must include the "fleet_health" action (dispatches to the frozen obs.fleet.health contract)',
    ).toContain('"fleet_health"');
  });

  it("registers the comis fleet CLI command (the operator FleetHealthReport surface — cli-uses-typed-rpc)", () => {
    // Distinct from `comis health` (the daemon-liveness probe) — `comis fleet`
    // is the cross-session degradation digest backed by the typed contract.
    const fleetCmd = readSource("packages/cli/src/commands/fleet.ts");
    expect(
      fleetCmd,
      "the CLI must register the `fleet` command (backed by the typed ObsFleetHealthContract)",
    ).toContain('.command("fleet")');
  });

  it("reads the 3 I-track diagnostic categories (health_signal / model_health / config_posture)", () => {
    // The fleet lens surfaces the Phase-160 I-track signals via sqlite
    // queryDiagnostics — by construction it never greps daemon.log. The three
    // category literals are the load-bearing read keys.
    const fleetHealth = readSource(
      "packages/daemon/src/api/obs-handlers/fleet-health.ts",
    );
    const REQUIRED_CATEGORIES = [
      '"health_signal"',
      '"model_health"',
      '"config_posture"',
    ] as const;
    const missing = REQUIRED_CATEGORIES.filter(
      (cat) => !fleetHealth.includes(cat),
    );
    expect(
      missing,
      `the fleet assembler must query every I-track category; missing: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("re-exports the fleet-health assembler from the @comis/daemon barrel (the 162-01 RE-PROVE seam)", () => {
    // The 162-01 barrel add lets the live-tier RE-PROVE scenario call the
    // assembler over a seeded tmp store via the bare `@comis/daemon` package
    // (the live config aliases only the TOP-LEVEL barrel → daemon/dist/index.js).
    // A refactor that drops it would silently break the milestone's proof harness.
    const daemonIndex = readSource("packages/daemon/src/index.ts");
    expect(
      daemonIndex,
      "the daemon barrel must re-export assembleFleetHealthReport (the 162-01 RE-PROVE seam)",
    ).toContain("assembleFleetHealthReport");
  });

  it("keeps the RE-PROVE scenario + operator RUNBOOK on disk (the 162-01 proof artifacts)", () => {
    // prettier-ignore — single-line existsSync(resolve(REPO_ROOT, …)) idiom (the v2.14 GA-marker
    // shape + the 162-02 acceptance grep `existsSync(resolve(REPO_ROOT`); no format gate in `validate`.
    expect(existsSync(resolve(REPO_ROOT, "test/live/scenarios/prove/fleet-reprove.test.ts")),
      "the Phase-162 RE-PROVE scenario (test/live/scenarios/prove/fleet-reprove.test.ts) must exist — the keyless 1-call/0-grep proof",
    ).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, "test/live/scenarios/prove/fleet-reprove-runbook.md")),
      "the Phase-162 operator RUNBOOK must exist alongside the scenario",
    ).toBe(true);

    // No-secret-leak guard: the scenario routes its rendered report through
    // assertNoSecrets — the secret-safety anchor for the costed RUN.
    const scenario = readSource(
      "test/live/scenarios/prove/fleet-reprove.test.ts",
    );
    expect(
      scenario,
      "the RE-PROVE scenario must route its report output through assertNoSecrets (the no-secret-leak guard)",
    ).toContain("assertNoSecrets");
  });

  it("H2 — the no-prod-datadir D9 guard + synthetic-exclusion predicate hold", () => {
    // H2a — the D9 no-prod-datadir write-guard is intact: appendSessionIndexEntry
    // must THROW when a VITEST/NODE_ENV=test process writes under the real
    // ~/.comis (mirror no-prod-datadir-in-tests.test.ts:37-39). Belt-and-suspenders
    // over that existing gate — the guard must use systemGetEnv (NOT process.env,
    // append.ts is scanned by the globals gate) + os.homedir() + throw new Error.
    const appendSrc = readSource(
      "packages/observability/src/session-index/append.ts",
    );
    expect(
      /systemGetEnv\(["']VITEST["']\)/.test(appendSrc),
      "append.ts must read systemGetEnv(\"VITEST\") for the D9 write-guard (not process.env)",
    ).toBe(true);
    expect(
      /throw new Error/.test(appendSrc),
      "the D9 guard must throw new Error when a test process writes the real datadir",
    ).toBe(true);
    expect(
      appendSrc.includes("os.homedir()"),
      "the D9 guard must resolve the real ~/.comis via os.homedir()",
    ).toBe(true);

    // H2b — synthetic exclusion is a REAL predicate, not a no-op: the fleet
    // reducer is called with `excludeSynthetic: true` so synthetic sessions
    // never leak into the operator digest. The `includeSynthetic` opt-in was
    // REMOVED in 161 (WR-02); the marker locks it out.
    const fleetHealth = readSource(
      "packages/daemon/src/api/obs-handlers/fleet-health.ts",
    );
    expect(
      fleetHealth,
      "the fleet reducer must exclude synthetic sessions (reduceFleetWindow(..., { excludeSynthetic: true }))",
    ).toContain("excludeSynthetic: true");
  });
});
