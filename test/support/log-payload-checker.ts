// SPDX-License-Identifier: Apache-2.0
/**
 * Closed-`ErrorKind` AST walker.
 *
 * Uses `ts.createProgram` + TypeChecker to resolve `errorKind:` expression
 * types regardless of construction shape (object literal, `Object.assign`,
 * spread, member-access). Source-grep cannot resolve these evasion vectors;
 * the TypeChecker can.
 *
 * Cache: persistent JSON at
 * `node_modules/.cache/architecture-walker/log-payload-checker.json`.
 * Composite key (mtime + sha256) — both must match for a cache hit, otherwise
 * recompute. `version: 1` invalidates old caches when walker logic changes.
 *
 * The valid 9-member closed union mirrors the canonical ErrorKind union (`config | network |
 * auth | validation | timeout | resource | dependency | internal | platform`).
 *
 * @module
 */

import {
  readFileSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import * as ts from "typescript";

/**
 * Closed `ErrorKind` union — exactly 11 members. Any
 * literal in `errorKind:` position not in this set is reported as a
 * violation by the walker. `precondition` was added so RPC handlers can
 * throw `PreconditionError` and
 * the dispatcher classifies caller-state mismatches at warn-level
 * (errorKind: "precondition") rather than escalating to error/internal.
 * `sandbox_unavailable` covers the
 * fail-closed dynamic skill-validation path: no materializable bwrap jail
 * degrades to `static-only` coverage (honest degradation, NOT a fault) — it
 * must NOT inflate failure metrics (Defer ≠ Retry).
 */
const VALID_ERROR_KINDS: ReadonlySet<string> = new Set([
  "config",
  "network",
  "auth",
  "validation",
  "precondition",
  "timeout",
  "resource",
  "dependency",
  "internal",
  "platform",
  "sandbox_unavailable",
]);

/**
 * Per-file cache entry. Both `mtimeMs` AND `sha256` are checked at hit
 * time. The walker stores `line` / `character` / `literal` for each
 * violation; `snippet` is re-rendered from the live source on each run
 * (snippet is fresh each invocation, not cached).
 */
interface CacheEntry {
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly violations: ReadonlyArray<{
    readonly line: number;
    readonly character: number;
    readonly literal: string;
  }>;
}

/**
 * Cache file shape. `version: 1` is the schema-version field; mismatch (or
 * corrupted JSON) drops the cache and recomputes every entry — guards against
 * cache poisoning. Version 4 includes syntax-level literal checks so a type
 * assertion cannot disguise an off-union string.
 */
interface CacheFile {
  readonly version: 4;
  readonly entries: Record<string, CacheEntry>;
}

const CACHE_PATH = resolve(
  process.cwd(),
  "node_modules/.cache/architecture-walker/log-payload-checker.json",
);

let cache: CacheFile | null = null;

function loadCache(): CacheFile {
  if (cache) return cache;
  if (!existsSync(CACHE_PATH)) {
    cache = { version: 4, entries: {} };
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheFile;
    cache = raw.version === 4 ? raw : { version: 4, entries: {} };
  } catch {
    // Corrupted JSON or unreadable file — drop cache and recompute.
    cache = { version: 4, entries: {} };
  }
  return cache;
}

function saveCache(): void {
  if (!cache) return;
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  // Write-then-rename so concurrent vitest workers (especially across the
  // workspace's mixed `threads` + `forks` projects) cannot interleave a
  // partial-write that the next loadCache() then drops as corrupt JSON.
  // Same pattern as core/src/config/atomic-write-file.ts.
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, CACHE_PATH);
}

/**
 * Resets the in-memory cache singleton. Test-only — call from a `beforeEach`
 * (or the test's `clearCache()` helper) to make on-disk cache deletions
 * actually take effect. Without this, `loadCache()` short-circuits on the
 * still-populated module variable and tests pass vacuously.
 */
export function resetCacheForTest(): void {
  cache = null;
}

function fileHash(filePath: string): { mtimeMs: number; sha256: string } {
  const stat = statSync(filePath);
  const sha256 = createHash("sha256")
    .update(readFileSync(filePath))
    .digest("hex");
  return { mtimeMs: stat.mtimeMs, sha256 };
}

/**
 * One detected off-union `errorKind` literal in a logger payload.
 *
 * `file` is an absolute path; `line` and `character` are 1-indexed
 * (matching TypeScript diagnostic + editor cursor convention). `literal`
 * is the off-union value, OR the sentinel string `<unresolved type>` for
 * payloads where the TypeChecker resolved `errorKind` to the open
 * `string` type rather than a closed-union literal. `snippet` is a
 * 3-line context window around the offending line.
 */
export interface LogPayloadViolation {
  readonly file: string;
  readonly line: number;
  readonly character: number;
  readonly literal: string;
  readonly snippet: string;
}

function literalHiddenByAssertions(expression: ts.Expression): string | undefined {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isStringLiteralLike(current) ? current.text : undefined;
}

/**
 * Walk the given root files, build a single TS Program with the
 * TypeChecker, and report every WARN/ERROR/FATAL log-call whose payload's
 * `errorKind` resolves to a literal NOT in the closed 9-member union (or
 * to the open `string` type — also reported as `<unresolved type>`).
 *
 * Cache: per-file mtime+sha256 composite key. On hit, the walker
 * re-renders snippets from the live source but reuses the stored
 * `line` / `character` / `literal` triples. On miss (or first run) the
 * walker recomputes and writes the entry.
 */
