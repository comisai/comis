// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { findInSourceFiles } from "./source-grep.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

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
    // be empty -- this is the exact invariant Plan 17-04's architecture-grep
    // test asserts.
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

describe("tsconfig __tests__ exclude (TOOLING-CFG-15 prep)", () => {
  for (const pkg of ["core", "shared", "skills", "daemon"] as const) {
    it(`packages/${pkg}/tsconfig.json excludes src/__tests__/**`, () => {
      const tsconfigPath = resolve(REPO_ROOT, `packages/${pkg}/tsconfig.json`);
      const content = readFileSync(tsconfigPath, "utf8");
      expect(content).toMatch(/"src\/__tests__\/\*\*"/);
    });
  }
});
