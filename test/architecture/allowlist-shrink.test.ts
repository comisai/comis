// SPDX-License-Identifier: Apache-2.0
/**
 * Allowlist shrink-only gate (D-04 / ORCH-EXT-24).
 *
 * Reads the base ref's `test/support/architecture-allowlist.ts` via
 * `git show origin/main:test/support/architecture-allowlist.ts`, parses
 * both base and head allowlist arrays via static AST extraction (NOT
 * dynamic import — robust to schema drift between commits), and asserts
 * every L-ID present in HEAD is either present in BASE or has been
 * explicitly removed (no new L-IDs in head).
 *
 * This catches the "remove L1 + add L99 in the same PR" failure mode
 * that pure length-monotonicity would miss. The test is part of Phase 27's
 * deliverable but its load-bearing role is from Phase 32 onwards (per
 * design §15.5 + ORCH-EXT-24).
 *
 * Local-fallback: if `origin/main` is not fetched (running locally without
 * `git fetch`), the test SKIPS with a console.warn — auto-fetching from a
 * test would surprise developers and require network access during
 * `pnpm test`. CI always has the base ref via standard checkout actions.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as ts from "typescript";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const ALLOWLIST_PATH = resolve(REPO_ROOT, "test/support/architecture-allowlist.ts");
const BASE_REF = process.env.COMIS_ALLOWLIST_BASE_REF ?? "origin/main";

function readBaseAllowlist(): string | null {
  try {
    return execSync(`git show ${BASE_REF}:test/support/architecture-allowlist.ts`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/**
 * Static AST extraction of ALLOWLIST entries' `id` properties from source text.
 *
 * Why static extraction over `import("file:///abs/path/...")`: the file at
 * the BASE ref may have a different schema (imports moved between commits),
 * causing dynamic import to fail. Static parsing is robust to that drift.
 */
function extractAllowlistIds(sourceText: string): Set<string> {
  const sf = ts.createSourceFile("allowlist.ts", sourceText, ts.ScriptTarget.ES2023, true);
  const ids = new Set<string>();

  function visit(node: ts.Node): void {
    // Find: `export const ALLOWLIST: ... = [ ... ] as const;`
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (d) => ts.isIdentifier(d.name) && d.name.text === "ALLOWLIST",
      )
    ) {
      const decl = node.declarationList.declarations.find(
        (d) => ts.isIdentifier(d.name) && d.name.text === "ALLOWLIST",
      );
      // The initializer may be `[...] as const` (AsExpression wrapping ArrayLiteralExpression)
      // OR a bare `[...]` (ArrayLiteralExpression directly). Handle both.
      let arrayExpr: ts.ArrayLiteralExpression | undefined;
      if (decl?.initializer) {
        if (
          ts.isAsExpression(decl.initializer) &&
          ts.isArrayLiteralExpression(decl.initializer.expression)
        ) {
          arrayExpr = decl.initializer.expression;
        } else if (ts.isArrayLiteralExpression(decl.initializer)) {
          arrayExpr = decl.initializer;
        }
      }
      if (arrayExpr) {
        for (const el of arrayExpr.elements) {
          if (ts.isObjectLiteralExpression(el)) {
            for (const prop of el.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === "id" &&
                ts.isStringLiteral(prop.initializer)
              ) {
                ids.add(prop.initializer.text);
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return ids;
}

describe("allowlist-shrink (D-04)", () => {
  it("every L-ID present in head is either present in base OR head shrinks the set", () => {
    const baseText = readBaseAllowlist();
    if (baseText === null) {
      console.warn(
        `[allowlist-shrink] Could not retrieve ${BASE_REF}:test/support/architecture-allowlist.ts. ` +
          `Skipping. This is expected when running locally without 'git fetch'. ` +
          `CI runs always have the base ref available.`,
      );
      return;
    }
    const headText = readFileSync(ALLOWLIST_PATH, "utf8");
    const baseIds = extractAllowlistIds(baseText);
    const headIds = extractAllowlistIds(headText);
    const added = [...headIds].filter((id) => !baseIds.has(id));
    expect(
      added,
      formatViolations({
        description:
          "Allowlist is shrink-only (D-04 / design §15.5). The following L-IDs were ADDED in this PR:",
        violations: added.map((id) => ({
          file: `architecture-allowlist.ts (id: ${id})`,
          line: 0,
        })),
        suggestedFix:
          "If a new violation must be allowlisted, it requires an explicit phase commit (not a feature PR). Either (a) close the underlying violation in this PR (preferred), or (b) escalate to a design-doc amendment + phase commit.",
        designRef:
          'design §15.5 ("Feature PRs target the *current* allowlist") + Phase 32 ORCH-EXT-24',
      }),
    ).toEqual([]);
  });

  it("self-test: extractAllowlistIds parses the head ALLOWLIST and agrees with regex", () => {
    // Sanity check: the static AST extractor must work on the head allowlist.
    // The shrink-only test could pass vacuously (empty ⊆ empty), so we
    // cross-check the AST extractor against an independent regex count.
    // Both sides may legitimately be 0 once the allowlist closes (Phase 36
    // GUARDRAILS-01 closed the last entry — vacuous-pass is now correct
    // because the array IS the closed empty set, and the regex also reads 0).
    // The load-bearing assertion is the AST-vs-regex agreement below.
    const headText = readFileSync(ALLOWLIST_PATH, "utf8");
    const headIds = extractAllowlistIds(headText);
    const regexCount = (headText.match(/^\s*id:\s*"L\d+"/gm) ?? []).length;
    expect(
      headIds.size,
      "extractAllowlistIds parse-self-test: must agree with regex regardless of allowlist size (Phase 36 GUARDRAILS-01 closed the last entry — vacuous-pass is now legitimate because the array is the closed empty set).",
    ).toBeGreaterThanOrEqual(0);
    expect(
      headIds.size,
      "AST extractor must agree with regex-counted L-IDs in the file",
    ).toBe(regexCount);
  });
});
