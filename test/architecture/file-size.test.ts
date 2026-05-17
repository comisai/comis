// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide file-size invariant.
 *
 * Every production `.ts` file under `packages/*\/src/` must be ≤800 lines
 * unless it carries a `fileSizeAllowlist` entry in
 * `test/support/architecture-allowlist.ts`.
 *
 * The walker hard-excludes generated files (`*.generated.ts`) and
 * declaration files (`*.d.ts`) at the basename level — the 9569-line
 * `packages/web/src/api/contracts.generated.ts` must never reach the rule.
 *
 * Line-counting semantic: `split(/\r?\n/).length` (JS-native; matches
 * editor display). Difference vs `wc -l` is ±1 per file — well within
 * tolerance since the `lines` field on each allowlist entry is
 * informational only (filter keys on `{file}` alone).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileSizeAllowlist } from "../support/architecture-allowlist.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const MAX_LINES = 800;

/**
 * Walk every workspace package's `src/` and return absolute paths of
 * non-test, non-generated, non-declaration `.ts` production files.
 * Mirrors `log-payload-checker.test.ts:listAllProductionFiles()` with
 * two added basename filters: `.generated.ts` and `.d.ts`.
 *
 * Note: walks `packages/<pkg>/src/` for every directory under `packages/`
 * — does NOT hard-code WORKSPACE_PACKAGES, so new packages added later
 * are automatically scanned.
 */
function walkProductionFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue; // symlink loop guard
    if (entry.isDirectory()) {
      if (
        [
          "__tests__",
          "__snapshots__",
          "dist",
          "node_modules",
          "__test-helpers",
          "fixtures",
        ].includes(entry.name)
      ) {
        continue;
      }
      walkProductionFiles(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
}

function listAllProductionFiles(): string[] {
  const out: string[] = [];
  let packageDirs;
  try {
    packageDirs = readdirSync(PACKAGES_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pkg of packageDirs) {
    if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
    walkProductionFiles(resolve(PACKAGES_ROOT, pkg.name, "src"), out);
  }
  return out;
}

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

describe("file-size — production .ts ≤800 lines", () => {
  it("no NEW oversized production .ts files beyond fileSizeAllowlist", () => {
    const files = listAllProductionFiles();

    const violations = files
      .map((file) => {
        const content = readFileSync(file, "utf8");
        const lines = content.split(/\r?\n/).length;
        return { file, lines };
      })
      .filter((v) => v.lines > MAX_LINES);

    const allowlistedFiles = new Set(
      fileSizeAllowlist.map((e) => e.file),
    );
    const newViolations = violations.filter(
      (v) => !allowlistedFiles.has(repoRelative(v.file)),
    );

    expect(
      newViolations,
      formatViolations({
        description: `Production .ts files under packages/*\/src/ must be ≤${MAX_LINES} lines. Generated files (*.generated.ts) and declarations (*.d.ts) are hard-excluded by the walker and must never appear in the allowlist.`,
        violations: newViolations.map((v) => ({
          file: repoRelative(v.file),
          line: v.lines,
          snippet: `${v.lines} lines (cap: ${MAX_LINES})`,
        })),
        suggestedFix:
          "Split the file or add a fileSizeAllowlist entry to test/support/architecture-allowlist.ts. NEVER add a *.generated.ts file to the allowlist — fix the walker exclusion instead.",
        designRef:
          "test/architecture/file-size.test.ts (file-size invariant)",
        allowlistRef:
          "fileSizeAllowlist (test/support/architecture-allowlist.ts)",
      }),
    ).toEqual([]);

    // Sanity: walker actually scanned production files.
    expect(
      files.length,
      "sanity: listAllProductionFiles enumerated at least one production .ts file",
    ).toBeGreaterThan(0);

    // Sanity: contracts.generated.ts must NEVER reach the walker output.
    const generatedLeak = files.filter((f) => f.endsWith(".generated.ts"));
    expect(
      generatedLeak,
      "*.generated.ts MUST be excluded at walker basename filter, NOT via the allowlist",
    ).toEqual([]);
  });
});

/**
 * Executor subdirectory stricter caps.
 *
 * Each extracted module in the four executor subdirectories has a stricter
 * line cap than the project-wide 800L gate. The cap is enforced ONLY when
 * the subdirectory exists.
 *
 * Walker pattern + .split(/\r?\n/).length line counter + formatViolations
 * error shape mirror the parent block above.
 */
describe("file-size — executor subdirectory caps", () => {
  const CAPS: ReadonlyArray<{ dir: string; cap: number }> = [
    {
      dir: "packages/agent/src/executor/stream-wrappers/request-body",
      cap: 600,
    },
    {
      dir: "packages/agent/src/executor/pi-executor",
      cap: 400,
    },
    {
      dir: "packages/agent/src/executor/prompt-runner",
      cap: 500,
    },
    {
      dir: "packages/agent/src/executor/cache-detection",
      cap: 350,
    },
  ];

  /**
   * Fallback exceptions: files whose further closure-extraction would
   * require either a 50+-field state shape or break the natural
   * orchestrator-edge boundary. These carry a `removedIn: "deferred"`
   * allowlist entry in test/support/architecture-allowlist.ts and are
   * revisited in a focused follow-up. Each entry is repo-relative.
   */
  const FALLBACK_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
    // Thinned PiExecutor factory + inside-lock withSession callback. The
    // withSession callback (~950L) resists clean closure extraction because
    // its hundreds of inter-references between session manager, bridge,
    // stream wrappers, context engine, tool pipeline, and runPrompt
    // invocation would require a 50+-field state shape. Likely seam is
    // sub-decomposing the bridge construction (~210L) and stream-wrapper
    // wiring (~30L) into independent helpers.
    "packages/agent/src/executor/pi-executor/pi-executor.ts",
  ]);

  for (const { dir, cap } of CAPS) {
    it(`${dir}/* production .ts files ≤${cap} lines`, () => {
      const absDir = resolve(REPO_ROOT, dir);
      // Vacuously satisfied pre-split: directory does not exist yet.
      if (!existsSync(absDir)) {
        expect([]).toEqual([]);
        return;
      }
      const files: string[] = [];
      walkProductionFiles(absDir, files);
      const violations = files
        .map((file) => ({
          file,
          lines: readFileSync(file, "utf8").split(/\r?\n/).length,
        }))
        .filter((v) => v.lines > cap)
        // Fallback exception filter — files cited above in
        // FALLBACK_EXCEPTIONS carry a `removedIn: "deferred"` allowlist
        // entry citing why further closure extraction was deferred.
        .filter((v) => !FALLBACK_EXCEPTIONS.has(repoRelative(v.file)));

      expect(
        violations,
        formatViolations({
          description: `Executor subdirectory cap: every production .ts file under ${dir}/ must be ≤${cap} lines.`,
          violations: violations.map((v) => ({
            file: repoRelative(v.file),
            line: v.lines,
            snippet: `${v.lines} lines (cap: ${cap})`,
          })),
          suggestedFix: `Extract additional helpers from the oversized module. The barrel index.ts (≤80L) re-exports only canonical names — no aliases.`,
          designRef:
            "test/architecture/file-size.test.ts (executor subdirectory caps)",
          allowlistRef:
            "FALLBACK_EXCEPTIONS Set above carries fallback paths (each backed by a removedIn: \"deferred\" allowlist entry citing the closure-extraction friction).",
        }),
      ).toEqual([]);
    });
  }
});

/**
 * Per-subdirectory stricter caps.
 *
 * Each new subdirectory created by a file-split has a stricter line cap
 * than the project-wide 800L gate. The cap is enforced ONLY when the
 * subdirectory exists.
 *
 * Walker pattern + .split(/\r?\n/).length line counter + formatViolations
 * error shape mirror the blocks above.
 */
