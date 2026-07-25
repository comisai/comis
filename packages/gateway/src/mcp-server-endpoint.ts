// SPDX-License-Identifier: Apache-2.0
/**
 * POST /mcp/v1 endpoint mount.
 *
 * Mounts the Streamable HTTP MCP server route on the gateway's Hono app.
 * Per-request lifecycle:
 *
 *   1. Extract bearer via `extractBearerToken(c.req.header("authorization"))`.
 *   2. `tokenStore.verify(token)` — null ⇒ 401 (errorKind:"auth").
 *   3. `checkScope(client.scopes, "mcp-client")` — false ⇒ 403
 *      (errorKind:"auth").
 *   4. `client.scopes.includes("admin")` ⇒ 403 (errorKind:"security"). This
 *      is defense-in-depth: the `.refine` on `GatewayTokenSchema`
 *      already blocks co-issuance at config-load. If this branch fires,
 *      something has bypassed schema validation (a config-validation bug).
 *   5. `mcp = deps.buildMcpServerForClient(client)` — per-client McpServer
 *      with default-deny tools/list filter (the policy gate runs inside the
 *      factory; see `packages/daemon/src/api/mcp-server-handlers.ts`).
 *   6. `transport = new StreamableHTTPServerTransport({ sessionIdGenerator })`
 *      → `mcp.connect(transport)` → `transport.handleRequest(req, res,
 *      parsedBody)`.
 *
 * Hono c.env accessor:
 *   The `@hono/node-server@2.0.11` `HttpBindings` type declares
 *   `{ incoming: IncomingMessage; outgoing: ServerResponse }`. Verified by
 *   reading `node_modules/@hono/node-server/dist/types.d.ts` directly.
 *
 * Body parsing (body pre-parse pitfall): Hono pre-parses POST bodies on demand. The
 * SDK transport's `handleRequest(req, res, parsedBody?)` accepts a
 * pre-parsed body as the 3rd arg; pass `await c.req.json().catch(() =>
 * undefined)` so the SDK does not re-read the consumed stream.
 *
 * @module
 */

import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  checkScope,
  extractBearerToken,
  type TokenClient,
  type TokenStore,
} from "./auth/token-auth.js";
import type { GatewayLogger } from "./server/gateway-logger.js";

// ---------------------------------------------------------------------------
// Hono bindings -- @hono/node-server@1.19.14 HttpBindings shape
// ---------------------------------------------------------------------------

/**
 * Hono environment bindings exposed by `@hono/node-server`. Matches the
 * `HttpBindings` type at `node_modules/@hono/node-server/dist/types.d.ts`.
 *
 * Generic-typed locally so the Hono handler can read `c.env.incoming` /
 * `c.env.outgoing` without an `as` cast. Defined inline rather than imported
 * to avoid coupling the gateway to a private `@hono/node-server` subpath
 * (`./types`) — the public package exports HttpBindings only via the bundled
 * types, not a stable runtime entry.
 */
type NodeHttpBindings = {
  incoming: IncomingMessage;
  outgoing: ServerResponse;
};

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Dependencies for mounting `POST /mcp/v1` on a Hono app. */
export interface McpServerEndpointDeps {
  /** Token verification store (TokenClient surfaces the `mcpClient` block). */
  readonly tokenStore: TokenStore;
  /** Per-client McpServer factory — see
   *  `packages/daemon/src/api/mcp-server-handlers.ts`. */
  readonly buildMcpServerForClient: (client: TokenClient) => McpServer;
  /** Gateway-scoped logger. Log calls emit with
   *  `module:"mcp-server"` via the parent binding plus
   *  `submodule:"endpoint"` here. */
  readonly logger: GatewayLogger;
  /**
   * Maximum POST body size in bytes. The Hono `bodyLimit` middleware fires
   * BEFORE the route handler buffers the body via `c.req.json()`, so a
   * holder of a valid mcp-client-scoped token cannot exhaust daemon heap
   * memory by streaming a multi-gigabyte POST body (DoS
   * defense). Mirrors `config.httpBodyLimitBytes` -- the same ceiling
   * `rest-api.ts` applies to POST /api/chat at line 329-337.
   */
  readonly bodyLimitBytes: number;
}

// ---------------------------------------------------------------------------
// Mount function
// ---------------------------------------------------------------------------

/**
 * Mount POST /mcp/v1 on the supplied Hono app.
 *
 * MUST be mounted AFTER the global rate-limit middleware (so layer-1 IP
 * caps apply) and BEFORE the catch-all `app.notFound` handler. The caller
 * (`packages/daemon/src/wiring/...`) is responsible for that ordering;
 * `hono-server.ts` mounts via this helper between rate-limit (~line 124)
 * and the /ws route (~line 147).
 */
