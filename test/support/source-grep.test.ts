// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { findInSourceFiles } from "./source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const FIXTURES_ROOT = resolve(here, "__fixtures__/source-grep");

describe("findInSourceFiles", () => {
  it("finds existing tokens in the live codebase", () => {
    const result = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages/core/src/ports"),
      needle: "ToolCapabilityPort",
    });
    expect(result.checkedFiles).toBeGreaterThan(0);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("returns empty matches for a needle that does not exist (sanity)", () => {
    const result = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages/core/src/ports"),
      needle: "DEFINITELYNOTAREALSTRING_xyz_qq_zz",
    });
    expect(result.matches).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });

  it("respects custom excludeDirs", () => {
    // With __test-helpers excluded AND .test.ts files filtered, the stub
    // literal lives nowhere in production source paths, so the result must
    // be empty -- this is the exact invariant the architecture-grep test
    // asserts.
    const result = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages/core/src/ports"),
      needle: "createCapabilityPortStub",
      excludeDirs: [
        "__tests__",
        "__snapshots__",
        "dist",
        "node_modules",
        "__test-helpers",
      ],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(result.matches).toEqual([]);
  });

  it("respects excludeFileSuffixes", () => {
    // Without the suffix filter, the stub literal IS found in the test file.
    const noFilter = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages/core/src/ports"),
      needle: "createCapabilityPortStub",
      excludeDirs: [
        "__tests__",
        "__snapshots__",
        "dist",
        "node_modules",
        "__test-helpers",
      ],
    });
    expect(noFilter.matches.length).toBeGreaterThan(0);
    // With excludeFileSuffixes filtering out test files, the matches drop.
    const withFilter = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages/core/src/ports"),
      needle: "createCapabilityPortStub",
      excludeDirs: [
        "__tests__",
        "__snapshots__",
        "dist",
        "node_modules",
        "__test-helpers",
      ],
      excludeFileSuffixes: [".test.ts"],
    });
    expect(withFilter.matches.length).toBeLessThan(noFilter.matches.length);
  });

  it("default excludes skip __tests__, __snapshots__, dist, node_modules", () => {
    // Token lives under __test-helpers/ -- defaults DO scan __test-helpers/
    // (it is not in the default exclude list). So we expect to find it.
    const result = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages/core/src/ports"),
      needle: "createCapabilityPortStub",
      // No explicit excludeDirs -- uses defaults.
    });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("respects custom extensions filter", () => {
    const result = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages/core/src/ports"),
      needle: "ToolCapabilityPort",
      extensions: [".test.ts"],
    });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const m of result.matches) {
      expect(m.endsWith(".test.ts")).toBe(true);
    }
  });

  it("supports RegExp needles", () => {
    const result = findInSourceFiles({
      rootDir: resolve(REPO_ROOT, "packages/core/src/ports"),
      needle: /createCapabilityPort(Stub|NoOp)/,
    });
    expect(result.matches.length).toBeGreaterThan(0);
  });
});

describe("findInSourceFiles -- hardening", () => {
  it("clones caller-supplied global regex per file scan (no lastIndex leak)", () => {
    const re = /needle/g;
    const result = findInSourceFiles({
      rootDir: resolve(FIXTURES_ROOT, "two-matching-files"),
      needle: re,
    });
    expect(
      result.matches.length,
      "regex /g must clone per file -- both files must match",
    ).toBe(2);
  });

  it("clones caller-supplied sticky regex per file scan", () => {
    const re = /^import/y;
    const result = findInSourceFiles({
      rootDir: resolve(FIXTURES_ROOT, "two-files-with-leading-import"),
      needle: re,
    });
    expect(
      result.matches.length,
      "regex /y must clone per file -- both files must match",
    ).toBe(2);
  });

  it("merges caller-supplied excludeDirs with defaults instead of replacing", () => {
    const result = findInSourceFiles({
      rootDir: resolve(FIXTURES_ROOT, "with-tests-and-legacy"),
      needle: "the-needle",
      excludeDirs: ["legacy"],
    });
    expect(
      result.matches.find((p) => p.includes("/__tests__/")),
      "default __tests__ exclusion must persist",
    ).toBeUndefined();
    expect(
      result.matches.find((p) => p.includes("/legacy/")),
      "caller-supplied legacy/ exclusion must apply",
    ).toBeUndefined();
    expect(
      result.matches.find((p) => p.endsWith("/c.ts")),
      "non-excluded c.ts must be found",
    ).toBeDefined();
  });

  it("empty caller excludeDirs uses default exclusions only", () => {
    const result = findInSourceFiles({
      rootDir: resolve(FIXTURES_ROOT, "with-tests-and-legacy"),
      needle: "the-needle",
      excludeDirs: [],
    });
    expect(
      result.matches.find((p) => p.includes("/__tests__/")),
      "defaults must still apply when caller passes []",
    ).toBeUndefined();
    expect(
      result.matches.find((p) => p.includes("/legacy/")),
      "legacy NOT in defaults -- must be scanned",
    ).toBeDefined();
  });
});

describe("tsconfig __tests__ exclude", () => {
  for (const pkg of ["core", "shared", "skills", "daemon"] as const) {
    it(`packages/${pkg}/tsconfig.json excludes src/__tests__/**`, () => {
      const tsconfigPath = resolve(REPO_ROOT, `packages/${pkg}/tsconfig.json`);
      const content = readFileSync(tsconfigPath, "utf8");
      expect(content).toMatch(/"src\/__tests__\/\*\*"/);
    });
  }
});
