// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { findForbiddenImports } from "./import-checker.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(here, "__fixtures__/import-checker");

describe("findForbiddenImports -- AST-based import detection", () => {
  it("detects multi-line imports of forbidden package", () => {
    const result = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: "@comis/agent",
    });
    const multiLineHit = result.violations.find((v) =>
      v.file.endsWith("multi-line-import.ts"),
    );
    expect(
      multiLineHit,
      "multi-line import must be detected via AST",
    ).toBeDefined();
    expect(multiLineHit?.importedSymbols).toContain("X");
    expect(multiLineHit?.importedSymbols).toContain("Y");
    expect(
      result.checkedFiles,
      "sanity: helper walked at least one fixture file",
    ).toBeGreaterThan(0);
  });

  it("does NOT report imports inside comments", () => {
    const result = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: "@comis/agent",
    });
    expect(
      result.violations.find((v) => v.file.endsWith("import-in-comment.ts")),
      "comment imports must NOT match -- TS parser strips comments",
    ).toBeUndefined();
  });

  it("does NOT report imports inside template strings", () => {
    const result = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: "@comis/agent",
    });
    expect(
      result.violations.find((v) => v.file.endsWith("import-in-template.ts")),
      "template-string imports must NOT match -- parsed as string literal, not import",
    ).toBeUndefined();
  });

  it("returns empty violations array for clean files but non-zero checkedFiles", () => {
    const all = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: "@comis/agent",
    });
    expect(
      all.violations.find((v) => v.file.endsWith("clean-no-import.ts")),
      "clean file must not appear in violations",
    ).toBeUndefined();
    expect(
      all.checkedFiles,
      "every fixture file must be counted",
    ).toBeGreaterThan(0);
  });

  it("respects allowlistPaths (substring match against absolute path); allowlisted files still count toward checkedFiles", () => {
    const result = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: "@comis/agent",
      allowlistPaths: ["multi-line-import.ts"],
    });
    expect(
      result.violations.find((v) => v.file.endsWith("multi-line-import.ts")),
      "allowlisted file must NOT appear in violations",
    ).toBeUndefined();
    expect(
      result.checkedFiles,
      "allowlisted files still count toward checkedFiles -- the walker considered them (counted before the allowlist short-circuit)",
    ).toBeGreaterThan(0);
  });

  it("returns ImportViolation with line, column, snippet, importedSymbols populated", () => {
    const result = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: "@comis/agent",
    });
    const hit = result.violations.find((v) =>
      v.file.endsWith("multi-line-import.ts"),
    );
    expect(hit).toBeDefined();
    expect(hit?.line).toBeGreaterThan(0);
    expect(hit?.column).toBeGreaterThan(0);
    expect(hit?.snippet.length).toBeGreaterThan(0);
    expect(hit?.importedSymbols.length).toBeGreaterThanOrEqual(2);
  });

  it("records on each violation which forbidden specifier it matched", () => {
    const result = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: "@comis/agent",
    });
    const hit = result.violations.find((v) =>
      v.file.endsWith("multi-line-import.ts"),
    );
    expect(
      hit?.specifier,
      "a single-specifier scan still attributes the match, so callers can group a multi-specifier result",
    ).toBe("@comis/agent");
  });

  it("matches any of several forbidden specifiers in one walk, attributing each violation to the specifier it matched", () => {
    const result = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: ["@comis/agent", "@comis/infra"],
    });
    const byFile = new Map(
      result.violations.map((v) => [v.file.split("/").pop(), v.specifier]),
    );
    expect(
      byFile.get("multi-line-import.ts"),
      "@comis/agent importer must be attributed to @comis/agent",
    ).toBe("@comis/agent");
    expect(
      byFile.get("second-package-import.ts"),
      "@comis/infra importer must be attributed to @comis/infra",
    ).toBe("@comis/infra");
  });

  it("returns the same violations for an N-specifier walk as for N single-specifier walks", () => {
    // The equivalence that lets a caller replace an O(N) sequence of
    // full-tree walks with ONE walk: the array form must be exactly the
    // union of the single form, not an approximation of it. The daemon's
    // cross-handler-import invariant relies on this to check 27 sibling
    // specifiers without re-parsing the tree 27 times.
    const specifiers = ["@comis/agent", "@comis/infra"] as const;
    const union = specifiers.flatMap(
      (s) =>
        findForbiddenImports({ rootDir: FIXTURES_ROOT, forbiddenPackage: s })
          .violations,
    );
    const batched = findForbiddenImports({
      rootDir: FIXTURES_ROOT,
      forbiddenPackage: [...specifiers],
    }).violations;
    const key = (v: { file: string; line: number; specifier: string }) =>
      `${v.specifier}|${v.file}|${v.line}`;
    expect(
      [...batched].map(key).sort(),
      "one N-specifier walk must find exactly what N single-specifier walks find",
    ).toEqual([...union].map(key).sort());
    expect(
      batched.length,
      "sanity: the fixtures must produce at least one violation per specifier",
    ).toBeGreaterThanOrEqual(2);
  });
});
