// SPDX-License-Identifier: Apache-2.0
/**
 * Callable-global classifier.
 *
 * Walks every caller-supplied production .ts file as part of a single
 * `ts.createProgram` so the TypeChecker can resolve `.unref()` /
 * `.cancel()` / `.ref()` method-call receivers to `TimerHandle` /
 * `NodeJS.Timeout` / `NodeJS.Immediate` (exempt from the
 * forbidden-global gate).
 *
 * Classification: walks every CallExpression / NewExpression /
 * PropertyAccessExpression / ElementAccessExpression and matches:
 *   - `Date.now()`              — CallExpression(PropAccess(Date, now))
 *   - `new Date(...)`           — NewExpression(Id(Date))
 *   - `process.env[X]` / `.X`   — PropAccess/ElemAccess on process.env
 *   - `setTimeout(...)`         — CallExpression(Id(setTimeout))
 *   - `setInterval(...)`        — same shape
 *   - `clearTimeout(...)`       — same shape
 *   - `clearInterval(...)`      — same shape
 *
 * Bootstrap-path exemption: files matching any pattern in
 * `BOOTSTRAP_PATH_PATTERNS` are skipped before classification.
 *
 * TimerHandle/NodeJS.Timeout exemption: a CallExpression of the form
 * `<receiver>.unref()` / `.cancel()` / `.ref()` is skipped when the
 * receiver type resolves to `TimerHandle` / `Timeout` / `Immediate`
 * via `ts.TypeChecker.getTypeAtLocation(...)`.
 *
 * Cache: persistent JSON at
 * `node_modules/.cache/architecture-walker/globals-classifier.json`.
 * mtime+sha256 composite key per file; schema-version: 1 (bump on
 * rule-semantics change).
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
 * The 7 callable-global patterns the classifier flags. Matches the
 * `GlobalsAllowlistEntry.global` union in test/support/architecture-allowlist.ts.
 */
export type GlobalPattern =
  | "Date.now"
  | "new Date"
  | "process.env"
  | "setTimeout"
  | "setInterval"
  | "clearTimeout"
  | "clearInterval";

/**
 * One classifier violation. `line` and `character` are 1-indexed.
 * `snippet` is rendered from the live source file (not cached).
 */
export interface GlobalsViolation {
  readonly file: string;
  readonly line: number;
  readonly character: number;
  readonly pattern: GlobalPattern;
  readonly snippet: string;
}

/**
 * Bootstrap-path exemption regex set (sanctioned bootstrap entry-point paths).
 * Notes:
 *   - `packages/shared/src/runtime/` does NOT exist on disk.
 *   - `packages/core/src/env-layer.ts` does NOT exist (actual path is
 *     `packages/core/src/config/env-layer.ts`).
 *
 * If a future change adds `packages/shared/src/runtime/`, this regex set
 * extends — no preemptive entries for directories that don't exist.
 */
const BOOTSTRAP_PATH_PATTERNS: readonly RegExp[] = [
  /packages\/daemon\/src\/daemon\.ts$/,
  /packages\/cli\/src\/cli\.ts$/,
  /packages\/cli\/src\/index\.ts$/,
  /packages\/cli\/src\/commands\/[^/]+\.ts$/,
  /packages\/(core|infra)\/src\/runtime\//,
  /packages\/core\/src\/load-env\.ts$/,
  /packages\/core\/src\/config\/env-layer\.ts$/,
  // The supervised Terminal Worker PROCESS entry (spec §1.1/§2.1): the daemon
  // forks `node terminal-worker-main.js`, so this file OWNS the process boundary
  // — it adapts process.stdin (the §2.3 IPC), process.env (config the daemon
  // threads), and process.exit (lifecycle on parent-stdin-close) into the worker.
  // Exactly the daemon.ts/cli.ts bootstrap role; the worker LOGIC stays port-based
  // (createTerminalWorker takes injected clock/env/fs).
  /packages\/skills\/src\/tools\/builtin\/terminal-driver\/terminal-worker-main\.ts$/,
  // The in-jail egress relay-as-init PROCESS entry (spec §3.5): run as
  // `node egress-relay-init.js --socket … -- child` as PID-1 inside the bwrap
  // jail. It owns process.argv/env/exit (parse args, set the child's HTTPS_PROXY,
  // exec the child) — the bootstrap role, like terminal-worker-main.ts. The
  // top-level main() is guarded to run ONLY as the entry script (importable in tests).
  /packages\/skills\/src\/tools\/builtin\/terminal-driver\/egress-relay-init\.ts$/,
  /packages\/[^/]+\/src\/__tests__\//,
  /test\//,
] as const;

