// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the ContextStorePort row-DTO residency walker.
 *
 * The original 38-method ContextStorePort interface was split into
 * ContextEngineStore (34 methods, in `context-engine-store.ts`) +
 * ContextAdminStore (4 methods, in `context-admin-store.ts`).
 * ContextStorePort itself is now a type alias
 * (`type ContextStorePort = ContextEngineStore & ContextAdminStore`).
 *
 * The walker now accepts arrays of port-file paths + interface names so it
 * can union the Ctx*Row references across the split.
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
const CONTEXT_ENGINE_STORE_PATH = resolve(
  REPO_ROOT,
  "packages/core/src/ports/context-engine-store.ts",
);
const CONTEXT_ADMIN_STORE_PATH = resolve(
  REPO_ROOT,
  "packages/core/src/ports/context-admin-store.ts",
);
const TYPES_PATH = resolve(
  REPO_ROOT,
  "packages/core/src/ports/context-store-types.ts",
);
const CACHE_PATH = resolve(
  process.cwd(),
  "node_modules/.cache/architecture-walker/ports-dto-residency-checker.json",
);

const PORT_FILES = [CONTEXT_ENGINE_STORE_PATH, CONTEXT_ADMIN_STORE_PATH] as const;
const PORT_INTERFACES = ["ContextEngineStore", "ContextAdminStore"] as const;

function clearCache(): void {
  resetCacheForTest();
  try {
    rmSync(CACHE_PATH, { force: true });
  } catch {
    // ignore — cache may not exist yet
  }
}

describe("checkContextStoreRowResidency", () => {
  beforeEach(() => {
    clearCache();
  });

  it("real ContextEngineStore + ContextAdminStore + context-store-types.ts: zero violations (all transitively-referenced Ctx*Row are exported)", () => {
    const violations = checkContextStoreRowResidency(
      PORT_FILES,
      TYPES_PATH,
      PORT_INTERFACES,
    );
    expect(violations).toEqual([]);
  });

  it("walker does not throw on the real ports — proves >= 1 Ctx*Row was collected across the split (the impl throws when collectedRowNames.size === 0)", () => {
    expect(() =>
      checkContextStoreRowResidency(PORT_FILES, TYPES_PATH, PORT_INTERFACES),
    ).not.toThrow();
  });

  it("cache hit: second invocation returns the same violations (no recompute)", () => {
    const first = checkContextStoreRowResidency(
      PORT_FILES,
      TYPES_PATH,
      PORT_INTERFACES,
    );
    // Do NOT clear cache between invocations — second call must hit the
    // in-memory + on-disk cache and return the same shape.
    const second = checkContextStoreRowResidency(
      PORT_FILES,
      TYPES_PATH,
      PORT_INTERFACES,
    );
    expect(second).toEqual(first);
  });

  it("throws when none of the requested interface names exist in any of the port files", () => {
    expect(() =>
      checkContextStoreRowResidency(
        PORT_FILES,
        TYPES_PATH,
        ["NonExistentInterface"],
      ),
    ).toThrow(/none of the requested interfaces/);
  });
});
