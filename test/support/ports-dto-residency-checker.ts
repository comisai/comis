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
 * Walk each context-store port interface in `contextStorePaths` (accepts a
 * single string or an array of paths) and return any Ctx*Row type names that
 * are referenced transitively from method signatures (parameters and return
 * types) but NOT exported from `typesPath` as `export interface <Name> { ... }`.
 *
 * Phase 60-02 (REFACTOR-04) split the original 38-method `ContextStorePort`
 * interface into two narrower interfaces — `ContextEngineStore` (34 methods)
 * in `context-engine-store.ts` and `ContextAdminStore` (4 methods) in
 * `context-admin-store.ts`. `ContextStorePort` itself is now a type alias
 * (`type ContextStorePort = ContextEngineStore & ContextAdminStore`). The
 * walker accepts a list of port files + a list of interface names so it
 * can union the Ctx*Row references across the split.
 *
 * Throws if the walker collects zero Ctx*Row names across all port files —
 * the combined Engine + Admin surface has 38 methods and at least 7 row
 * types are guaranteed to appear; zero means the walker is broken, not
 * that the port is empty.
 *
 * Backward-compatible call shape: passing a single string + single
 * interface name preserves the original behavior.
 */
export function checkContextStoreRowResidency(
  contextStorePaths: string | readonly string[],
  typesPath: string,
  portInterfaceNames: string | readonly string[] = "ContextStorePort",
  compilerOptions: ts.CompilerOptions = {},
): readonly PortsDtoResidencyViolation[] {
  const portPathList = typeof contextStorePaths === "string"
    ? [contextStorePaths]
    : [...contextStorePaths];
  const interfaceNameList = typeof portInterfaceNames === "string"
    ? [portInterfaceNames]
    : [...portInterfaceNames];

  const c = loadCache();
  const compositeKey = `${portPathList.join("|")}::${typesPath}::${interfaceNameList.join(",")}`;

  // Composite cache key — every port file and the types file must be unchanged to hit.
  const portKeys = portPathList.map((p) => fileHash(p));
  const typesKey = fileHash(typesPath);
  const composite = createHash("sha256")
    .update([...portKeys.map((k) => k.sha256), typesKey.sha256].join(":"))
    .digest("hex");
  const mtimeSum = portKeys.reduce((sum, k) => sum + k.mtimeMs, 0) + typesKey.mtimeMs;

  const cached = c.entries[compositeKey];
  if (
    cached &&
    cached.mtimeSum === mtimeSum &&
    cached.composite === composite
  ) {
    return Object.freeze(cached.violations.slice());
  }

  const program = ts.createProgram({
    rootNames: [...portPathList, typesPath],
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

  const typesSource = program.getSourceFile(typesPath);
  if (!typesSource) {
    throw new Error(
      `ports-dto-residency-checker: could not load types source file (${typesPath})`,
    );
  }

  // Step 1 — for each port file, find one of the requested interface
  // declarations. A missing interface in any one port file is allowed (the
  // split places different interfaces in different files); a port file with
  // none of the requested interfaces is a misconfiguration.
  const portInterfaces: Array<{ source: ts.SourceFile; iface: ts.InterfaceDeclaration }> = [];
  for (const portPath of portPathList) {
    const portSource = program.getSourceFile(portPath);
    if (!portSource) {
      throw new Error(
        `ports-dto-residency-checker: could not load port source file (${portPath})`,
      );
    }
    let found: ts.InterfaceDeclaration | undefined;
    ts.forEachChild(portSource, (node) => {
      if (
        ts.isInterfaceDeclaration(node) &&
        interfaceNameList.includes(node.name.text)
      ) {
        found = node;
      }
    });
    if (found) {
      portInterfaces.push({ source: portSource, iface: found });
    }
  }
  if (portInterfaces.length === 0) {
    throw new Error(
      `ports-dto-residency-checker: none of the requested interfaces [${interfaceNameList.join(", ")}] found across port files [${portPathList.join(", ")}]`,
    );
  }

  // Step 2 — collect every Ctx*Row name referenced transitively from method
  // signatures (parameters and return types) across all port interfaces.
  // Recursion follows TypeChecker resolution through imports / aliases /
  // nested member types.
  const collectedRowNames = new Set<string>();
  const visitedTypeSymbols = new Set<ts.Symbol>();

  function recordIfCtxRow(name: string): void {
    if (CTX_ROW_RE.test(name)) collectedRowNames.add(name);
  }

  function walkTypeNode(typeNode: ts.TypeNode | undefined, source: ts.SourceFile): void {
    if (!typeNode) return;
    if (ts.isTypeReferenceNode(typeNode)) {
      const typeNameText = typeNode.typeName.getText(source);
      recordIfCtxRow(typeNameText);

      const type = checker.getTypeFromTypeNode(typeNode);
      const sym = type.aliasSymbol ?? type.symbol;
      if (sym && !visitedTypeSymbols.has(sym)) {
        visitedTypeSymbols.add(sym);
        recordIfCtxRow(sym.name);
        for (const decl of sym.declarations ?? []) {
          if (ts.isInterfaceDeclaration(decl)) {
            const declSource = decl.getSourceFile();
            for (const member of decl.members) {
              if (ts.isPropertySignature(member)) walkTypeNode(member.type, declSource);
              if (ts.isMethodSignature(member)) {
                for (const param of member.parameters) walkTypeNode(param.type, declSource);
                walkTypeNode(member.type, declSource);
              }
            }
          }
        }
      }
      for (const arg of typeNode.typeArguments ?? []) walkTypeNode(arg, source);
    }
    ts.forEachChild(typeNode, (child) => {
      if (ts.isTypeNode(child as ts.TypeNode)) {
        walkTypeNode(child as ts.TypeNode, source);
      }
    });
  }

  for (const { source, iface } of portInterfaces) {
    for (const member of iface.members) {
      if (ts.isMethodSignature(member)) {
        for (const param of member.parameters) walkTypeNode(param.type, source);
        walkTypeNode(member.type, source);
      }
    }
  }

  if (collectedRowNames.size === 0) {
    throw new Error(
      `ports-dto-residency-checker: walker found 0 Ctx*Row names referenced from [${interfaceNameList.join(", ")}] across [${portPathList.join(", ")}] — this is a walker bug (the combined port surface has 38 methods and at least 7 row types should appear). Verify the TypeChecker resolution.`,
    );
  }

  // Step 3 — verify each collected name is exported from typesPath.
  const violations: PortsDtoResidencyViolation[] = [];
  const typesText = typesSource.getText();
  for (const name of collectedRowNames) {
    const exportRe = new RegExp(`export\\s+interface\\s+${name}\\b`);
    if (!exportRe.test(typesText)) {
      // Find a location in any port source that mentions this name.
      let line = 1;
      let character = 1;
      let snippet = `<${name}>`;
      let locatedFile = portPathList[0] ?? "<unknown>";
      for (const { source } of portInterfaces) {
        let done = false;
        ts.forEachChild(source, function walk(node) {
          if (done) return;
          if (
            ts.isTypeReferenceNode(node) &&
            node.typeName.getText(source) === name
          ) {
            const pos = source.getLineAndCharacterOfPosition(node.getStart());
            line = pos.line + 1;
            character = pos.character + 1;
            snippet = node.getText(source).slice(0, 120);
            locatedFile = source.fileName;
            done = true;
            return;
          }
          ts.forEachChild(node, walk);
        });
        if (done) break;
      }
      violations.push({
        file: locatedFile,
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
