// SPDX-License-Identifier: Apache-2.0
/**
 * Leaf-package invariant for `@comis/shared`.
 *
 * `@comis/shared` is the inward-most leaf of the dependency graph (depended on
 * by `@comis/core` and everything downstream). It MUST NOT import from
 * `@comis/core` (or any other workspace package) — the dependency direction is
 * inward to core, not the reverse.
 *
 * This test greps `packages/shared/src/**\/*.ts` for any `from "@comis/core"`
 * source import (including subpath imports like `@comis/core/runtime`) and
 * fails the build on any non-zero match.
 *
 * `@comis/shared`'s `withTimeout` and `createTTLCache` utilities accept
 * their time/timer dependencies via bare structural callback parameters
 * (`(cb, ms) => () => void` and `() => number`), preserving the leaf
 * invariant. This test makes that invariant a build-failing regression
 * ratchet.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const SHARED_SRC = resolve(REPO_ROOT, "packages/shared/src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("@comis/shared remains leaf (zero @comis/core source imports)", () => {
  it("packages/shared/src/**/*.ts has zero `from \"@comis/core\"` imports", () => {
    const files = listTsFiles(SHARED_SRC);
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      // Match `from "@comis/core"` OR `from "@comis/core/...` (subpaths).
      // Allow `import type` too (a type-only import still violates the
      // leaf invariant because we treat the package as the boundary).
      if (/from\s+["']@comis\/core(\/|["'])/.test(content)) {
        offenders.push(f);
      }
    }
    expect(
      offenders,
      `Files in packages/shared/src/ must not import from @comis/core: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
