// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke test for `command-directive-types.ts` — boundary type mirror.
 *
 * The file under test holds an agent-local mirror of
 * `@comis/orchestrator/src/commands/types.ts` (see header for the cycle-
 * breaking rationale: agent CANNOT depend on orchestrator). Because the
 * file is pure-type (no runtime exports — only `export interface`
 * declarations), there is no behavior to exercise at runtime; importing it
 * yields an empty module namespace.
 *
 * Instead, this test asserts the file's STATIC properties (the two exported
 * interface declarations and the maintenance-contract comment) by reading
 * the source text via `readFileSync` — same idiom as
 * `packages/comis/src/cli-entry.test.ts` (which also covers a file that
 * cannot be tested through a runtime import).
 *
 * The maintenance contract documented in the file header is: "this file
 * MUST stay in lock-step with `@comis/orchestrator/src/commands/types.ts`.
 * Any field added/removed in the orchestrator's `CommandDirectives` must be
 * mirrored here in the same commit." This smoke test catches accidental
 * removal of the mirrored interface declarations — a developer who deletes
 * an `export interface` line from this file (vs. renaming/updating it) will
 * see a test failure on the next test run.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "command-directive-types.ts");

describe("command-directive-types.ts — agent-local boundary-type mirror shape contract", () => {
  it("exports the PromptSkillDirective interface that mirrors the orchestrator-side shape", () => {
    const content = readFileSync(sourcePath, "utf8");
    expect(content).toMatch(/^export\s+interface\s+PromptSkillDirective\b/m);
  });

  it("exports the CommandDirectives interface that mirrors the orchestrator-side shape", () => {
    const content = readFileSync(sourcePath, "utf8");
    expect(content).toMatch(/^export\s+interface\s+CommandDirectives\b/m);
  });

  it("contains zero runtime exports — type-only file (no export const/function/class allowed)", () => {
    const content = readFileSync(sourcePath, "utf8");
    // The file MUST stay type-only: a runtime export would mean the file is
    // no longer a pure boundary-type mirror and the cycle-breaking rationale
    // documented in the header no longer holds.
    expect(content).not.toMatch(/^export\s+(const|let|var|function|class|enum)\b/m);
  });

  it("documents the lock-step maintenance contract with @comis/orchestrator's commands/types.ts", () => {
    const content = readFileSync(sourcePath, "utf8");
    // The header MUST keep the maintenance-contract note so future
    // contributors understand why the duplication exists.
    expect(content).toMatch(/lock-step with[\s\S]*@comis\/orchestrator[\s\S]*commands\/types\.ts/);
  });
});
