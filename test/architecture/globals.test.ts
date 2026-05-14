// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide globals invariant (HYG-07, HYG-08, HYG-10, HYG-11, HYG-12).
 *
 * Forbids direct calls to `Date.now()`, `new Date(...)`, `process.env[...]`,
 * `setTimeout(...)`, `setInterval(...)`, `clearTimeout(...)`,
 * `clearInterval(...)` in production source under `packages/*\/src/`
 * outside the bootstrap/runtime adapter allowlist (AGENTS.md §2.2
 * sanctioned paths — see `BOOTSTRAP_PATH_PATTERNS` in
 * test/support/globals-classifier.ts).
 *
 * The classifier (`classifyGlobals`) is AST + TypeChecker-aware: it skips
 * JSDoc / type-only imports / string literals / `*.generated.ts` and
 * exempts `.unref()` / `.cancel()` / `.ref()` calls on `TimerHandle` /
 * `NodeJS.Timeout` / `NodeJS.Immediate`.
 *
 * Phase 39 (PORTS) closes every flagged site by retargeting to injected
 * `ClockPort` / `EnvPort` / `TimerPort` deps. Phase 37 seeds
 * `globalsAllowlist` with one entry per current callable-global site
 * outside `BOOTSTRAP_PATH_PATTERNS` (~360+1 entries, including the
 * HYG-12 marker). All entries are tagged `removedIn: "phase-B"`; Phase
 * 39 (PORTS) removes each entry atomically as the corresponding site
 * is retargeted through ClockPort/EnvPort/TimerPort (design doc §5.2
 * steps 7-8). No entry is allowed to outlive its retarget.
 *
 * Fixture validation (HYG-11) runs BEFORE the production scan: the
 * classifier must produce ≥7 violations on `globals-positive.ts` and
 * 0 violations on `globals-negative.ts` before we trust its production
 * output.
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

describe("globals — classifier fixture-positive (HYG-10, HYG-11)", () => {
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

describe("globals — classifier fixture-negative (HYG-10, HYG-11)", () => {
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
        designRef:
          "code-quality-plan §4.5 (5) / Phase A / D-GLOB-03 — TypeChecker exemption for TimerHandle.unref()",
      }),
    ).toEqual([]);
  });
});

describe("globals — production source (HYG-07, HYG-08, HYG-12)", () => {
  beforeEach(() => resetCacheForTest());
  it("no NEW callable global outside bootstrap regex + globalsAllowlist", () => {
    const allFiles = listAllProductionFiles();
    const violations = classifyGlobals(allFiles);

    // Allowlist key shape: {file, line, global} per PATTERNS.md key table.
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
          "Production source outside the bootstrap/runtime adapter allowlist directly calls a forbidden global. Phase 39 (PORTS) closes these by retargeting to injected ClockPort / EnvPort / TimerPort.",
        violations: newViolations.map((v) => ({
          file: repoRelative(v.file),
          line: v.line,
          column: v.character,
          snippet: `${v.pattern} — use injected port (clock/env/timers) instead`,
        })),
        suggestedFix:
          "Inject ClockPort / EnvPort / TimerPort via deps and retarget. See design §4.2 (5) + §5.2 + Phase B (PORTS-11..13). If a NEW sanctioned path is required, EXTEND BOOTSTRAP_PATH_PATTERNS in test/support/globals-classifier.ts (don't add an allowlist entry).",
        designRef:
          "code-quality-plan §4.2 (5) / Phase A / HYG-07 / Phase B PORTS-11..13",
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
