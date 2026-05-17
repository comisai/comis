// SPDX-License-Identifier: Apache-2.0
/**
 * AST-based forbidden-import detector.
 *
 * Replaces source-grep when checking imports: parses each candidate file
 * via the TypeScript Compiler API (`ts.createSourceFile` +
 * `ts.forEachChild`) and walks `ImportDeclaration` nodes. This handles
 * cases that defeat regex source-grep:
 *
 *   - multi-line imports (`import {\n  X,\n  Y,\n} from "@comis/agent";`)
 *   - imports inside `//` or block comments (parser strips comments)
 *   - import-shaped strings inside template literals (parsed as
 *     `StringLiteral`, not `ImportDeclaration`)
 *   - value-import vs type-only-import distinction via the optional
 *     `valueImportsOnly` flag — used by composition-root.test.ts and
 *     infra-runtime-scope.test.ts to allow
 *     `import type { ComisLogger } from "@comis/infra"` while still
 *     flagging runtime value-imports.
 *
 * Closes a source-grep evasion vector: regex matchers miss multi-line
 * imports, comment-blocks, and template-literal lookalikes.
 *
 * Result shape mirrors `test/support/source-grep.ts` `SourceGrepResult` so
 * per-package architecture tests can use the uniform sanity check
 * `expect(result.checkedFiles, "sanity").toBeGreaterThan(0)` regardless
 * of which helper they call.
 *
 * @module
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

/**
 * One detected import of a forbidden package, with citation context.
 *
 * `file` is an absolute path; `line` and `column` are 1-indexed (matching
 * the convention of TypeScript diagnostic output and editor cursors).
 * `snippet` includes the line above, the offending line, and the line
 * below, each prefixed with its 1-indexed line number.
 */
export interface ImportViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly importedSymbols: readonly string[];
  readonly snippet: string;
}

/**
 * Options controlling the walk + detection.
 *
 * `excludeFileSuffixes` defaults to `[".test.ts"]` -- pass `[]` to scan
 * test files. `allowlistPaths` is a substring match against the absolute
 * path of each candidate file (NOT a glob); allowlisted files are still
 * parsed and counted toward `checkedFiles`, but their violations are
 * dropped.
 *
 * `valueImportsOnly` skips type-only `ImportDeclaration`s so that
 * `import type { X } from "@comis/foo"` does NOT count as a violation.
 * See the field doc for exact semantics on mixed-form imports.
 */
export interface FindForbiddenImportsOptions {
  readonly rootDir: string;
  readonly forbiddenPackage: string;
  readonly allowlistPaths?: readonly string[];
  readonly excludeFileSuffixes?: readonly string[];
  /**
   * When true, ImportDeclarations whose entire importClause is type-only
   * (`import type { X } from "@comis/foo"`) are NOT reported as
   * violations. For the mixed form `import { type X, Y } from "..."`
   * (the import itself is not type-only, but individual specifiers are
   * tagged `type`), the violation is reported only if at least one
   * NON-type-only specifier exists OR the import has a default/namespace
   * binding (those are always value-mode — TS has no per-binding
   * type-only flag for `import foo from ...` or `import * as foo`).
   * Pure side-effect imports (`import "@comis/foo"`) have no symbol
   * binding at all and are likewise skipped under this flag.
   *
   * Default: false (every existing caller relies on this — closing
   * the flag preserves all per-package architecture tests).
   *
   * Behavior matrix:
   *   - `import type { X } from "@comis/foo"` → skipped
   *   - `import { X } from "@comis/foo"`       → reported (value)
   *   - `import { type X, Y } from "@comis/foo"` → reported (Y is value)
   *   - `import { type X } from "@comis/foo"`  → skipped (no value spec)
   *   - `import * as foo from "@comis/foo"`    → reported (namespace = value)
   *   - `import foo from "@comis/foo"`         → reported (default = value)
   *   - `import "@comis/foo"`                  → skipped (no symbol)
   */
  readonly valueImportsOnly?: boolean;
}

/**
 * Result of `findForbiddenImports`.
 *
 * `violations` is a frozen array of detected imports. `checkedFiles` is
 * the count of `.ts` files actually opened and parsed (after directory +
 * suffix exclusions). Allowlisted files DO count toward `checkedFiles` --
 * the walker still parsed them; their imports were intentionally exempted
 * from violations.
 */
export interface FindForbiddenImportsResult {
  readonly violations: readonly ImportViolation[];
  readonly checkedFiles: number;
}

const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  "__tests__",
  "__snapshots__",
  "dist",
  "node_modules",
];
const DEFAULT_EXCLUDE_FILE_SUFFIXES: readonly string[] = [".test.ts"];

/**
 * Walk `rootDir` and report every `ImportDeclaration` whose module
 * specifier exactly matches `forbiddenPackage`.
 *
 * Symlinks are skipped (loop guard). Directories `__tests__`,
 * `__snapshots__`, `dist`, `node_modules` are skipped unconditionally.
 * Files matching `excludeFileSuffixes` (default: `[".test.ts"]`) are
 * skipped before parsing.
 */
