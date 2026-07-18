// SPDX-License-Identifier: Apache-2.0
/**
 * SYSTEM-HEALTH GA-READINESS — the milestone's terminal shrink-only checklist.
 *
 * This is the durable system-health GA marker (the analog of
 * `glass-box-ga-readiness.test.ts`). It does NOT re-run the architecture
 * suite — that is `pnpm test:architecture`'s job (the auto-discovery enforcers:
 * api-contracts-bidirectional, mcp-export-policy, cli-uses-typed-rpc,
 * log-payload-checker, trajectory-event-types-known, contract-codegen-drift,
 * no-prod-datadir-in-tests). Instead it asserts the "System Health Lens"
 * SURFACE ANCHORS are still in place, so a future PR that silently drops the
 * `obs.system.health` contract, downgrades the `obs_system_health` MCP export
 * policy, removes the `comis system-health` CLI, un-maps the `system_health` agent
 * action, drops the daemon barrel re-export, deletes the live verification
 * scenario / RUNBOOK, removes the no-prod-datadir write-guard, or
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

describe("System-Health GA-readiness — the milestone surfaces are present + gated", () => {
  it("registers the obs.system.health admin-scoped RPC contract in the observability barrel", () => {
    // The system-lens centerpiece contract lives in system-health-report.ts and is
    // re-exported through the observability api-contracts barrel; the
    // bidirectional gate keys off the `method: "obs.system.health"` literal, and
    // the admin scope is the cross-session privilege boundary (operators only).
    const systemReport = readSource(
      "packages/core/src/api-contracts/system-health-report.ts",
    );
    expect(
      systemReport,
      'ObsSystemHealthContract must declare `method: "obs.system.health"` (the bidirectional gate\'s discovery key)',
    ).toContain('method: "obs.system.health"');
    expect(
      systemReport,
      'ObsSystemHealthContract must declare `scopes: ["admin"]` (the cross-session privilege boundary)',
    ).toContain('scopes: ["admin"]');

    const obsBarrel = readSource(
      "packages/core/src/api-contracts/observability.ts",
    );
    expect(
      obsBarrel,
      "the observability api-contracts barrel must re-export ObsSystemHealthContract (so it is in the bidirectional contract set)",
    ).toContain("ObsSystemHealthContract");
  });

  it("registers the obs_system_health MCP tool as permission-gated (the mcp-export-policy registry)", () => {
    // never-inject-admin: obs_system_health reaches the SystemHealthReport via the
    // direct assembler closure under daemon authority (NOT the admin-gated
    // obs.system.health RPC), and the tool is registered `permission-gated`
    // (allowlist is the grant, never auto-exported). The mcp-export-policy gate
    // walks this registry; the policy + name are on the SAME registerToolMetadata
    // line, so the gate must bind them together via a regex.
    const registry = readSource(
      "packages/skills/src/skills/bridge/tool-metadata-registry.ts",
    );
    expect(
      registry,
      'the tool-metadata registry must register obs_system_health with mcpExportPolicy: "permission-gated"',
    ).toMatch(
      /registerToolMetadata\(\s*"obs_system_health"[\s\S]*?mcpExportPolicy:\s*"permission-gated"/,
    );

    // The MCP server-handler dispatch routes obs_system_health to the direct
    // assembler closure (NOT the admin RPC) — the never-inject-admin anchor.
    const mcpHandlers = readSource(
      "packages/daemon/src/api/mcp-server-handlers.ts",
    );
    expect(
      mcpHandlers,
      "the MCP server handlers must dispatch the obs_system_health tool (direct-assembler, not the admin RPC)",
    ).toContain('toolName === "obs_system_health"');
  });

  it("exposes the obs_query `system_health` action (the platform-tool surface for the SystemHealthReport)", () => {
    const obsQueryTool = readSource(
      "packages/skills/src/platform-tools/tools/obs-query-tool.ts",
    );
    expect(
      obsQueryTool,
      'obs_query VALID_ACTIONS must include the "system_health" action (dispatches to the frozen obs.system.health contract)',
    ).toContain('"system_health"');
  });

  it("registers the comis system-health CLI command (the operator SystemHealthReport surface — cli-uses-typed-rpc)", () => {
    // Distinct from `comis health` (the daemon-liveness probe) — `comis system-health`
    // is the cross-session degradation digest backed by the typed contract.
    const systemCmd = readSource("packages/cli/src/commands/system-health.ts");
    expect(
      systemCmd,
      "the CLI must register the `system-health` command (backed by the typed ObsSystemHealthContract)",
    ).toContain('.command("system-health")');
  });

  it("reads the 3 diagnostic categories (health_signal / model_health / config_posture)", () => {
    // The system health view surfaces these diagnostic signals via sqlite
    // queryDiagnostics — by construction it never greps daemon.log. The three
    // category literals are the load-bearing read keys.
    const systemHealth = readSource(
      "packages/daemon/src/api/obs-handlers/system-health.ts",
    );
    const REQUIRED_CATEGORIES = [
      '"health_signal"',
      '"model_health"',
      '"config_posture"',
    ] as const;
    const missing = REQUIRED_CATEGORIES.filter(
      (cat) => !systemHealth.includes(cat),
    );
    expect(
      missing,
      `the system assembler must query every I-track category; missing: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("re-exports the system-health assembler from the @comis/daemon barrel for live verification", () => {
    // The barrel export lets the live verification scenario call the
    // assembler over a seeded tmp store via the bare `@comis/daemon` package
    // (the live config aliases only the TOP-LEVEL barrel → daemon/dist/index.js).
    // A refactor that drops it would silently break the milestone's proof harness.
    const daemonIndex = readSource("packages/daemon/src/index.ts");
    expect(
      daemonIndex,
      "the daemon barrel must re-export assembleSystemHealthReport for live verification",
    ).toContain("assembleSystemHealthReport");
  });

  it("keeps the live verification scenario and operator runbook on disk", () => {
    // prettier-ignore — single-line existsSync(resolve(REPO_ROOT, …)) idiom (the GA-marker
    // shape + the acceptance grep `existsSync(resolve(REPO_ROOT`); no format gate in `validate`.
    expect(existsSync(resolve(REPO_ROOT, "test/live/scenarios/prove/system-reprove.test.ts")),
      "the system verification scenario must exist as a keyless one-call, zero-grep proof",
    ).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, "test/live/scenarios/prove/system-reprove-runbook.md")),
      "the operator runbook must exist alongside the system verification scenario",
    ).toBe(true);

    // No-secret-leak guard: the scenario routes its rendered report through
    // assertNoSecrets — the secret-safety anchor for the costed RUN.
    const scenario = readSource(
      "test/live/scenarios/prove/system-reprove.test.ts",
    );
    expect(
      scenario,
      "the system verification scenario must route its report output through assertNoSecrets",
    ).toContain("assertNoSecrets");
  });

  it("the no-prod-datadir write-guard + synthetic-exclusion predicate hold", () => {
    // The no-prod-datadir write-guard is intact: appendSessionIndexEntry
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

    // Synthetic exclusion is a REAL predicate, not a no-op: the system
    // reducer is called with `excludeSynthetic: true` so synthetic sessions
    // never leak into the operator digest. The `includeSynthetic` opt-in was
    // removed; the marker locks it out.
    const systemHealth = readSource(
      "packages/daemon/src/api/obs-handlers/system-health.ts",
    );
    expect(
      systemHealth,
      "the system reducer must exclude synthetic sessions (reduceSystemWindow(..., { excludeSynthetic: true }))",
    ).toContain("excludeSynthetic: true");
  });
});