function isBootstrapPath(file: string): boolean {
  return BOOTSTRAP_PATH_PATTERNS.some((re) => re.test(file));
}

interface CachedViolation {
  readonly line: number;
  readonly character: number;
  readonly pattern: GlobalPattern;
}

interface CacheEntry {
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly violations: ReadonlyArray<CachedViolation>;
}

/**
 * Cache file shape. `version: 1` is the schema-version field; mismatch
 * (or corrupted JSON) drops the cache and recomputes — cache-poisoning
 * mitigation. Bump to 2 when rule semantics change.
 */
interface CacheFile {
  readonly version: 1;
  readonly entries: Record<string, CacheEntry>;
}

const CACHE_PATH = resolve(
  process.cwd(),
  "node_modules/.cache/architecture-walker/globals-classifier.json",
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
    cache = { version: 1, entries: {} };
  }
  return cache;
}

function saveCache(): void {
  if (!cache) return;
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  // Atomic write-then-rename — concurrent vitest workers cannot
  // interleave partial writes (same pattern as log-payload-checker.ts).
  const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, CACHE_PATH);
}

/**
 * Reset the in-memory cache singleton — test-only. Without this, the
 * fixture-driven sub-tests would see stale violations from a previous
 * production scan.
 */
export function resetCacheForTest(): void {
  cache = null;
}

function fileHash(filePath: string): {
  readonly mtimeMs: number;
  readonly sha256: string;
} {
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
    out.push(`${l}: ${lines[l - 1] ?? ""}`);
  }
  return out.join("\n");
}

/**
 * True if `node` is a CallExpression like `receiver.unref()` /
 * `.cancel()` / `.ref()` where the receiver type resolves to
 * `TimerHandle` (the port), `Timeout` (NodeJS.Timeout), or
 * `Immediate` (NodeJS.Immediate).
 *
 * The check matches by symbol name, so adding a new TimerHandle-shaped
 * type (or introducing TimerHandle itself in a later refactor) extends
 * the exemption automatically without code changes here.
 */
function isTimerHandleMethodCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const methodName = node.expression.name.text;
  if (methodName !== "unref" && methodName !== "cancel" && methodName !== "ref") {
    return false;
  }
  const receiverType = checker.getTypeAtLocation(node.expression.expression);
  const symbol = receiverType.getSymbol();
  if (!symbol) return false;
  const name = symbol.getName();
  return name === "TimerHandle" || name === "Timeout" || name === "Immediate";
}

/**
 * Pattern-match a single expression node and return its GlobalPattern
 * (if it's a callable-global) or null.
 */
function classifyNode(
  node: ts.Node,
  checker: ts.TypeChecker,
): GlobalPattern | null {
  // CallExpression: Date.now(), setTimeout(...), etc.
  if (ts.isCallExpression(node)) {
    if (isTimerHandleMethodCall(node, checker)) return null;
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      if (callee.text === "setTimeout") return "setTimeout";
      if (callee.text === "setInterval") return "setInterval";
      if (callee.text === "clearTimeout") return "clearTimeout";
      if (callee.text === "clearInterval") return "clearInterval";
    }
    if (ts.isPropertyAccessExpression(callee)) {
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Date" &&
        callee.name.text === "now"
      ) {
        return "Date.now";
      }
    }
    return null;
  }
  // NewExpression: new Date(...)
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date"
  ) {
    return "new Date";
  }
  // PropertyAccess on `process.env` itself (the 2-level shape).
  // This catches:
  //   - bare `process.env`                  (e.g. `options.env ?? process.env`)
  //   - `process.env.NODE_ENV`              (the outer PropAccess wraps this one)
  //   - `process.env["HOME"]`               (the outer ElemAccess wraps this one)
  //   - `process.env.X = "..."`             (LHS of assignment — same inner PropAccess)
  // process.env mutation IS flagged (both read and write are forbidden outside
  // sanctioned paths). Flagging at the inner `process.env`
  // node dedupes naturally — the outer PropAccess / ElemAccess /
  // AssignmentExpression isn't itself flagged because its `node.expression`
  // is the inner `process.env` PropAccess, not a `process` Identifier.
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env"
  ) {
    return "process.env";
  }
  return null;
}

