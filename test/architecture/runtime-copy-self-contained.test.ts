// SPDX-License-Identifier: Apache-2.0
/**
 * Shipped runtime copy must explain the current behavior without relying on
 * private planning labels. Security finding codes such as SEC-GW-003 and
 * standards such as ISO-8601 remain valid public identifiers.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface RuntimeCopyViolation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

const INTERNAL_LABEL =
  /\b(?:R\d+|(?:BL|WR|KNOB|CLI|CWF|DISPATCH|FINAL|WS|EGRESS)-\d+(?:-[A-Z0-9]+)*)\b|\b(?:Phase|Plan) \d+\b|live finding|\.planning\//;

function walkProductionSource(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "__test-helpers", "fixtures", "node_modules"].includes(entry.name)) {
        continue;
      }
      walkProductionSource(fullPath, files);
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".generated.ts")
    ) {
      files.push(fullPath);
    }
  }
}

function productionSourceFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const sourceRoot = resolve(PACKAGES_ROOT, pkg.name, "src");
    try {
      walkProductionSource(sourceRoot, files);
    } catch {
      // A package without src/ has no production TypeScript to inspect.
    }
  }
  return files;
}

function collectRuntimeCopyViolations(file: string): RuntimeCopyViolation[] {
  const sourceText = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const violations: RuntimeCopyViolation[] = [];

  const inspect = (node: ts.Node): void => {
    let text: string | undefined;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text = node.getText(sourceFile);
    }

    if (text !== undefined && INTERNAL_LABEL.test(text)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        file: file.slice(REPO_ROOT.length + 1),
        line: position.line + 1,
        text: text.replace(/\s+/g, " ").slice(0, 240),
      });
    }

    ts.forEachChild(node, inspect);
  };

  inspect(sourceFile);
  return violations;
}

describe("runtime copy is self-contained", () => {
  it("ships no user-facing string that depends on a private planning label", () => {
    const violations = productionSourceFiles().flatMap(collectRuntimeCopyViolations);

    expect(
      violations,
      "Replace private labels with a direct description of the current behavior.",
    ).toEqual([]);
  });
});
