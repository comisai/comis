// SPDX-License-Identifier: Apache-2.0
/**
 * Ports-DTO residency walker (primary check).
 *
 * Walks the ContextStorePort interface declaration's method signatures via
 * the TypeScript Compiler API + TypeChecker, enumerates every Ctx*Row type
 * referenced transitively from method parameters / return types, and
 * asserts each one is exported from context-store-types.ts.
 *
 * This is the PRIMARY check. A complementary text-level regex check lives
 * in packages/core/src/__tests__/architecture.test.ts and additionally
 * covers Ctx*Row mentions in comments / non-method positions in
 * context-store.ts.
 *
 * Pattern mirrors test/support/log-payload-checker.ts. Cache: persistent
 * JSON at node_modules/.cache/architecture-walker/
 * ports-dto-residency-checker.json keyed by per-file mtime + sha256.
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

const CTX_ROW_RE = /^Ctx[A-Z][A-Za-z]+Row$/;

/**
 * One detected Ctx*Row that is referenced from a ContextStorePort method
 * signature but NOT exported from the sibling context-store-types.ts file.
 */
export interface PortsDtoResidencyViolation {
  readonly file: string;
  readonly line: number;
  readonly character: number;
  readonly bindingName: string;
  readonly kind: "missing-export";
  readonly snippet: string;
}

interface CacheEntry {
  readonly mtimeSum: number;
  readonly composite: string;
  readonly violations: ReadonlyArray<{
    readonly file: string;
    readonly line: number;
    readonly character: number;
    readonly bindingName: string;
    readonly kind: "missing-export";
    readonly snippet: string;
  }>;
  readonly collectedNames: ReadonlyArray<string>;
}

interface CacheFile {
  readonly version: 1;
  readonly entries: Record<string, CacheEntry>;
}

const CACHE_PATH = resolve(
  process.cwd(),
  "node_modules/.cache/architecture-walker/ports-dto-residency-checker.json",
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
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
    renameSync(tmp, CACHE_PATH);
  } catch {
    // best-effort persistence; loss of cache only triggers recompute
  }
}

/**
 * Resets the in-memory cache singleton. Test-only — call from a beforeEach
 * to make on-disk cache deletions actually take effect.
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
 * Walk the ContextStorePort interface in `contextStorePath` and return any
 * Ctx*Row type names that are referenced transitively from its method
 * signatures (parameters and return types) but NOT exported from
 * `typesPath` as `export interface <Name> { ... }`.
 *
 * Throws if the walker collects zero Ctx*Row names — the ContextStorePort
 * has 38 methods and at least 7 row types are guaranteed to appear; zero
 * means the walker is broken, not that the port is empty.
 */
