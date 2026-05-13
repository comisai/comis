// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the ContextStorePort row-DTO residency walker
 * (MEM-CTX-PORTS-04 primary check).
 *
 * The walker uses ts.createProgram + TypeChecker to enumerate every
 * Ctx*Row type transitively referenced from ContextStorePort method
 * signatures and verify each one is exported from the sibling
 * context-store-types.ts file.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

import {
  checkContextStoreRowResidency,
  resetCacheForTest,
} from "./ports-dto-residency-checker.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const CONTEXT_STORE_PATH = resolve(
  REPO_ROOT,
  "packages/core/src/ports/context-store.ts",
);
const TYPES_PATH = resolve(
  REPO_ROOT,
  "packages/core/src/ports/context-store-types.ts",
);
const CACHE_PATH = resolve(
  process.cwd(),
  "node_modules/.cache/architecture-walker/ports-dto-residency-checker.json",
);

function clearCache(): void {
  resetCacheForTest();
  try {
    rmSync(CACHE_PATH, { force: true });
  } catch {
    // ignore — cache may not exist yet
  }
}

describe("checkContextStoreRowResidency (MEM-CTX-PORTS-04 primary)", () => {
  beforeEach(() => {
    clearCache();
  });

  it("real ContextStorePort + context-store-types.ts: zero violations (all transitively-referenced Ctx*Row are exported)", () => {
    const violations = checkContextStoreRowResidency(
      CONTEXT_STORE_PATH,
      TYPES_PATH,
    );
    expect(violations).toEqual([]);
  });

  it("walker does not throw on the real port — proves >= 1 Ctx*Row was collected (the impl throws when collectedRowNames.size === 0)", () => {
    expect(() =>
      checkContextStoreRowResidency(CONTEXT_STORE_PATH, TYPES_PATH),
    ).not.toThrow();
  });

  it("cache hit: second invocation returns the same violations (no recompute)", () => {
    const first = checkContextStoreRowResidency(
      CONTEXT_STORE_PATH,
      TYPES_PATH,
    );
    // Do NOT clear cache between invocations — second call must hit the
    // in-memory + on-disk cache and return the same shape.
    const second = checkContextStoreRowResidency(
      CONTEXT_STORE_PATH,
      TYPES_PATH,
    );
    expect(second).toEqual(first);
  });

  it("throws when the requested interface name does not exist in the port file", () => {
    expect(() =>
      checkContextStoreRowResidency(
        CONTEXT_STORE_PATH,
        TYPES_PATH,
        "NonExistentInterface",
      ),
    ).toThrow(/NonExistentInterface interface not found/);
  });
});
