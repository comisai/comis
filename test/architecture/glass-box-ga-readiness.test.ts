// SPDX-License-Identifier: Apache-2.0
/**
 * OBSERVABILITY-EXPLAIN GA-READINESS — the milestone's terminal shrink-only checklist.
 *
 * This is the durable observability-explain GA marker. It does NOT re-run the architecture
 * suite — that is `pnpm test:architecture`'s job (the auto-discovery enforcers:
 * api-contracts-bidirectional, mcp-export-policy, cli-uses-typed-rpc,
 * log-payload-checker, trajectory-event-types-known, contract-codegen-drift).
 * Instead it asserts the observability-explain SURFACE ANCHORS are still in place,
 * so a future PR that silently drops the `obs.explain` contract, downgrades the
 * `obs_explain` MCP export policy, removes the `comis explain` CLI, un-maps the
 * tool-lifecycle / session-summary trajectory events, drops the daemon
 * barrel re-export, or deletes the RE-PROVE scenario fails THIS test loudly
 * (deterministic, cheap — fs/string reads only, NO runtime path).
 *
 * Why a checklist-as-test (not a full-suite shell-out): the underlying gates
 * already enforce every anchor below via AST/auto-discovery; this file is
 * belt-and-suspenders — a single human-readable GA record that pins the
 * surface-level shape of the milestone. It is SHRINK-ONLY: it registers no new
 * event/tool/contract; every assertion is a presence check that can only hold
 * or grow. Keeping it free of any child-process / shell-out (fs reads ONLY,
 * mirroring ship-gate.test.ts) keeps it immune to the known macOS-only
 * O_NOFOLLOW flakes elsewhere — Linux CI is the authoritative green for the
 * full suite.
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

describe("Observability-explain GA-readiness — the milestone surfaces are present + gated", () => {
  it("registers the obs.explain RPC contract (the api-contracts-bidirectional discovery surface)", () => {
    // The centerpiece contract lives in incident-report.ts and is
    // re-exported through the observability api-contracts barrel; the
    // bidirectional gate keys off the `method: "obs.explain"` literal.
    const incidentReport = readSource(
      "packages/core/src/api-contracts/incident-report.ts",
    );
    expect(
      incidentReport,
      "ObsExplainContract must declare `method: \"obs.explain\"` (the bidirectional gate's discovery key)",
    ).toContain('method: "obs.explain"');

    const obsBarrel = readSource(
      "packages/core/src/api-contracts/observability.ts",
    );
    expect(
      obsBarrel,
      "the observability api-contracts barrel must re-export ObsExplainContract (so it is in the bidirectional contract set)",
    ).toContain("ObsExplainContract");
  });

  it("registers the obs_explain MCP tool as permission-gated (the mcp-export-policy registry)", () => {
    // never-inject-admin: obs_explain reaches the IncidentReport via the
    // trust-flag-FREE assembler, NOT the admin-gated obs.explain RPC, and the
    // tool is registered `permission-gated` (allowlist is the grant, never
    // auto-exported). The mcp-export-policy gate walks this registry.
    const registry = readSource(
      "packages/skills/src/skills/bridge/tool-metadata-registry.ts",
    );
    expect(
      registry,
      'the tool-metadata registry must register obs_explain with mcpExportPolicy: "permission-gated"',
    ).toMatch(
      /registerToolMetadata\(\s*"obs_explain"[\s\S]*?mcpExportPolicy:\s*"permission-gated"/,
    );

    // The MCP server-handler dispatch routes obs_explain to the direct
    // assembler closure (NOT the admin RPC) — the never-inject-admin anchor.
    const mcpHandlers = readSource(
      "packages/daemon/src/api/mcp-server-handlers.ts",
    );
    expect(
      mcpHandlers,
      "the MCP server handlers must dispatch the obs_explain tool (direct-assembler, not the admin RPC)",
    ).toContain('toolName === "obs_explain"');
  });

  it("exposes the obs_query `explain` action (the platform-tool surface for the IncidentReport)", () => {
    const obsQueryTool = readSource(
      "packages/skills/src/platform-tools/tools/obs-query-tool.ts",
    );
    expect(
      obsQueryTool,
      'obs_query VALID_ACTIONS must include the "explain" action (dispatches to the frozen obs.explain contract)',
    ).toContain('"explain"');
  });

  it("registers the comis explain CLI command (the operator IncidentReport surface — cli-uses-typed-rpc)", () => {
    const explainCmd = readSource("packages/cli/src/commands/explain.ts");
    expect(
      explainCmd,
      'the CLI must register the `explain <sessionKeyOrTraceId>` command (backed by the typed ObsExplainContract)',
    ).toContain('.command("explain <sessionKeyOrTraceId>")');
  });

  it("maps the tool-lifecycle events + session:summary into the trajectory bridge (trajectory-event-types-known)", () => {
    // The activity layer rides the event-bus → trajectory bridge.
    // The three tool-lifecycle events (started / executed / timeout) and the
    // session-summary event must be mapped in EVENT_BUS_TO_TRAJECTORY so the
    // trajectory-event-types-known gate (which fails on any unmapped event)
    // stays green.
    const bridge = readSource(
      "packages/observability/src/trajectory/event-bus-bridge.ts",
    );
    const REQUIRED_MAPPED_EVENTS = [
      '"tool:started"',
      '"tool:executed"',
      '"tool:timeout"',
      '"session:summary"',
    ] as const;
    const unmapped = REQUIRED_MAPPED_EVENTS.filter(
      (evt) => !bridge.includes(evt),
    );
    expect(
      unmapped,
      `the trajectory bridge must map every Glass-Box lifecycle/summary event; unmapped: ${unmapped.join(", ")}`,
    ).toEqual([]);
  });

  it("re-exports the obs.explain assembler from the @comis/daemon barrel (the RE-PROVE seam)", () => {
    // The barrel add lets the live-tier RE-PROVE scenario call the
    // frozen assembler over a fixture reader without a deep
    // daemon-internal dist path. A refactor that drops it would silently break
    // the milestone's proof harness.
    const daemonIndex = readSource("packages/daemon/src/index.ts");
    expect(
      daemonIndex,
      "the daemon barrel must re-export assembleIncidentReportFromSources (the 156-01 RE-PROVE seam)",
    ).toContain("assembleIncidentReportFromSources");
    expect(
      daemonIndex,
      "the daemon barrel must re-export the IncidentSourceReader DI-seam type",
    ).toContain("IncidentSourceReader");
  });

  it("keeps the RE-PROVE scenario + operator RUNBOOK on disk (the proof artifacts)", () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          "test/live/scenarios/prove/diagnosis-reprove.test.ts",
        ),
      ),
      "the RE-PROVE scenario (test/live/scenarios/prove/diagnosis-reprove.test.ts) must exist — the G1 1-call/0-reads proof",
    ).toBe(true);
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          "test/live/scenarios/prove/diagnosis-reprove-runbook.md",
        ),
      ),
      "the operator RE-PROVE RUNBOOK must exist alongside the scenario",
    ).toBe(true);

    // No-prod-datadir guard: the scenario reads from FIXTURES via an in-process
    // reader (NOT ~/.comis) and routes every emitted ledger/markdown through
    // assertNoSecrets — the secret-safety anchor for the costed RUN.
    const scenario = readSource(
      "test/live/scenarios/prove/diagnosis-reprove.test.ts",
    );
    expect(
      scenario,
      "the RE-PROVE scenario must route its ledger output through assertNoSecrets (the no-secret-leak guard)",
    ).toContain("assertNoSecrets");
  });
});