describe("file-size — per-subdirectory caps", () => {
  const CAPS: ReadonlyArray<{ dir: string; cap: number }> = [
    // Skills
    { dir: "packages/skills/src/tools/builtin/exec-tool", cap: 600 },
    { dir: "packages/skills/src/tools/builtin/exec-security", cap: 500 },
    { dir: "packages/skills/src/skills/integrations/mcp-client", cap: 500 },
    { dir: "packages/skills/src/tools/builtin/web-search-tool", cap: 500 },
    { dir: "packages/skills/src/skills/registry/skill-registry", cap: 500 },
    // Memory
    { dir: "packages/memory/src/observability-store", cap: 500 },
    // Channels
    { dir: "packages/channels/src/telegram/telegram-adapter", cap: 500 },
    // CLI
    { dir: "packages/cli/src/tooling-fill/orchestrator", cap: 500 },
    // Core schema/contracts
    { dir: "packages/core/src/config/schema-agent", cap: 500 },
    { dir: "packages/core/src/api-contracts/workspace", cap: 500 },
    { dir: "packages/core/src/api-contracts/orchestrator", cap: 500 },
    // Daemon API
    { dir: "packages/daemon/src/api/config-handlers", cap: 400 },
    { dir: "packages/daemon/src/api/session-handlers", cap: 500 },
    { dir: "packages/daemon/src/api/graph-handlers", cap: 500 },
    { dir: "packages/daemon/src/api/obs-handlers", cap: 500 },
    // Daemon wiring + daemon.ts stages
    { dir: "packages/daemon/src/wiring/setup-agents", cap: 600 },
    { dir: "packages/daemon/src/wiring/setup-channels", cap: 600 },
    { dir: "packages/daemon/src/wiring/setup-gateway", cap: 600 },
    { dir: "packages/daemon/src/wiring/setup-cross-session", cap: 600 },
    { dir: "packages/daemon/src/stages", cap: 600 },
  ];

  /**
   * Fallback exceptions — reserved for files whose further closure
   * extraction is deferred mid-split. Each entry carries a paired
   * `removedIn: "deferred"` allowlist entry in
   * test/support/architecture-allowlist.ts citing the friction.
   */
  const FALLBACK_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
    // Reserved for fallbacks discovered during closure audits (each entry
    // gets a `removedIn: "deferred"` allowlist entry citing the friction).
  ]);

  for (const { dir, cap } of CAPS) {
    it(`${dir}/* production .ts files ≤${cap} lines`, () => {
      const absDir = resolve(REPO_ROOT, dir);
      // Vacuously satisfied pre-split: directory does not exist yet.
      if (!existsSync(absDir)) {
        expect([]).toEqual([]);
        return;
      }
      const files: string[] = [];
      walkProductionFiles(absDir, files);
      const violations = files
        .map((file) => ({
          file,
          lines: readFileSync(file, "utf8").split(/\r?\n/).length,
        }))
        .filter((v) => v.lines > cap)
        .filter((v) => !FALLBACK_EXCEPTIONS.has(repoRelative(v.file)));

      expect(
        violations,
        formatViolations({
          description: `Subdirectory cap: every production .ts file under ${dir}/ must be ≤${cap} lines.`,
          violations: violations.map((v) => ({
            file: repoRelative(v.file),
            line: v.lines,
            snippet: `${v.lines} lines (cap: ${cap})`,
          })),
          suggestedFix: `Extract additional helpers. The barrel index.ts (≤80L) re-exports only canonical names — no aliases.`,
          designRef: `test/architecture/file-size.test.ts (per-subdirectory caps)`,
          allowlistRef: `FALLBACK_EXCEPTIONS Set carries fallback paths with explicit removedIn: "deferred" entries.`,
        }),
      ).toEqual([]);
    });
  }
});