export function findForbiddenImports(
  opts: FindForbiddenImportsOptions,
): FindForbiddenImportsResult {
  const exclude = new Set(DEFAULT_EXCLUDE_DIRS);
  const excludeSuffixes =
    opts.excludeFileSuffixes ?? DEFAULT_EXCLUDE_FILE_SUFFIXES;
  const allowlist = opts.allowlistPaths ?? [];
  const violations: ImportViolation[] = [];
  let checkedFiles = 0;

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Directory missing or inaccessible; skip silently.
    }
    for (const entry of entries) {
      // Skip hidden files/dirs (`.git`, `.DS_Store`, etc.).
      if (entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // Loop guard.
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!entry.name.endsWith(".ts")) continue;
        if (excludeSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
          continue;
        }
        // Allowlisted files still count toward checkedFiles -- the walker
        // CONSIDERED them (entry survived suffix + hidden-dir + symlink
        // filters); allowlisted entries are then skipped before parsing
        // to save I/O while preserving the count. Bump BEFORE the
        // allowlist `continue` so the count reflects "files the helper
        // considered". The increment is deliberately ahead of
        // `ts.createSourceFile` -- existing tests in
        // `import-checker.test.ts` assert that allowlisted files still
        // contribute to `checkedFiles > 0`.
        checkedFiles++;
        if (allowlist.some((al) => full.includes(al))) continue;

        const content = readFileSync(full, "utf8");
        const sf = ts.createSourceFile(
          full,
          content,
          ts.ScriptTarget.ES2023,
          /* setParentNodes */ true,
        );

        ts.forEachChild(sf, function visit(node) {
          if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            // Match exact package OR any subpath (`@comis/agent/dist/foo`).
            // CLAUDE.md §9 forbids `@comis/<pkg>/dist/...` subpaths anyway,
            // and architecture allowlists key on file paths — a subpath
            // import would otherwise smuggle past every rule keyed on the
            // bare package name.
            (node.moduleSpecifier.text === opts.forbiddenPackage ||
              node.moduleSpecifier.text.startsWith(
                `${opts.forbiddenPackage}/`,
              ))
          ) {
            // Type-only filter (default false preserves backwards compat
            // with every existing caller). See
            // FindForbiddenImportsOptions.valueImportsOnly doc for the
            // full behavior matrix; the checks below mirror that contract.
            if (opts.valueImportsOnly === true) {
              const clause = node.importClause;
              // No clause = side-effect import `import "..."` — no symbol
              // binding, never a value-import of a named symbol; skip.
              if (!clause) {
                ts.forEachChild(node, visit);
                return;
              }
              // Whole-import type-only `import type { X } from "..."` —
              // never a runtime value reference; skip.
              if (clause.isTypeOnly) {
                ts.forEachChild(node, visit);
                return;
              }
              // Mixed form: `import { type X, Y } from "..."`. NamedImports
              // specifiers carry their own per-binding isTypeOnly flag.
              // Default + namespace bindings are ALWAYS value-mode (TS has
              // no per-binding type-only flag for `import foo from ...` or
              // `import * as foo`), so the presence of either short-circuits
              // the check to "reported". The mixed-form skip only fires when
              // there is no default + no namespace + every NamedImport
              // specifier is type-only.
              if (
                !clause.name &&
                clause.namedBindings &&
                ts.isNamedImports(clause.namedBindings)
              ) {
                const hasValueSpecifier = clause.namedBindings.elements.some(
                  (el) => !el.isTypeOnly,
                );
                if (!hasValueSpecifier) {
                  // Every named binding was `type X` — type-only; skip.
                  ts.forEachChild(node, visit);
                  return;
                }
              }
            }
            const { line, character } = sf.getLineAndCharacterOfPosition(
              node.getStart(),
            );
            const line1 = line + 1;
            const col1 = character + 1;
            const importedSymbols = collectImportedSymbols(node);
            violations.push({
              file: full,
              line: line1,
              column: col1,
              importedSymbols,
              snippet: extractSnippet(content, line1),
            });
          }
          ts.forEachChild(node, visit);
        });
      }
    }
  }

  walk(opts.rootDir);
  return { violations: Object.freeze(violations.slice()), checkedFiles };
}

/**
 * Collect the named imports + default-import + namespace-import bindings
 * from an `ImportDeclaration`. Side-effect imports (`import "x";`)
 * produce an empty array.
 */
function collectImportedSymbols(node: ts.ImportDeclaration): readonly string[] {
  const symbols: string[] = [];
  const clause = node.importClause;
  if (!clause) return symbols;
  if (clause.name) {
    symbols.push(clause.name.text); // default import
  }
  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings)) {
      symbols.push(`* as ${bindings.name.text}`);
    } else if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        symbols.push(el.name.text);
      }
    }
  }
  return symbols;
}

/**
 * Render 3 lines of context around `line1Indexed` (line-1, line, line+1)
 * with each output line prefixed by its 1-indexed line number, e.g.
 *
 *   13:   const a = 1;
 *   14:   import { X } from "@comis/agent";
 *   15:   const b = 2;
 *
 * Out-of-range lines are silently dropped (e.g. line 1 has no preceding
 * line).
 */
function extractSnippet(content: string, line1Indexed: number): string {
  const lines = content.split("\n");
  const out: string[] = [];
  for (let l = line1Indexed - 1; l <= line1Indexed + 1; l++) {
    if (l < 1 || l > lines.length) continue;
    out.push(`${l}: ${lines[l - 1]}`);
  }
  return out.join("\n");
}
