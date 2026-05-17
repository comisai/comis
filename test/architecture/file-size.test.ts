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
