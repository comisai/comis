// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture invariant — cache-trace-writer.ts deletion (Plan 46-01).
 *
 * Asserts that the legacy
 * `packages/agent/src/executor/stream-wrappers/cache-trace-writer.ts`
 * file no longer exists, and that no live source file imports
 * `createCacheTraceWriter`. The cache-trace artifact was promoted to
 * `@comis/observability/cache-trace/*` in plan 46-01; any future PR
 * that re-introduces the legacy file or the old import symbol is
 * caught here.
 *
 * Out of scope:
 *   - `CacheTraceConfig` type literal — kept off the deny-list because
 *     `CacheTraceConfigSchema` in `packages/core/src/config/` is the
 *     NEW symbol (different shape, owned by Zod).
 *   - The new `createCacheTrace` (from @comis/observability) — that's
 *     the intended successor symbol; it is NOT banned.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

const LEGACY_WRITER_PATH = join(
  REPO_ROOT,
  "packages/agent/src/executor/stream-wrappers/cache-trace-writer.ts",
);

const SEARCH_ROOTS = [
  "packages/agent/src",
  "packages/observability/src",
  "packages/cli/src",
  "packages/daemon/src",
  "packages/core/src",
  "packages/orchestrator/src",
].map((p) => join(REPO_ROOT, p));

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      entry.isFile() &&
      full.endsWith(".ts") &&
      !full.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("CACHE-OBS-06 — cache-trace-writer.ts is deleted and not re-exported", () => {
  it("the legacy file path does not exist", () => {
    expect(
      existsSync(LEGACY_WRITER_PATH),
      `Expected legacy ${LEGACY_WRITER_PATH} to be deleted by Plan 46-01 Task 11`,
    ).toBe(false);
  });

  it("no production source file imports createCacheTraceWriter (code, not comments)", () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      expect(statSync(root).isDirectory()).toBe(true);
      const files = listSourceFiles(root);
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        // Strip single-line comments + JSDoc block comments before grepping
        // so the deletion-note comment in
        // packages/agent/src/executor/stream-wrappers/index.ts doesn't
        // false-positive. The strip is naive — it handles the
        // overwhelmingly common case (comments with no embedded string
        // literals); for this architecture invariant a residual false-
        // negative is acceptable because the import graph itself catches
        // the runtime use.
        const stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^[ \t]*\/\/.*$/gm, "");
        if (/\bcreateCacheTraceWriter\b/.test(stripped)) {
          offenders.push(file);
        }
      }
    }
    expect(
      offenders,
      [
        "Files still referencing createCacheTraceWriter (deleted symbol, Plan 46-01):",
        ...offenders,
        "",
        "Use @comis/observability buildCacheTraceWrapper / createCacheTrace instead.",
      ].join("\n"),
    ).toEqual([]);
  });
});
