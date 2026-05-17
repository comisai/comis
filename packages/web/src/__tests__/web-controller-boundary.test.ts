// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 44 (WEB-DECOMP) — web controller-view boundary structural test.
 *
 * Enforces the controller/view extraction pattern across `packages/web/src/views/`
 * and `packages/web/src/components/` per design §10 / WEB-DECOMP-03 + WEB-DECOMP-04
 * + WEB-DECOMP-05:
 *
 *   1. Controllers contain NO Lit `` html` `` template literals (controllers own
 *      state + RPC; templates live in the view).
 *   2. Views do NOT directly call `rpcClient.call(...)` (controllers own RPC).
 *      Gated by `PRE_EXTRACTION_ALLOWLIST` — drained per Wave 2-7 split commit.
 *   3. Naming convention: controllers MUST end in `-controller.ts`
 *      (no `-ctrl.ts` or `.controller.ts` alternates).
 *   4. Co-location: every `<view>-controller.ts` MUST have a `<view>.ts` neighbor
 *      in the same directory.
 *
 * Wave 1 (this commit) state: assertions 1+3+4 vacuously satisfied (no controllers
 * exist). Assertion 2 satisfied via `PRE_EXTRACTION_ALLOWLIST` containing EXACTLY
 * the files where `grep -cE '\b(this\.)?rpcClient!?\.call\b' <file>` returns >0
 * at HEAD (23 in-scope INCLUDED + 5 OOS INCLUDED = 28 paths). Each Wave 2-7 split
 * commit REMOVES its in-scope file from the Set IF the file is currently in the Set;
 * the 3 in-scope files with grep == 0 (`ic-graph-canvas.ts`, `ic-cron-editor.ts`,
 * `app.ts`) are NOT in the Set, so no drain step is needed for them. The 5 OOS
 * files STAY in the Set permanently (not Phase 44 scope, but legitimately call RPC).
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

// W2 fix: also walk SRC_ROOT top-level .ts files (NON-recursive) to cover
// `app.ts` + the future `app-controller.ts` (Wave 7) under the boundary
// assertions. Without this, app.ts is invisible to the boundary test, and
// a violation in the app shell (html`` in a controller, rpcClient.call in
// app.ts post-extraction) would NOT be caught.
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

describe("web controller-view boundary (WEB-DECOMP-03 + WEB-DECOMP-04 + WEB-DECOMP-05)", () => {
  // ----------------------------------------------------------------------
  // Assertion 1: controllers contain NO Lit html`` template literals.
  // (Controllers own state + RPC; templates live in views.)
  // ----------------------------------------------------------------------
  it("controllers do not contain Lit html`` templates (WEB-DECOMP-03)", () => {
    const files = walkWebViews(resolve(SRC_ROOT, "views"))
      .concat(walkWebViews(resolve(SRC_ROOT, "components")))
      .concat(walkSrcRootShell(SRC_ROOT)) // W2: also include app-controller.ts (Wave 7)
      .filter((f) => f.endsWith("-controller.ts"));
    const violators = files.filter((f) => /\bhtml`/.test(readFileSync(f, "utf8")));
    expect(violators.map(repoRelative)).toEqual([]);
  });

  // ----------------------------------------------------------------------
  // Assertion 2: views do NOT call rpcClient.call directly.
  // (Controllers own RPC orchestration; views render snapshot data.)
  // ----------------------------------------------------------------------
  //
  // PRE_EXTRACTION_ALLOWLIST — drained per Wave 2-7 split commit.
  //
  //   IN-SCOPE INCLUDED (23): Phase 44 extracts a controller for each; each
  //                            Wave 2-7 split commit REMOVES the file's path
  //                            from this Set.
  //   IN-SCOPE EXCLUDED (3):   ic-graph-canvas.ts + ic-cron-editor.ts + app.ts
  //                            have grep == 0 for `\b(this\.)?rpcClient!?\.call\b`
  //                            at Wave-1 HEAD (verified). The regex never matches
  //                            them, so they MUST NOT be in this Set — including
  //                            them would be misleading dead weight, and no drain
  //                            step is needed when Waves 4 / 6 / 7 extract them.
  //   OUT-OF-SCOPE INCLUDED (5): legitimately call rpcClient.call today but are
  //                              NOT in Phase 44 scope (below 800L). These STAY
  //                              in the Set permanently — no Phase 44 extraction.
  //
  // Source of truth for each entry's inclusion: the `grep -cE` count next to it
  // (verified at Wave-1 baseline on `feat/code-quality-plan` HEAD, 2026-05-17).
  // Each entry MUST have count >0. Any entry with count == 0 MUST be removed.
  //
  const PRE_EXTRACTION_ALLOWLIST = new Set<string>([
    // ===== IN-SCOPE INCLUDED — drained per Wave 2-7 split commit =====
    // Wave 2
    //   setup-wizard.ts:   drained — extracted via setup-wizard-controller.ts   (Task 1).
    //   skills.ts:         drained — extracted via skills-controller.ts         (Task 2).
    //   chat-console.ts:   drained — RPC extracted via chat-console-controller.ts (Task 3).
    //   message-center.ts: drained — RPC extracted via message-center-controller.ts (Task 4).
    //   config-editor.ts:  drained — RPC extracted via config-editor-controller.ts (Task 5).
    // Wave 3
    //   agent-editor.ts:    drained — RPC extracted via agent-editor-controller.ts (Task 1).
    //   scheduler.ts:       drained — RPC extracted via scheduler-controller.ts (Task 2).
    //   memory-inspector.ts: drained — RPC extracted via memory-inspector-controller.ts (Task 3).
    //   observe-view.ts:    drained — RPC extracted via observe-view-controller.ts (Task 4).
    //   models.ts:          drained — RPC extracted via models-controller.ts (Task 5).
    // Wave 4
    //   ic-node-editor.ts:     drained — RPC extracted via ic-node-editor-controller.ts (Task 1).
    //   workspace-manager.ts:  drained — RPC extracted via workspace-manager-controller.ts (Task 2).
    //   channel-detail.ts:     drained — RPC extracted via channel-detail-controller.ts (Task 3).
    //   ic-graph-canvas.ts:    0 rpcClient.call (verified HEAD) — EXCLUDED (regex never matches); deferred Tier 3 per OQ-4.
    //   dashboard.ts:          drained — RPC extracted via dashboard-controller.ts (Task 5).
    // Wave 5
    //   mcp-management.ts: drained — RPC extracted via mcp-management-controller.ts (Task 1).
    //   session-detail.ts: drained — RPC extracted via session-detail-controller.ts (Task 2).
    "packages/web/src/views/agents/agent-list.ts",                  //  5 rpcClient.call (verified HEAD)
    "packages/web/src/views/pipelines/pipeline-list.ts",            //  7 rpcClient.call (verified HEAD)
    "packages/web/src/views/pipelines/pipeline-builder.ts",         //  4 rpcClient.call (verified HEAD)
    // Wave 6
    "packages/web/src/views/agents/agent-detail.ts",                //  3 rpcClient.call (verified HEAD)
    "packages/web/src/views/media-test.ts",                         //  7 rpcClient.call (verified HEAD) — INCLUDED
    // ic-cron-editor.ts: 0 rpcClient.call (verified HEAD) — EXCLUDED (form-only, no RPC).
    "packages/web/src/views/pipelines/pipeline-monitor.ts",         //  4 rpcClient.call (verified HEAD) — INCLUDED
    // Wave 7
    // app.ts: 0 rpcClient.call (verified HEAD) — EXCLUDED (RPC indirect via PollingController).
    //   Note: app.ts constructs `rpcClient` then passes it to PollingController; it
    //   does NOT directly call `rpcClient.call(...)`. The boundary regex matches only
    //   direct call sites — app.ts is therefore not a Wave-1 baseline violator and
    //   needs no entry here. Wave 7's app-controller extraction does NOT require a
    //   Set drain step for app.ts (was never in the Set).
    "packages/web/src/views/security.ts",                           //  3 rpcClient.call (verified HEAD)

    // ===== OUT-OF-SCOPE INCLUDED — STAY permanently (not Phase 44 scope) =====
    // Each verified to have grep >0 at Wave-1 HEAD. Counts not annotated since
    // they are not subject to Phase 44 cap pressure and not drained by any wave.
    "packages/web/src/views/channel-list.ts",
    "packages/web/src/views/context-dag-browser.ts",
    "packages/web/src/views/media-config.ts",
    "packages/web/src/views/session-list.ts",
    "packages/web/src/views/subagents.ts",
  ]);

  it("views do not call rpcClient.call directly (controllers own RPC) (WEB-DECOMP-03)", () => {
    const files = walkWebViews(resolve(SRC_ROOT, "views"))
      .concat(walkWebViews(resolve(SRC_ROOT, "components")))
      .concat(walkSrcRootShell(SRC_ROOT)) // W2: also include app.ts (Wave 7 shell)
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
  it("no alternate controller-suffix forms (-ctrl.ts, .controller.ts) (WEB-DECOMP-03)", () => {
    const files = walkWebViews(resolve(SRC_ROOT, "views"))
      .concat(walkWebViews(resolve(SRC_ROOT, "components")))
      .concat(walkSrcRootShell(SRC_ROOT)); // W2: also include SRC_ROOT shell files
    const wrongSuffix = files.filter((f) => /-ctrl\.ts$|\.controller\.ts$/.test(f));
    expect(wrongSuffix.map(repoRelative)).toEqual([]);
  });

  // ----------------------------------------------------------------------
  // Assertion 4: co-location — every controller has a sibling view file.
  // ----------------------------------------------------------------------
  it("controllers are co-located with their view (WEB-DECOMP-04 + WEB-DECOMP-05)", () => {
    const controllers = walkWebViews(resolve(SRC_ROOT, "views"))
      .concat(walkWebViews(resolve(SRC_ROOT, "components")))
      .concat(walkSrcRootShell(SRC_ROOT)) // W2: also include app-controller.ts (Wave 7)
      .filter((f) => f.endsWith("-controller.ts"));
    const orphans = controllers.filter((c) => {
      const viewPath = c.replace(/-controller\.ts$/, ".ts");
      return !existsSync(viewPath);
    });
    expect(orphans.map(repoRelative)).toEqual([]);
  });
});
