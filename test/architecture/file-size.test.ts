// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide file-size invariant (HYG-03).
 *
 * Every production `.ts` file under `packages/*\/src/` must be ≤800 lines
 * unless it carries a `fileSizeAllowlist` entry in
 * `test/support/architecture-allowlist.ts` tagged with the closing phase
 * (Phase E/F/G per design §8/§9/§10).
 *
 * The walker hard-excludes generated files (`*.generated.ts`) and
 * declaration files (`*.d.ts`) at the basename level — per RESEARCH.md
 * Landmine §3 the 9569-line `packages/web/src/api/contracts.generated.ts`
 * must never reach the rule.
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
 * two added basename filters: `.generated.ts` and `.d.ts` (Landmine §3).
 *
 * Note: walks `packages/<pkg>/src/` for every directory under `packages/`
 * — does NOT hard-code WORKSPACE_PACKAGES, so new packages added in
 * future phases are automatically scanned.
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

describe("file-size — production .ts ≤800 lines (HYG-03)", () => {
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
          "Split the file per design §8/§9/§10 (Phases 42/43/44) or add a fileSizeAllowlist entry to test/support/architecture-allowlist.ts with removedIn tagged to the closing phase. NEVER add a *.generated.ts file to the allowlist — fix the walker exclusion instead.",
        designRef:
          "code-quality-plan §4.2 (1) / Phase A / HYG-03 / Phases 42/43/44 close splits",
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
      "Landmine §3: *.generated.ts MUST be excluded at walker basename filter, NOT via the allowlist",
    ).toEqual([]);
  });
});

/**
 * EXEC-SPLIT-10 — Phase 42 executor subdirectory stricter caps.
 *
 * Per design §8.4: each extracted module in the four new executor
 * subdirectories has a stricter line cap than the project-wide 800L
 * HYG-03 gate. The cap is enforced ONLY when the subdirectory exists
 * (i.e., after each Wave 2-5 split commit lands).
 *
 * Pre-split (Wave 1) state: the four target directories do not exist
 * yet; the assertion is vacuously satisfied (empty violations array).
 *
 * GREEN state: as each split commit (Wave 2 cache-detection → Wave 3
 * request-body → Wave 4 prompt-runner → Wave 5 pi-executor) lands, the
 * directory comes into existence and the test enforces the cap.
 *
 * Walker pattern + .split(/\r?\n/).length line counter + formatViolations
 * error shape mirror the parent HYG-03 block above.
 */
