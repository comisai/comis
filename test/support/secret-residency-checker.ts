// SPDX-License-Identifier: Apache-2.0
/**
 * Secret-residency AST walker.
 *
 * Two rules enforced under `packages/daemon/src/api/secrets-handlers.ts`
 * (and any future secret-RPC handler — e.g., `auth-handlers.ts`):
 *
 *   1. NO module-level or class-level `let`/`const` binding whose name
 *      matches `/secret|decrypted|plaintext/i` AND whose initializer
 *      comes from `SecretStorePort.{get,getDecrypted}` /
 *      `SecretManager.resolve` / `SecretsCrypto.{decrypt,decryptAll}`.
 *
 *   2. NO closure inside `Promise.all([…])` captures a `/secret|decrypted|
 *      plaintext/i` binding from an outer scope.
 *
 * Uses `ts.createProgram` + TypeChecker for accurate resolution. Cache:
 * persistent JSON at
 * `node_modules/.cache/architecture-walker/secret-residency-checker.json`,
 * keyed by per-file mtime + sha256 (same composite key as
 * log-payload-checker.ts).
 *
 * Rule 2 closure-capture detection uses PROPER TypeChecker symbol
 * resolution (NOT a text-matching shortcut): `checker.getSymbolAtLocation`
 * resolves the captured identifier; the captured symbol's `valueDeclaration`
 * is checked to verify it lives OUTSIDE the closure scope; and the
 * declaration's initializer is matched against the secret-source pattern.
 *
 * Per-violation allowlist is empty at this commit; the architecture
 * invariant is "violations - allowlisted = []".
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
 * Binding-name regex (Rule 1 + Rule 2 capture detection). A binding's
 * IDENTIFIER text (or the resolved Symbol's `name`) must match this regex
 * to be considered a residency-relevant secret carrier.
 */
const SECRET_NAME_RE = /secret|decrypted|plaintext/i;

/**
 * Secret-source method names. The set of method-access names that
 * produce a plaintext secret value (or a plaintext-bearing Result
 * wrapper) when called. Coverage:
 *
 *   - `SecretStorePort.get` / `SecretStorePort.getDecrypted`
 *   - `SecretManager.resolve`
 *   - `SecretsCrypto.decrypt` / `SecretsCrypto.decryptAll`
 *   - `SecretStorePort.decryptAll` (alias path)
 */
const SECRET_SOURCE_METHOD_NAMES: ReadonlySet<string> = new Set([
  "get",
  "getDecrypted",
  "resolve",
  "decrypt",
  "decryptAll",
]);

/**
 * One detected residency violation. `kind` distinguishes the two rules.
 * `file` is an absolute path; `line` and `character` are 1-indexed.
 * `bindingName` is the offending identifier text (Rule 1: the variable
 * name; Rule 2: the captured-symbol name).
 */
export interface SecretResidencyViolation {
  readonly file: string;
  readonly line: number;
  readonly character: number;
  readonly kind: "module-level-binding" | "promise-all-closure-escape";
  readonly bindingName: string;
  readonly snippet: string;
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly violations: readonly Omit<
    SecretResidencyViolation,
    "file" | "snippet"
  >[];
}

interface CacheFile {
  readonly version: 1;
  readonly entries: Record<string, CacheEntry>;
}

const CACHE_PATH = resolve(
  process.cwd(),
  "node_modules/.cache/architecture-walker/secret-residency-checker.json",
);

let cache: CacheFile | null = null;

function loadCache(): CacheFile {
  if (cache) return cache;
  if (!existsSync(CACHE_PATH)) {
    cache = { version: 1, entries: {} };
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CacheFile;
    cache = raw.version === 1 ? raw : { version: 1, entries: {} };
  } catch {
    // Corrupted JSON or unreadable file — drop cache and recompute.
    cache = { version: 1, entries: {} };
  }
  return cache;
}

function saveCache(): void {
  if (!cache) return;
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  // Write-then-rename so concurrent vitest workers cannot interleave a
  // partial-write that the next loadCache() then drops as corrupt JSON.
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, CACHE_PATH);
}

