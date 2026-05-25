// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide globals invariant.
 *
 * Forbids direct calls to `Date.now()`, `new Date(...)`, `process.env[...]`,
 * `setTimeout(...)`, `setInterval(...)`, `clearTimeout(...)`,
 * `clearInterval(...)` in production source under `packages/*\/src/`
 * outside the bootstrap/runtime adapter allowlist (see `BOOTSTRAP_PATH_PATTERNS` in
 * test/support/globals-classifier.ts for the sanctioned paths).
 *
 * The classifier (`classifyGlobals`) is AST + TypeChecker-aware: it skips
 * JSDoc / type-only imports / string literals / `*.generated.ts` and
 * exempts `.unref()` / `.cancel()` / `.ref()` calls on `TimerHandle` /
 * `NodeJS.Timeout` / `NodeJS.Immediate`.
 *
 * Each flagged site is closed by retargeting to injected `ClockPort` /
 * `EnvPort` / `TimerPort` deps. `globalsAllowlist` carries one entry per
 * still-pending callable-global site outside `BOOTSTRAP_PATH_PATTERNS`;
 * entries are removed atomically as each site is retargeted. No entry is
 * allowed to outlive its retarget.
 *
 * Fixture validation runs BEFORE the production scan: the classifier
 * must produce ≥7 violations on `globals-positive.ts` and 0 violations
 * on `globals-negative.ts` before we trust its production output.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyGlobals,
  resetCacheForTest,
} from "../support/globals-classifier.js";
import { formatViolations } from "../support/architecture-helpers.js";
import { globalsAllowlist } from "../support/architecture-allowlist.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const FIXTURES_DIR = resolve(here, "fixtures");

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT)
    ? absPath.slice(REPO_ROOT.length + 1)
    : absPath;
}

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
    if (entry.isSymbolicLink()) continue;
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

describe("globals — classifier fixture-positive", () => {
  beforeEach(() => resetCacheForTest());
  it("globals-positive fixture produces ≥7 violations (one per pattern)", () => {
    const fixture = resolve(FIXTURES_DIR, "globals-positive.ts");
    // Fixtures live under test/, which is in BOOTSTRAP_PATH_PATTERNS for
    // production scans. Opt out of that exemption so the classifier
    // actually classifies the fixture content.
    const violations = classifyGlobals([fixture], { respectBootstrapPaths: false });
    expect(
      violations.length,
      `Classifier must detect at least 7 violations in the positive fixture (got ${violations.length})`,
    ).toBeGreaterThanOrEqual(7);

    // Also verify diversity: at least 4 distinct GlobalPattern values
    // surfaced (sanity that the classifier isn't double-counting one
    // pattern type).
    const distinctPatterns = new Set(violations.map((v) => v.pattern));
    expect(
      distinctPatterns.size,
      `Classifier must detect at least 4 distinct GlobalPattern types (got ${distinctPatterns.size}: ${[...distinctPatterns].join(", ")})`,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe("globals — classifier fixture-negative", () => {
  beforeEach(() => resetCacheForTest());
  it("globals-negative fixture produces 0 violations", () => {
    const fixture = resolve(FIXTURES_DIR, "globals-negative.ts");
    // Same opt-out as positive: fixtures live under test/.
    const violations = classifyGlobals([fixture], { respectBootstrapPaths: false });

    expect(
      violations,
      formatViolations({
        description:
          "globals-negative fixture MUST classify clean — JSDoc, type-only imports, string literals, identifier mentions, TimerHandle.unref(), and object-property setTimeout must not match.",
        violations: violations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          column: v.character,
          snippet: `${v.pattern} — ${v.snippet}`,
        })),
        suggestedFix:
          "Adjust the classifier so the named CLEAN case is no longer matched. Negative fixtures pin the boundary of classifier correctness. Common bugs: comment-traversal, type-only-import recognition, or missing TypeChecker exemption for TimerHandle/NodeJS.Timeout receivers.",
      }),
    ).toEqual([]);
  });
});

describe("globals — production source", () => {
  beforeEach(() => resetCacheForTest());
  it("no NEW callable global outside bootstrap regex + globalsAllowlist", () => {
    const allFiles = listAllProductionFiles();
    const violations = classifyGlobals(allFiles);

    // Allowlist key shape: {file, line, global}.
    // Each occurrence is a distinct site.
    const allowlistKey = new Set(
      globalsAllowlist.map((e) => `${e.file}:${e.line}:${e.global}`),
    );
    const newViolations = violations.filter(
      (v) =>
        !allowlistKey.has(
          `${repoRelative(v.file)}:${v.line}:${v.pattern}`,
        ),
    );

    expect(
      newViolations,
      formatViolations({
        description:
          "Production source outside the bootstrap/runtime adapter allowlist directly calls a forbidden global. Close these by retargeting to injected ClockPort / EnvPort / TimerPort.",
        violations: newViolations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          column: v.character,
          snippet: `${v.pattern} — use injected port (clock/env/timers) instead`,
        })),
        suggestedFix:
          "Inject ClockPort / EnvPort / TimerPort via deps and retarget. If a NEW sanctioned path is required, EXTEND BOOTSTRAP_PATH_PATTERNS in test/support/globals-classifier.ts (don't add an allowlist entry).",
        allowlistRef:
          "globalsAllowlist (test/support/architecture-allowlist.ts)",
      }),
    ).toEqual([]);

    // Sanity: walker actually scanned production files.
    expect(
      allFiles.length,
      "sanity: listAllProductionFiles enumerated at least one file",
    ).toBeGreaterThan(0);
  });
});
