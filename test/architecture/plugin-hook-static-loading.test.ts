// SPDX-License-Identifier: Apache-2.0
/** Plugin and hook extension points accept constructed ports, never code locations. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const HOOKS_ROOT = resolve(REPO_ROOT, "packages/core/src/hooks");

const EXTENSION_BOUNDARY_FILES = [
  "packages/core/src/bootstrap.ts",
  "packages/core/src/ports/channel-plugin.ts",
  "packages/core/src/ports/hook-types.ts",
  "packages/core/src/ports/plugin.ts",
  "packages/channels/src/shared/channel-registry.ts",
  "packages/daemon/src/wiring/setup-delivery.ts",
] as const;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly construct: string;
}

function hookSourceFiles(): string[] {
  return readdirSync(HOOKS_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => resolve(HOOKS_ROOT, entry.name));
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function findDynamicLoading(file: string): Violation[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true);
  const violations: Violation[] = [];
  const rel = relative(REPO_ROOT, file);

  function record(node: ts.Node, construct: string): void {
    violations.push({ file: rel, line: lineOf(sourceFile, node), construct });
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) record(node, "dynamic import");
      if (
        ts.isIdentifier(node.expression) &&
        ["Function", "createRequire", "eval", "require"].includes(node.expression.text)
      ) {
        record(node, `${node.expression.text}()`);
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Function"
    ) {
      record(node, "new Function()");
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ["node:module", "node:vm"].includes(node.moduleSpecifier.text)
    ) {
      record(node, `import ${node.moduleSpecifier.text}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe("plugin and hook static loading boundary", () => {
  it("contains no runtime code-loading primitive in an extension path", () => {
    const files = [
      ...hookSourceFiles(),
      ...EXTENSION_BOUNDARY_FILES.map((path) => resolve(REPO_ROOT, path)),
    ];
    const violations = files.flatMap(findDynamicLoading);

    expect(violations).toEqual([]);
  });

  it("registers constructed plugin ports through the composition root", () => {
    const registry = readFileSync(
      resolve(REPO_ROOT, "packages/core/src/hooks/plugin-registry.ts"),
      "utf8",
    );
    const bootstrap = readFileSync(resolve(REPO_ROOT, "packages/core/src/bootstrap.ts"), "utf8");

    expect(registry).toContain("register(plugin: PluginPort)");
    expect(bootstrap).toContain("const pluginRegistry = createPluginRegistry()");
  });
});
