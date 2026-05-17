// SPDX-License-Identifier: Apache-2.0
/**
 * Lock-in: the web SPA's `api/` directory MUST import neither any
 * `@comis/*` workspace package NOR any `node:*` builtin.
 *
 * Why: `packages/web/src/api/` is the browser-only seam — its files ship in
 * the Vite bundle that runs in the user's browser. Importing a Node-only
 * symbol (e.g., `node:fs`, `node:path`, raw `fs` / `path` / `crypto`) would
 * either pull in a Node polyfill (silent runtime bloat) or break the build.
 * Importing a `@comis/*` server-side package would defeat the codegen seam:
 * the generated `contracts.generated.ts` IS the cross-process boundary; no
 * other @comis surface belongs in the browser.
 *
 * The forbidden-packages list mirrors the `HARD_FORBIDDEN_PACKAGES`
 * constellation in `packages/gateway/src/__tests__/architecture.test.ts`.
 *
 * Lock-in scope: the test walks `packages/web/src/api/` (NOT all of
 * `packages/web/src/`). The view/component layer can still import a
 * Node-only symbol via a relative path or a `vite-plugin-node-polyfills`
 * shim (the `api/` directory is the load-bearing seam — every contract
 * dispatch and validator runs through it).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenImports } from "../support/import-checker.js";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const WEB_API_DIR = resolve(REPO_ROOT, "packages/web/src/api");

/**
 * Every workspace package — none may be imported from `packages/web/src/api/`.
 * The web SPA depends on the generated `contracts.generated.ts` (which has
 * zero `@comis/*` imports by construction — codegen-asserted) and on
 * browser primitives. The `@comis/*` graph is server-only.
 */
const FORBIDDEN_FOR_WEB = [
  "@comis/core",
  "@comis/agent",
  "@comis/infra",
  "@comis/shared",
  "@comis/memory",
  "@comis/skills",
  "@comis/scheduler",
  "@comis/channels",
  "@comis/orchestrator",
  "@comis/gateway",
  "@comis/daemon",
  "@comis/cli",
] as const;

/**
 * Node-builtin specifiers that ship in the Node runtime but not the browser.
 * The `node:` prefix form is the modern canonical spelling; the bare form
 * (`"fs"`, `"path"`, …) is the legacy spelling. Both resolve to the same
 * Node-only modules in `node_modules/@types/node`, so both must be banned.
 *
 * The set is intentionally narrow — `stream`, `zlib`, `crypto`, `fs`,
 * `path` cover the universe of "would silently break in browser" imports
 * that current production code references. New entries get added on the
 * day a new Node builtin starts showing up in the workspace.
 */
const FORBIDDEN_NODE_BUILTINS_BARE = ["fs", "path", "crypto", "zlib", "stream"] as const;

describe("Web no @comis/* and no node:* imports", () => {
  // ---------------------------------------------------------------------
  // Block 1 — forbidden @comis/* packages via AST-walked findForbiddenImports.
  // ---------------------------------------------------------------------
  for (const forbidden of FORBIDDEN_FOR_WEB) {
    it(`packages/web/src/api/ does NOT import ${forbidden}`, () => {
      const { violations, checkedFiles } = findForbiddenImports({
        rootDir: WEB_API_DIR,
        forbiddenPackage: forbidden,
        excludeFileSuffixes: [".test.ts"],
      });
      expect(
        violations,
        formatViolations({
          description: `packages/web/src/api/ must not import ${forbidden} — the web SPA runs in the browser, where ${forbidden} (a Node-only @comis workspace package) is not resolvable.`,
          violations: violations.map((v) => ({
            file: v.file,
            line: v.line,
            column: v.column,
            snippet: v.snippet,
          })),
          suggestedFix: `Replace the import with named exports from "./contracts.generated.js" (or refactor the consuming code to a server-side surface). The generated artifact is the one-way seam between core and web.`,
          designRef: "Browser-safe constraints — packages/web/src/api/ must contain no @comis/* imports",
        }),
      ).toEqual([]);
      expect(
        checkedFiles,
        "sanity: findForbiddenImports walked at least one packages/web/src/api/ file",
      ).toBeGreaterThan(0);
    });
  }

  // ---------------------------------------------------------------------
  // Block 2 — forbidden node:* builtins via raw source-content regex.
  //
  // We need a regex (not AST) because the generated file is ~9569 lines and
  // parsing it for every Node builtin check would be wasteful; the AST
  // version is reserved for @comis/* (where false positives from comment
  // text are real). Node-builtin import strings are simple enough that a
  // regex over the raw source is reliable + 100× faster.
  // ---------------------------------------------------------------------
  it("packages/web/src/api/ has no `node:*` imports", () => {
    const offenders = findRawImportMatches(WEB_API_DIR, /from\s+["']node:/);
    expect(
      offenders,
      formatViolations({
        description: `packages/web/src/api/ must not contain any \`from "node:…"\` import — browser builds cannot resolve Node builtins.`,
        violations: offenders.map((file) => ({ file, line: 0 })),
        suggestedFix: `Move the Node-only logic to a server-side package (e.g., packages/daemon/) and surface the result via an RPC contract in @comis/core/api-contracts/. The browser consumes the result through contracts.generated.ts.`,
        designRef: "Browser-safe constraints — packages/web/src/api/ must contain no node:* imports",
      }),
    ).toEqual([]);
  });

  for (const bare of FORBIDDEN_NODE_BUILTINS_BARE) {
    it(`packages/web/src/api/ has no bare \`${bare}\` import`, () => {
      // Match `from "fs"` or `from 'fs'` but NOT `from "fsevents"` etc.
      const pattern = new RegExp(`from\\s+["']${bare}["']`);
      const offenders = findRawImportMatches(WEB_API_DIR, pattern);
      expect(
        offenders,
        formatViolations({
          description: `packages/web/src/api/ must not contain a bare \`from "${bare}"\` import — Vite resolves bare imports against node_modules, and ${bare} is a Node builtin (no browser polyfill ships by default).`,
          violations: offenders.map((file) => ({ file, line: 0 })),
          suggestedFix: `If you must use a ${bare}-equivalent in the browser, find a published browser-safe alternative (e.g., crypto → SubtleCrypto via globalThis.crypto). Server-side ${bare} usage belongs in a non-web package.`,
          designRef: "Browser-safe constraints — packages/web/src/api/ must contain no bare Node-builtin imports",
        }),
      ).toEqual([]);
    });
  }
});

/**
 * Walk `rootDir` and return every `.ts` file whose raw text matches `needle`.
 * Skips `__tests__`, `dist`, `node_modules`, hidden files, and `.test.ts`.
 *
 * Implemented inline (not via `findInSourceFiles`) because the architecture
 * test surface needs a path-level (not match-level) result and we already
 * exclude `.test.ts` consistently with `findForbiddenImports` defaults.
 */
function findRawImportMatches(rootDir: string, needle: RegExp): string[] {
  const out: string[] = [];
  const SKIP_DIRS = new Set(["__tests__", "__snapshots__", "dist", "node_modules"]);

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      const src = readFileSync(full, "utf8");
      // Clone the regex so `g`/`y` flags on caller-supplied patterns don't
      // retain `lastIndex` state across files.
      const re = new RegExp(needle.source, needle.flags);
      if (re.test(src)) out.push(full);
    }
  }
  walk(rootDir);
  return out;
}