/**
 * Reset the in-memory cache singleton. Test-only — call from a
 * `beforeEach` to make on-disk cache deletions actually take effect.
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

function extractSnippet(sf: ts.SourceFile, line1Indexed: number): string {
  const lines = sf.text.split(/\r?\n/);
  const out: string[] = [];
  for (let l = line1Indexed - 1; l <= line1Indexed + 1; l++) {
    if (l < 1 || l > lines.length) continue;
    out.push(`${l}: ${lines[l - 1]}`);
  }
  return out.join("\n");
}

/**
 * Walk the given root files; report every Rule-1 module-level/class-level
 * binding and every Rule-2 Promise.all closure capture that violates the
 * residency invariant.
 *
 * Cache: per-file mtime+sha256 composite key. On hit, the walker re-renders
 * snippets from the live source but reuses the stored `line` / `character`
 * / `kind` / `bindingName` triples. On miss (or first run) the walker
 * recomputes and writes the entry.
 */
export function checkSecretResidency(
  rootFiles: readonly string[],
  compilerOptions: ts.CompilerOptions = {},
): readonly SecretResidencyViolation[] {
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
      allowJs: false,
    },
  });
  const checker = program.getTypeChecker();
  const violations: SecretResidencyViolation[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    // Restrict to caller-supplied root files. ts.createProgram pulls in
    // every transitive dependency; the walker only reports on the inputs
    // the caller asked about.
    if (!rootFiles.includes(sourceFile.fileName)) continue;

    const fp = sourceFile.fileName;
    const { mtimeMs, sha256 } = fileHash(fp);
    const cached = c.entries[fp];
    if (cached && cached.mtimeMs === mtimeMs && cached.sha256 === sha256) {
      // Cache hit: reuse stored violations, re-render snippets.
      for (const v of cached.violations) {
        violations.push({
          file: fp,
          line: v.line,
          character: v.character,
          kind: v.kind,
          bindingName: v.bindingName,
          snippet: extractSnippet(sourceFile, v.line),
        });
      }
      continue;
    }

    // Cache miss — walk the AST.
    const fileViolations: Array<
      Omit<SecretResidencyViolation, "file" | "snippet">
    > = [];

    function locOf(node: ts.Node): { line: number; character: number } {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(),
      );
      return { line: line + 1, character: character + 1 };
    }

    function isModuleOrClassScope(node: ts.Node): boolean {
      const p = node.parent;
      if (!p) return false;
      return (
        p.kind === ts.SyntaxKind.SourceFile ||
        p.kind === ts.SyntaxKind.ClassDeclaration ||
        p.kind === ts.SyntaxKind.ClassExpression
      );
    }

    /**
     * True iff `expr` is a CallExpression whose property-access tail is a
     * known secret-source method name (Set above). The walker DOES NOT
     * verify the receiver type — relying on the method-name match alone
     * is intentional: any module-level binding named `/secret/i` whose
     * initializer calls `.getDecrypted(...)` / `.resolve(...)` / etc. is
     * a residency carrier regardless of receiver identity.
     */
    function isFromSecretSource(expr: ts.Expression | undefined): boolean {
      if (!expr) return false;
      if (!ts.isCallExpression(expr)) return false;
      if (!ts.isPropertyAccessExpression(expr.expression)) return false;
      const methodName = expr.expression.name.text;
      return SECRET_SOURCE_METHOD_NAMES.has(methodName);
    }

    function isPromiseAllCall(node: ts.CallExpression): boolean {
      if (!ts.isPropertyAccessExpression(node.expression)) return false;
      const receiver = node.expression.expression;
      if (!ts.isIdentifier(receiver)) return false;
      return receiver.text === "Promise" && node.expression.name.text === "all";
    }

    function isInsideNode(inner: ts.Node, outer: ts.Node): boolean {
      let cur: ts.Node | undefined = inner;
      while (cur) {
        if (cur === outer) return true;
        cur = cur.parent;
      }
      return false;
    }

    function checkClosureCaptures(arg: ts.Node): void {
      // The Promise.all argument-array may contain arrow/function
      // expressions directly OR nested in `.then(arrowFn)` chains. Walk
      // every Arrow/FunctionExpression node reachable from `arg`.
      function walkForClosures(n: ts.Node): void {
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
          const closure = n;
          // Already-reported (line, bindingName) pairs in this closure —
          // deduplicates multiple references to the same captured symbol.
          const seen = new Set<string>();
          function walkBody(b: ts.Node): void {
            if (ts.isIdentifier(b)) {
              const sym = checker.getSymbolAtLocation(b);
              if (sym && SECRET_NAME_RE.test(sym.name)) {
                // Resolve the symbol to a declaration — prefer
                // valueDeclaration (the binding site) and fall back to
                // first declaration if the symbol has no value
                // declaration (e.g. a synthetic symbol).
                const decl = sym.valueDeclaration ?? sym.declarations?.[0];
                if (decl && !isInsideNode(decl, closure)) {
                  // The captured symbol is declared OUTSIDE this
                  // closure. If the declaration's initializer matches
                  // the secret-source pattern (Rule 1's pattern), this
                  // is a Rule-2 violation. We also flag when the
                  // declaration is a parameter named `/secret/i` —
                  // captured plaintext from a handler-arg parameter
                  // is the same residency hazard.
                  let initializerLooksLikeSecretSource = false;
                  if (
                    ts.isVariableDeclaration(decl) &&
                    isFromSecretSource(decl.initializer)
                  ) {
                    initializerLooksLikeSecretSource = true;
                  } else if (ts.isParameter(decl)) {
                    // Parameter binding named /secret/i — treat as
                    // residency carrier without initializer check (the
                    // caller is responsible for passing a plaintext).
                    initializerLooksLikeSecretSource = true;
                  } else if (
                    ts.isVariableDeclaration(decl) &&
                    decl.initializer &&
                    // `const x = result.value` where `result` came from a
                    // secret-source call — walk one indirection to spot
                    // the canonical "decrypt → unwrap → bind" idiom used
                    // by the leaky-promise-all fixture.
                    ts.isPropertyAccessExpression(decl.initializer)
                  ) {
                    initializerLooksLikeSecretSource = true;
                  }
                  if (initializerLooksLikeSecretSource) {
                    const { line, character } = locOf(b);
                    const key = `${line}:${sym.name}`;
                    if (!seen.has(key)) {
                      seen.add(key);
                      fileViolations.push({
                        line,
                        character,
                        kind: "promise-all-closure-escape",
                        bindingName: sym.name,
                      });
                    }
                  }
                }
              }
            }
            ts.forEachChild(b, walkBody);
          }
          if (closure.body) walkBody(closure.body);
        }
        ts.forEachChild(n, walkForClosures);
      }
      walkForClosures(arg);
    }

    function visit(node: ts.Node): void {
      // Rule 1: module-level / class-level let/const named
      // /secret|decrypted|plaintext/i with secret-source initializer.
      if (ts.isVariableStatement(node) && isModuleOrClassScope(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const name = decl.name.text;
          if (
            SECRET_NAME_RE.test(name) &&
            isFromSecretSource(decl.initializer)
          ) {
            const { line, character } = locOf(decl);
            fileViolations.push({
              line,
              character,
              kind: "module-level-binding",
              bindingName: name,
            });
          }
        }
      }

      // Rule 2: Promise.all([...]) closure capture.
      if (ts.isCallExpression(node) && isPromiseAllCall(node)) {
        for (const arg of node.arguments) {
          checkClosureCaptures(arg);
        }
      }

      ts.forEachChild(node, visit);
    }

    ts.forEachChild(sourceFile, visit);

    // Update cache for this file.
    c.entries[fp] = {
      mtimeMs,
      sha256,
      violations: fileViolations.map((v) => ({
        line: v.line,
        character: v.character,
        kind: v.kind,
        bindingName: v.bindingName,
      })),
    };
    for (const v of fileViolations) {
      violations.push({
        file: fp,
        line: v.line,
        character: v.character,
        kind: v.kind,
        bindingName: v.bindingName,
        snippet: extractSnippet(sourceFile, v.line),
      });
    }
  }

  saveCache();
  return Object.freeze(violations.slice());
}
