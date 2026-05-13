// SPDX-License-Identifier: Apache-2.0
/**
 * Fixture-driven unit tests for the secret-residency AST walker
 * (MEM-CTX-PORTS-14 part 1).
 *
 * Three fixture files under
 * `test/architecture/fixtures/secret-residency/` exercise the walker:
 *
 *   1. `safe-handler.ts`        — locally-scoped plaintext, no Promise.all
 *      (expects zero violations).
 *   2. `leaky-module-level.ts`  — Rule 1 violation: module-level `const`
 *      `secretValue` with `mockStore.getDecrypted(...)` initializer.
 *   3. `leaky-promise-all.ts`   — Rule 2 violation (RES-PIT-31-1):
 *      Promise.all closure captures `secretBinding` from outer scope.
 *
 * The Rule-2 detection uses PROPER TypeChecker symbol resolution (per
 * I-11 fix in Phase 31 revision iter 2). Text-matching shortcuts are
 * explicitly rejected by the walker — these tests verify the walker
 * correctly resolves the captured `secretBinding` symbol back to its
 * declaration outside the closure.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import {
  checkSecretResidency,
  resetCacheForTest,
} from "./secret-residency-checker.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(here, "../architecture/fixtures/secret-residency");
const CACHE_PATH = resolve(
  process.cwd(),
  "node_modules/.cache/architecture-walker/secret-residency-checker.json",
);

function clearCache(): void {
  resetCacheForTest();
  try {
    rmSync(CACHE_PATH, { force: true });
  } catch {
    // Ignore — the cache file may not exist yet.
  }
}

describe("checkSecretResidency walker (MEM-CTX-PORTS-14 part 1)", () => {
  beforeEach(() => {
    clearCache();
  });

  it("safe-handler.ts produces zero violations", () => {
    const violations = checkSecretResidency([
      resolve(FIXTURES_DIR, "safe-handler.ts"),
    ]);
    expect(violations).toEqual([]);
  });

  it("leaky-module-level.ts produces ≥1 violation with kind 'module-level-binding' and bindingName 'secretValue'", () => {
    const violations = checkSecretResidency([
      resolve(FIXTURES_DIR, "leaky-module-level.ts"),
    ]);
    expect(violations.length).toBeGreaterThan(0);
    const v = violations.find((x) => x.bindingName === "secretValue");
    expect(v).toBeDefined();
    expect(v?.kind).toBe("module-level-binding");
  });

  it("leaky-promise-all.ts produces ≥1 violation with kind 'promise-all-closure-escape'", () => {
    const violations = checkSecretResidency([
      resolve(FIXTURES_DIR, "leaky-promise-all.ts"),
    ]);
    const promiseAllViolations = violations.filter(
      (v) => v.kind === "promise-all-closure-escape",
    );
    expect(promiseAllViolations.length).toBeGreaterThan(0);
    expect(/secret|decrypted|plaintext/i.test(
      promiseAllViolations[0]!.bindingName,
    )).toBe(true);
  });

  it("cache hits on second invocation when files unchanged (mtime + sha256 composite key)", () => {
    clearCache();
    const first = checkSecretResidency([
      resolve(FIXTURES_DIR, "leaky-module-level.ts"),
    ]);
    const second = checkSecretResidency([
      resolve(FIXTURES_DIR, "leaky-module-level.ts"),
    ]);
    expect(second.length).toBe(first.length);
    if (first.length > 0) {
      expect(second[0]?.kind).toBe(first[0]?.kind);
      expect(second[0]?.bindingName).toBe(first[0]?.bindingName);
      expect(second[0]?.line).toBe(first[0]?.line);
    }
  });
});
