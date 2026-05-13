// SPDX-License-Identifier: Apache-2.0
/**
 * moduleResolution allowlist (SKILLS-SPLIT-05).
 *
 * Asserts every consumer tsconfig in the workspace uses a subpath-aware
 * module-resolution mode: `NodeNext`, `node16`, or `bundler`. Legacy
 * `"node"` is the only mode that does NOT honor `exports`-map subpaths;
 * if reintroduced, Phase 33's 3-subpath exports (per SKILLS-SPLIT-01..04)
 * would silently break -- bare-package imports like `@comis/skills/tools`
 * would fail to resolve, falling back to the deleted package-root `main`
 * field.
 *
 * Per RES-PIT-5 in 33-RESEARCH.md, this test is the regression guard
 * against a future PR that "drops ESM strictness" by switching to legacy
 * `"node"` resolution.
 *
 * The base config MUST define `moduleResolution`; per-package configs MAY
 * inherit from base (mr === undefined is allowed). Only `packages/web/`
 * currently overrides to `"bundler"`; every other package inherits.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatViolations,
  type ViolationCitation,
} from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

/**
 * The three subpath-aware moduleResolution modes (per RES-ARCH-6).
 * `node16` is the legacy alias for `NodeNext` in TS 5.x; `bundler` is
 * the Vite/web-target equivalent.
 */
const SUBPATH_AWARE = ["NodeNext", "node16", "bundler"] as const;

/**
 * Every tsconfig file in the workspace this rule applies to.
 * Broader than WORKSPACE_PACKAGES (which excludes web + comis); SKILLS-SPLIT-05
 * covers ALL consumer tsconfigs because any of them could regress.
 */
const TSCONFIG_FILES = [
  "tsconfig.base.json",
  ...[
    "shared",
    "core",
    "infra",
    "memory",
    "scheduler",
    "skills",
    "agent",
    "channels",
    "orchestrator",
    "gateway",
    "cli",
    "daemon",
    "web",
    "comis",
  ].map((p) => `packages/${p}/tsconfig.json`),
];

/**
 * Parse a legacy "<path>: <message>" violation string into a structured
 * ViolationCitation so `formatViolations()` renders the path in the file
 * field and the issue prose in the snippet block.
 */
function structureViolation(raw: string): ViolationCitation {
  const m = raw.match(/^([^:\s]+(?:\.json)):\s*(.+)$/);
  if (m) return { file: m[1], line: 0, snippet: m[2] };
  return { file: raw, line: 0 };
}

describe("moduleResolution allowlist (SKILLS-SPLIT-05)", () => {
  it("every consumer tsconfig uses NodeNext, node16, or bundler", () => {
    const violations: string[] = [];
    for (const file of TSCONFIG_FILES) {
      const path = resolve(REPO_ROOT, file);
      const json = JSON.parse(readFileSync(path, "utf8")) as {
        compilerOptions?: { moduleResolution?: string };
      };
      const mr = json.compilerOptions?.moduleResolution;
      // tsconfig.base.json MUST define moduleResolution (subpath-aware
      // resolution is workspace-wide).
      if (file === "tsconfig.base.json" && !mr) {
        violations.push(
          `${file}: missing moduleResolution (base config must define it)`,
        );
        continue;
      }
      // Per-package configs MAY inherit (mr === undefined OK) or override
      // to one of the allowlist values. Anything else is a violation.
      if (mr && !(SUBPATH_AWARE as readonly string[]).includes(mr)) {
        violations.push(
          `${file}: moduleResolution="${mr}" not in [${SUBPATH_AWARE.join(", ")}] (per SKILLS-SPLIT-05 / RES-PIT-5)`,
        );
      }
    }
    expect(
      violations,
      formatViolations({
        description:
          "Every consumer tsconfig must use a subpath-aware moduleResolution: NodeNext, node16, or bundler. Legacy 'node' breaks Phase 33's exports-map subpaths.",
        violations: violations.map(structureViolation),
        suggestedFix:
          "Set compilerOptions.moduleResolution to 'NodeNext' (preferred for Node-target packages) or 'bundler' (for browser/Vite targets like @comis/web). Inheriting from tsconfig.base.json (no override) is also valid.",
        designRef:
          "design §10.2 (subpath exports require subpath-aware resolution) + 33-RESEARCH.md RES-ARCH-6 / RES-PIT-5",
        allowlistRef: "SKILLS-SPLIT-05",
      }),
    ).toEqual([]);
  });
});
