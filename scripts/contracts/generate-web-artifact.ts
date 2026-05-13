// SPDX-License-Identifier: Apache-2.0
/**
 * Codegen entry point: produces `packages/web/src/api/contracts.generated.{ts,json,size.json}`
 * deterministically from `API_CONTRACTS_ORDERED` (populated by Wave C — 190
 * contracts across 14 domains as of Plan 35-19).
 *
 * Phase 35 Wave D Plan 35-20.
 *
 * Pipeline (RESEARCH §"Example: Generator entry point" lines 1315–1406):
 *   1. Allowlist gate (WEB-CONTRACTS-11): run `assertOnlyAllowlistShapes` over
 *      every contract's request + response. Forbidden shapes (e.g., `z.date`,
 *      `z.refine`, `z.lazy`) throw with method + direction + path + class
 *      name; bubbles up uncaught.
 *   2. Sort contracts alphabetically by method name. This is the single
 *      sort point (RESEARCH §"Determinism rules" item 1).
 *   3. Emit a JSON Schema map via `z.toJSONSchema(schema, { unrepresentable:
 *      "throw", reused: "inline" })`. `"throw"` is mandatory (CONTEXT D-06 +
 *      BLOCKER 5) — `"any"` silently produces `{}` for forbidden shapes,
 *      disabling validation in the generated browser artifact.
 *   4. Write the JSON map to `contracts.generated.json`.
 *   5. Emit the TS dispatch-table form via `emitDispatchTableTs`; write to
 *      `contracts.generated.ts`.
 *   6. Measure minified + gzipped sizes; write to
 *      `contracts.generated.size.json`. Exit 1 on budget overage.
 *
 * Determinism (RESEARCH §"Determinism rules" lines 763–778):
 *   - No `Date.now()`, no `new Date()`, no UUID, no `Math.random()`.
 *   - JSON.stringify with 2-space indent (matches diff conventions).
 *   - Esbuild minify is deterministic on pinned version.
 *   - Single sort point: alphabetical-by-method-name on the top-level CONTRACTS map.
 *
 * Browser-safety (WEB-CONTRACTS-15): The emitted TS has zero `@comis/*`,
 * zero `node:*`, and zero Zod imports. The emitter (`emitDispatchTableTs`)
 * is responsible for these invariants; the codegen entry point validates by
 * source-grep at test time (see `test/architecture/web-generated-imports.test.ts`).
 *
 * Usage:
 *   pnpm contracts:generate
 *   # or: npx tsx scripts/contracts/generate-web-artifact.ts
 *
 * @module
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { API_CONTRACTS_ORDERED } from "@comis/core";
import { assertOnlyAllowlistShapes } from "./walk-zod-schema.js";
import { emitDispatchTableTs, type JsonSchemaMap } from "./emit-dispatch-table.js";
import { measureSizes, type SizeReport } from "./size-budget.js";

// ---------------------------------------------------------------------------
// Output paths — anchored to repo root via this script's directory.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const WEB_API_DIR = resolve(REPO_ROOT, "packages", "web", "src", "api");

export const OUT_TS = resolve(WEB_API_DIR, "contracts.generated.ts");
export const OUT_JSON = resolve(WEB_API_DIR, "contracts.generated.json");
export const OUT_SIZE = resolve(WEB_API_DIR, "contracts.generated.size.json");

// ---------------------------------------------------------------------------
// Codegen result — returned by `runCodegen()` so callers (the entry point and
// the `generate.test.ts` tests) can introspect the produced artifacts without
// re-reading disk.
// ---------------------------------------------------------------------------

export interface CodegenResult {
  /** TS source written to `contracts.generated.ts` (does NOT include trailing-newline normalization). */
  readonly tsSource: string;
  /** JSON Schema map written to `contracts.generated.json` (stable iteration order). */
  readonly jsonSchemaMap: JsonSchemaMap;
  /** Size report written to `contracts.generated.size.json`. */
  readonly sizeReport: SizeReport;
}

/**
 * Run the codegen pipeline against the @comis/core contract registry and
 * write the 3 artifacts. Throws on allowlist failure; returns the produced
 * artifacts for in-process inspection.
 *
 * The function is pure-ish: it writes files but has no side-effects beyond
 * the three OUT_* paths. Returning the artifacts lets the codegen-drift test
 * compare against the on-disk versions without re-running.
 */