describe("file-size — Phase 42 executor subdirectory caps (EXEC-SPLIT-10)", () => {
  const CAPS: ReadonlyArray<{ dir: string; cap: number; req: string }> = [
    {
      dir: "packages/agent/src/executor/stream-wrappers/request-body",
      cap: 600,
      req: "EXEC-SPLIT-02",
    },
    {
      dir: "packages/agent/src/executor/pi-executor",
      cap: 400,
      req: "EXEC-SPLIT-05",
    },
    {
      dir: "packages/agent/src/executor/prompt-runner",
      cap: 500,
      req: "EXEC-SPLIT-07",
    },
    {
      dir: "packages/agent/src/executor/cache-detection",
      cap: 350,
      req: "EXEC-SPLIT-09",
    },
  ];

  /**
   * §13.3 fallback exceptions (per Plan 42-05 + Plan 42-05-SUMMARY.md):
   * files whose further closure-extraction would require either a 50+-field
   * state shape or break the natural orchestrator-edge boundary. These
   * carry a `removedIn: "deferred"` allowlist entry in
   * test/support/architecture-allowlist.ts and are revisited in a focused
   * follow-up. Each entry is repo-relative.
   */
  const FALLBACK_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
    // Plan 42-05 §13.3: thinned PiExecutor factory + inside-lock withSession
    // callback. 4 closure-extracted helpers shipped (safety-gate,
    // compaction-trigger, executor-error-mapping, session-bootstrap,
    // message-envelope — all state-first per EXEC-SPLIT-06). The
    // withSession callback (~950L) resists clean closure extraction because
    // its hundreds of inter-references between session manager, bridge,
    // stream wrappers, context engine, tool pipeline, and runPrompt
    // invocation would require a 50+-field state shape. Revisit in Phase G/H
    // — likely seam is sub-decomposing the bridge construction (~210L) and
    // stream-wrapper wiring (~30L) into independent helpers.
    "packages/agent/src/executor/pi-executor/pi-executor.ts",
  ]);

  for (const { dir, cap, req } of CAPS) {
    it(`${dir}/* production .ts files ≤${cap} lines (${req})`, () => {
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
        // §13.3 fallback exception filter — files cited above in
        // FALLBACK_EXCEPTIONS Set carry a `removedIn: "deferred"` allowlist
        // entry citing why further closure extraction was deferred.
        .filter((v) => !FALLBACK_EXCEPTIONS.has(repoRelative(v.file)));

      expect(
        violations,
        formatViolations({
          description: `Phase 42 executor subdirectory cap (${req}): every production .ts file under ${dir}/ must be ≤${cap} lines.`,
          violations: violations.map((v) => ({
            file: repoRelative(v.file),
            line: v.lines,
            snippet: `${v.lines} lines (cap: ${cap})`,
          })),
          suggestedFix: `Extract additional helpers from the oversized module per design §8.2 decomposition. The barrel index.ts (≤80L) re-exports only canonical names — no aliases.`,
          designRef: `code-quality-plan §8.4 / Phase 42 / ${req}`,
          allowlistRef:
            "FALLBACK_EXCEPTIONS Set above carries §13.3 fallback paths (each backed by a removedIn: \"deferred\" allowlist entry citing the closure-extraction friction).",
        }),
      ).toEqual([]);
    });
  }
});

/**
 * Phase 43 Phase F subdirectory stricter caps — FILE-SPLIT-NN family.
 *
 * Per design §9: each new subdirectory created by a Wave 2-8 split has a
 * stricter line cap than the project-wide 800L HYG-03 gate. The cap is
 * enforced ONLY when the subdirectory exists (i.e., after each split commit
 * lands).
 *
 * Pre-split state (Wave 1 — this commit): NONE of the target subdirectories
 * exist yet. Every cap is vacuously satisfied via `!existsSync(absDir)`.
 *
 * GREEN state: as each Wave 2-8 split commit creates its subdirectory, the
 * corresponding cap activates and enforces. Wave-by-wave:
 *   Wave 2 — skills (exec-tool, exec-security, mcp-client, web-search-tool, skill-registry)
 *   Wave 3 — memory (observability-store)
 *   Wave 4 — channels (telegram-adapter)
 *   Wave 5 — CLI (tooling-fill/orchestrator)
 *   Wave 6 — core schema/contracts (schema-agent, workspace, orchestrator)
 *   Wave 7 — daemon API (config-handlers, session-handlers, graph-handlers, obs-handlers)
 *   Wave 8 — daemon wiring + daemon.ts stages (setup-agents/channels/gateway/cross-session, stages/)
 *
 * Walker pattern + .split(/\r?\n/).length line counter + formatViolations
 * error shape mirror the HYG-03 + EXEC-SPLIT-10 blocks above.
 */
