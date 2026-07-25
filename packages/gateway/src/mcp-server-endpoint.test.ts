// SPDX-License-Identifier: Apache-2.0
/**
 * mountMcpServerEndpoint body-size limit tests.
 *
 * Enforces that POST /mcp/v1 honors a bodyLimit middleware before the route
 * handler buffers the request body. Without this gate, a holder of any valid
 * `mcp-client`-scoped token can POST a multi-gigabyte body and the daemon's
 * heap allocates proportional memory per concurrent request
 * (`c.req.json()` buffers the entire body before parsing).
 *
 * The fix mounts a `bodyLimit({ maxSize: deps.bodyLimitBytes })` middleware
 * on the route — same posture as `rest-api.ts` does for POST /api/chat
 * (see `packages/gateway/src/web/rest-api.ts:329-337`).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
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
 * Uses an in-memory token store with a single `mcp-client`-scoped token by
 * default; supply `tokenScopes` to override (e.g., `["*", "mcp-client"]` for
 * wildcard runtime-gate tests).
 */
function mountForTest(opts: {
  bodyLimitBytes: number;
  buildMcpServerForClient?: McpServerEndpointDeps["buildMcpServerForClient"];
  tokenScopes?: string[];
}): { app: Hono; token: string } {
  const token = "x".repeat(64);
  const scopes = opts.tokenScopes ?? ["mcp-client"];
  const tokenStore = createTokenStore([
    {
      id: "mcp-test",
      secret: token,
      scopes,
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

describe("mountMcpServerEndpoint -- auth gates", () => {
  it("Gate 1 rejects POST /mcp/v1 with no Authorization header (401)", async () => {
    const factorySpy = vi.fn(makeNoopBuildMcpServer());
    const { app } = mountForTest({
      bodyLimitBytes: 1_048_576,
      buildMcpServerForClient: factorySpy,
    });

    const res = await app.request("/mcp/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(401);
    expect(factorySpy).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      error?: { code?: number; message?: string };
    };
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toBe("Unauthorized");
  });

  it("Gate 2 rejects POST /mcp/v1 with an unrecognized bearer token (401)", async () => {
    const factorySpy = vi.fn(makeNoopBuildMcpServer());
    const { app } = mountForTest({
      bodyLimitBytes: 1_048_576,
      buildMcpServerForClient: factorySpy,
    });

    const res = await app.request("/mcp/v1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${"z".repeat(64)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(401);
    expect(factorySpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("Unauthorized");
  });

  it("Gate 3 rejects a valid token lacking the mcp-client scope (403)", async () => {
    const factorySpy = vi.fn(makeNoopBuildMcpServer());
    const { app, token } = mountForTest({
      bodyLimitBytes: 1_048_576,
      tokenScopes: ["rpc"],
      buildMcpServerForClient: factorySpy,
    });

    const res = await app.request("/mcp/v1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(403);
    expect(factorySpy).not.toHaveBeenCalled();
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe("Insufficient scope");
  });
});

describe("mountMcpServerEndpoint -- McpServer initialization failure", () => {
  it("returns 500 with a JSON-RPC error envelope when buildMcpServerForClient throws", async () => {
    const factorySpy = vi.fn(() => {
      throw new Error("registry exploded");
    });
    const { app, token } = mountForTest({
      bodyLimitBytes: 1_048_576,
      buildMcpServerForClient:
        factorySpy as unknown as McpServerEndpointDeps["buildMcpServerForClient"],
    });

    const res = await app.request("/mcp/v1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    // The factory throw is caught and mapped to a 500 with the JSON-RPC
    // initialization-failed envelope (errorKind:"internal").
    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error?: { code?: number; message?: string };
    };
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toBe("MCP server initialization failed");
  });
});

describe("mountMcpServerEndpoint -- body-size limit", () => {
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

    // Contract: bodyLimit fires BEFORE the route handler buffers the
    // body via c.req.json(). 413 is the canonical Hono bodyLimit status.
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

// ---------------------------------------------------------------------------
// Runtime Gate 4 must reject wildcard "*" alongside admin
//
// `client.scopes.includes("admin")` was the original Gate 4 check.
// `checkScope` treats `"*"` as a wildcard that grants ALL scopes including
// "admin", so a token with `["*", "mcp-client"]` has admin-equivalent
// access AND mcp-client access -- the exact privilege-escalation pathway
// the disjointness invariant prevents.
//
// The runtime gate must reject admin-EQUIVALENT scopes (`"admin"` OR `"*"`)
// in addition to literal `"admin"`. Defense-in-depth: a config-load bypass
// should not silently let a wildcard-scoped token reach the McpServer factory.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Response-already-sent contract (regression: ERR_HTTP_HEADERS_SENT double-write)
//
// The MCP SDK's StreamableHTTPServerTransport writes the FULL response (SSE or
// JSON) directly on the raw Node ServerResponse (`c.env.outgoing`). The route
// handler must therefore return a Response that tells `@hono/node-server` to
// leave `outgoing` untouched (the `x-hono-already-sent` sentinel). Returning a
// plain `c.body(null)` instead makes the node adapter call `outgoing.writeHead`
// a SECOND time — throwing `ERR_HTTP_HEADERS_SENT` and destroying the socket
// mid-response, which corrupts/truncates every MCP reply.
//
// The `app.request()` harness used by the tests above never runs through the
// real node adapter (no `c.env.incoming/outgoing`), so it cannot observe this
// double-write. This block boots a real `@hono/node-server` listener and drives
// a real POST /mcp/v1 so the adapter's response path executes.
// ---------------------------------------------------------------------------

function serveMountedApp(opts: {
  bodyLimitBytes?: number;
  tokenScopes?: string[];
}): Promise<{ baseUrl: string; token: string; close: () => Promise<void> }> {
  const { app, token } = mountForTest({
    bodyLimitBytes: opts.bodyLimitBytes ?? 1_048_576,
    tokenScopes: opts.tokenScopes,
  });
  return new Promise((resolvePromise) => {
    const server = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      (info: AddressInfo) => {
        resolvePromise({
          baseUrl: `http://127.0.0.1:${info.port}`,
          token,
          close: () =>
            new Promise<void>((res, rej) =>
              server.close((err) => (err ? rej(err) : res())),
            ),
        });
      },
    );
  });
}

describe("mountMcpServerEndpoint -- response-already-sent (no double-write)", () => {
  it("does not re-write headers after the SDK transport sent the response", async () => {
    // `@hono/node-server` logs the double-write failure via `console.error(err)`
    // (err.code === 'ERR_HTTP_HEADERS_SENT'). Capture those calls; the contract
    // is that NONE fire.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { baseUrl, token, close } = await serveMountedApp({});
    let fetchError: unknown;
    let status = 0;
    let body = "";
    try {
      const res = await fetch(`${baseUrl}/mcp/v1`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          // StreamableHTTP requires BOTH content types in Accept.
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "double-write-regression", version: "0.0.0" },
          },
        }),
      });
      status = res.status;
      body = await res.text();
    } catch (err) {
      // A torn-down socket (outgoing.destroy after the failed second write)
      // surfaces here as a fetch network error on some timings.
      fetchError = err;
    } finally {
      // Let the node adapter's post-handler write attempt settle onto the
      // microtask/tick queue so a late console.error is captured before assert.
      await new Promise((r) => setTimeout(r, 50));
      await close();
    }

    const headerErrors = consoleErrorSpy.mock.calls.filter((callArgs) =>
      callArgs.some(
        (a) =>
          a instanceof Error &&
          ((a as NodeJS.ErrnoException).code === "ERR_HTTP_HEADERS_SENT" ||
            a.message.includes("Cannot write headers")),
      ),
    );
    consoleErrorSpy.mockRestore();

    // Primary, deterministic pin: the node adapter must never attempt a second
    // writeHead on the transport-owned ServerResponse.
    expect(headerErrors).toEqual([]);
    // The transport-written response must reach the client intact.
    expect(fetchError).toBeUndefined();
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("mountMcpServerEndpoint -- wildcard admin-equivalent runtime gate", () => {
  it("mountMcpServerEndpoint Gate 4 rejects a token with wildcard star and mcp-client co-issued", async () => {
    const factorySpy = vi.fn(() =>
      new McpServer(
        { name: "test", version: "0.0.0" },
        { capabilities: { tools: {}, resources: { subscribe: false } } },
      ),
    );
    // The wildcard "*" satisfies checkScope(scopes, "admin") yet was not
    // rejected by the literal `includes("admin")` check — the runtime gate
    // closes this hole.
    const { app, token } = mountForTest({
      bodyLimitBytes: 1_048_576,
      tokenScopes: ["*", "mcp-client"],
      buildMcpServerForClient: factorySpy,
    });

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

    // Gate 4 fires BEFORE the McpServer factory. The factory must NOT be
    // called; the response is HTTP 403 with the disjoint-scope JSON-RPC
    // error envelope.
    expect(factorySpy).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error?: { code?: number; message?: string };
    };
    expect(body.error?.message).toMatch(/disjoint-scope/i);
  });
});
