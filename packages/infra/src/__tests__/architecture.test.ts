// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariants for @comis/infra.
 *
 * Forbidden-import rules: production source MUST NOT import any of the
 * downstream packages (@comis/agent, @comis/channels, @comis/skills,
 * @comis/scheduler, @comis/cli, @comis/gateway, @comis/memory,
 * @comis/daemon, @comis/orchestrator). infra is a low-level logging
 * + utility package; nothing downstream may flow back into it.
 *
 * Note (L12 closed in Phase 28 commit 2 / CORE-PORTS-05): the Pino-free
 * structural ComisLogger contract + LogFields + ErrorKind +
 * VALID_LOG_LEVELS + isValidLogLevel canonically live in @comis/core.
 * @comis/infra is now Pino-runtime-only; `infra/src/logging/logger.ts`
 * imports ComisLogger as a type alias from @comis/core (assignability
 * proof: `infra/src/logging/__tests__/logger-contract.test.ts`).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { findForbiddenImports } from "../../../../test/support/import-checker.js";
import { formatViolations } from "../../../../test/support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");

const FORBIDDEN_PACKAGES = [
  "@comis/agent",
  "@comis/channels",
  "@comis/skills",
  "@comis/scheduler",
  "@comis/cli",
  "@comis/gateway",
  "@comis/memory",
  "@comis/daemon",
  "@comis/orchestrator",
] as const;

describe("@comis/infra -- architecture invariants", () => {
  for (const forbidden of FORBIDDEN_PACKAGES) {
    it(`production source does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: SRC_ROOT,
        forbiddenPackage: forbidden,
      });
      expect(
        violations,
        formatViolations({
          description: `@comis/infra production source must not import ${forbidden}.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            "If a type is needed, move it to @comis/core; if a runtime value, the dependency direction is wrong (infra is downstream-of nothing in the §2.2 target package graph).",
          designRef: "design §2.2 / L12 (logger types canonical location)",
        }),
      ).toEqual([]);
      // Pattern E sanity check: helper actually walked production source files.
      expect(checkedFiles, "sanity: findForbiddenImports walked at least one infra/src file").toBeGreaterThan(0);
    });
  }

  it("infra/src/logging/logger.ts imports ComisLogger contract from @comis/core", () => {
    // Phase 28 commit 2 (CORE-PORTS-05) closed L12: the Pino-free structural
    // ComisLogger contract canonically lives in @comis/core, not @comis/infra.
    // The infra logger module retypes its `ComisLogger` alias to point at the
    // core contract; the assignability proof in
    // `infra/src/logging/__tests__/logger-contract.test.ts` guarantees the
    // Pino-backed runtime impl satisfies the structural shape.
    //
    // This rule guards the source-grep boundary so a future edit that
    // recreates a local `pino.Logger<...>` alias (without going through the
    // core contract) is caught pre-merge.
    const loggerPath = resolve(SRC_ROOT, "logging", "logger.ts");
    const content = readFileSync(loggerPath, "utf8");
    expect(
      content.includes(
        'import type { ComisLogger as CoreComisLogger } from "@comis/core"',
      ),
      "L12 (closed in Phase 28 commit 2 / CORE-PORTS-05): infra/src/logging/logger.ts " +
        'must `import type { ComisLogger as CoreComisLogger } from "@comis/core"`. ' +
        "The Pino-free structural ComisLogger contract canonically lives in @comis/core; " +
        "infra's runtime Pino factory must retype its ComisLogger alias to point at it.",
    ).toBe(true);
    expect(
      content.includes("export type ComisLogger = CoreComisLogger"),
      "L12 (closed in Phase 28 commit 2 / CORE-PORTS-05): infra/src/logging/logger.ts " +
        "must `export type ComisLogger = CoreComisLogger`. Re-aliasing keeps every " +
        "call-site name inside infra unchanged while moving the contract canonical " +
        "home to @comis/core.",
    ).toBe(true);
  });
});
