// SPDX-License-Identifier: Apache-2.0
/**
 * Lock-in: @comis/observability imports neither @comis/agent nor
 * @comis/daemon nor @comis/cli nor @comis/orchestrator. Top-level
 * defense-in-depth boundary at the architecture-allowlist level.
 *
 * Mirrors `cli-no-agent-no-infra.test.ts` per research §6.1: source-level
 * AST walker via `findForbiddenImports` PLUS grep-assertions on
 * `package.json` and `tsconfig.json` — so a future PR that re-adds a
 * workspace dep or tsconfig reference is caught by the architecture
 * suite before any source-level import regression.
 *
 * The four forbidden packages are the consumer-tier siblings of
 * observability: agent runs LLM execution flow, daemon hosts the
 * composition root, cli is the operator entrypoint, orchestrator owns
 * inbound pipeline + execution coordination. None of them should be
 * pulled into the observability substrate — substrate is a leaf
 * dependency of agent / daemon / orchestrator, not the other way around.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenImports } from "../support/import-checker.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const OBSERVABILITY_SRC = resolve(REPO_ROOT, "packages/observability/src");

describe("@comis/observability isolation — no @comis/agent + @comis/daemon + @comis/cli + @comis/orchestrator", () => {
  for (const forbidden of [
    "@comis/agent",
    "@comis/daemon",
    "@comis/cli",
    "@comis/orchestrator",
  ] as const) {
    it(`observability/src imports do NOT include ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: OBSERVABILITY_SRC,
        forbiddenPackage: forbidden,
        excludeFileSuffixes: [".test.ts"],
      });
      expect(
        violations,
        formatViolations({
          description: `observability/src imports must not include ${forbidden}`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix:
            "Substrate is a leaf dep of agent/daemon/cli/orchestrator. Retarget the import to @comis/core / @comis/infra / @comis/shared (the substrate's only three allowed peer packages).",
          designRef:
            "@comis/observability must remain a leaf in the dep graph (research §6.1)",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one observability/src file",
      ).toBeGreaterThan(0);
    });
  }

  it("packages/observability/package.json declares no agent / daemon / cli / orchestrator dependency", () => {
    const pkg = readFileSync(
      resolve(REPO_ROOT, "packages/observability/package.json"),
      "utf8",
    );
    for (const forbidden of [
      "@comis/agent",
      "@comis/daemon",
      "@comis/cli",
      "@comis/orchestrator",
    ]) {
      expect(
        pkg,
        `package.json must not list ${forbidden}`,
      ).not.toMatch(new RegExp(`"${forbidden.replace("/", "\\/")}"`));
    }
  });

  it("packages/observability/tsconfig.json declares no reference to ../agent / ../daemon / ../cli / ../orchestrator", () => {
    const ts = readFileSync(
      resolve(REPO_ROOT, "packages/observability/tsconfig.json"),
      "utf8",
    );
    for (const forbiddenRef of [
      "../agent",
      "../daemon",
      "../cli",
      "../orchestrator",
    ]) {
      expect(
        ts,
        `tsconfig.json must not reference ${forbiddenRef}`,
      ).not.toMatch(
        new RegExp(`"path":\\s*"${forbiddenRef.replace("/", "\\/")}"`),
      );
    }
  });
});
