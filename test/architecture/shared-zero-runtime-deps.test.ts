// SPDX-License-Identifier: Apache-2.0
/**
 * @comis/shared zero-runtime-deps invariant (ARCH-BASE-09).
 *
 * shared is the leaf-package guarantee for the published comisai bundle.
 * Adding any runtime dependency here breaks the bundling assumption that
 * shared is portable across all consumers without transitive npm fetches.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

describe("shared-zero-runtime-deps (ARCH-BASE-09)", () => {
  it("@comis/shared MUST have zero runtime `dependencies`", () => {
    const pkgJson = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "packages/shared/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkgJson.dependencies ?? {};
    const depKeys = Object.keys(deps);
    expect(
      depKeys,
      formatViolations({
        description:
          "@comis/shared MUST have zero runtime `dependencies`. Adding any breaks the published comisai bundle's leaf-package guarantee.",
        violations: depKeys.map((k) => ({
          file: `packages/shared/package.json (dependencies.${k})`,
          line: 0,
        })),
        suggestedFix:
          "Either move the dependency to devDependencies (if test-only) OR move the consumer code to a downstream package that already pins the dep.",
        designRef:
          'design §2.2 / CLAUDE.md "Supply-chain invariants"',
      }),
    ).toEqual([]);
  });
});
