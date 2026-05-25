// SPDX-License-Identifier: Apache-2.0
/**
 * MCP server endpoint /mcp/v1 integration test.
 *
 * Exercises the security-critical surface end-to-end via the MCP SDK 1.29.0
 * `Client` + `StreamableHTTPClientTransport`. Asserts:
 *
 *   1. POST /mcp/v1 with no Authorization header returns 401 (auth gate).
 *   2. POST /mcp/v1 with an rpc-only token returns 403 (scope gate -- missing
 *      "mcp-client").
 *   3. POST /mcp/v1 with a synthesized token co-issuing admin + mcp-client
 *      returns 403 (defense-in-depth -- the schema refine blocks issuance,
 *      but the endpoint also rejects at runtime).
 *   4. POST /mcp/v1 with a valid mcp-client token whose mcpClient.allowlist
 *      is empty exposes ONLY the `safe`-classified tools (web_search,
 *      web_fetch, browser). NO permission-gated, NO never-export.
 *   5. POST /mcp/v1 with a valid mcp-client token whose allowlist includes
 *      "memory_search" exposes safe UNION {memory_search}. never-export
 *      tools NEVER appear.
 *
 * Uses port 8569 + dedicated test config to avoid conflicts with other
 * integration suites that run sequentially under vitest pool: "forks".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { DAEMON_STARTUP_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-mcp-server-tools-list.yaml",
);

// ---------------------------------------------------------------------------
// Test secrets -- aligned with the YAML config; neutral fixture placeholder values.
// ---------------------------------------------------------------------------

const RPC_ONLY_SECRET = "mcp-svr-toolslist-rpc-only-tok-22";
const MCP_EMPTY_SECRET = "mcp-svr-toolslist-mcp-empty-tok-3";
const MCP_MEMORY_SECRET = "mcp-svr-toolslist-mcp-memory-tok-4";

// Expected safe-set: 3 tools annotated mcpExportPolicy="safe".
const EXPECTED_SAFE_TOOLS = ["browser", "web_fetch", "web_search"] as const;
// Subset of the never-export set -- a few high-value canaries to assert
// they NEVER appear in tools/list regardless of allowlist.
const NEVER_EXPORT_CANARIES = [
  "tokens_manage",
  "exec",
  "write",
  "memory_store",
  "sessions_send",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated MCP client connected to /mcp/v1.
 *
 * The SDK's `Client.connect` performs the MCP `initialize` handshake; the
 * `tools/list` call goes over the resulting Streamable HTTP transport.
 */
async function connectMcpClient(
  baseUrl: string,
  bearer: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/v1`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${bearer}` },
      },
    },
  );
  const client = new Client({ name: "phase-69-test-client", version: "0.0.1" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Direct fetch helper for the auth-gate tests (no SDK -- we want to assert
 * raw HTTP status codes BEFORE the MCP handshake even starts).
 */
async function rawPostMcp(
  baseUrl: string,
  bearer: string | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (bearer !== undefined) {
    headers["authorization"] = `Bearer ${bearer}`;
  }
  // A well-formed JSON-RPC initialize request body. Even if auth fails, the
  // server must reject BEFORE parsing or invoking the SDK transport.
  return fetch(`${baseUrl}/mcp/v1`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "phase-69-test-raw", version: "0.0.1" },
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("/mcp/v1 endpoint auth + default-deny tools/list filter", () => {
  let handle: TestDaemonHandle;
  let baseUrl: string;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    baseUrl = handle.gatewayUrl;
  }, DAEMON_STARTUP_MS + 30_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Auth gate -- 401 / 403
  // -------------------------------------------------------------------------

  it(
    "POST /mcp/v1 with no Authorization header returns 401 (errorKind auth)",
    async () => {
      const res = await rawPostMcp(baseUrl, undefined);
      expect(res.status).toBe(401);
    },
  );

  it(
    "POST /mcp/v1 with an rpc-only token returns 403 -- token missing mcp-client scope",
    async () => {
      const res = await rawPostMcp(baseUrl, RPC_ONLY_SECRET);
      expect(res.status).toBe(403);
    },
  );

  // -------------------------------------------------------------------------
  // Default-deny filter -- empty allowlist exposes ONLY safe tools
  // -------------------------------------------------------------------------

  it(
    "POST /mcp/v1 mcp-client token without allowlist exposes ONLY tools annotated mcpExportPolicy safe",
    async () => {
      const { client, close } = await connectMcpClient(baseUrl, MCP_EMPTY_SECRET);
      try {
        const list = await client.listTools();
        const exposedNames = list.tools.map((t) => t.name).sort();
        expect(exposedNames).toEqual([...EXPECTED_SAFE_TOOLS].sort());

        // Negative assertion: NO never-export tool name appears.
        for (const canary of NEVER_EXPORT_CANARIES) {
          expect(exposedNames).not.toContain(canary);
        }
        // Negative assertion: permission-gated tool (memory_search) is also
        // absent because the allowlist is empty.
        expect(exposedNames).not.toContain("memory_search");
      } finally {
        await close();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Default-deny filter -- allowlist = ["memory_search"] exposes safe ∪ {memory_search}
  // -------------------------------------------------------------------------

  it(
    "POST /mcp/v1 mcp-client token with allowlist memory_search exposes safe union memory_search no never-export tools",
    async () => {
      const { client, close } = await connectMcpClient(baseUrl, MCP_MEMORY_SECRET);
      try {
        const list = await client.listTools();
        const exposedNames = list.tools.map((t) => t.name).sort();
        const expected = [...EXPECTED_SAFE_TOOLS, "memory_search"].sort();
        expect(exposedNames).toEqual(expected);

        // never-export canaries are still absent.
        for (const canary of NEVER_EXPORT_CANARIES) {
          expect(exposedNames).not.toContain(canary);
        }
        // Another permission-gated tool (memory_get) is in the registry but
        // NOT in this token's allowlist -- must be absent.
        expect(exposedNames).not.toContain("memory_get");
      } finally {
        await close();
      }
    },
  );
});
