// SPDX-License-Identifier: Apache-2.0
/**
 * 65-P2 architecture-grep — per-server MCP tool filtering is confined to
 * the bridge.
 *
 * OPUX-08 applies the per-server `toolAllowlist` / `toolBlocklist` filter
 * EXCLUSIVELY at `mcpToolsToAgentTools`
 * (`packages/skills/src/skills/bridge/mcp-tool-bridge.ts`). To guarantee no
 * future change re-implements the filter at dispatch (which would leave the
 * filtered tool visible in the agent's registry — STRIDE T-65-09), this gate
 * forbids the literal identifiers `toolAllowlist` / `toolBlocklist` anywhere
 * under `packages/**` except a small set of sanctioned sites:
 *
 *  - the bridge itself (the only filter-aware site + the
 *    `extractServerToolFilters` helper that names the fields);
 *  - the Zod schema that DECLARES the fields
 *    (`packages/core/src/config/schema-integrations.ts`);
 *  - the runtime config mirror that DECLARES the fields on `McpServerConfig`
 *    (`packages/skills/.../mcp-client/mcp-client-types.ts`, landed in Plan
 *    65-01). This is a passive type-shape mirror, not filter logic.
 *
 * The schema snapshot fixture carries the literal field-name strings and is
 * allowlisted too (Pitfall 8). `*.test.ts` files are skipped — test data
 * legitimately names the fields.
 *
 * Deliberate-violation check: temporarily adding `const x = "toolAllowlist";`
 * to any non-allowlisted `packages/**` source file MUST make this test fail.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_DIR = resolve(REPO_ROOT, "packages");

/**
 * Paths (repo-root-relative, POSIX) where the literal field names are
 * sanctioned. Compared via `endsWith` against POSIX-normalized file paths.
 */
const ALLOWED_SITES: readonly string[] = [
  // The only filter-aware site + extractServerToolFilters helper.
  "packages/skills/src/skills/bridge/mcp-tool-bridge.ts",
  // The Zod schema that declares the fields.
  "packages/core/src/config/schema-integrations.ts",
  // The runtime config mirror (McpServerConfig) that declares the fields —
  // landed in Plan 65-01; a passive type-shape mirror, not filter logic.
  "packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts",
  // Schema snapshot fixture contains the literal strings (Pitfall 8).
  "test/architecture/__snapshots__/McpServerEntrySchema.json",
];

const FORBIDDEN_TOKENS: readonly string[] = ["toolAllowlist", "toolBlocklist"];

/** Recursively collect `.ts`/`.tsx` source files, skipping dist + node_modules. */
function walkTsFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "dist" || entry === "node_modules") continue;
      walkTsFiles(full, acc);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      acc.push(full);
    }
  }
}

/** Normalize to POSIX separators so `endsWith` comparisons are portable. */
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

describe("65-P2 — toolAllowlist/toolBlocklist references confined to the bridge", () => {
  it("does not reference toolAllowlist or toolBlocklist outside the sanctioned sites", () => {
    const allTs: string[] = [];
    walkTsFiles(PACKAGES_DIR, allTs);

    // Sanity: the snapshot fixture (a non-.ts allowed site) carries the
    // literals; assert the gate actually scanned real source.
    expect(allTs.length, "walker must find packages source files").toBeGreaterThan(0);

    const violations: Array<{ file: string; token: string }> = [];
    for (const file of allTs) {
      const rel = toPosix(file);
      if (ALLOWED_SITES.some((a) => rel.endsWith(a))) continue;
      // Test files legitimately name the fields in fixtures/assertions.
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      const src = readFileSync(file, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        if (src.includes(token)) {
          violations.push({ file: rel, token });
        }
      }
    }

    expect(
      violations,
      `Per-server MCP tool filtering (toolAllowlist/toolBlocklist) must stay confined to the bridge (65-P2). ` +
        `Move filter logic into packages/skills/src/skills/bridge/mcp-tool-bridge.ts and read persisted fields ` +
        `via extractServerToolFilters. Violations: ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });

  it("the bridge IS allowed to name the filter fields (allowlist is not over-broad)", () => {
    // Guards against an ALLOWED_SITES typo that would silently disable the
    // gate: the bridge must genuinely contain the literals it is allowed.
    const bridge = readFileSync(
      resolve(REPO_ROOT, "packages/skills/src/skills/bridge/mcp-tool-bridge.ts"),
      "utf8",
    );
    expect(bridge).toContain("toolAllowlist");
    expect(bridge).toContain("toolBlocklist");
  });
});
