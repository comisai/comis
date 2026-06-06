// SPDX-License-Identifier: Apache-2.0
/**
 * buildMcpConfig — shared helper for MCP scenario tests.
 *
 * Builds a temp YAML config file patching the MCP server entry under
 * integrations.mcp.servers[0]. The gateway port is NOT patched here —
 * ConversationDriver._buildPortedConfigPath() handles that separately so
 * each driver gets its own unique port.
 *
 * Base config: test/config/config.test.yaml
 *
 * Keys written (appended as a new integrations block since the base test
 * config does not have one):
 *   - integrations.mcp.servers[0].name       ("mock-test-server")
 *   - integrations.mcp.servers[0].transport  ("stdio"|"sse"|"http")
 *   - integrations.mcp.servers[0].url        (opts.serverUrl or default loopback)
 *   - integrations.mcp.servers[0].auth       ("none"|"bearer"|"oauth")
 *   - integrations.mcp.servers[0].token      (opts.bearerToken or empty string)
 *   - integrations.mcp.servers[0].command    (stdio only; placeholder — actual
 *     stdio server is launched separately by the scenario test)
 *
 * Mirrors ctx-config.ts exactly, adding only the integrations block.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const _here = dirname(fileURLToPath(import.meta.url));

/**
 * Options for building a per-TRANSPORT_AUTH_MATRIX-cell temp config.
 */
export interface McpConfigOpts {
  /** MCP transport type. */
  transport: "stdio" | "sse" | "http";
  /** Auth scheme for the MCP server. */
  auth: "none" | "bearer" | "oauth";
  /** Override the server URL (SSE/HTTP). Defaults to http://127.0.0.1:9999/mcp/v1. */
  serverUrl?: string;
  /** Bearer token value (used when auth="bearer"). */
  bearerToken?: string;
  /** Human-readable label used in the output filename (sanitised). */
  label: string;
  /** Short prefix for the temp filename (e.g. "mcp-sse"). Defaults to "mcp". */
  filePrefix?: string;
}

/**
 * Build a temp YAML config patching integrations.mcp.servers[0] transport and auth.
 *
 * The base test config (test/config/config.test.yaml) does not have an
 * integrations block, so this helper always appends one at the end of the file.
 *
 * The gateway port is NOT patched here — ConversationDriver._buildPortedConfigPath()
 * handles that separately so each driver gets its own unique port.
 *
 * @returns Absolute path to the written temp YAML file.
 */
export function buildMcpConfig(opts: McpConfigOpts): string {
  const base = join(_here, "../../config/config.test.yaml");
  let content = readFileSync(base, "utf-8");

  const serverUrl = opts.serverUrl ?? "http://127.0.0.1:9999/mcp/v1";
  const bearerToken = opts.bearerToken ?? "";

  // The base test config does not have an integrations block.
  // Always append one at the end of the file.
  // For stdio transport, include a placeholder command so schema validation
  // succeeds. The actual stdio server process is launched separately by the
  // scenario test (e.g., mock-mcp-server).
  const stdioLine =
    opts.transport === "stdio"
      ? `          command: "node -e 'process.exit(0)'"\n`
      : "";

  const integrationsBlock = [
    "\nintegrations:",
    "  mcp:",
    "    servers:",
    "      - name: mock-test-server",
    `        transport: ${opts.transport}`,
    `        url: ${serverUrl}`,
    stdioLine.length > 0 ? `        command: "node -e 'process.exit(0)'"` : null,
    `        auth: ${opts.auth}`,
    `        token: ${bearerToken}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  content = content + integrationsBlock + "\n";

  const prefix = opts.filePrefix ?? "mcp";
  const outPath = join(
    tmpdir(),
    `${prefix}-${opts.label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.yaml`,
  );
  writeFileSync(outPath, content, "utf-8");
  return outPath;
}
