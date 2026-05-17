// SPDX-License-Identifier: Apache-2.0
/**
 * Web controller-view boundary structural test.
 *
 * Enforces the controller/view extraction pattern across
 * `packages/web/src/views/` and `packages/web/src/components/`:
 *
 *   1. Controllers contain NO Lit `` html` `` template literals (controllers own
 *      state + RPC; templates live in the view).
 *   2. Views do NOT directly call `rpcClient.call(...)` (controllers own RPC).
 *      Gated by `PRE_EXTRACTION_ALLOWLIST`, which contains exactly the
 *      out-of-scope files (under the 800L cap) that legitimately call
 *      `rpcClient.call` today and were not in the original extraction
 *      inventory. These stay in the Set permanently as the architectural
 *      baseline.
 *   3. Naming convention: controllers MUST end in `-controller.ts`
 *      (no `-ctrl.ts` or `.controller.ts` alternates).
 *   4. Co-location: every `<view>-controller.ts` MUST have a `<view>.ts` neighbor
 *      in the same directory.
 *
 * Any regression that re-introduces a `rpcClient.call(...)` site in a view OR
 * a `<view>-controller.ts` that contains an html`` template OR a misnamed
 * controller-suffix variant OR an orphan controller without a sibling view
 * will fail this test.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(SRC_ROOT, "../../..");

function repoRelative(absPath: string): string {
  return absPath.startsWith(REPO_ROOT + "/") ? absPath.slice(REPO_ROOT.length + 1) : absPath;
}

function walkWebViews(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "__snapshots__" || entry.name === "__tests__") continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkWebViews(full, out);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".generated.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

// Also walk SRC_ROOT top-level .ts files (NON-recursive) to cover `app.ts`
// + `app-controller.ts` under the boundary assertions. Without this, app.ts
// is invisible to the boundary test, and a violation in the app shell
// (html`` in a controller, rpcClient.call in app.ts) would NOT be caught.
const SRC_ROOT_SHELL_EXCLUSIONS = new Set<string>([
  "index.ts",
  "main.ts",
  "vite-env.d.ts",
  // contracts.generated.ts is already excluded by the .generated.ts check below.
]);
function walkSrcRootShell(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name.endsWith(".generated.ts")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (SRC_ROOT_SHELL_EXCLUSIONS.has(entry.name)) continue;
    out.push(resolve(dir, entry.name));
  }
  return out;
}

describe("web controller-view boundary", () => {
  // ----------------------------------------------------------------------
  // Assertion 1: controllers contain NO Lit html`` template literals.
  // (Controllers own state + RPC; templates live in views.)
  // ----------------------------------------------------------------------
  it("controllers do not contain Lit html`` templates", () => {
    const files = walkWebViews(resolve(SRC_ROOT, "views"))
      .concat(walkWebViews(resolve(SRC_ROOT, "components")))
      .concat(walkSrcRootShell(SRC_ROOT)) // also include app-controller.ts
      .filter((f) => f.endsWith("-controller.ts"));
    const violators = files.filter((f) => /\bhtml`/.test(readFileSync(f, "utf8")));
    expect(violators.map(repoRelative)).toEqual([]);
  });

  // ----------------------------------------------------------------------
  // Assertion 2: views do NOT call rpcClient.call directly.
  // (Controllers own RPC orchestration; views render snapshot data.)
  // ----------------------------------------------------------------------
  //
  // PRE_EXTRACTION_ALLOWLIST contains the out-of-scope files that
  // legitimately call `rpcClient.call(...)` today. They are below the 800L
  // cap and were not part of the original controller-extraction inventory,
  // so they stay in this Set permanently as the architectural baseline.
  // Any future work that decides to extract controllers for these files
  // would drain them at that time.
  //
  const PRE_EXTRACTION_ALLOWLIST = new Set<string>([
    // Each verified to have `grep -cE '\b(this\.)?rpcClient!?\.call\b'` > 0.
    // These files are <800L and were never in the extraction inventory.
    "packages/web/src/views/channel-list.ts",
    "packages/web/src/views/context-dag-browser.ts",
    "packages/web/src/views/media-config.ts",
    "packages/web/src/views/session-list.ts",
    "packages/web/src/views/subagents.ts",
  ]);

  it("views do not call rpcClient.call directly (controllers own RPC)", () => {
    const files = walkWebViews(resolve(SRC_ROOT, "views"))
      .concat(walkWebViews(resolve(SRC_ROOT, "components")))
      .concat(walkSrcRootShell(SRC_ROOT)) // also include app.ts shell
      .filter((f) => !f.endsWith("-controller.ts"));
    const violators = files.filter((f) => {
      const rel = repoRelative(f);
      if (PRE_EXTRACTION_ALLOWLIST.has(rel)) return false;
      const content = readFileSync(f, "utf8");
      return /\b(this\.)?rpcClient!?\.call\b/.test(content);
    });
    expect(violators.map(repoRelative)).toEqual([]);
  });

  // ----------------------------------------------------------------------
  // Assertion 3: naming convention — controllers end in `-controller.ts`.
  // (No `-ctrl.ts` or `.controller.ts` alternates.)
  // ----------------------------------------------------------------------
  it("no alternate controller-suffix forms (-ctrl.ts, .controller.ts)", () => {
    const files = walkWebViews(resolve(SRC_ROOT, "views"))
      .concat(walkWebViews(resolve(SRC_ROOT, "components")))
      .concat(walkSrcRootShell(SRC_ROOT)); // also include SRC_ROOT shell files
    const wrongSuffix = files.filter((f) => /-ctrl\.ts$|\.controller\.ts$/.test(f));
    expect(wrongSuffix.map(repoRelative)).toEqual([]);
  });

  // ----------------------------------------------------------------------
  // Assertion 4: co-location — every controller has a sibling view file.
  // ----------------------------------------------------------------------
  it("controllers are co-located with their view", () => {
    const controllers = walkWebViews(resolve(SRC_ROOT, "views"))
      .concat(walkWebViews(resolve(SRC_ROOT, "components")))
      .concat(walkSrcRootShell(SRC_ROOT)) // also include app-controller.ts
      .filter((f) => f.endsWith("-controller.ts"));
    const orphans = controllers.filter((c) => {
      const viewPath = c.replace(/-controller\.ts$/, ".ts");
      return !existsSync(viewPath);
    });
    expect(orphans.map(repoRelative)).toEqual([]);
  });
});
