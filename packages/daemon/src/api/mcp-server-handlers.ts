// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 69 Plan 03 -- buildMcpServerForClient factory.
 *
 * Constructs a per-request `McpServer` (SDK 1.29.0 high-level wrapper)
 * scoped to one authenticated MCP client (`TokenClient` with `mcp-client`
 * scope). Applies the default-deny `tools/list` filter at registration time:
 *
 *   - mcpExportPolicy === "safe"             → register (any mcp-client)
 *   - mcpExportPolicy === "permission-gated" → register IFF client's
 *                                              `mcpClient.allowlist` contains
 *                                              the tool name
 *   - mcpExportPolicy === "never-export"     → SKIP
 *   - mcpExportPolicy === undefined          → SKIP (default-deny safety net;
 *                                              Plan 02's CI gate makes
 *                                              "undefined" impossible in
 *                                              committed code)
 *
 * The filtered registration set IS the exposed surface — never-export tools
 * never reach the SDK's tool index, so they cannot leak via `tools/list` or
 * be invoked via `tools/call`.
 *
 * `tools/call` callbacks are STUBBED in this plan: they return
 * `{ isError: true, content: [{type:"text", text:"..."}] }`. The real
 * dispatcher (rate limit + input validation + rpcCall + wrapExternalContent)
 * lands in Plan 04 (SERVE-07).
 *
 * @module
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllToolMetadata, type ComisToolMetadata } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { TokenClient } from "@comis/gateway";

// ---------------------------------------------------------------------------
// Deps + factory
// ---------------------------------------------------------------------------

/**
 * Dependencies for `buildMcpServerForClient`.
 *
 * Kept minimal — the factory consults the side-channel tool registry
 * (`getAllToolMetadata()`) directly, and the per-client allowlist comes
 * from the verified `TokenClient`. The `daemonVersion` is advertised as
 * `serverInfo.version` per CONTEXT §1 ("name: 'comis', version: <pkg.json
 * version>").
 */
export interface BuildMcpServerForClientDeps {
  /** Logger bound with `module: "mcp-server"`. */
  readonly logger: ComisLogger;
  /** Daemon package version (read once at composition root from
   *  `packages/daemon/package.json`). Advertised as `serverInfo.version`. */
  readonly daemonVersion: string;
}

/**
 * Build a fresh per-request `McpServer` instance scoped to the supplied
 * authenticated MCP client.
 *
 * The caller (the Hono `/mcp/v1` route handler) is responsible for
 * connecting the returned `McpServer` to a `StreamableHTTPServerTransport`
 * via `mcp.connect(transport)`.
 *
 * Stub tool callbacks: this plan ships the auth gate + the default-deny
 * filter. Real `tools/call` dispatch (rate-limit, validateInput, rpcCall,
 * wrapExternalContent) lands in Plan 04 — see `STUB_NOT_IMPLEMENTED_MSG`.
 */
export function buildMcpServerForClient(
  deps: BuildMcpServerForClientDeps,
  client: TokenClient,
): McpServer {
  const { logger, daemonVersion } = deps;
  const mcp = new McpServer(
    { name: "comis", version: daemonVersion },
    { capabilities: { tools: {}, resources: { subscribe: false } } },
  );

  const allowlist = new Set<string>(client.mcpClient?.allowlist ?? []);
  const allTools = getAllToolMetadata();

  let registered = 0;
  let skippedNeverExport = 0;
  let skippedGated = 0;
  let skippedUndefined = 0;

  for (const [name, meta] of allTools) {
    const policy = meta.mcpExportPolicy;
    if (policy === undefined) {
      // Default-deny safety net. Plan 02's CI gate makes this impossible in
      // committed code; if it does fire at runtime, treat as a defense-in-
      // depth assertion (Plan 02 SUMMARY guidance).
      skippedUndefined += 1;
      continue;
    }
    if (policy === "never-export") {
      skippedNeverExport += 1;
      continue;
    }
    if (policy === "permission-gated" && !allowlist.has(name)) {
      skippedGated += 1;
      continue;
    }

    // policy === "safe" OR (policy === "permission-gated" AND allowlisted)
    mcp.registerTool(
      name,
      { description: describeTool(name, meta) },
      stubCallback,
    );
    registered += 1;
  }

  logger.info(
    {
      clientId: client.id,
      submodule: "tools-list-filter",
      registered,
      skippedNeverExport,
      skippedGated,
      skippedUndefined,
      allowlistSize: allowlist.size,
    },
    "MCP server tool registration complete (Phase 69 Plan 03 -- tools/call stub)",
  );

  return mcp;
}

// ---------------------------------------------------------------------------
// Stub callback (Plan 04 replaces with real dispatcher)
// ---------------------------------------------------------------------------

/**
 * Stub `tools/call` response. Plan 04 (SERVE-07) replaces this with the
 * full dispatcher: rate-limit → validateInput → rpcCall → wrapExternalContent.
 *
 * Exported only so the unit test can pin the message shape; production code
 * never references it directly (it's bound into every `registerTool` call).
 */
export const STUB_NOT_IMPLEMENTED_MSG =
  "[Comis MCP] tools/call dispatch lands in Plan 04 (SERVE-07)";

async function stubCallback(): Promise<{
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}> {
  return {
    isError: true,
    content: [{ type: "text", text: STUB_NOT_IMPLEMENTED_MSG }],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a short description for the registered tool. Currently we surface
 * a "(from Comis)" suffix plus the tool name; future enhancements can mine
 * `meta.searchHint` or pull the upstream `AgentTool.description`. Keeping
 * it minimal here avoids leaking implementation-internal text into the
 * MCP wire surface.
 */
function describeTool(name: string, _meta: ComisToolMetadata): string {
  return `${name} (from Comis)`;
}

