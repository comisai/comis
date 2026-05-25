// SPDX-License-Identifier: Apache-2.0
/**
 * Source-grep regression tests for envelope-wrapper.ts.
 *
 * Pins the dynamic-preamble assembly shape (array-concat with filter(Boolean))
 * + the Pino debug-log canonical fields + the submodule binding label.
 * Behavioral verification of the rendered output lives in the renderer unit
 * test (capability-index-context.test.ts) and integration tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, "envelope-wrapper.ts");
const source = readFileSync(sourcePath, "utf-8");

describe("envelope-wrapper.ts — capability-index threading", () => {
  it("dynamic preamble uses array-concat [dynamicPreamble, capabilityIndexContext, deferredContext].filter(Boolean)", () => {
    // Source-grep: structural lock on the array-concat shape. Behavioral
    // verification of the rendered output lives in the renderer unit test
    // (capability-index-context.test.ts) and integration tests.
    expect(source).toMatch(
      /\[\s*dynamicPreamble\s*,\s*capabilityIndexContext\s*,\s*deferredContext\s*\]\s*\.\s*filter\s*\(\s*Boolean\s*\)/,
    );
  });

  it("Pino debug log emits the seven canonical fields with submodule label and message", () => {
    // Each canonical field appears literally in the log object.
    expect(source).toMatch(/capabilityIndexTokens/);
    expect(source).toMatch(/deferredContextTokens/);
    expect(source).toMatch(/fullPreambleTokens/);
    expect(source).toMatch(/clusterCount/);
    expect(source).toMatch(/activeToolCount/);
    expect(source).toMatch(/deferredToolCount/);
    expect(source).toMatch(/promptSkillCount/);
    // Message text matches expected placement verbatim.
    expect(source).toMatch(/"Dynamic preamble assembled"/);
  });

  it("submodule binding label is exactly 'executor.capability-index'", () => {
    // Submodule binding via deps.logger.child({ submodule: "..." }).
    expect(source).toMatch(/submodule\s*:\s*["']executor\.capability-index["']/);
  });
});
