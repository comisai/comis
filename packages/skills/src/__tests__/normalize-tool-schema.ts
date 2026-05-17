// SPDX-License-Identifier: Apache-2.0
/**
 * Test-owned helper: deterministic JSON normalization for TypeBox schemas.
 *
 * Mirrors `stableStringify` from `packages/core/src/config/section-registry-parity.test.ts:26-44`
 * (the canonical pattern in this repo). The function returns a plain JS object
 * with string keys sorted lexicographically and `undefined` values dropped;
 * `JSON.stringify` is the runtime that drops Symbol keys.
 *
 * Why TypeBox not Zod: every platform tool uses `typebox 1.1.37`'s
 * `Type.Object(...)` builder. TypeBox `TSchema` IS JSON Schema directly —
 * no serialization layer needed. The `TYPEBOX_VERSION` export pins the
 * snapshot filename so cross-version snapshots are never compared.
 *
 * TYPEBOX_VERSION resolution: `typebox`'s `package.json` is not exposed in
 * its `exports` map (verified at typebox@1.1.37). We resolve the runtime
 * path of `typebox`'s entry module via `import.meta.resolve("typebox")`,
 * then read the sibling `package.json` via `node:fs` — this works under
 * Vite/Vitest's resolver (which honors exports) AND under `tsc`/`node`
 * (which use the same resolver). The version is read once at module load.
 *
 * @module
 */
import type { TSchema } from "typebox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

interface TypeboxPackageJson {
  readonly version: string;
}

function readTypeboxVersion(): string {
  // `import.meta.resolve` returns the resolved entry-point URL (e.g.
  // file:///…/node_modules/typebox/build/index.mjs). The package.json
  // sits two directories up at typebox's package root.
  const entryUrl = import.meta.resolve("typebox");
  const entryPath = fileURLToPath(entryUrl);
  const pkgRoot = dirname(dirname(entryPath)); // …/typebox/build/.. -> …/typebox
  const pkgJsonPath = resolve(pkgRoot, "package.json");
  const raw = readFileSync(pkgJsonPath, "utf8");
  const parsed = JSON.parse(raw) as TypeboxPackageJson;
  return parsed.version;
}

/**
 * Normalize a TypeBox schema for snapshot comparison.
 *
 * Returns a plain JS value (or array, or null) with all object string keys
 * sorted lexicographically and `undefined` values dropped. Symbol keys are
 * dropped natively by `JSON.stringify`'s replacer mechanism.
 */
export function normalizeToolSchema(schema: TSchema | unknown): unknown {
  return JSON.parse(
    JSON.stringify(
      schema,
      (_key, val) => {
        if (val !== null && typeof val === "object" && !Array.isArray(val)) {
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(val as Record<string, unknown>).sort()) {
            const v = (val as Record<string, unknown>)[k];
            if (v !== undefined) sorted[k] = v;
          }
          return sorted;
        }
        return val;
      },
    ),
  );
}

export const TYPEBOX_VERSION: string = readTypeboxVersion();
