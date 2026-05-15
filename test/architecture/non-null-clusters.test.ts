// SPDX-License-Identifier: Apache-2.0
/**
 * Non-null assertion cluster gate (TS-HYG-12).
 *
 * Forward-looking architecture test: prevents regression in the 4 files where
 * Phase 41 Plan 41-06 eliminated concentrated `!.` clusters by introducing the
 * requireGlobalState helper (TS-HYG-12 foundation, Plan 41-03), explicit
 * length-checks, named regex groups, or pinned-narrowed values.
 *
 * Any future `<identifier>!.` or `<identifier>!;` in these files trips the
 * gate. See .planning/phases/41-typescript-hygiene/41-RESEARCH.md §"Non-Null
 * Cluster Fixes" for the approved alternatives.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

const CLUSTER_FILES: readonly string[] = [
  "packages/web/src/app.ts",
  "packages/core/src/config/git-manager.ts",
  "packages/core/src/config/env-substitution.ts",
  "packages/memory/src/memory-api.ts",
] as const;

describe("Non-null assertion cluster gate (TS-HYG-12)", () => {
  it.each(CLUSTER_FILES)(
    "%s contains zero non-null assertion clusters (`!.` or `!;`)",
    (relPath) => {
      const content = readFileSync(resolve(REPO_ROOT, relPath), "utf8");
      const lines = content.split("\n");
      const offenders: { line: number; text: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        // Skip lines that are pure single-line comments / JSDoc continuations.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        // Detect `<identifier>!.` or `<identifier>!;` on an identifier (not `!=`).
        if (
          /[A-Za-z_$][A-Za-z0-9_$]*!\./.test(line) ||
          /[A-Za-z_$][A-Za-z0-9_$]*!;/.test(line)
        ) {
          offenders.push({ line: i + 1, text: line.trim() });
        }
      }
      expect(
        offenders,
        `${relPath} must contain zero non-null assertion clusters (TS-HYG-12). ` +
          `Use requireGlobalState helper, explicit length-checks, named regex groups, ` +
          `or pin-narrowed values per .planning/phases/41-typescript-hygiene/41-RESEARCH.md §"Non-Null Cluster Fixes". ` +
          `Offenders: ${JSON.stringify(offenders, null, 2)}`,
      ).toEqual([]);
    },
  );
});
