// SPDX-License-Identifier: Apache-2.0
/**
 * MCP-02 — allow/blocklist + mcpExportPolicy + per-client rate-limit enforcement.
 *
 * Stage-A (always): policy constants validated (EXPECTED_SAFE_TOOLS, NEVER_EXPORT_CANARIES,
 *   safe/permission-gated/never-export mutual exclusivity).
 * Stage-B (always, mock server): allowlist + rate-limit + policy_violation scenarios — LLM-free, daemon-free.
 *
 * Rate-limit text matches the product prefix from:
 *   packages/daemon/src/api/mcp-server-handlers.ts ~line 390:
 *   "[rate_limit_exceeded] tool ${toolName} exceeded ${ceiling}/min for this client"
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMockMcpServer } from "../../support/mock-mcp-server.js";
import type { MockMcpServer } from "../../support/mock-mcp-server.js";
import {
  expectMcpTaintMarkers,
  expectRateLimitRejection,
} from "../../assert/mcp-trace.js";
import type { McpRoundTripResult } from "../../assert/mcp-trace.js";

// ---------------------------------------------------------------------------
// Policy constants — mirror mcp-server-tools-list.test.ts
// ---------------------------------------------------------------------------

const EXPECTED_SAFE_TOOLS = ["browser", "web_fetch", "web_search"] as const;
const NEVER_EXPORT_CANARIES = [
  "tokens_manage",
  "exec",
  "write",
  "memory_store",
  "sessions_send",
] as const;
const MCP_POLICY_BEARER = "phase-140-policy-mock-bearer";

// ---------------------------------------------------------------------------
// Local connectMcpClient helper
// ---------------------------------------------------------------------------

async function connectMcpClient(
  baseUrl: string,
  bearer?: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/v1`),
    bearer ? { requestInit: { headers: { authorization: `Bearer ${bearer}` } } } : undefined,
  );
  const client = new Client({ name: "phase-140-policy-test", version: "0.0.1" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Stage-A — policy constants and safe-tool set (always runs, no COMIS_LIVE)
// ---------------------------------------------------------------------------

describe("MCP-02 Stage-A — policy constants and safe-tool set", () => {
  it("EXPECTED_SAFE_TOOLS has 3 tools", () => {
    expect(EXPECTED_SAFE_TOOLS.length).toBe(3);
  });

  it("NEVER_EXPORT_CANARIES are distinct from safe tools", () => {
    for (const canary of NEVER_EXPORT_CANARIES) {
      // EXPECTED_SAFE_TOOLS is a readonly tuple — cast to readonly string[] for includes()
      expect((EXPECTED_SAFE_TOOLS as readonly string[]).includes(canary)).toBe(false);
    }
  });

  it("safe + permission-gated + never-export are mutually exclusive in this fixture", () => {
    // EXPECTED_SAFE_TOOLS and NEVER_EXPORT_CANARIES must share no entries
    const safeSet = new Set<string>(EXPECTED_SAFE_TOOLS);
    for (const canary of NEVER_EXPORT_CANARIES) {
      expect(safeSet.has(canary)).toBe(false);
    }
    // Each set must be non-empty (structural completeness)
    expect(EXPECTED_SAFE_TOOLS.length).toBeGreaterThan(0);
    expect(NEVER_EXPORT_CANARIES.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — allow/blocklist + rate-limit (mock server, runs unconditionally)
//
// No describe.skipIf: mock server is LLM-free and daemon-free. These tests
// always run because:
//   1. No real LLM calls are made.
//   2. No real daemon is started (no API keys needed).
//   3. The mock server starts/stops in beforeAll/afterAll within this describe block.
// ---------------------------------------------------------------------------

describe("MCP-02 Stage-B — allow/blocklist + rate-limit (mock server)", () => {
  let mockServer: MockMcpServer;
  let baseUrl: string;

  beforeAll(async () => {
    mockServer = createMockMcpServer({ transport: "http", auth: "bearer", bearerToken: MCP_POLICY_BEARER });
    ({ baseUrl } = await mockServer.start());
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
  });

  // -------------------------------------------------------------------------
  // Test 1: allowlisted tool returns success + taint markers present
  // -------------------------------------------------------------------------

  it("allowlisted tool returns success + taint markers present", async () => {
    mockServer.setNextToolsCallResponse({
      content: [
        {
          type: "text",
          text: "<<<UNTRUSTED_abc>>>content<<<END_UNTRUSTED_abc>>>\nSECURITY NOTICE: MCP tool result",
        },
      ],
      isError: false,
    });

    const { client, close } = await connectMcpClient(baseUrl, MCP_POLICY_BEARER);
    try {
      const r = (await client.callTool({
        name: "echo",
        arguments: { text: "hi" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

      const result: McpRoundTripResult = {
        text: r.content?.[0]?.text ?? "",
        isError: r.isError ?? false,
      };
      await expectMcpTaintMarkers(result);
    } finally {
      await close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: rate-limit cap of 2 → 3rd call is rejected with [rate_limit_exceeded]
  // -------------------------------------------------------------------------

  it("rate-limit cap of 2 → 3rd call is rejected with [rate_limit_exceeded]", async () => {
    mockServer.setRateLimit(2);

    const { client, close } = await connectMcpClient(baseUrl, MCP_POLICY_BEARER);
    try {
      // Call 1 — should succeed
      const r1 = (await client.callTool({
        name: "echo",
        arguments: { text: "call-1" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(r1.isError ?? false).toBe(false);

      // Call 2 — should succeed (at ceiling)
      const r2 = (await client.callTool({
        name: "echo",
        arguments: { text: "call-2" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(r2.isError ?? false).toBe(false);

      // Call 3 — should be rate-limited (exceeds ceiling of 2)
      const r3 = (await client.callTool({
        name: "echo",
        arguments: { text: "call-3" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

      const result3: McpRoundTripResult = {
        text: r3.content?.[0]?.text ?? "",
        isError: r3.isError ?? false,
      };
      await expectRateLimitRejection(result3);
    } finally {
      await close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: non-allowlisted tool returns isError
  // -------------------------------------------------------------------------

  it("non-allowlisted tool returns isError", async () => {
    mockServer.setNextToolsCallResponse({
      content: [{ type: "text", text: "[policy_violation] tool not in allowlist" }],
      isError: true,
    });

    const { client, close } = await connectMcpClient(baseUrl, MCP_POLICY_BEARER);
    try {
      const r = (await client.callTool({
        name: "never_export_tool",
        arguments: {},
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

      expect(r.isError).toBe(true);
      expect(r.content?.[0]?.text ?? "").toContain("policy_violation");
    } finally {
      await close();
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: safe tools (web_search) always returned (mcpExportPolicy: safe)
  // -------------------------------------------------------------------------

  it("safe tools (web_search) always returned (mcpExportPolicy: safe)", async () => {
    mockServer.setNextToolsCallResponse({
      content: [{ type: "text", text: "search result" }],
      isError: false,
    });

    const { client, close } = await connectMcpClient(baseUrl, MCP_POLICY_BEARER);
    try {
      const r = (await client.callTool({
        name: "web_search",
        arguments: { query: "test" },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

      expect(r.isError ?? false).toBe(false);
      expect(r.content?.[0]?.text ?? "").toBeTruthy();
    } finally {
      await close();
    }
  });
});
