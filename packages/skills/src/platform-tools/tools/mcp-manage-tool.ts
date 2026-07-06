// SPDX-License-Identifier: Apache-2.0
// @allow-throw: connect action re-throws non-OAuth RPC errors at line 352; caught by the
// skill executor tool-result boundary which formats all thrown errors as tool error responses.
// Only the needs_oauth_login branch is caught and converted — all other errors propagate
// unchanged per the non-swallow invariant.
/**
 * MCP server management tool: multi-action tool for MCP server lifecycle.
 *
 * Supports 5 actions: list, status, connect, disconnect, reconnect.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to mcp.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ApprovalGate } from "@comis/core";
import { registerActivityLabelSpec } from "@comis/core";
import { readStringParam, throwToolError } from "../tool-helpers.js";
import { createAdminManageTool } from "../admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// Activity label spec. Descriptor name == emitted name.
// Per-action overrides use the tool's REAL action enum
// (list/status/connect/disconnect/reconnect), not a placeholder example.
registerActivityLabelSpec("mcp_manage", {
  semanticPhase: "tool",
  label: "managing MCP servers",
  actions: {
    list: { label: "listing MCP servers" },
    status: { label: "checking MCP server status" },
    connect: { label: "connecting MCP server" },
    disconnect: { label: "disconnecting MCP server" },
    reconnect: { label: "reconnecting MCP server" },
  },
});

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const McpManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("status"),
      Type.Literal("connect"),
      Type.Literal("disconnect"),
      Type.Literal("reconnect"),
    ],
    { description: "MCP server management action. Valid values: list (all servers with status), status (detailed single server info), connect (add new server), disconnect (remove server), reconnect (restart server connection)" },
  ),
  server_name: Type.Optional(
    Type.String({
      description: "MCP server name. Required for status/connect/disconnect/reconnect.",
    }),
  ),
  transport: Type.Optional(
    Type.String({
      description: "Transport: 'stdio' (default when 'command' is provided), 'sse', or 'http' (default when 'url' is provided). Override only when both command and url are set, or to force a specific transport.",
    }),
  ),
  command: Type.Optional(
    Type.String({
      description: "Command to execute for stdio transport (e.g. npx). Required for stdio connect.",
    }),
  ),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Arguments for the stdio command (e.g. ["-y", "@upstash/context7-mcp"]).',
    }),
  ),
  url: Type.Optional(
    Type.String({
      description: "Server URL for remote transport (sse or http). Required for sse/http connect.",
    }),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Custom HTTP headers for remote transports (e.g. Authorization). Keys are header names, values are header values.",
    }),
  ),
  auth: Type.Optional(
    Type.Union(
      [Type.Literal("headers"), Type.Literal("oauth")],
      {
        description:
          'Auth scheme for remote transports. "oauth" triggers PKCE flow via mcp_login. Default: "headers" (credential injection via the headers field). Only relevant for sse/http transports.',
      },
    ),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Environment variables for a STDIO server (e.g. SERVICE_USERNAME). REQUIRED for stdio servers that need credentials/config in the environment. Values may reference stored secrets as ${VAR_NAME} (e.g. {"SERVICE_PASSWORD":"${SERVICE_PASSWORD}"}) — resolved from the encrypted secret store at spawn, so the plaintext never enters config. Keys are env-var names, values are the value or a ${VAR} reference.',
    }),
  ),
});

const VALID_ACTIONS = ["list", "status", "connect", "disconnect", "reconnect"] as const;

// ---------------------------------------------------------------------------
// Helpers (LLM UX self-correction)
// ---------------------------------------------------------------------------

/**
 * Coerce `args` from a JSON-encoded string into a real `string[]`.
 *
 * Mirrors `coerceConfig` in `providers-manage-tool.ts` (JSON-string + shape-check
 * + fall-through pattern), with one adjustment: because `tool.execute()` in unit
 * tests is invoked directly (not via the SDK's `prepareToolCall` path that runs
 * TypeBox validation), this helper must REJECT non-array-parseable strings
 * itself — otherwise a string `args` would silently flow through to the RPC
 * handler and corrupt argv when the daemon spawns the stdio subprocess.
 *
 * - Non-string `raw` (array, undefined, anything else): pass through unchanged.
 * - String `raw` that parses to `string[]`: return the parsed array.
 * - String `raw` that fails to parse OR parses to a non-`string[]`: throw
 *   `[invalid_value]` with an operator-actionable hint.
 */
function coerceArgs(p: Record<string, unknown>): unknown {
  const raw = p.args;
  if (typeof raw !== "string") {
    return raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throwToolError(
      "invalid_value",
      `mcp_manage args must be a string array; received a non-JSON string.`,
      {
        param: "args",
        hint: 'Provide args as a real array like ["-y", "@upstash/context7-mcp"], or as a JSON string whose elements are all strings.',
      },
    );
  }
  if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
    return parsed;
  }
  throwToolError(
    "invalid_value",
    `mcp_manage args must be a string array; the supplied JSON did not parse to a string[].`,
    {
      param: "args",
      hint: 'Provide args as a real array like ["-y", "@upstash/context7-mcp"], or as a JSON string whose elements are all strings.',
    },
  );
}

