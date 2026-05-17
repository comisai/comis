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
 *      Gated by `PRE_EXTRACTION_ALLOWLIST` — fully drained at Phase 44 close
 *      (Wave 8 closing-drain commit). Set state is now TERMINAL: 5 OOS permanent
 *      entries only.
 *   3. Naming convention: controllers MUST end in `-controller.ts`
 *      (no `-ctrl.ts` or `.controller.ts` alternates).
 *   4. Co-location: every `<view>-controller.ts` MUST have a `<view>.ts` neighbor
 *      in the same directory.
 *
 * **Phase 44 closure state (Wave 8 commit):** all 26 in-scope files have reached
 * terminal state (split + drained from PRE_EXTRACTION_ALLOWLIST, or never in the
 * Set because grep == 0 at HEAD, or §10.5-deferred per WEB-DECOMP-09 with the
 * `removedIn: "deferred"` allowlist entry). PRE_EXTRACTION_ALLOWLIST contains
 * EXACTLY the 5 OUT-OF-SCOPE files that legitimately call rpcClient.call today
 * but are not Phase 44 scope (under 800L). These STAY in the Set permanently —
 * they are NOT post-Phase-44 violations. Closure invariant verified by Wave 8:
 * `grep -c 'removedIn: "phase-G"' test/support/architecture-allowlist.ts == 0`.
 *
 * Any future regression that re-introduces a `rpcClient.call(...)` site in a
 * view OR a `<view>-controller.ts` that contains an html`` template OR a
 * misnamed controller-suffix variant OR an orphan controller without a sibling
 * view will fail this test. This is the post-Phase-44 architectural gate.
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
  // PRE_EXTRACTION_ALLOWLIST — FULLY DRAINED at Phase 44 close (Wave 8).
  //
  // **Set state is terminal.** All 26 in-scope Phase 44 files have reached
  // closure (either split + drained from this Set, or never in the Set because
  // grep == 0 at Wave-1 baseline, or §10.5-deferred per WEB-DECOMP-09 with the
  // corresponding `removedIn: "deferred"` entry in `test/support/architecture-allowlist.ts`).
  //
  // The remaining 5 entries are ALL OUT-OF-SCOPE: they legitimately call
  // `rpcClient.call(...)` today but are below the 800L Phase-44 cap and were
  // not included in the §10.2 / 2026-05-13-addendum inventory. They STAY in
  // this Set permanently — they are NOT post-Phase-44 violations. Any future
  // phase that decides to extract controllers for these files would drain
  // them at that time.
  //
  // Closure invariant (verified by Wave 8 commit):
  //   `grep -c 'removedIn: "phase-G"' test/support/architecture-allowlist.ts == 0`
  //
  // Wave-by-wave drain history (for audit; do not modify these annotations):
  //   Wave 2 (5 drains): setup-wizard, skills, chat-console, message-center, config-editor.
  //   Wave 3 (5 drains): agent-editor, scheduler, memory-inspector, observe-view, models.
  //   Wave 4 (4 drains): ic-node-editor, workspace-manager, channel-detail, dashboard.
  //                      (ic-graph-canvas was never in the Set — 0 rpcClient.call at HEAD;
  //                       deferred Tier 3 per OQ-4 with allowlist `removedIn: "deferred"`.)
  //   Wave 5 (5 drains): mcp-management, session-detail, agent-list, pipeline-list, pipeline-builder.
  //   Wave 6 (3 drains): agent-detail, media-test, pipeline-monitor.
  //                      (ic-cron-editor was never in the Set — 0 rpcClient.call at HEAD;
  //                       NO-RPC controller variant landed; §10.5-deferred for view cap.)
  //   Wave 7 (1 drain):  security.
  //                      (app.ts was never in the Set — 0 rpcClient.call at HEAD; RPC
  //                       indirect via PollingController construction. Tier 1 app-controller
  //                       split landed cleanly under the 500L cap with no drain step needed.)
  //   Wave 8 (0 drains): no remaining in-scope entries — phase closing commit only.
  //
  //   Total: 23 in-scope drains via Set + 3 in-scope non-Set files (cap-met or deferred)
  //          = 26 in-scope files reaching terminal state.
  //
  const PRE_EXTRACTION_ALLOWLIST = new Set<string>([
    // ===== OUT-OF-SCOPE PERMANENT (5 entries) — NOT Phase 44 scope =====
    // Each verified to have `grep -cE '\b(this\.)?rpcClient!?\.call\b'` > 0 at
    // Wave-1 HEAD and at Phase 44 close. These files are <800L and were never
    // in the §10.2 / 2026-05-13-addendum inventory. They STAY in this Set
    // permanently as the legitimate post-Phase-44 baseline.
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