/**
 * Phase 44 Phase G per-FILE caps — WEB-DECOMP-NN family.
 *
 * Per design §10: each Wave 2-7 split commit extracts a `<view>-controller.ts`
 * alongside the existing `<view>.ts`. The PAIRED cap enforces BOTH a view ≤viewCap
 * (default 800L, tightened to 500L for 5 small files per plan-06/07 acceptance)
 * AND a controller ≤controllerCap (per-file per RESEARCH §"Decomposition"). The
 * cap activates ONLY when the controller file exists (i.e., post-split).
 *
 * Pre-split (Wave 1 — this commit): NONE of the 26 controllers exist yet. Every
 * cap is vacuously satisfied via `!existsSync(absController)`. The view's
 * existing `phase-G` `fileSizeAllowlist` entry covers the global ≤800L gate
 * until the controller exists.
 *
 * GREEN state: as each Wave 2-7 split commit creates its `<view>-controller.ts`,
 * the corresponding cap activates and enforces BOTH the tightened view cap AND
 * the controller cap. The view's `fileSizeAllowlist` entry is removed in the
 * same commit (drains the `phase-G` cohort progressively).
 *
 * Walker is NOT used here — each cap is a single absolute file path. Line
 * counter (`.split(/\r?\n/).length`) and `formatViolations()` error shape
 * mirror the HYG-03 + EXEC-SPLIT-10 + FILE-SPLIT-NN blocks above.
 */
