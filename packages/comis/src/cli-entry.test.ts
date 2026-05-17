// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for the comisai umbrella CLI bootstrap (`cli-entry.ts`).
 *
 * Cannot import `cli-entry.ts` directly at test time — the source has a
 * top-level `await import(safePath(...))` that invokes Commander.js and
 * exits the test process. Instead, this test asserts the file's STATIC
 * properties (shape, deps, header) by reading the source text via
 * `readFileSync` (same idiom as `executor-post-execution.test.ts`).
 *
 * Catches `prepack.js` resolution breakage by pinning the file's @comis/*
 * dependency graph to exactly `@comis/core` — `@comis/cli` must be
 * dynamically resolved via `import.meta.resolve`, never statically imported,
 * so that the bundled-monorepo `npm install -g comisai` path works.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntryPath = resolve(here, "cli-entry.ts");

describe("comisai cli-entry.ts — CLI bootstrap shape contract", () => {
  it("starts with the canonical shebang line for direct node execution", () => {
    const content = readFileSync(cliEntryPath, "utf8");
    expect(content.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("uses safePath from @comis/core to resolve cli.js relative to the ESM-resolved @comis/cli dist directory", () => {
    const content = readFileSync(cliEntryPath, "utf8");
    expect(content).toMatch(/import\s*\{[^}]*\bsafePath\b[^}]*\}\s*from\s*"@comis\/core"/);
    expect(content).toMatch(/await\s+import\s*\(\s*safePath\s*\(/);
  });

  it("does not statically depend on any @comis/* package other than @comis/core (cli is dynamically resolved)", () => {
    const content = readFileSync(cliEntryPath, "utf8");
    const comisImports = [...content.matchAll(/from\s+"(@comis\/[^"]+)"/g)].map((m) => m[1]);
    expect(comisImports).toEqual(["@comis/core"]);
  });

  it("dynamically resolves @comis/cli via import.meta.resolve rather than a static import statement", () => {
    const content = readFileSync(cliEntryPath, "utf8");
    expect(content).toMatch(/import\.meta\.resolve\(\s*"@comis\/cli"\s*\)/);
  });
});