export function runCodegen(): CodegenResult {
  // 1. Allowlist gate (WEB-CONTRACTS-11). Forbidden shapes throw with the
  //    contract's method name + direction + class name; the error bubbles
  //    up to the entry point.
  for (const c of API_CONTRACTS_ORDERED) {
    assertOnlyAllowlistShapes(c.method, "request", c.request);
    assertOnlyAllowlistShapes(c.method, "response", c.response);
  }

  // 2. Sort by method name (alphabetical) — the single sort point per
  //    RESEARCH §"Determinism rules" item 1. The aggregator in
  //    packages/core/src/api-contracts/index.ts already sorts by DOMAIN
  //    (BLOCKER 6, Plan 35-19) but we re-sort by METHOD here so the codegen
  //    output is alphabetical at the method-name level — independent of
  //    aggregator order.
  const sortedContracts = [...API_CONTRACTS_ORDERED].sort((a, b) =>
    a.method.localeCompare(b.method),
  );

  // 3. JSON Schema map. `unrepresentable: "throw"` is load-bearing (CONTEXT
  //    D-06 + BLOCKER 5): forbidden Zod shapes that slipped past the
  //    allowlist (e.g., a new contract author adding `.refine()`) hard-fail
  //    codegen rather than silently producing `{}` (validation disabled).
  //    `reused: "inline"` (no `$defs`) keeps the output flat for diffability.
  const jsonSchemaMap: Record<
    string,
    { request: unknown; response: unknown; scopes: readonly string[] }
  > = {};
  for (const c of sortedContracts) {
    jsonSchemaMap[c.method] = {
      request: z.toJSONSchema(c.request, { unrepresentable: "throw", reused: "inline" }),
      response: z.toJSONSchema(c.response, {
        unrepresentable: "throw",
        reused: "inline",
      }),
      scopes: c.scopes,
    };
  }

  // 4. Write JSON sibling artifact. 2-space indent + trailing newline (POSIX).
  const jsonOutput = JSON.stringify(jsonSchemaMap, null, 2) + "\n";
  writeFileSync(OUT_JSON, jsonOutput);

  // 5. Emit + write TS dispatch-table.
  const tsSource = emitDispatchTableTs(jsonSchemaMap as JsonSchemaMap);
  writeFileSync(OUT_TS, tsSource);

  // 6. Measure size + write report.
  const perContractSchemas: Record<string, { request: unknown; response: unknown }> = {};
  for (const [method, entry] of Object.entries(jsonSchemaMap)) {
    perContractSchemas[method] = { request: entry.request, response: entry.response };
  }
  const sizeReport = measureSizes(tsSource, perContractSchemas);
  writeFileSync(OUT_SIZE, JSON.stringify(sizeReport, null, 2) + "\n");

  return {
    tsSource,
    jsonSchemaMap: jsonSchemaMap as JsonSchemaMap,
    sizeReport,
  };
}

/**
 * CLI entry point. Runs `runCodegen`, prints a one-line summary, and exits
 * non-zero on budget overage.
 */
function main(): void {
  const result = runCodegen();
  const { sizeReport } = result;
  console.log(
    `Generated ${Object.keys(result.jsonSchemaMap).length} contracts: ` +
      `${sizeReport.totalMinified}B minified / ${sizeReport.totalGzipped}B gzipped ` +
      `(budget: ${sizeReport.budget.minified}B / ${sizeReport.budget.gzipped}B)`,
  );
  if (sizeReport.overBudget) {
    console.error(
      `Codegen output exceeds budget: minified=${sizeReport.totalMinified}B ` +
        `(limit ${sizeReport.budget.minified}), ` +
        `gzipped=${sizeReport.totalGzipped}B (limit ${sizeReport.budget.gzipped}).`,
    );
    process.exit(1);
  }
}

// Run when invoked as a script (the typical `npx tsx` / `pnpm contracts:generate`
// path). Avoid running when this module is imported (e.g., by the test file).
const isMainModule = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (isMainModule) {
  main();
}
