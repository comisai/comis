// SPDX-License-Identifier: Apache-2.0
/**
 * Every CLI RPC call goes through the contract registry via `callTyped(...)`.
 * Raw `client.call(` is forbidden everywhere in packages/cli/src/ EXCEPT
 * inside the wrapper module(s):
 *   - packages/cli/src/client/rpc-client.ts (the gate location)
 *   - packages/cli/src/client/typed-rpc.ts  (sibling re-exporter, if present)
 *
 * This test enforces the architectural invariant — it prevents regressions
 * where someone reintroduces a raw `client.call(` outside the wrapper.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const CLI_SRC = resolve(REPO_ROOT, "packages/cli/src");

/** Files allowed to contain raw `client.call(` — the wrapper module surface. */
const ALLOWLIST = new Set<string>([
  "client/rpc-client.ts",
  "client/typed-rpc.ts",
]);

/** Recursively collect .ts files under root, excluding .test.ts. */
function collectTsFiles(
  root: string,
  acc: string[] = [],
  base = root,
): string[] {
  for (const entry of readdirSync(root)) {
    const full = resolve(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectTsFiles(full, acc, base);
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      acc.push(relative(base, full));
    }
  }
  return acc;
}

describe("CLI uses typed RPC wrapper only", () => {
  // Every CLI command has been retargeted to callTyped. Any future
  // regression that reintroduces a raw `client.call(` outside the wrapper
  // trips this assertion.
  it("no raw client.call( outside the wrapper module", () => {
    const files = collectTsFiles(CLI_SRC);
    const violations: { file: string; line: number; reason: string }[] = [];
    for (const rel of files) {
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(resolve(CLI_SRC, rel), "utf8");
      // Strip comment-only lines to avoid false positives from JSDoc snippets.
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const stripped = line
          .replace(/^\s*\/\/.*$/, "")
          .replace(/^\s*\*.*$/, "");
        if (/\bclient\.call\s*\(/.test(stripped)) {
          violations.push({
            file: rel,
            line: i + 1,
            reason: `line ${i + 1}: raw \`client.call(\` — replace with \`callTyped(client, ContractName, params)\``,
          });
        }
      }
    }
    expect(
      violations,
      formatViolations({
        description: "Raw client.call( occurrences outside the wrapper module",
        violations: violations.map((v) => ({
          file: v.file,
          line: v.line,
          snippet: v.reason,
        })),
        suggestedFix:
          "Replace with callTyped(client, <DomainContract>, params). See packages/core/src/api-contracts/ for the contract registry.",
        designRef: "packages/core/src/api-contracts/",
      }),
    ).toEqual([]);
  });

  // `callTyped` is exported from packages/cli/src/client/rpc-client.ts.
  // The wrapper-exists gate is permanent — any future regression that
  // removes the export trips this assertion.
  it("the wrapper module exists at packages/cli/src/client/rpc-client.ts", () => {
    const wrapper = readFileSync(
      resolve(CLI_SRC, "client/rpc-client.ts"),
      "utf8",
    );
    expect(wrapper, "wrapper module must export callTyped").toMatch(
      /(export\s+(async\s+)?function\s+callTyped|export\s+\{[^}]*callTyped)/,
    );
  });
});
