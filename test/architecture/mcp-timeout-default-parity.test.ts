// SPDX-License-Identifier: Apache-2.0
/**
 * Parity gate: the MCP call-tool deadline has ONE default.
 *
 * The two-sources-of-truth drift this pins (comis-moshe 2026-07-26): the config
 * schema defaulted `integrations.mcp.callToolTimeoutMs` to 120_000 while
 * `createMcpClientManager` fell back to a local `?? 60_000` literal and the
 * `McpClientManagerDeps` JSDoc documented 60000. Any wiring path that did not
 * thread the configured value therefore ran a silently-halved deadline, and the
 * docs told an operator the wrong number.
 *
 * Source-derived on purpose: reading the literals out of the files is what
 * catches a future edit to either side.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpConfigSchema, MCP_CALL_TOOL_TIMEOUT_MS_DEFAULT } from "@comis/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("MCP callToolTimeoutMs has a single default", () => {
  it("the schema's parsed default IS the exported constant", () => {
    const parsed = McpConfigSchema.parse({});
    expect(parsed.callToolTimeoutMs).toBe(MCP_CALL_TOOL_TIMEOUT_MS_DEFAULT);
  });

  it("the client manager's construction fallback references the constant, never a literal", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "packages/skills/src/skills/integrations/mcp-client/index.ts"),
      "utf8",
    );
    const line = src
      .split("\n")
      .find((l) => l.includes("callToolTimeoutMs:") && l.includes("??"));
    expect(line, "no callToolTimeoutMs fallback line found").toBeDefined();
    expect(line).toContain("MCP_CALL_TOOL_TIMEOUT_MS_DEFAULT");
    // A bare numeric fallback is exactly the drift this gate exists to stop.
    expect(line).not.toMatch(/\?\?\s*\d/);
  });

  it("the deps JSDoc does not document a stale numeric default", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts"),
      "utf8",
    );
    const jsdoc = src
      .split("\n")
      .filter((l) => /callToolTimeoutMs invocations|individual callTool invocations/.test(l));
    expect(jsdoc.length).toBeGreaterThan(0);
    for (const line of jsdoc) {
      const numbers = line.match(/\d{4,}/g) ?? [];
      for (const n of numbers) {
        expect(Number(n)).toBe(MCP_CALL_TOOL_TIMEOUT_MS_DEFAULT);
      }
    }
  });
});
