// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture-grep — per-server MCP tool filtering is confined to
 * the bridge.
 *
 * Applies the per-server `toolAllowlist` / `toolBlocklist` filter
 * EXCLUSIVELY at `mcpToolsToAgentTools`
 * (`packages/skills/src/skills/bridge/mcp-tool-bridge.ts`). To guarantee no
 * future change re-implements the filter at dispatch (which would leave the
 * filtered tool visible in the agent's registry), this gate
 * forbids the literal identifiers `toolAllowlist` / `toolBlocklist` anywhere
 * under `packages/**` except a small set of sanctioned sites:
 *
 *  - the bridge itself (the only filter-aware site + the
 *    `extractServerToolFilters` helper that names the fields);
 *  - the Zod schema that DECLARES the fields
 *    (`packages/core/src/config/schema-integrations.ts`);
 *  - the runtime config mirror that DECLARES the fields on `McpServerConfig`
 *    (`packages/skills/.../mcp-client/mcp-client-types.ts`).
 *    This is a passive type-shape mirror, not filter logic.
 *  - the two daemon construction sites that FORWARD the persisted fields into
 *    the runtime `McpServerConfig` (`packages/daemon/src/wiring/setup-mcp.ts`
 *    at startup + `packages/daemon/src/api/mcp-handlers.ts` mcp.connect).
 *    Without this plumbing the filter never reaches the
 *    bridge for config-defined / reconnected servers. These sites only COPY
 *    the values config→runtime; they contain no filter LOGIC (the
 *    allowlist/blocklist comparison stays solely in the bridge).
 *  - the persisted-entry builder
 *    (`packages/daemon/src/api/mcp-persisted-entry.ts`), extracted from
 *    mcp-handlers.ts. It PRESERVES the persisted fields
 *    (incl. toolAllowlist/toolBlocklist) onto the entry written back to
 *    config.yaml — pure passthrough, same plumbing role as the mcp.connect
 *    site it was carved out of; no filter LOGIC.
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
  // a passive type-shape mirror, not filter logic.
  "packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts",
  // Daemon construction sites that FORWARD persisted fields into the
  // runtime McpServerConfig. Pure config→runtime plumbing (no filter logic);
  // required so the bridge receives the filter for config-defined/reconnected
  // servers.
  "packages/daemon/src/wiring/setup-mcp.ts",
  "packages/daemon/src/api/mcp-handlers.ts",
  // Persisted-entry builder extracted from mcp-handlers.ts.
  // Preserves persisted fields (incl. toolAllowlist/toolBlocklist) onto the
  // config.yaml entry — pure passthrough, no filter logic (same role as the
  // mcp.connect site it was carved out of).
  "packages/daemon/src/api/mcp-persisted-entry.ts",
  // bundle-install-helper's buildRuntimeConfig projects a persisted
  // McpServerEntry into McpServerConfig for manager.connect. Same plumbing
  // role as setup-mcp.ts + mcp-handlers.ts — a passive config→runtime
  // forward (no filter logic). The bridge still owns the actual
  // allowlist/blocklist comparison.
  "packages/daemon/src/skills/bundle-install-helper.ts",
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

describe("toolAllowlist/toolBlocklist references confined to the bridge", () => {
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
      `Per-server MCP tool filtering (toolAllowlist/toolBlocklist) must stay confined to the bridge. ` +
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
