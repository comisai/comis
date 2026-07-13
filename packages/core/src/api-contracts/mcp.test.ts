// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the MCP-domain contracts.
 *
 * Mirrors the structure of `packages/core/src/api-contracts/tokens.test.ts`
 * (closest analog by admin-only + 6-method scope including record-shaped
 * optional fields).
 *
 * MCP RPC methods are managed via the web SPA only (no CLI consumer for
 * `mcp.list|status|connect|disconnect|reconnect|test` in
 * `packages/cli/src/commands/`). The CLI's `comis mcp` surface touches
 * `config.read` / `config.patch` (managing `integrations.mcp.servers`
 * entries) — NOT these admin RPCs. This test exercises the contract-side
 * surface only.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  McpListContract,
  McpStatusContract,
  McpConnectContract,
  McpDisconnectContract,
  McpReconnectContract,
  McpTestContract,
  MCP_CONTRACTS,
} from "./mcp.js";

describe("mcp-domain contracts", () => {
  it("MCP_CONTRACTS has exactly 6 entries (the 6 methods in mcp-handlers.ts)", () => {
    expect(MCP_CONTRACTS.length).toBe(6);
  });

  it("mcp.list: method name is correct", () => {
    expect(McpListContract.method).toBe("mcp.list");
  });

  it("mcp.status: method name is correct", () => {
    expect(McpStatusContract.method).toBe("mcp.status");
  });

  it("mcp.connect: method name is correct", () => {
    expect(McpConnectContract.method).toBe("mcp.connect");
  });

  it("mcp.disconnect: method name is correct", () => {
    expect(McpDisconnectContract.method).toBe("mcp.disconnect");
  });

  it("mcp.reconnect: method name is correct", () => {
    expect(McpReconnectContract.method).toBe("mcp.reconnect");
  });

  it("mcp.test: method name is correct", () => {
    expect(McpTestContract.method).toBe("mcp.test");
  });

  it("all 6 contracts are admin-scoped (mirrors setup-gateway-api.ts:284-287)", () => {
    expect(McpListContract.scopes).toEqual(["admin"]);
    expect(McpStatusContract.scopes).toEqual(["admin"]);
    expect(McpConnectContract.scopes).toEqual(["admin"]);
    expect(McpDisconnectContract.scopes).toEqual(["admin"]);
    expect(McpReconnectContract.scopes).toEqual(["admin"]);
    expect(McpTestContract.scopes).toEqual(["admin"]);
  });

  // --- mcp.list ------------------------------------------------------------

  it("mcp.list: request accepts an empty object", () => {
    expect(() => McpListContract.request.parse({})).not.toThrow();
  });

  it("mcp.list: response accepts an empty servers array", () => {
    expect(() =>
      McpListContract.response.parse({ servers: [], total: 0 }),
    ).not.toThrow();
  });

  it("mcp.list: response accepts a minimal server row", () => {
    expect(() =>
      McpListContract.response.parse({
        servers: [
          {
            name: "ctx7",
            status: "connected",
            toolCount: 2,
            lastHealthCheck: 1_700_000_000_000,
            reconnectAttempt: 0,
          },
        ],
        total: 1,
      }),
    ).not.toThrow();
  });

  it("mcp.list: response accepts a row with capabilities + serverVersion", () => {
    expect(() =>
      McpListContract.response.parse({
        servers: [
          {
            name: "ctx7",
            status: "connected",
            toolCount: 2,
            lastHealthCheck: 1_700_000_000_000,
            reconnectAttempt: 0,
            capabilities: { tools: {}, resources: {} },
            serverVersion: { name: "ctx7-impl", version: "2.0.0" },
          },
        ],
        total: 1,
      }),
    ).not.toThrow();
  });

  it("mcp.list: response rejects rows missing required status", () => {
    expect(() =>
      McpListContract.response.parse({
        servers: [{ name: "x", toolCount: 0, lastHealthCheck: 0, reconnectAttempt: 0 }],
        total: 1,
      }),
    ).toThrow();
  });

  it("mcp.list: response rejects unknown status enum values", () => {
    expect(() =>
      McpListContract.response.parse({
        servers: [
          {
            name: "x",
            status: "bogus",
            toolCount: 0,
            lastHealthCheck: 0,
            reconnectAttempt: 0,
          },
        ],
        total: 1,
      }),
    ).toThrow();
  });

  // --- mcp.status ----------------------------------------------------------

  it("mcp.status: request requires server_name", () => {
    expect(() => McpStatusContract.request.parse({})).toThrow();
  });

  it("mcp.status: request rejects empty-string server_name (min(1))", () => {
    expect(() =>
      McpStatusContract.request.parse({ server_name: "" }),
    ).toThrow();
  });

  it("mcp.status: request accepts non-empty server_name", () => {
    expect(() =>
      McpStatusContract.request.parse({ server_name: "ctx7" }),
    ).not.toThrow();
  });

  it("mcp.status: response accepts a full-detail row", () => {
    expect(() =>
      McpStatusContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 1,
        tools: [
          { name: "search", qualifiedName: "mcp:ctx7/search", callableName: "mcp__ctx7--search", description: "Search docs" },
        ],
        lastHealthCheck: 1_700_000_000_000,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        generation: 0,
        instructions: "Use search",
        capabilities: { tools: {}, resources: {} },
        serverVersion: { name: "ctx7-impl", version: "1.2.3" },
      }),
    ).not.toThrow();
  });

  it("mcp.status: response accepts minimal (no optional fields)", () => {
    expect(() =>
      McpStatusContract.response.parse({
        name: "basic",
        status: "connected",
        toolCount: 0,
        tools: [],
        lastHealthCheck: 1_700_000_000_000,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
        generation: 0,
      }),
    ).not.toThrow();
  });

  it("mcp.status: response rejects rows missing required generation", () => {
    expect(() =>
      McpStatusContract.response.parse({
        name: "x",
        status: "connected",
        toolCount: 0,
        tools: [],
        lastHealthCheck: 0,
        reconnectAttempt: 0,
        maxReconnectAttempts: 5,
      }),
    ).toThrow();
  });

  // --- mcp.connect ---------------------------------------------------------

  it("mcp.connect: request requires server_name + transport", () => {
    expect(() => McpConnectContract.request.parse({})).toThrow();
    expect(() =>
      McpConnectContract.request.parse({ server_name: "x" }),
    ).toThrow();
    expect(() =>
      McpConnectContract.request.parse({ transport: "stdio" }),
    ).toThrow();
  });

  it("mcp.connect: request rejects empty-string server_name (min(1))", () => {
    expect(() =>
      McpConnectContract.request.parse({ server_name: "", transport: "stdio" }),
    ).toThrow();
  });

  it("mcp.connect: request rejects unknown transport enum values", () => {
    expect(() =>
      McpConnectContract.request.parse({
        server_name: "x",
        transport: "websocket",
      }),
    ).toThrow();
  });

  it("mcp.connect: request accepts stdio with command + args", () => {
    expect(() =>
      McpConnectContract.request.parse({
        server_name: "ctx7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      }),
    ).not.toThrow();
  });

  it("mcp.connect: request accepts http with url + headers (record allowlist shape)", () => {
    expect(() =>
      McpConnectContract.request.parse({
        server_name: "authed",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token123" },
      }),
    ).not.toThrow();
  });

  it("mcp.connect: request accepts env record (allowlist shape)", () => {
    expect(() =>
      McpConnectContract.request.parse({
        server_name: "finnhub",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-finnhub"],
        env: { FINNHUB_API_KEY: "${FINNHUB_API_KEY}" },
      }),
    ).not.toThrow();
  });

  it("mcp.connect: request rejects non-string env values", () => {
    expect(() =>
      McpConnectContract.request.parse({
        server_name: "bad",
        transport: "stdio",
        env: { FOO: 42 },
      }),
    ).toThrow();
  });

  it("mcp.connect: response shape — { name, status, toolCount, tools: string[] }", () => {
    expect(() =>
      McpConnectContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 2,
        tools: ["search", "resolve"],
      }),
    ).not.toThrow();
  });

  it("mcp.connect: response rejects non-string-array tools (handler maps to string[])", () => {
    expect(() =>
      McpConnectContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 1,
        tools: [{ name: "search" }],
      }),
    ).toThrow();
  });

  // ───────────────────────────────────────────────────────────────────────
  // mcp.connect persistence + warning response fields (additive)
  // ───────────────────────────────────────────────────────────────────────

  it("mcp.connect: response accepts persistence:'persisted' (no warning)", () => {
    expect(() =>
      McpConnectContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 2,
        tools: ["s"],
        persistence: "persisted",
      }),
    ).not.toThrow();
  });

  it("mcp.connect: response accepts persistence:'runtime_only' with warning string", () => {
    expect(() =>
      McpConnectContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 2,
        tools: ["s"],
        persistence: "runtime_only",
        warning: "EACCES: write failed",
      }),
    ).not.toThrow();
  });

  it("mcp.connect: response accepts persistence:'skipped' (no warning)", () => {
    expect(() =>
      McpConnectContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 2,
        tools: ["s"],
        persistence: "skipped",
      }),
    ).not.toThrow();
  });

  it("mcp.connect: response rejects unknown persistence enum value", () => {
    expect(() =>
      McpConnectContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 2,
        tools: ["s"],
        persistence: "bogus",
      }),
    ).toThrow();
  });

  it("mcp.connect: response rejects non-string warning value", () => {
    expect(() =>
      McpConnectContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 2,
        tools: ["s"],
        persistence: "runtime_only",
        warning: 42 as unknown as string,
      }),
    ).toThrow();
  });

  // --- mcp.disconnect ------------------------------------------------------

  it("mcp.disconnect: request requires server_name", () => {
    expect(() => McpDisconnectContract.request.parse({})).toThrow();
  });

  it("mcp.disconnect: request rejects empty-string server_name (min(1))", () => {
    expect(() =>
      McpDisconnectContract.request.parse({ server_name: "" }),
    ).toThrow();
  });

  it("mcp.disconnect: request accepts non-empty server_name", () => {
    expect(() =>
      McpDisconnectContract.request.parse({ server_name: "ctx7" }),
    ).not.toThrow();
  });

  it("mcp.disconnect: response shape — { name, status: 'disconnected' }", () => {
    expect(() =>
      McpDisconnectContract.response.parse({
        name: "ctx7",
        status: "disconnected",
      }),
    ).not.toThrow();
  });

  it("mcp.disconnect: response rejects status: 'connected' (handler ALWAYS returns 'disconnected' on success)", () => {
    // The handler returns `{ name, status: "disconnected" }` ONLY on
    // success (mcp-handlers.ts line 138); failure paths (server not
    // found) throw before the return. The contract therefore models the
    // success-path shape with `status: z.literal("disconnected")` rather
    // than the broader McpConnectionStatusEnum.
    expect(() =>
      McpDisconnectContract.response.parse({
        name: "ctx7",
        status: "connected",
      }),
    ).toThrow();
  });

  // ───────────────────────────────────────────────────────────────────────
  // mcp.disconnect persistence + warning response fields (additive)
  // ───────────────────────────────────────────────────────────────────────

  it("mcp.disconnect: response accepts persistence:'persisted' (no warning)", () => {
    expect(() =>
      McpDisconnectContract.response.parse({
        name: "ctx7",
        status: "disconnected",
        persistence: "persisted",
      }),
    ).not.toThrow();
  });

  it("mcp.disconnect: response accepts persistence:'runtime_only' with warning string", () => {
    expect(() =>
      McpDisconnectContract.response.parse({
        name: "ctx7",
        status: "disconnected",
        persistence: "runtime_only",
        warning: "ENOENT: config.yaml missing",
      }),
    ).not.toThrow();
  });

  it("mcp.disconnect: response accepts persistence:'skipped' (no warning)", () => {
    expect(() =>
      McpDisconnectContract.response.parse({
        name: "ctx7",
        status: "disconnected",
        persistence: "skipped",
      }),
    ).not.toThrow();
  });

  it("mcp.disconnect: response rejects unknown persistence enum value", () => {
    expect(() =>
      McpDisconnectContract.response.parse({
        name: "ctx7",
        status: "disconnected",
        persistence: "bogus",
      }),
    ).toThrow();
  });

  it("mcp.disconnect: response rejects non-string warning value", () => {
    expect(() =>
      McpDisconnectContract.response.parse({
        name: "ctx7",
        status: "disconnected",
        persistence: "runtime_only",
        warning: { msg: "object" } as unknown as string,
      }),
    ).toThrow();
  });

  // --- mcp.reconnect -------------------------------------------------------

  it("mcp.reconnect: request requires server_name", () => {
    expect(() => McpReconnectContract.request.parse({})).toThrow();
  });

  it("mcp.reconnect: request rejects empty-string server_name (min(1))", () => {
    expect(() =>
      McpReconnectContract.request.parse({ server_name: "" }),
    ).toThrow();
  });

  it("mcp.reconnect: request accepts minimal { server_name } (uses stored config)", () => {
    expect(() =>
      McpReconnectContract.request.parse({ server_name: "ctx7" }),
    ).not.toThrow();
  });

  it("mcp.reconnect: request accepts fallback config (transport + url + headers)", () => {
    expect(() =>
      McpReconnectContract.request.parse({
        server_name: "recon-srv",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer recon-token" },
      }),
    ).not.toThrow();
  });

  it("mcp.reconnect: response shape mirrors mcp.connect", () => {
    expect(() =>
      McpReconnectContract.response.parse({
        name: "ctx7",
        status: "connected",
        toolCount: 1,
        tools: ["search"],
      }),
    ).not.toThrow();
  });

  // --- mcp.test ------------------------------------------------------------

  it("mcp.test: request requires name + transport (NOTE: param is 'name' not 'server_name' — handler line 142)", () => {
    expect(() => McpTestContract.request.parse({})).toThrow();
    expect(() => McpTestContract.request.parse({ name: "x" })).toThrow();
    expect(() =>
      McpTestContract.request.parse({ transport: "stdio" }),
    ).toThrow();
  });

  it("mcp.test: request rejects empty-string name (min(1))", () => {
    expect(() =>
      McpTestContract.request.parse({ name: "", transport: "stdio" }),
    ).toThrow();
  });

  it("mcp.test: request rejects 'server_name' (handler reads 'name' for test only)", () => {
    // Belt-and-suspenders test: the contract `name` field is intentional;
    // a caller passing `server_name` would be rejected by `.parse()` for
    // missing `name`. This codifies the handler-reality at the contract
    // level so future drift surfaces immediately.
    expect(() =>
      McpTestContract.request.parse({
        server_name: "ctx7",
        transport: "stdio",
      }),
    ).toThrow();
  });

  it("mcp.test: request accepts minimal stdio probe", () => {
    expect(() =>
      McpTestContract.request.parse({
        name: "ctx7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      }),
    ).not.toThrow();
  });

  it("mcp.test: request accepts http probe with headers", () => {
    expect(() =>
      McpTestContract.request.parse({
        name: "remote",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headers: { "X-API-Key": "test-key" },
      }),
    ).not.toThrow();
  });

  it("mcp.test: response accepts success path { success: true, toolCount, tools }", () => {
    expect(() =>
      McpTestContract.response.parse({
        success: true,
        toolCount: 2,
        tools: ["search", "resolve"],
      }),
    ).not.toThrow();
  });

  it("mcp.test: response accepts failure path { success: false, error }", () => {
    expect(() =>
      McpTestContract.response.parse({
        success: false,
        error: "ENOENT: npx not found",
      }),
    ).not.toThrow();
  });

  it("mcp.test: response requires success field", () => {
    expect(() =>
      McpTestContract.response.parse({ toolCount: 0, tools: [] }),
    ).toThrow();
  });

  it("mcp.test: response rejects non-boolean success", () => {
    expect(() =>
      McpTestContract.response.parse({ success: "true" }),
    ).toThrow();
  });
});