describe("file-size — Phase 43 Phase F subdirectory caps (FILE-SPLIT-NN)", () => {
  const CAPS: ReadonlyArray<{ dir: string; cap: number; req: string }> = [
    // Wave 2: Skills
    { dir: "packages/skills/src/tools/builtin/exec-tool", cap: 600, req: "FILE-SPLIT-02" },
    { dir: "packages/skills/src/tools/builtin/exec-security", cap: 500, req: "FILE-SPLIT-11" },
    { dir: "packages/skills/src/skills/integrations/mcp-client", cap: 500, req: "FILE-SPLIT-11" },
    { dir: "packages/skills/src/tools/builtin/web-search-tool", cap: 500, req: "FILE-SPLIT-11" },
    { dir: "packages/skills/src/skills/registry/skill-registry", cap: 500, req: "FILE-SPLIT-11" },
    // Wave 3: Memory
    { dir: "packages/memory/src/observability-store", cap: 500, req: "FILE-SPLIT-13" },
    // Wave 4: Channels
    { dir: "packages/channels/src/telegram/telegram-adapter", cap: 500, req: "FILE-SPLIT-12" },
    // Wave 5: CLI
    { dir: "packages/cli/src/tooling-fill/orchestrator", cap: 500, req: "FILE-SPLIT-10" },
    // Wave 6: Core schema/contracts
    { dir: "packages/core/src/config/schema-agent", cap: 500, req: "FILE-SPLIT-14" },
    { dir: "packages/core/src/api-contracts/workspace", cap: 500, req: "FILE-SPLIT-14" },
    { dir: "packages/core/src/api-contracts/orchestrator", cap: 500, req: "FILE-SPLIT-14" },
    // Wave 7: Daemon API
    { dir: "packages/daemon/src/api/config-handlers", cap: 400, req: "FILE-SPLIT-03" },
    { dir: "packages/daemon/src/api/session-handlers", cap: 500, req: "FILE-SPLIT-04" },
    { dir: "packages/daemon/src/api/graph-handlers", cap: 500, req: "FILE-SPLIT-05" },
    { dir: "packages/daemon/src/api/obs-handlers", cap: 500, req: "FILE-SPLIT-09" },
    // Wave 8: Daemon wiring + daemon.ts stages
    { dir: "packages/daemon/src/wiring/setup-agents", cap: 600, req: "FILE-SPLIT-08" },
    { dir: "packages/daemon/src/wiring/setup-channels", cap: 600, req: "FILE-SPLIT-08" },
    { dir: "packages/daemon/src/wiring/setup-gateway", cap: 600, req: "FILE-SPLIT-08" },
    { dir: "packages/daemon/src/wiring/setup-cross-session", cap: 600, req: "FILE-SPLIT-08" },
    { dir: "packages/daemon/src/stages", cap: 600, req: "FILE-SPLIT-06" },
  ];

  /**
   * §13.3 fallback exceptions — reserved for files whose further closure
   * extraction is deferred mid-wave. Each entry carries a paired
   * `removedIn: "deferred"` allowlist entry in test/support/architecture-allowlist.ts
   * citing the friction.
   *
   * Empty at Wave 1 (this commit). Populated as needed by Waves 2-8 closure
   * audits.
   */
  const FALLBACK_EXCEPTIONS: ReadonlySet<string> = new Set<string>([
    // Reserved for §13.3 fallbacks discovered mid-wave (each entry gets a
    // `removedIn: "deferred"` allowlist entry citing the friction).
  ]);

  for (const { dir, cap, req } of CAPS) {
    it(`${dir}/* production .ts files ≤${cap} lines (${req})`, () => {
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
          description: `Phase 43 Phase F subdirectory cap (${req}): every production .ts file under ${dir}/ must be ≤${cap} lines.`,
          violations: violations.map((v) => ({
            file: repoRelative(v.file),
            line: v.lines,
            snippet: `${v.lines} lines (cap: ${cap})`,
          })),
          suggestedFix: `Extract additional helpers per RESEARCH §"Decomposition" tables. The barrel index.ts (≤80L) re-exports only canonical names — no aliases.`,
          designRef: `code-quality-plan §9 / Phase 43 / ${req}`,
          allowlistRef: `FALLBACK_EXCEPTIONS Set carries §13.3 fallback paths with explicit removedIn: "deferred" entries.`,
        }),
      ).toEqual([]);
    });
  }
});
