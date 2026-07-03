// SPDX-License-Identifier: Apache-2.0
// @allow-throw: MCP SDK resources/read callback boundary — thrown errors are caught by the SDK and surfaced as MCP error responses on the wire (same pattern as RPC handler modules; see packages/daemon/src/api/subagent-handlers.ts:2).
/**
 * MCP `resources/list` + `resources/read`.
 *
 * Per-MCP-client `sessionAllowlist` gates which session keys this client
 * may enumerate (resources/list) and read (resources/read). The CONFIRMED-only
 * filter (read side) restricts the projected transcript to messages whose
 * derived `deliveryStatus === "confirmed"` -- pending outbound messages
 * are never exposed to external MCP clients.
 *
 * Threat model coverage:
 *
 *   - Cross-conversation leak              — sessionAllowlist gate.
 *   - Unconfirmed-message leak             — deliveryStatus filter.
 *   - Prompt injection via resource content — wrapExternalContent applied to
 *     the rendered transcript with `source: "mcp_resource"` and a per-session
 *     `sender` tag.
 *
 * @module
 */

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { systemDateFrom, wrapExternalContent } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { TokenClient } from "@comis/gateway";

// ---------------------------------------------------------------------------
// Deps + factory
// ---------------------------------------------------------------------------

/**
 * Dependencies for `registerMcpResourcesForClient`.
 *
 * The factory consumes the same `daemonRpcForMcpClient` trust-flag-isolated
 * indirection that the tools/call dispatcher uses -- so
 * `session.history` is invoked WITHOUT injecting `_trustLevel:"admin"`.
 */
export interface RegisterMcpResourcesDeps {
  /** Logger bound with `module: "mcp-server"`. */
  readonly logger: ComisLogger;
  /** Trust-flag-isolated RPC indirection. Wired at the composition root to
   *  `(method, params) => rpcCall(method, params)`. NEVER spreads
   *  `_trustLevel:"admin"` -- so `session.history` runs at the
   *  caller's natural trust level (rpc-scope read). */
  readonly daemonRpcForMcpClient: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Page size to use when fetching session.history for resources/read. The
   *  MCP resource view is a snapshot transcript -- a large limit avoids the
   *  need for cursor pagination at the MCP layer (the MCP spec supports
   *  resource cursors but we ship a single bounded view). */
  readonly resourceReadLimit: number;
}

/**
 * Shape of the (subset of) `session.history` response the resources/read
 * callback consumes. Mirrors `SessionHistoryContract.response` but only
 * includes the fields the resources surface needs.
 */
interface SessionHistoryResponse {
  messages: ReadonlyArray<{
    role: string;
    content: string;
    timestamp: number;
    deliveryStatus?: "confirmed" | "pending";
  }>;
}

/**
 * Register `resources/list` + `resources/read` on the supplied per-request
 * `McpServer` instance for the given authenticated MCP client. Reads the
 * `mcpClient.sessionAllowlist` array to gate enumeration + read access on a
 * per-session basis.
 *
 * Empty `sessionAllowlist` => `resources/list` returns `[]` (no resources).
 * Per-session gate: `resources/read` on a sessionKey NOT in the allowlist
 * rejects with `[session_not_allowlisted]` + structured `errorKind:"auth"`
 * log line.
 */
export function registerMcpResourcesForClient(
  mcp: McpServer,
  deps: RegisterMcpResourcesDeps,
  client: TokenClient,
): void {
  const sessionAllowlist = new Set<string>(client.mcpClient?.sessionAllowlist ?? []);
  const { logger } = deps;

  mcp.registerResource(
    "session",
    new ResourceTemplate("comis://session/{sessionKey}", {
      list: async () => {
        // Enumerate one resource per allowlisted session key. The set is
        // operator-curated via gateway.tokens[].mcpClient.sessionAllowlist;
        // an empty set = empty list (default-deny equivalent for sessions).
        const resources = [...sessionAllowlist].map((sk) => ({
          uri: `comis://session/${sk}`,
          name: `Session ${sk}`,
          mimeType: "text/plain",
          description:
            "Confirmed messages from this Comis session (CONFIRMED-only; pending outbound messages excluded)",
        }));
        return { resources };
      },
    }),
    {
      description:
        "Comis session transcript (CONFIRMED-only). Outbound messages still pending or in-flight via the channel-adapter delivery queue are excluded.",
    },
    async (uri, variables) => {
      const sessionKey = String(variables.sessionKey ?? "");

      // -------- Allowlist gate (cross-conversation leak) -----------------
      if (!sessionAllowlist.has(sessionKey)) {
        logger.warn(
          {
            clientId: client.id,
            sessionKey,
            submodule: "resources-read",
            errorKind: "auth" as const,
            hint:
              "Add sessionKey to gateway.tokens[].mcpClient.sessionAllowlist to expose this session",
          },
          "MCP resources/read denied -- session not in per-client allowlist",
        );
        // The SDK turns thrown errors inside the callback into JSON-RPC
        // error responses on the wire (the Client side surfaces them as
        // McpError). The bracketed token is a machine-parsable code; the
        // sessionKey suffix is included for operator debugging (the same
        // suffix already appears in the URI the caller passed in -- this
        // adds no extra information disclosure beyond what the caller
        // sent).
        throw new Error(`[session_not_allowlisted] sessionKey=${sessionKey}`);
      }

      // -------- Dispatch session.history through the trust-flag-isolated
      //          RPC indirection. The dispatcher does NOT inject
      //          `_trustLevel:"admin"`; session.history is rpc-scope read.
      const history = (await deps.daemonRpcForMcpClient("session.history", {
        session_key: sessionKey,
        limit: deps.resourceReadLimit,
      })) as SessionHistoryResponse;

      // -------- CONFIRMED filter (unconfirmed-message leak) --------------
      // Outbound messages whose deliveryStatus is "pending" are excluded.
      // Inbound messages are always confirmed by the handler so they pass.
      //
      // Strict equality, NO nullish coalesce. The MCP resources/read surface
      // is an EXTERNAL trust boundary -- absence of the field is "unknown
      // status" and the conservative default is EXCLUDE. A `?? "confirmed"`
      // fallback here would render legacy messages as if confirmed, leaking
      // transcripts whose outbound delivery state was never tracked.
      // The web-dashboard session.history RPC consumer is unaffected (it does
      // not run this filter).
      const confirmedOnly = history.messages.filter(
        (m) => m.deliveryStatus === "confirmed",
      );

      const rendered = confirmedOnly
        .map(
          (m) =>
            `[${systemDateFrom(m.timestamp).toISOString()}] ${m.role}: ${m.content}`,
        )
        .join("\n");

      // -------- Wrap (prompt-injection defense-in-depth) -----------
      // Message bodies contain user-supplied text; wrapping with
      // SECURITY NOTICE + random-hex markers tells the MCP client's LLM
      // to treat the content as data, not commands.
      const wrapped = wrapExternalContent(rendered, {
        source: "mcp_resource",
        sender: `mcp-resource:session:${sessionKey}`,
      });

      logger.info(
        {
          clientId: client.id,
          sessionKey,
          submodule: "resources-read",
          totalMessages: history.messages.length,
          confirmedMessages: confirmedOnly.length,
          excludedPending: history.messages.length - confirmedOnly.length,
        },
        "MCP resources/read served (CONFIRMED-only filter applied)",
      );

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: wrapped,
          },
        ],
      };
    },
  );
}
