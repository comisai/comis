#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal stdio MCP server fixture for the E2E CLI test
 * (test/e2e/cli-mcp.test.ts).
 *
 * The CLI E2E test spawns a REAL test daemon (via test/support/daemon-harness)
 * whose McpClientManager uses the PRODUCTION MCP SDK — so `comis mcp connect`
 * needs a genuine MCP server process to complete the stdio handshake (a bare
 * `/bin/true` would exit before the initialize round-trip and make mcp.connect
 * throw). This fixture is that server: it speaks the MCP stdio protocol via
 * `@modelcontextprotocol/sdk` and advertises two trivial tools so the connect
 * response reports a non-zero toolCount.
 *
 * It is an ESM `.mjs` (not a `.ts`) so the daemon can spawn it with a plain
 * `node <path>` command — no transpile step. It is NOT a `*.test.ts` file, so
 * neither the integration nor the e2e vitest `include` globs pick it up; it is
 * a pure fixture loaded only as a child process.
 *
 * Resolution: `@modelcontextprotocol/sdk` resolves from the repo root
 * node_modules (the daemon's CWD), the same place the daemon's own SDK import
 * resolves. The fixture is launched as `node <abs-path-to-this-file>` so its
 * own bare import is resolved against the repo-root module graph.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  const server = new McpServer({
    name: "comis-e2e-test-server",
    version: "1.0.0",
  });

  // Two trivial tools — registering any tool makes the server advertise the
  // `tools` capability, and the daemon's listTools discovery reports
  // toolCount === 2 in the mcp.connect / mcp.list responses.
  server.tool("echo", "Echo back a fixed marker string.", async () => ({
    content: [{ type: "text", text: "comis-e2e-echo" }],
  }));

  server.tool("ping", "Health probe; returns pong.", async () => ({
    content: [{ type: "text", text: "pong" }],
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The process now blocks on stdin, serving MCP requests until the parent
  // (the daemon's stdio transport) closes the pipe on disconnect.
}

main().catch((err) => {
  // Surface fatal startup errors on stderr so a spawn failure is diagnosable.
  process.stderr.write(`mcp-test-server fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
