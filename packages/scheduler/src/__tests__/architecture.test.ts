// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/scheduler.
 *
 * Forbidden-import rules:
 *   - Production source MUST NOT import @comis/{agent, channels, memory,
 *     skills, cli, gateway, daemon, orchestrator}. scheduler is a leaf
 *     in the §2.2 package graph; allowed @comis/* deps are exactly
 *     {@comis/shared, @comis/core}.
 *   - Production source MUST NOT import "proper-lockfile". Phase 35 Plan
 *     35-04 (D-01 #1) relocated the canonical createFileLock() factory
 *     from packages/scheduler/src/execution/execution-lock.ts to
 *     packages/core/src/runtime/file-lock.ts. Scheduler internals that
 *     still need a file lock consume FileLockPort.withLock() via
 *     `createFileLock()` from @comis/core.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { findInSourceFiles } from "../../../../test/support/source-grep.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

const FORBIDDEN_PACKAGES = [
  "@comis/agent",
  "@comis/channels",
  "@comis/memory",
  "@comis/skills",
  "@comis/cli",
  "@comis/gateway",
  "@comis/daemon",
  "@comis/orchestrator",
] as const;

// Path of the package surface (scheduler/src/index.ts) — used by the
// "createFileLock is NOT exported" rule below (Phase 35 Plan 35-04 / D-01 #1).
const SCHEDULER_INDEX = resolve(SRC_ROOT, "index.ts");

describe("@comis/scheduler -- architecture invariants", () => {
  it("does NOT export createFileLock from package surface (D-01 #1 — relocated to @comis/core)", async () => {
    // Phase 35 Plan 35-04 (D-01 #1): the FileLockPort factory lives in
    // @comis/core/runtime/file-lock.ts now. Scheduler MUST NOT re-export it
    // (deletes the architecture-allowlist L6 + L19 dependency edges).
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(SCHEDULER_INDEX, "utf8");
    expect(
      /export\s*\{[^}]*\bcreateFileLock\b[^}]*\}/.test(source),
      "scheduler/src/index.ts MUST NOT re-export createFileLock (Phase 35 Plan 35-04 / D-01 #1). External consumers import createFileLock from @comis/core.",
    ).toBe(false);
  });

  it("does NOT export withExecutionLock, isLocked, or ExecutionLockOptions from package surface (Phase 35 Plan 35-04 — deleted alongside execution-lock.ts)", async () => {
    // The legacy helpers (withExecutionLock + isLocked + ExecutionLockOptions)
    // were file-internal in execution-lock.ts. Phase 35 Plan 35-04 deletes that
    // file entirely; scheduler internals consume `createFileLock().withLock()`
    // from @comis/core.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(SCHEDULER_INDEX, "utf8");
    const offenders: string[] = [];
    if (/export\s*\{[^}]*\bwithExecutionLock\b[^}]*\}/.test(source)) {
      offenders.push("withExecutionLock");
    }
    if (/export\s*\{[^}]*\bisLocked\b[^}]*\}/.test(source)) {
      offenders.push("isLocked");
    }
    if (/export\s+type\s*\{[^}]*\bExecutionLockOptions\b[^}]*\}/.test(source)) {
      offenders.push("ExecutionLockOptions");
    }
    expect(
      offenders,
      "scheduler/src/index.ts MUST NOT re-export withExecutionLock / isLocked / ExecutionLockOptions (Phase 35 Plan 35-04 / D-01 #1). These were deleted alongside execution-lock.ts.",
    ).toEqual([]);
  });

  for (const forbidden of FORBIDDEN_PACKAGES) {
    it(`production source does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/scheduler production source must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            "scheduler depends only on @comis/{shared, core}. If a type is needed, move it to @comis/core/ports.",
          designRef:
            "design §2.2 (target package graph) / §5.2 (FileLockPort lives in core)",
        }),
      ).toEqual([]);
      expect(checkedFiles, "sanity: findForbiddenImports walked at least one scheduler/src file").toBeGreaterThan(0);
    });
  }

  it("scheduler production source contains zero 'proper-lockfile' imports (Phase 35 Plan 35-04 / D-01 #1)", () => {
    // After execution-lock.ts deletion the scheduler package contains no
    // proper-lockfile consumers in production code. The check uses
    // findInSourceFiles' substring matcher (proper-lockfile is a regular
    // npm package, not a @comis/* module, so AST module-specifier checks
    // don't apply).
    const result = findInSourceFiles({
      rootDir: SRC_ROOT,
      needle: "proper-lockfile",
      excludeFileSuffixes: [".test.ts"],
    });
    expect(
      result.matches,
      formatViolations({
        description:
          "@comis/scheduler production source must not import 'proper-lockfile' — it was relocated to @comis/core in Phase 35 Plan 35-04 alongside the createFileLock() factory.",
        violations: result.matches.map((file) => ({ file, line: 0 })),
        suggestedFix:
          "Consume the FileLockPort returned by createFileLock() from @comis/core instead of importing proper-lockfile directly.",
        designRef: "design §5.2 (FileLockPort) + Phase 35 Plan 35-04 (D-01 #1)",
      }),
    ).toEqual([]);
    expect(result.checkedFiles, "sanity: findInSourceFiles walked at least one file in @comis/scheduler/src").toBeGreaterThan(0);
  });
});
