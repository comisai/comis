// SPDX-License-Identifier: Apache-2.0
/** Web RPC dispatch stays generated, typed, and literal at every call site. */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const WEB_SRC = resolve(REPO_ROOT, "packages/web/src");
const GENERATED_JSON = resolve(WEB_SRC, "api/contracts.generated.json");

function sourceFiles(path: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (
      entry.isFile()
      && entry.name.endsWith(".ts")
      && !entry.name.endsWith(".test.ts")
      && entry.name !== "contracts.generated.ts"
    ) {
      files.push(full);
    }
  }
  return files;
}

describe("web RPC generated method boundary", () => {
  it("web sources dispatch only literal methods present in the generated map", () => {
    const generated = JSON.parse(readFileSync(GENERATED_JSON, "utf8")) as Record<string, unknown>;
    const methods = new Set(Object.keys(generated));
    const violations: string[] = [];

    for (const file of sourceFiles(WEB_SRC)) {
      const source = readFileSync(file, "utf8");
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "call"
          && /rpc/iu.test(node.expression.expression.getText(ast))
        ) {
          const method = node.arguments[0];
          const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          const at = `${relative(REPO_ROOT, file)}:${location.line + 1}`;
          if (!method || !ts.isStringLiteralLike(method)) {
            violations.push(`${at}: RPC method must be a literal generated key`);
          } else if (!methods.has(method.text)) {
            violations.push(`${at}: unregistered RPC method ${method.text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }

    expect(violations).toEqual([]);
  });

  it("the typed client rejects unknown names and infers generated results", () => {
    const typeTest = resolve(WEB_SRC, "api/rpc-client.types.test.ts");
    const program = ts.createProgram([typeTest], {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["vitest/globals"],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).filter(
      (diagnostic) => diagnostic.file?.fileName === typeTest,
    );
    const messages = diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
    expect(messages).toEqual([]);
  });
});
