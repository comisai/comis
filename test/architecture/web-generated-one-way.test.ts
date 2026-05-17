// SPDX-License-Identifier: Apache-2.0
/**
 * Code generation is ONE-WAY (core → web).
 *
 * `packages/web/src/api/contracts.generated.{ts,json,size.json}` is the
 * codegen output of `pnpm contracts:generate` — it is consumed by the web
 * SPA in the browser. NO other workspace package may import from this file:
 * the moment a server-side package starts importing the browser-side
 * artifact, the boundary inverts (generated artifact would have to know
 * about its consumers), which is a textbook codegen architectural
 * regression.
 *
 * This test walks `packages/<pkg>/src/` for every workspace package OTHER
 * than `@comis/web` and asserts no source file imports any path matching
 * `web/src/api/contracts.generated`. Empty allowlist; defense-in-depth
 * against any future PR that would create a back-edge.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");

/**
 * The web package — its own consumption of contracts.generated.* is the
 * intended forward direction (the entire point of the codegen seam).
 * Every other workspace package must be back-edge-free.
 */
const WEB_PACKAGE = "web";

/**
 * Regex matching any import specifier whose path lands on the generated
 * artifact, regardless of relative depth, file extension, or whether the
 * caller imports `.ts`, `.js`, or omits the extension entirely.
 *
 * Examples of intentionally-matched specifiers:
 *   - `from "../../web/src/api/contracts.generated.js"`
 *   - `from "../web/src/api/contracts.generated"`
 *   - `from "@comis/web/src/api/contracts.generated.ts"` (theoretical;
 *      blocked separately by `private: true` on @comis/web, but caught here
 *      too as belt-and-suspenders).
 *   - Side-effect imports (`import "../web/src/api/contracts.generated.js"`)
 *     also match — that form would be a perversely sneaky way of pulling
 *     the 9569-line artifact into a server bundle.
 *
 * Intentional non-matches:
 *   - Imports of the JSON file (`contracts.generated.json`) — `node --import`
 *     handles those distinctly; we use the loose pattern because it covers
 *     `.ts` and `.json` both.
 */
const ONE_WAY_VIOLATION_PATTERN = /["'][^"']*web\/src\/api\/contracts\.generated/;

describe("Web contracts.generated.* is consumed ONE-WAY", () => {
  it("no workspace package OTHER than @comis/web imports from web/src/api/contracts.generated", () => {
    const offenders = findBackEdgeImports();
    expect(
      offenders,
      formatViolations({
        description: `Code generation is one-way (core → web). No workspace package other than @comis/web may import from packages/web/src/api/contracts.generated.* — that would invert the codegen seam.`,
        violations: offenders.map((o) => ({ file: o.file, line: o.line, snippet: o.snippet })),
        suggestedFix: `If the server side needs the same contract data, import API_CONTRACTS / API_CONTRACTS_ORDERED from @comis/core/api-contracts (the SOURCE of the codegen, not its OUTPUT). The generated artifact is for the browser only.`,
        designRef: "Code generation is one-way (core → web); the browser-side artifact has no server-side consumers",
      }),
    ).toEqual([]);
    // Sanity: we actually walked at least one non-web package, otherwise
    // the test could trivially pass by walking nothing.
    expect(
      countNonWebPackagesWalked(),
      "sanity: at least 8 non-web workspace packages should exist + be walked",
    ).toBeGreaterThan(8);
  });
});

interface BackEdgeOffender {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * Walk every workspace package's `src/` directory (excluding `@comis/web`)
 * and return every import that lands on `web/src/api/contracts.generated`.
 *
 * Implemented as a plain raw-text regex scan over `.ts` files (not AST):
 * the pattern is unambiguous (no false positives from comments because the
 * needle includes a slash + the literal filename prefix; comments would
 * need to embed that exact substring verbatim), and the scan needs to be
 * fast across ~13 packages × hundreds of source files.
 */
function findBackEdgeImports(): readonly BackEdgeOffender[] {
  const offenders: BackEdgeOffender[] = [];
  const packages = listWorkspacePackages();
  for (const pkg of packages) {
    if (pkg === WEB_PACKAGE) continue;
    const srcDir = resolve(PACKAGES_ROOT, pkg, "src");
    if (!safeIsDirectory(srcDir)) continue;
    walkTsFiles(srcDir, (file, content) => {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!/\bfrom\b|\bimport\s/.test(line)) continue;
        // Clone regex per check to avoid `lastIndex` carry-over even though
        // the source pattern is non-global.
        const re = new RegExp(
          ONE_WAY_VIOLATION_PATTERN.source,
          ONE_WAY_VIOLATION_PATTERN.flags,
        );
        if (re.test(line)) {
          offenders.push({
            file,
            line: i + 1,
            snippet: extractSnippet(lines, i + 1),
          });
        }
      }
    });
  }
  return offenders;
}

function countNonWebPackagesWalked(): number {
  let count = 0;
  for (const pkg of listWorkspacePackages()) {
    if (pkg === WEB_PACKAGE) continue;
    const srcDir = resolve(PACKAGES_ROOT, pkg, "src");
    if (safeIsDirectory(srcDir)) count++;
  }
  return count;
}

function listWorkspacePackages(): readonly string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}

function safeIsDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const SKIP_DIRS = new Set(["__tests__", "__snapshots__", "dist", "node_modules"]);

function walkTsFiles(
  dir: string,
  visit: (file: string, content: string) => void,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTsFiles(full, visit);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    const content = readFileSync(full, "utf8");
    visit(full, content);
  }
}

function extractSnippet(lines: readonly string[], line1: number): string {
  const out: string[] = [];
  for (let l = line1 - 1; l <= line1 + 1; l++) {
    if (l < 1 || l > lines.length) continue;
    out.push(`${l}: ${lines[l - 1]}`);
  }
  return out.join("\n");
}

// Silence the unused-import warning during typecheck for relative; it can
// become useful when the test gets richer per-file allowlist logic later.
void relative;