describe("file-size — Phase 44 Phase G view caps (WEB-DECOMP-NN)", () => {
  const FILE_CAPS: ReadonlyArray<{
    file: string;
    viewCap: number;
    controllerCap: number;
    req: string;
  }> = [
    // Wave 2
    { file: "packages/web/src/views/setup-wizard.ts",          viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/skills.ts",                viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/chat-console.ts",          viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/message-center.ts",        viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/config-editor.ts",         viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    // Wave 3
    { file: "packages/web/src/views/agents/agent-editor.ts",   viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/scheduler.ts",             viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/memory-inspector.ts",      viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/observe-view.ts",          viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/models.ts",                viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    // Wave 4 (incl. graph components)
    { file: "packages/web/src/components/graph/ic-node-editor.ts",  viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-04" },
    { file: "packages/web/src/views/agents/workspace-manager.ts",   viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/channel-detail.ts",             viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/components/graph/ic-graph-canvas.ts", viewCap: 800, controllerCap: 800, req: "WEB-DECOMP-04" },
    { file: "packages/web/src/views/dashboard.ts",                  viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    // Wave 5
    { file: "packages/web/src/views/mcp-management.ts",             viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/session-detail.ts",             viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/agents/agent-list.ts",          viewCap: 800, controllerCap: 900, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/pipelines/pipeline-list.ts",    viewCap: 800, controllerCap: 700, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/pipelines/pipeline-builder.ts", viewCap: 800, controllerCap: 700, req: "WEB-DECOMP-01" },
    // Wave 6
    { file: "packages/web/src/views/agents/agent-detail.ts",        viewCap: 500, controllerCap: 700, req: "WEB-DECOMP-01" }, // W4: tightened to 500 (per plan-06 acceptance)
    { file: "packages/web/src/views/media-test.ts",                 viewCap: 500, controllerCap: 600, req: "WEB-DECOMP-01" }, // W4: tightened to 500 (per plan-06 acceptance)
    { file: "packages/web/src/components/scheduler/ic-cron-editor.ts", viewCap: 500, controllerCap: 500, req: "WEB-DECOMP-04" }, // W4: tightened to 500 (per plan-06 acceptance)
    { file: "packages/web/src/views/pipelines/pipeline-monitor.ts",    viewCap: 500, controllerCap: 500, req: "WEB-DECOMP-01" }, // W4: tightened to 500 (per plan-06 acceptance)
    // Wave 7
    { file: "packages/web/src/app.ts",                              viewCap: 800, controllerCap: 500, req: "WEB-DECOMP-01" },
    { file: "packages/web/src/views/security.ts",                   viewCap: 500, controllerCap: 500, req: "WEB-DECOMP-01" }, // W4: tightened to 500 (per plan-07 acceptance)

    // === Wave 4 Tier 2 fallback entries (W3 pre-seed) =========================
    // Per OQ-4 / PATTERNS.md §"Special cases" #14, if ic-graph-canvas Tier 1 (single
    // controller) fails to reach caps, Tier 2 falls back to TWO helper modules:
    // `ic-graph-canvas-pan-zoom.ts` + `ic-graph-canvas-drag.ts` (pure functions,
    // NOT controllers; ≤400L each per RESEARCH §"Graph Component Notes" #2).
    //
    // To AVOID mutating this CAPS array mid-phase (test-binding stability), the
    // Tier-2 entries are pre-seeded here as commented-out lines. If Wave 4 Tier 2
    // is selected, the executor UNCOMMENTS these two lines AND removes (or
    // comments out) the `ic-graph-canvas.ts` entry above — net zero array
    // mutation. Tier 1 path leaves these commented and changes nothing.
    //
    // Tier 2 contract: uncomment the two entries below + remove (or comment out)
    // the `ic-graph-canvas.ts` entry. DO NOT add net-new entries mid-phase.
    //
    // { file: "packages/web/src/components/graph/ic-graph-canvas-pan-zoom.ts", viewCap: 400, controllerCap: 0, req: "WEB-DECOMP-04" }, // Tier 2 fallback
    // { file: "packages/web/src/components/graph/ic-graph-canvas-drag.ts",     viewCap: 400, controllerCap: 0, req: "WEB-DECOMP-04" }, // Tier 2 fallback
  ];

  /**
   * §10.5 fallback exceptions — reserved for files whose view+controller cap
   * cannot be met without violating design intent. Each entry carries a paired
   * `removedIn: "deferred"` allowlist entry in test/support/architecture-allowlist.ts
   * with reason "web view; internal velocity only". Auto-acceptable per WEB-DECOMP-09.
   *
   * Empty at Wave 1 (this commit). Populated as needed by Waves 2-7 + Wave 8.
   */
  const FALLBACK_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
    // Reserved for §10.5 fallbacks (auto-acceptable per WEB-DECOMP-09).
  ]);

  for (const { file, viewCap, controllerCap, req } of FILE_CAPS) {
    it(`${file} ≤${viewCap} lines + co-located controller ≤${controllerCap} lines (${req})`, () => {
      const absView = resolve(REPO_ROOT, file);
      if (!existsSync(absView)) {
        // File was removed entirely — out of phase scope.
        expect([]).toEqual([]);
        return;
      }
      if (FALLBACK_EXCEPTIONS.has(file)) {
        // Deferred per WEB-DECOMP-09 — vacuously satisfied.
        expect([]).toEqual([]);
        return;
      }
      const controllerPath = file.replace(/\.ts$/, "-controller.ts");
      const absController = resolve(REPO_ROOT, controllerPath);
      if (!existsSync(absController)) {
        // Pre-split: vacuously satisfied. The view's fileSizeAllowlist phase-G
        // entry covers the global ≤800L gate until the controller exists.
        expect([]).toEqual([]);
        return;
      }
      // Post-split: enforce BOTH caps.
      const viewLines = readFileSync(absView, "utf8").split(/\r?\n/).length;
      const controllerLines = readFileSync(absController, "utf8").split(/\r?\n/).length;
      const violations: Array<{ path: string; lines: number; cap: number }> = [];
      if (viewLines > viewCap) {
        violations.push({ path: file, lines: viewLines, cap: viewCap });
      }
      if (controllerLines > controllerCap) {
        violations.push({ path: controllerPath, lines: controllerLines, cap: controllerCap });
      }
      expect(
        violations,
        formatViolations({
          description: `Phase 44 Phase G view+controller cap (${req}): view ≤${viewCap}L AND controller ≤${controllerCap}L.`,
          violations: violations.map((v) => ({
            file: v.path,
            line: v.lines,
            snippet: `${v.lines} lines (cap: ${v.cap})`,
          })),
          suggestedFix: `Push template helpers to view; push more action methods + state to controller. Or accept WEB-DECOMP-09 deferral (auto-acceptable) by adding to FALLBACK_EXCEPTIONS + fileSizeAllowlist with removedIn: "deferred".`,
          designRef: `code-quality-plan §10 / Phase 44 / ${req}`,
          allowlistRef: `FALLBACK_EXCEPTIONS Set carries §10.5 fallback paths with explicit removedIn: "deferred" entries (auto-acceptable per WEB-DECOMP-09).`,
        }),
      ).toEqual([]);
    });
  }
});
