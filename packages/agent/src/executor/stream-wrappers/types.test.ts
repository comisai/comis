// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `stream-wrappers/types.ts` — pure-type module.
 *
 * The file under test holds a single `export type StreamFnWrapper` —
 * a pure type-only module with no runtime behavior. Importing it at test
 * time yields an empty module namespace (TypeScript type-only declarations
 * are erased at compile time).
 *
 * Same static-source-text idiom as `command-directive-types.test.ts`
 * (sibling test in this directory) and `packages/comis/src/cli-entry.test.ts`
 * (project-wide convention for files that cannot be exercised through a
 * runtime import).
 *
 * Phase 40 / Phase C §6.3.1 / COV-06.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "types.ts");

describe("stream-wrappers/types.ts — pure-type module shape contract", () => {
  it("exports the StreamFnWrapper type that wraps a StreamFn into a decorated StreamFn", () => {
    const content = readFileSync(sourcePath, "utf8");
    expect(content).toMatch(/^export\s+type\s+StreamFnWrapper\b/m);
  });

  it("contains zero runtime exports — type-only file (no export const/function/class allowed)", () => {
    const content = readFileSync(sourcePath, "utf8");
    // Keeping this file type-only matters: a runtime export would suggest
    // a refactor target (move to a sibling .ts file) and would invalidate
    // the "import type only" contract that the barrel preserves.
    expect(content).not.toMatch(/^export\s+(const|let|var|function|class|enum)\b/m);
  });

  it("imports the StreamFn type from @mariozechner/pi-agent-core (its sole runtime dep is type-only)", () => {
    const content = readFileSync(sourcePath, "utf8");
    expect(content).toMatch(/import\s+type\s*\{\s*StreamFn\s*\}\s*from\s*"@mariozechner\/pi-agent-core"/);
  });
});
