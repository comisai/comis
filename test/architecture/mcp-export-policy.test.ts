// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture test — MCP export policy gate.
 *
 * Every unique tool name registered via registerToolMetadata in
 * tool-metadata-registry.ts MUST appear in at least ONE call that
 * sets `mcpExportPolicy`. Spread-merge semantics in
 * @comis/core's registerToolMetadata mean a tool can be registered
 * 5 times (size cap / read-only / validator / output schema / search
 * hint) with mcpExportPolicy on any one of those — that's why the
 * invariant is "every UNIQUE name", not "every CALL".
 *
 * Failure mode: missing annotation defaults to "never-export" at
 * runtime (default-deny safety net, enforced by the tools/list
 * filter) — but the developer never thought about the classification,
 * which is the risk this gate closes. The CI gate enforces ANNOTATION
 * PRESENCE only; the literal value (safe / permission-gated /
 * never-export) is the security policy, gated behind a HUMAN-UAT
 * security-reviewer step before the v2.4 / v2.5 ship.
 *
 * Walker pattern: mirrors test/architecture/contract-handler-parity.test.ts
 * (lines 76-228) — TypeScript-compiler AST walker. Scope limited to a
 * single file (tool-metadata-registry.ts) for determinism; other files
 * that re-export or use registerToolMetadata (e.g. tests) are intentionally
 * skipped.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const REGISTRY_PATH = resolve(
  REPO_ROOT,
  "packages/skills/src/skills/bridge/tool-metadata-registry.ts",
);

describe("mcp-export-policy CI gate", () => {
  it("every unique tool registered via registerToolMetadata declares an explicit mcpExportPolicy", () => {
    const src = readFileSync(REGISTRY_PATH, "utf-8");
    const sf = ts.createSourceFile(
      REGISTRY_PATH,
      src,
      ts.ScriptTarget.Latest,
      true,
    );

    /** Map<toolName, hasPolicy> — OR-merged across all calls for the name. */
    const toolHasPolicy = new Map<string, boolean>();

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "registerToolMetadata" &&
        node.arguments.length >= 2 &&
        ts.isStringLiteral(node.arguments[0]) &&
        ts.isObjectLiteralExpression(node.arguments[1])
      ) {
        const toolName = node.arguments[0].text;
        const hasPolicy = node.arguments[1].properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "mcpExportPolicy",
        );
        toolHasPolicy.set(
          toolName,
          (toolHasPolicy.get(toolName) ?? false) || hasPolicy,
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);

    const missing = [...toolHasPolicy.entries()]
      .filter(([, has]) => !has)
      .map(([name]) => name)
      .sort();

    expect(
      missing,
      `Tools missing mcpExportPolicy annotation in tool-metadata-registry.ts (${missing.length}):\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});