export function mountMcpServerEndpoint(
  app: Hono<{ Bindings: NodeHttpBindings }>,
  deps: McpServerEndpointDeps,
): void {
  const { tokenStore, buildMcpServerForClient, logger, bodyLimitBytes } = deps;

  // Body-size limit before c.req.json() buffers the body.
  // Without this gate, a holder of any valid mcp-client-scoped token can
  // POST a multi-gigabyte body and the daemon's heap grows proportionally
  // per concurrent request. The IP-level rate limiter caps request COUNT
  // but not request BYTE COUNT. 413 is the canonical Hono bodyLimit
  // response; we also wrap it in JSON-RPC error shape so MCP-aware clients
  // see a structured response instead of a bare HTTP status.
  const bodyLimitMw = bodyLimit({
    maxSize: bodyLimitBytes,
    onError: (c) =>
      c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32600, message: "Request body too large" },
          id: null,
        },
        413,
      ),
  });

  app.post("/mcp/v1", bodyLimitMw, async (c) => {
    // Gate 1 — extract bearer.
    const token =
      extractBearerToken(c.req.header("authorization") ?? "") ?? "";
    if (token === "") {
      logger.warn(
        {
          submodule: "endpoint",
          errorKind: "auth" as const,
          hint: "Send Authorization: Bearer <token> with an mcp-client-scoped token",
        },
        "MCP server connection rejected: no bearer token",
      );
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        },
        401,
      );
    }

    // Gate 2 — verify token.
    const client = tokenStore.verify(token);
    if (!client) {
      logger.warn(
        {
          submodule: "endpoint",
          errorKind: "auth" as const,
          hint: "Verify the token matches a gateway.tokens[].secret entry",
        },
        "MCP server connection rejected: invalid token",
      );
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        },
        401,
      );
    }

    // Gate 3 — scope check: require "mcp-client".
    if (!checkScope(client.scopes, "mcp-client")) {
      logger.warn(
        {
          clientId: client.id,
          submodule: "endpoint",
          errorKind: "auth" as const,
          hint: "Issue a token with scope mcp-client via tokens_manage; admin scope MUST NOT be co-issued",
        },
        "MCP server connection rejected: token missing mcp-client scope",
      );
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Insufficient scope" },
          id: null,
        },
        403,
      );
    }

    // Gate 4 — defense-in-depth: reject admin-EQUIVALENT + mcp-client
    // co-issuance. GatewayTokenSchema.refine already blocks at
    // config-load; if this branch fires, a config-validation bug let an
    // invalid token through.
    //
    // The wildcard scope `"*"` grants ALL scopes (including `"admin"`) via
    // `checkScope`, so the literal `includes("admin")` check was an
    // information-hole -- a token with `["*", "mcp-client"]` had
    // admin-equivalent access yet passed Gate 4. Reject `"*"` for the same
    // reason `"admin"` is rejected.
    if (client.scopes.includes("admin") || client.scopes.includes("*")) {
      logger.error(
        {
          clientId: client.id,
          submodule: "endpoint",
          errorKind: "internal" as const,
          hint:
            "admin-equivalent scope (admin or wildcard '*') co-issued with mcp-client violates the GatewayTokenSchema disjointness refine -- this should be impossible; investigate config-load validation",
        },
        "Refusing MCP connection from admin-equivalent-scoped token (defense-in-depth)",
      );
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Token has disjoint-scope violation",
          },
          id: null,
        },
        403,
      );
    }

    // All gates passed — build per-client McpServer, wire transport,
    // delegate request handling to the SDK.
    //
    // STATELESS MODE (sessionIdGenerator: undefined): each request creates a
    // fresh McpServer + transport pair scoped to this authenticated client.
    // The MCP spec's session-id handshake is bypassed; every POST is
    // self-contained (initialize → tools/list/call → response). This matches
    // the per-request lifecycle: the policy filter set is computed at the
    // moment the request lands, so subsequent calls in the same Streamable
    // HTTP session would need session-pinning we do not yet maintain. Plan
    // 04+ may switch to stateful mode if session-pinned state (rate-limit
    // bucket, ResourceTemplate subscriptions) is added; today, stateless is
    // the correct lifecycle.
    let mcp: McpServer;
    let transport: StreamableHTTPServerTransport;
    try {
      mcp = buildMcpServerForClient(client);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcp.connect(transport);
    } catch (err) {
      logger.error(
        {
          clientId: client.id,
          submodule: "endpoint",
          errorKind: "internal" as const,
          err,
          hint:
            "Inspect daemon logs for tool-metadata registry failures or SDK transport construction errors",
        },
        "MCP server initialization failed",
      );
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "MCP server initialization failed" },
          id: null,
        },
        500,
      );
    }

    // Mitigates Hono body pre-parse pitfall: Hono pre-parses body but SDK
    // transport expects raw stream. SDK accepts a pre-parsed JSON body as the
    // 3rd arg; on parse failure pass undefined and let the SDK surface the
    // JSON-RPC error.
    const parsedBody = await c.req.json().catch(() => undefined);

    const incoming = c.env.incoming;
    const outgoing = c.env.outgoing;

    try {
      await transport.handleRequest(incoming, outgoing, parsedBody);
    } catch (err) {
      // The SDK transport writes its own JSON-RPC error responses on
      // protocol-level failures. Reaching this branch means the underlying
      // Node ServerResponse threw before/after the SDK finished — log and
      // attempt a structured fallback only if headers haven't shipped.
      logger.error(
        {
          clientId: client.id,
          submodule: "endpoint",
          errorKind: "internal" as const,
          err,
          hint: "Inspect MCP SDK transport logs",
        },
        "MCP transport handleRequest threw",
      );
      if (!outgoing.headersSent) {
        return c.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP transport error",
            },
            id: null,
          },
          500,
        );
      }
      // Headers already shipped by the transport mid-stream — fall through to
      // the response-already-sent sentinel below so the node adapter does not
      // try to write them a second time.
    }

    // The transport wrote the full response (SSE or JSON) directly on the raw
    // Node ServerResponse. Signal `@hono/node-server` to leave `outgoing`
    // untouched via the response-already-sent header sentinel. Returning any
    // other Response (including `c.body(null)`) makes the node adapter call
    // `outgoing.writeHead()` a SECOND time — throwing ERR_HTTP_HEADERS_SENT and
    // destroying the socket mid-response, corrupting/truncating every reply.
    if (outgoing.headersSent) {
      return RESPONSE_ALREADY_SENT;
    }

    // The transport returned without writing anything (not expected for a
    // valid MCP POST). Emit a normal empty response so the client is not left
    // waiting on an open socket.
    return c.body(null);
  });

  logger.debug(
    { submodule: "endpoint", route: "POST /mcp/v1" },
    "MCP server endpoint mounted",
  );
}