export function checkContextStoreRowResidency(
  contextStorePath: string,
  typesPath: string,
  portInterfaceName = "ContextStorePort",
  compilerOptions: ts.CompilerOptions = {},
): readonly PortsDtoResidencyViolation[] {
  const c = loadCache();
  const compositeKey = `${contextStorePath}::${typesPath}::${portInterfaceName}`;

  // Composite cache key — both files must be unchanged to hit.
  const portKey = fileHash(contextStorePath);
  const typesKey = fileHash(typesPath);
  const composite = createHash("sha256")
    .update(portKey.sha256 + typesKey.sha256)
    .digest("hex");
  const mtimeSum = portKey.mtimeMs + typesKey.mtimeMs;

  const cached = c.entries[compositeKey];
  if (
    cached &&
    cached.mtimeSum === mtimeSum &&
    cached.composite === composite
  ) {
    return Object.freeze(cached.violations.slice());
  }

  const program = ts.createProgram({
    rootNames: [contextStorePath, typesPath],
    options: {
      ...compilerOptions,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
    },
  });
  const checker = program.getTypeChecker();

  const portSource = program.getSourceFile(contextStorePath);
  const typesSource = program.getSourceFile(typesPath);
  if (!portSource || !typesSource) {
    throw new Error(
      `ports-dto-residency-checker: could not load source files (${contextStorePath} / ${typesPath})`,
    );
  }

  // Step 1 — find the ContextStorePort interface declaration.
  let portInterface: ts.InterfaceDeclaration | undefined;
  ts.forEachChild(portSource, (node) => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === portInterfaceName
    ) {
      portInterface = node;
    }
  });
  if (!portInterface) {
    throw new Error(
      `ports-dto-residency-checker: ${portInterfaceName} interface not found in ${contextStorePath}`,
    );
  }

  // Step 2 — collect every Ctx*Row name referenced transitively from method
  // signatures (parameters and return types). Recursion follows TypeChecker
  // resolution through imports / aliases / nested member types.
  const collectedRowNames = new Set<string>();
  const visitedTypeSymbols = new Set<ts.Symbol>();

  function recordIfCtxRow(name: string): void {
    if (CTX_ROW_RE.test(name)) collectedRowNames.add(name);
  }

  function walkTypeNode(typeNode: ts.TypeNode | undefined): void {
    if (!typeNode) return;
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeNameText = typeNode.typeName.getText(portSource);
      recordIfCtxRow(typeNameText);

      const type = checker.getTypeFromTypeNode(typeNode);
      const sym = type.aliasSymbol ?? type.symbol;
      if (sym && !visitedTypeSymbols.has(sym)) {
        visitedTypeSymbols.add(sym);
        recordIfCtxRow(sym.name);
        for (const decl of sym.declarations ?? []) {
          if (ts.isInterfaceDeclaration(decl)) {
            for (const member of decl.members) {
              if (ts.isPropertySignature(member)) walkTypeNode(member.type);
              if (ts.isMethodSignature(member)) {
                for (const param of member.parameters) walkTypeNode(param.type);
                walkTypeNode(member.type);
              }
            }
          }
        }
      }
      for (const arg of typeNode.typeArguments ?? []) walkTypeNode(arg);
    }
    ts.forEachChild(typeNode, (child) => {
      if (ts.isTypeNode(child as ts.TypeNode)) {
        walkTypeNode(child as ts.TypeNode);
      }
    });
  }

  for (const member of portInterface.members) {
    if (ts.isMethodSignature(member)) {
      for (const param of member.parameters) walkTypeNode(param.type);
      walkTypeNode(member.type);
    }
  }

  if (collectedRowNames.size === 0) {
    throw new Error(
      `ports-dto-residency-checker: walker found 0 Ctx*Row names referenced from ${portInterfaceName} — this is a walker bug (the port has 38 methods and at least 7 row types should appear). Verify the TypeChecker resolution.`,
    );
  }

  // Step 3 — verify each collected name is exported from typesPath.
  const violations: PortsDtoResidencyViolation[] = [];
  const typesText = typesSource.getText();
  for (const name of collectedRowNames) {
    const exportRe = new RegExp(`export\\s+interface\\s+${name}\\b`);
    if (!exportRe.test(typesText)) {
      // Find a location in the port source that mentions this name.
      let line = 1;
      let character = 1;
      let snippet = `<${name}>`;
      ts.forEachChild(portSource, function walk(node) {
        if (
          ts.isTypeReferenceNode(node) &&
          node.typeName.getText(portSource) === name
        ) {
          const pos = portSource.getLineAndCharacterOfPosition(node.getStart());
          line = pos.line + 1;
          character = pos.character + 1;
          snippet = node.getText(portSource).slice(0, 120);
          return;
        }
        ts.forEachChild(node, walk);
      });
      violations.push({
        file: contextStorePath,
        line,
        character,
        bindingName: name,
        kind: "missing-export",
        snippet,
      });
    }
  }

  c.entries[compositeKey] = {
    mtimeSum,
    composite,
    violations,
    collectedNames: [...collectedRowNames],
  };
  saveCache();

  return Object.freeze(violations.slice());
}