export function checkLogPayloads(
  rootFiles: readonly string[],
  compilerOptions: ts.CompilerOptions = {},
): readonly LogPayloadViolation[] {
  const c = loadCache();
  const program = ts.createProgram({
    rootNames: [...rootFiles],
    options: {
      ...compilerOptions,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      // Allow walker to run on standalone fixture files that lack a
      // tsconfig.json — the walker only needs type resolution, not emit.
      allowJs: false,
    },
  });
  const checker = program.getTypeChecker();
  const violations: LogPayloadViolation[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    // Restrict to caller-supplied root files. ts.createProgram pulls in
    // every transitive dependency (including @types/node, vitest, etc.);
    // the walker only reports on the inputs the caller asked about.
    if (!rootFiles.includes(sourceFile.fileName)) continue;

    const fp = sourceFile.fileName;
    const { mtimeMs, sha256 } = fileHash(fp);
    const cached = c.entries[fp];
    if (cached && cached.mtimeMs === mtimeMs && cached.sha256 === sha256) {
      // Cache hit: reuse stored violations, re-render snippets from the
      // live source.
      for (const v of cached.violations) {
        violations.push({
          file: fp,
          line: v.line,
          character: v.character,
          literal: v.literal,
          snippet: extractSnippet(sourceFile, v.line),
        });
      }
      continue;
    }

    // Cache miss (or first invocation) — walk the AST.
    const fileViolations: Array<{
      line: number;
      character: number;
      literal: string;
    }> = [];
    const violationKeys = new Set<string>();

    const recordViolation = (node: ts.Node, literal: string): void => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const key = `${line}:${character}:${literal}`;
      if (violationKeys.has(key)) return;
      violationKeys.add(key);
      fileViolations.push({
        line: line + 1,
        character: character + 1,
        literal,
      });
    };

    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isCallExpression(node) && isLoggerWarnOrError(node)) {
        const payloadArg = node.arguments[0];
        if (payloadArg) {
          // Resolve the payload's type via the TypeChecker. This handles
          // object literals, variable references, `Object.assign({}, ...)`,
          // spread expressions, and member-access expressions uniformly.
          const payloadType = checker.getTypeAtLocation(payloadArg);
          const errorKindProp = payloadType.getProperty("errorKind");
          if (errorKindProp) {
            for (const declaration of errorKindProp.getDeclarations() ?? []) {
              if (!ts.isPropertyAssignment(declaration)) continue;
              const literal = literalHiddenByAssertions(declaration.initializer);
              if (literal !== undefined && !VALID_ERROR_KINDS.has(literal)) {
                recordViolation(declaration.initializer, literal);
              }
            }
            const errorKindType = checker.getTypeOfSymbolAtLocation(
              errorKindProp,
              payloadArg,
            );
            // errorKindType may be a single literal, a union of literals,
            // or the open `string` type. Iterate constituents uniformly.
            const constituents = errorKindType.isUnion()
              ? errorKindType.types
              : [errorKindType];
            for (const t of constituents) {
              if (t.isStringLiteral()) {
                if (!VALID_ERROR_KINDS.has(t.value)) {
                  recordViolation(payloadArg, t.value);
                }
              } else {
                // Open `string` (or any non-literal type) at this position
                // is itself a violation — the TypeChecker proved the value
                // is not narrowed to the closed union.
                recordViolation(payloadArg, "<unresolved type>");
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    });

    c.entries[fp] = {
      mtimeMs,
      sha256,
      violations: fileViolations.map((v) => ({
        line: v.line,
        character: v.character,
        literal: v.literal,
      })),
    };
    for (const v of fileViolations) {
      violations.push({
        file: fp,
        line: v.line,
        character: v.character,
        literal: v.literal,
        snippet: extractSnippet(sourceFile, v.line),
      });
    }
  }

  saveCache();
  return Object.freeze(violations.slice());
}

/**
 * Heuristic: a CallExpression is a logger warn/error/fatal call when its
 * callee is a property-access whose method name is `warn`, `error`, or
 * `fatal`. Matches `logger.warn(...)`, `deps.logger.error(...)`,
 * `getLogger("x").fatal(...)`, `child.warn(...)`, etc.
 */
function isLoggerWarnOrError(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const methodName = node.expression.name.text;
  return methodName === "warn" || methodName === "error" || methodName === "fatal";
}

/**
 * Render 3 lines of context around `line1Indexed` (line-1, line, line+1)
 * with each output line prefixed by its 1-indexed line number, matching
 * the snippet format used by the import-checker helper for visual parity
 * across the architecture suite.
 */
function extractSnippet(sf: ts.SourceFile, line1Indexed: number): string {
  const lines = sf.text.split(/\r?\n/);
  const out: string[] = [];
  for (let l = line1Indexed - 1; l <= line1Indexed + 1; l++) {
    if (l < 1 || l > lines.length) continue;
    out.push(`${l}: ${lines[l - 1]}`);
  }
  return out.join("\n");
}
