// SPDX-License-Identifier: Apache-2.0
/**
 * Builtin-tools label-coverage gate.
 *
 * Sibling of `transparency-label-coverage.test.ts`. That gate walks the LIVE
 * platform-tool descriptor registry; this one walks a HARDCODED list of the
 * 12 EMITTED builtin tool names because builtins are NOT in a registry — the
 * 12 factories are constructed individually by the daemon composition root,
 * with no introspectable enumeration. The hardcoded list is the contract: a
 * new builtin tool added without a spec must surface here as a failing test
 * (the developer adds the name → coverage gate flags the missing spec).
 *
 * Why `hasRegisteredLabelSpec` (not `resolveLabelSpec`): `resolveLabelSpec`
 * is TOTAL — it always returns a humanized fallback — so "did resolution
 * succeed?" passes for every tool and is a no-op gate.
 * The coverage check must ask "was a spec explicitly registered?".
 *
 * Why side-effect imports in `beforeAll`: each tool module's
 * `registerActivityLabelSpec(...)` call runs once on first import, populating
 * the singleton registry. The same pattern that the daemon composition root
 * relies on at startup; we replay it here so the registry is hot before the
 * `it` assertion runs.
 *
 * Why EMITTED names (NOT file basenames): the activity stream resolves on
 * `AgentTool.name` — the literal at each factory's return. For four builtins
 * the emitted name uses an UNDERSCORE while the file basename uses a hyphen:
 *   - `notebook-edit-tool.ts:120`   → `"notebook_edit"`
 *   - `apply-patch-tool.ts:475`     → `"apply_patch"`
 *   - `web-fetch-tool.ts:614`       → `"web_fetch"`
 *   - `web-search-tool/index.ts:114`→ `"web_search"`
 * A registration on the file-basename ("notebook-edit") would key the wrong
 * entry and the activity stream would silently fall back to the humanized
 * default. The list below MUST stay in the underscore form so that this
 * test fails loudly if someone reintroduces the hyphenated form.
 *
 * @module
 */
import { describe, it, expect, beforeAll } from "vitest";
import { hasRegisteredLabelSpec } from "@comis/core";

/**
 * The 12 EMITTED builtin tool names (the `AgentTool.name` field at each
 * factory's return). Verified via grep on `name:` in each factory file at
 * the cited lines. The 4 underscore-name variants are called out inline so
 * a reviewer cannot accidentally "fix" the hyphenated form.
 */
const BUILTIN_TOOLS = [
  "read",            // file-tools/read-tool.ts:361
  "write",           // file-tools/write-tool.ts:178
  "edit",            // file-tools/edit-tool.ts:196
  "ls",              // file-tools/ls-tool.ts:126
  "grep",            // file-tools/grep-tool.ts:402
  "find",            // file-tools/find-tool.ts:295
  "notebook_edit",   // file-tools/notebook-edit-tool.ts:120  ← UNDERSCORE not hyphen
  "apply_patch",     // file/apply-patch-tool.ts:475          ← UNDERSCORE not hyphen
  "exec",            // exec-tool/index.ts:75
  "process",         // process-tool.ts:111
  "web_fetch",       // web-fetch-tool.ts:614                 ← UNDERSCORE not hyphen
  "web_search",      // web-search-tool/index.ts:114          ← UNDERSCORE not hyphen
] as const;

describe("builtin-tools-label-coverage", () => {
  beforeAll(async () => {
    // Side-effect imports trigger each tool module's co-located
    // `registerActivityLabelSpec(...)` call at module load. Same idiom the
    // daemon composition root uses; mirrored in
    // `transparency-label-coverage.test.ts` via the platform-tools registry
    // walk. The `.js` suffix is the NodeNext convention — vitest resolves
    // to the `.ts` source at test time.
    await import("../tools/builtin/file-tools/read-tool.js");
    await import("../tools/builtin/file-tools/write-tool.js");
    await import("../tools/builtin/file-tools/edit-tool.js");
    await import("../tools/builtin/file-tools/ls-tool.js");
    await import("../tools/builtin/file-tools/grep-tool.js");
    await import("../tools/builtin/file-tools/find-tool.js");
    await import("../tools/builtin/file-tools/notebook-edit-tool.js");
    await import("../tools/builtin/file/apply-patch-tool.js");
    await import("../tools/builtin/exec-tool/index.js");
    await import("../tools/builtin/process-tool.js");
    await import("../tools/builtin/web-fetch-tool.js");
    await import("../tools/builtin/web-search-tool/index.js");
  });

  it("every builtin tool has a registered LabelSpec", () => {
    const offenders = BUILTIN_TOOLS.filter((name) => !hasRegisteredLabelSpec(name));
    expect(offenders).toEqual([]);
  });
});