/**
 * Coerce `headers` from a JSON-encoded string into a plain object.
 *
 * Mirrors the `coerceArgs` pattern above, adapted for the headers shape
 * constraint (must be an object, not an array, not null).
 *
 * The Higgsfield incident passed headers as a JSON string
 * (`'{"Authorization":"Bearer tok"}'`), which silently reached the daemon
 * as a string, bypassing credential-shape expectations. Coercion must happen
 * before `rpcCall("mcp.connect")` so the daemon-side credential firewall
 * sees the correct object shape.
 *
 * - Non-string `raw` (object, undefined, anything else): pass through unchanged.
 * - String `raw` that parses to a non-null, non-array object: return the parsed object.
 * - String `raw` that fails to parse: throw `[invalid_value]` with fix hint.
 * - String `raw` that parses to null, array, or a non-object: throw `[invalid_value]`.
 */
function coerceHeaders(p: Record<string, unknown>): unknown {
  const raw = p.headers;
  if (typeof raw !== "string") {
    return raw; // object/undefined: pass through
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throwToolError(
      "invalid_value",
      `mcp_manage headers must be an object; received a non-JSON string.`,
      {
        param: "headers",
        hint: 'Pass headers as an object, e.g. {"Authorization":"Bearer ${TOKEN}"}, not a JSON string.',
      },
    );
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed;
  }
  throwToolError(
    "invalid_value",
    `mcp_manage headers must be an object; the supplied JSON did not parse to an object.`,
    {
      param: "headers",
      hint: 'Pass headers as an object, e.g. {"Authorization":"Bearer ${TOKEN}"}, not a JSON string.',
    },
  );
}

/**
 * Coerce `env` from a JSON-encoded string into a plain object — same shape rules
 * as {@link coerceHeaders}. A stdio server that needs credentials (e.g. example-mcp
 * needs SERVICE_USERNAME/SERVICE_PASSWORD) receives them here; values may be `${VAR}`
 * secret references the daemon resolves at spawn. Coercion runs before
 * `rpcCall("mcp.connect")` so the daemon-side env-var validation sees a real object,
 * not a JSON string (the same footgun class the headers coercion guards).
 */
function coerceEnv(p: Record<string, unknown>): unknown {
  const raw = p.env;
  if (typeof raw !== "string") {
    return raw; // object/undefined: pass through
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throwToolError(
      "invalid_value",
      `mcp_manage env must be an object; received a non-JSON string.`,
      {
        param: "env",
        hint: 'Pass env as an object, e.g. {"SERVICE_PASSWORD":"${SERVICE_PASSWORD}"}, not a JSON string.',
      },
    );
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed;
  }
  throwToolError(
    "invalid_value",
    `mcp_manage env must be an object; the supplied JSON did not parse to an object.`,
    {
      param: "env",
      hint: 'Pass env as an object, e.g. {"SERVICE_PASSWORD":"${SERVICE_PASSWORD}"}, not a JSON string.',
    },
  );
}

/**
 * Coerce and validate the `auth` field.
 *
 * Mirrors the `coerceHeaders` pattern above, adapted for the auth enum
 * constraint (must be "headers" or "oauth" when present).
 *
 * Rejects any value not in ["headers","oauth"] via
 * `throwToolError("invalid_value",...)` before any handler logic runs.
 *
 * - `raw === undefined`: return `undefined` (field was not supplied; caller
 *   should apply a default of `"headers"` at the rpcCall call site).
 * - `raw === "headers"` or `raw === "oauth"`: return the value as-is.
 * - Any other value: throw `[invalid_value]` with an operator-actionable hint.
 */
function coerceAuth(p: Record<string, unknown>): "headers" | "oauth" | undefined {
  const raw = p.auth;
  if (raw === undefined) return undefined;
  if (raw === "headers" || raw === "oauth") return raw;
  throwToolError(
    "invalid_value",
    `mcp_manage auth must be "headers" or "oauth".`,
    {
      param: "auth",
      validValues: ["headers", "oauth"],
      hint: 'Pass auth:"oauth" to trigger PKCE OAuth flow via mcp_login, or omit for header-auth servers.',
    },
  );
}

/**
 * Up-front multi-field validator for `connect`: reports ALL missing required
 * fields in a single `[missing_param]` error rather than surfacing them
 * one-at-a-time across multiple LLM retries (the defect this task fixes).
 *
 * The `transport`-missing branch additionally requires a deducible source
 * (`command` or `url`); when both are missing, the error names them together.
 */
