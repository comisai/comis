// SPDX-License-Identifier: Apache-2.0
/**
 * Project-wide closed-`errorKind` invariant.
 *
 * Runs the log-payload-checker AST walker against every packages/*\/src
 * production file (excluding `*.test.ts` and the standard exclude
 * directories), filters violations against the in-file baseline
 * allowlist, and asserts that no NEW violations have been introduced
 * since the baseline was recorded.
 *
 * The closed-union enforcement either annotates each off-union literal
 * as a valid `ErrorKind` member OR escalates to a closed-union value at
 * the call site. The baseline below is empty, so the test enforces
 * strict closed-union enforcement.
 *
 * Baseline shape: each entry is a string `<relpath>:<line>:<literal>`
 * where `relpath` is the path relative to the repository root, `line`
 * is the 1-indexed line number reported by the walker, and `literal`
 * is the off-union value (or the sentinel `<unresolved type>` when the
 * TypeChecker resolved `errorKind` to the open `string` type rather
 * than a literal).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLogPayloads } from "../support/log-payload-checker.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

const WORKSPACE_PACKAGES = [
  "shared",
  "core",
  "infra",
  "memory",
  "scheduler",
  "skills",
  "agent",
  "channels",
  "gateway",
  "cli",
  "daemon",
] as const;

/**
 * Closed-union `errorKind` baseline — currently empty.
 *
 * Prior off-union `errorKind` literal sites (e.g. `performance`,
 * `delivery`, `transient`, `permanent`, `io`, `state`, `data`,
 * `operational`, `retrieval_failure`, `unsupported_region`,
 * `callback_validation_failed`, `invalid_grant`, `refresh_token_reused`,
 * `identity_decode_failed`, `callback_timeout`) have all been retired
 * via two passes:
 *   1. Adding `as const` to in-union literals so TypeChecker preserves
 *      the literal type (mechanical fix).
 *   2. Replacing off-union literals with the closest closed-union value.
 *   3. Routing every OAuth-derived logger payload to `errorKind: "auth"`.
 *
 * The set is empty; the architecture rule asserts strictly-closed
 * enforcement. ANY new off-union literal in `errorKind:` position fails
 * the gate immediately.
 */
const L16_BASELINE_VIOLATIONS = new Set<string>([
  // No baseline violations remain.
]);

/**
 * Walk every workspace package's `src/` and return the absolute path of
 * each non-test `.ts` production file. Mirrors the source-rules.test.ts
 * walker shape so the two architecture-level tests have consistent file
 * coverage.
 */
function listAllProductionFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
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
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        out.push(full);
      }
    }
  }
  for (const pkg of WORKSPACE_PACKAGES) {
    walk(resolve(PACKAGES_ROOT, pkg, "src"));
  }
  return out;
}

describe("log-payload-checker -- closed errorKind invariant", () => {
  it("no NEW off-union errorKind literals beyond the empty baseline", () => {
    const allFiles = listAllProductionFiles();
    const violations = checkLogPayloads(allFiles);

    const newViolations = violations.filter((v) => {
      const relPath = v.file.startsWith(REPO_ROOT)
        ? v.file.slice(REPO_ROOT.length + 1)
        : v.file;
      const key = `${relPath}:${v.line}:${v.literal}`;
      return !L16_BASELINE_VIOLATIONS.has(key);
    });

    expect(
      newViolations,
      formatViolations({
        description:
          "New off-union `errorKind` literals detected — outside the closed-union baseline.",
        violations: newViolations.map((v) => ({
          file: `${v.file}:${v.line}:${v.character}`,
          line: v.line,
          column: v.character,
          snippet: `errorKind: "${v.literal}" — not in closed union (config|network|auth|validation|timeout|resource|dependency|internal|platform)`,
        })),
        suggestedFix:
          "Use one of the 9 valid ErrorKind values per AGENTS.md §2.1. If a new kind is genuinely required, the closed union must be extended via design-doc amendment (NOT a feature PR).",
        designRef:
          "AGENTS.md §2.1 / design §1.3",
        allowlistRef: "L16_BASELINE_VIOLATIONS (in-file sub-allowlist)",
      }),
    ).toEqual([]);

    // Sanity: walker actually scanned production files.
    expect(
      allFiles.length,
      "sanity: listAllProductionFiles enumerated at least one file",
    ).toBeGreaterThan(0);
  });
});