/**
 * Optional knobs for `classifyGlobals`.
 *
 * `respectBootstrapPaths` (default `true`) — apply the
 * `BOOTSTRAP_PATH_PATTERNS` exemption (skip files under
 * `test/`, `packages/(core|infra)/src/runtime/`, etc.). Fixture
 * validation passes `false` so the classifier processes the
 * fixture file (which physically lives under `test/`) without the
 * skip. Production scans use the default `true`.
 */
export interface ClassifyGlobalsOptions {
  readonly compilerOptions?: ts.CompilerOptions;
  readonly respectBootstrapPaths?: boolean;
}

/**
 * Classify callable-global expressions in every file from `rootFiles`.
 *
 * Builds a single `ts.createProgram` so the TypeChecker can resolve
 * cross-file types (TimerHandle, NodeJS.Timeout from @types/node, etc).
 * Uses persistent mtime+sha256 cache keyed on file content; cache hit
 * re-renders snippets from live source.
 *
 * Bootstrap-path-matching files are skipped BEFORE classification
 * (controlled by `options.respectBootstrapPaths`, default `true`).
 */
export function classifyGlobals(
  rootFiles: readonly string[],
  options: ClassifyGlobalsOptions = {},
): readonly GlobalsViolation[] {
  const respectBootstrapPaths = options.respectBootstrapPaths ?? true;
  const compilerOptions = options.compilerOptions ?? {};
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
  const violations: GlobalsViolation[] = [];
  const rootFilesSet = new Set(rootFiles.map((f) => resolve(f)));

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const fp = sourceFile.fileName;
    // Restrict to caller-supplied roots — ts.createProgram pulls in every
    // transitive dep including @types/node, vitest, etc. Use a resolved
    // absolute-path Set so the caller's input (possibly relative) and the
    // Program's `fileName` (always absolute) compare correctly.
    if (!rootFilesSet.has(resolve(fp))) continue;

    // Bootstrap-path exemption: skip the whole file before classification.
    // Disabled when fixture validation explicitly opts out so test/
    // fixtures (which physically live under test/) classify as
    // production-shaped source.
    if (respectBootstrapPaths && isBootstrapPath(fp)) continue;

    const { mtimeMs, sha256 } = fileHash(fp);
    const cached = c.entries[fp];
    if (cached && cached.mtimeMs === mtimeMs && cached.sha256 === sha256) {
      for (const v of cached.violations) {
        violations.push({
          file: fp,
          line: v.line,
          character: v.character,
          pattern: v.pattern,
          snippet: extractSnippet(sourceFile, v.line),
        });
      }
      continue;
    }

    // Cache miss — walk AST.
    const fileViolations: CachedViolation[] = [];
    const visit = (node: ts.Node): void => {
      const pattern = classifyNode(node, checker);
      if (pattern !== null) {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        fileViolations.push({
          line: pos.line + 1,
          character: pos.character + 1,
          pattern,
        });
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);

    c.entries[fp] = { mtimeMs, sha256, violations: fileViolations };
    for (const v of fileViolations) {
      violations.push({
        file: fp,
        line: v.line,
        character: v.character,
        pattern: v.pattern,
        snippet: extractSnippet(sourceFile, v.line),
      });
    }
  }

  saveCache();
  return Object.freeze(violations.slice());
}
