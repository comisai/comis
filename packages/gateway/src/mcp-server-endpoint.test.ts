// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 69 CR-02 -- mountMcpServerEndpoint body-size limit tests.
 *
 * RED → GREEN: enforces that POST /mcp/v1 honors a bodyLimit middleware
 * before the route handler buffers the request body. Without this gate, a
 * holder of any valid `mcp-client`-scoped token can POST a multi-gigabyte
 * body and the daemon's heap allocates proportional memory per concurrent
 * request (`c.req.json()` buffers the entire body before parsing).
 *
 * The fix mounts a `bodyLimit({ maxSize: deps.bodyLimitBytes })` middleware
 * on the route — same posture as `rest-api.ts` does for POST /api/chat
 * (see `packages/gateway/src/web/rest-api.ts:329-337`).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  mountMcpServerEndpoint,
  type McpServerEndpointDeps,
} from "./mcp-server-endpoint.js";
import { createTokenStore, type TokenClient } from "./auth/token-auth.js";
import type { GatewayLogger } from "./server/gateway-logger.js";
import { createMockLogger as _createMockLogger } from "../../../test/support/mock-logger.js";

const createMockLogger = (): GatewayLogger =>
  _createMockLogger() as unknown as GatewayLogger;

/**
 * Construct a real McpServer with no tools registered. The body-limit
 * middleware fires BEFORE the route handler reads the body, so the McpServer
 * factory is irrelevant for this test — we only need a non-null value to
 * satisfy the deps shape; the route should reject 413 before ever calling
 * `buildMcpServerForClient(client)`.
 */
function makeNoopBuildMcpServer(): (client: TokenClient) => McpServer {
  return (_client) =>
    new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {}, resources: { subscribe: false } } },
    );
}

/**
 * Mount the endpoint on a fresh Hono app with the supplied bodyLimitBytes.
 * Uses an in-memory token store with a single `mcp-client`-scoped token.
 */
function mountForTest(opts: {
  bodyLimitBytes: number;
  buildMcpServerForClient?: McpServerEndpointDeps["buildMcpServerForClient"];
}): { app: Hono; token: string } {
  const token = "x".repeat(64);
  const tokenStore = createTokenStore([
    {
      id: "mcp-test",
      secret: token,
      scopes: ["mcp-client"],
      mcpClient: { allowlist: [], sessionAllowlist: [], toolRateLimit: {} },
    },
  ]);

  const app = new Hono();
  mountMcpServerEndpoint(
    app as unknown as Parameters<typeof mountMcpServerEndpoint>[0],
    {
      tokenStore,
      buildMcpServerForClient:
        opts.buildMcpServerForClient ?? makeNoopBuildMcpServer(),
      logger: createMockLogger(),
      bodyLimitBytes: opts.bodyLimitBytes,
    },
  );
  return { app, token };
}

describe("mountMcpServerEndpoint -- CR-02 body-size limit", () => {
  it("mountMcpServerEndpoint rejects POST /mcp/v1 with a body larger than the configured bodyLimitBytes with 413", async () => {
    const { app, token } = mountForTest({ bodyLimitBytes: 256 });

    // Craft a JSON-RPC body well over 256 bytes. Set Content-Length so the
    // bodyLimit middleware can short-circuit before buffering.
    const padding = "x".repeat(512);
    const jsonBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: { padding },
    });

    const res = await app.request("/mcp/v1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(jsonBody)),
      },
      body: jsonBody,
    });

    // The CR-02 contract is: bodyLimit fires BEFORE the route handler
    // buffers the body via c.req.json(). 413 is the canonical Hono
    // bodyLimit response status.
    expect(res.status).toBe(413);
  });

  it("mountMcpServerEndpoint accepts POST /mcp/v1 with a body within the configured bodyLimitBytes", async () => {
    // Track whether the route's downstream handler is reached -- a small
    // body should pass the bodyLimit gate and fall through to the
    // buildMcpServerForClient factory (which we record).
    const factorySpy = vi.fn(() =>
      new McpServer(
        { name: "test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: { subscribe: false } } },
      ),
    );
    const { app, token } = mountForTest({
      bodyLimitBytes: 4096,
      buildMcpServerForClient: factorySpy,
    });

    // A 50-byte payload comfortably under the 4096-byte ceiling.
    const jsonBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
    });

    const res = await app.request("/mcp/v1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(jsonBody)),
      },
      body: jsonBody,
    });

    // The body-limit gate passed -- the route reached the McpServer factory.
    // The SDK transport may or may not produce a meaningful response in this
    // unit-test path (no c.env.incoming/outgoing in Hono's app.request), so
    // we assert on the GATE not the SDK happy-path: status is NOT 413.
    expect(res.status).not.toBe(413);
    expect(factorySpy).toHaveBeenCalledTimes(1);
  });
});