function validateConnectParams(
  serverName: string | undefined,
  transport: string | undefined,
  command: unknown,
  url: unknown,
): void {
  const missing: string[] = [];
  if (typeof serverName !== "string" || serverName.length === 0) {
    missing.push("server_name");
  }
  if (transport === undefined) {
    missing.push("transport");
    if (
      (typeof command !== "string" || command.length === 0) &&
      (typeof url !== "string" || url.length === 0)
    ) {
      missing.push("command or url");
    }
  }
  if (missing.length > 0) {
    throwToolError(
      "missing_param",
      `mcp_manage(action="connect") is missing required parameters: ${missing.join(", ")}.`,
      {
        hint: 'Provide all required fields: server_name, transport ("stdio"|"sse"|"http"), and either command (for stdio) or url (for sse/http).',
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server management tool with 5 actions.
 *
 * Actions:
 * - **list** -- List all MCP servers with name, status, tool count
 * - **status** -- Get detailed status for one server (tools, health check)
 * - **connect** -- Connect to a new MCP server by config
 * - **disconnect** -- Disconnect an MCP server by name
 * - **reconnect** -- Disconnect and reconnect an MCP server
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @returns AgentTool implementing the MCP management interface
 */
export function createMcpManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
): AgentTool<typeof McpManageToolParams> {
  return createAdminManageTool(
    {
      name: "mcp_manage",
      label: "MCP Server Management",
      description:
        "Manage MCP servers: list, status, connect, disconnect, reconnect.",
      parameters: McpManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "mcp",
      gatedActions: ["connect", "disconnect", "reconnect"],
      actionOverrides: {
        async list(_p, rpcCall, ctx) {
          return rpcCall("mcp.list", { _trustLevel: ctx.trustLevel });
        },
        async status(p, rpcCall, ctx) {
          const name = readStringParam(p, "server_name");
          return rpcCall("mcp.status", { server_name: name, _trustLevel: ctx.trustLevel });
        },
        async connect(p, rpcCall, ctx) {
          const coercedArgs = coerceArgs(p);
          const serverName = typeof p.server_name === "string" ? p.server_name : undefined;
          // Infer transport from command (stdio) or url (http) when not
          // explicit. Mirrors the canonical inference in
          // packages/core/src/config/schema-integrations.ts
          // (McpServerEntrySchema z.preprocess). Kept inline here so the
          // multi-field LLM-UX missing-param error from
          // validateConnectParams fires BEFORE the RPC round-trip.
          const explicitTransport =
            typeof p.transport === "string" && p.transport.length > 0
              ? p.transport
              : undefined;
          const hasCommand = typeof p.command === "string" && p.command.length > 0;
          const hasUrl = typeof p.url === "string" && p.url.length > 0;
          const inferredTransport =
            explicitTransport ?? (hasCommand ? "stdio" : hasUrl ? "http" : undefined);
          const coercedAuth = coerceAuth(p);
          validateConnectParams(serverName, inferredTransport, p.command, p.url);
          // validateConnectParams threw if any field was missing — past this
          // point both serverName and inferredTransport are non-empty strings.
          try {
            return await rpcCall("mcp.connect", {
              server_name: serverName,
              transport: inferredTransport,
              command: p.command,
              args: coercedArgs,
              url: p.url,
              headers: coerceHeaders(p) as Record<string, string> | undefined,
              env: coerceEnv(p) as Record<string, string> | undefined,
              ...(coercedAuth !== undefined && { auth: coercedAuth }),
              _trustLevel: ctx.trustLevel,
            });
          } catch (err: unknown) {
            // Catch the structured needs_oauth_login error from mcp-handlers
            // and surface an actionable hint instead of re-throwing a
            // generic error that the agent cannot act on. Only catches errors where
            // .data.needs_oauth_login === true — all other errors are re-thrown
            // unchanged (the non-swallow invariant).
            const errData =
              err instanceof Error
                ? (err as unknown as {
                    data?: { needs_oauth_login?: boolean; server_name?: string; action?: string };
                  }).data
                : undefined;
            if (errData?.needs_oauth_login === true) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Run \`mcp_login({server_name: "${errData.server_name}"})\` to start the OAuth flow, then retry mcp_manage(action:"connect", auth:"oauth", url:..., transport:"http").`,
                  },
                ],
                details: errData,
              };
            }
            throw err;
          }
        },
        async disconnect(p, rpcCall, ctx) {
          const name = readStringParam(p, "server_name");
          return rpcCall("mcp.disconnect", { server_name: name, _trustLevel: ctx.trustLevel });
        },
        async reconnect(p, rpcCall, ctx) {
          const name = readStringParam(p, "server_name");
          const coercedArgs = coerceArgs(p);
          return rpcCall("mcp.reconnect", {
            server_name: name,
            transport: p.transport,
            command: p.command,
            args: coercedArgs,
            url: p.url,
            headers: coerceHeaders(p) as Record<string, string> | undefined,
            env: coerceEnv(p) as Record<string, string> | undefined,
            _trustLevel: ctx.trustLevel,
          });
        },
      },
    },
    rpcCall,
    approvalGate,
  );
}
