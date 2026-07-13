// SPDX-License-Identifier: Apache-2.0
/**
 * MCP-server-management RPC contracts. Mirrors
 * `packages/daemon/src/api/mcp-handlers.ts`.
 *
 * The mcp-handlers.ts factory exposes 6 admin-scoped methods that gate
 * the runtime lifecycle of MCP (Model Context Protocol) server
 * connections:
 *
 *   - `mcp.list`        (admin) — enumerate active MCP server connections
 *                                  with status + tool counts + per-server
 *                                  capability flags. Read-only.
 *   - `mcp.status`      (admin) — detailed status for a single server by
 *                                  `server_name`: tools, generation, last
 *                                  health-check timestamp, capabilities,
 *                                  instructions, and serverVersion (from
 *                                  the SDK after connect).
 *   - `mcp.connect`     (admin) — establish a connection to a new server.
 *                                  Nested config object is modelled with
 *                                  allowlist shapes only: transport is the
 *                                  3-value enum (`stdio | sse | http`),
 *                                  optional `command`/`args`/`url`/`env`/
 *                                  `headers`. Pre-spawn env-var validation
 *                                  rejects unresolved `${VAR}` references
 *                                  before the manager.connect call.
 *   - `mcp.disconnect`  (admin) — tear down a named server connection.
 *                                  Throws on unknown server (handler line
 *                                  133-135).
 *   - `mcp.reconnect`   (admin) — reconnect a named server, preserving the
 *                                  generation counter and stored config.
 *                                  Falls back to a full connect when no
 *                                  stored config exists, accepting the same
 *                                  optional `transport`/`command`/`args`/
 *                                  `url`/`env`/`headers` shape as
 *                                  `mcp.connect`.
 *   - `mcp.test`        (admin) — probe a server config WITHOUT registering
 *                                  it. Uses a temporary `McpClientManager`
 *                                  bound to a 15s timeout; tears down on
 *                                  exit. Never throws — returns
 *                                  `{ success, error?, toolCount?, tools? }`.
 *
 * All 6 contracts have `scopes: ["admin"] as const`, mirroring the
 * registration in
 * `packages/daemon/src/wiring/setup-gateway-api.ts` lines 284-287
 * (`registerRpcPassthrough(..., ["mcp.list", "mcp.status",
 * "mcp.connect", "mcp.disconnect", "mcp.reconnect", "mcp.test"],
 * "admin")`).
 *
 * The `mcp.*` RPC methods are managed via the web SPA only — no CLI
 * consumer exists for any of the 6 methods in
 * `packages/cli/src/commands/`. The CLI does have a `comis mcp` command
 * surface (managing config-side `integrations.mcp.servers` entries), but
 * those flows touch `config.read` / `config.patch` — NOT `mcp.list` /
 * `mcp.status` / etc.
 *
 * **Request param names match the handler.** mcp-handlers.ts (lines 51,
 * 82, 128, 142, 191) reads `server_name` for 4 of the 6 methods (status,
 * connect, disconnect, reconnect) and `name` for `mcp.test` (line 142).
 * The contract request schemas model the ACTUAL handler-read param names
 * verbatim. `mcp.connect` and `mcp.reconnect` ALSO carry `headers`
 * (Record<string, string>), present in handler lines 96 + 211 + the
 * existing test assertions (mcp-handlers.test.ts lines 241-256 + 446-463
 * verify `headers` pass-through).
 *
 * Response shapes match the handler's actual return values verbatim:
 *   - `mcp.list` returns `{ servers: ServerListEntry[], total: number }`
 *     where each row carries `name`, `status`, `toolCount`, optional
 *     `lastHealthCheck`/`reconnectAttempt`/`error`, optional `capabilities`
 *     (`z.record(z.string(), z.unknown())` — escape-hatch shape from the
 *     12-shape allowlist), and optional `serverVersion` (the SDK
 *     `{ name, version }` object aliased from `serverInfo`).
 *   - `mcp.status` returns the same per-server shape with additional
 *     fields: `tools` (array of `{ name, qualifiedName, description? }`),
 *     `maxReconnectAttempts`, `generation`, `serverInfo` (raw SDK
 *     object), `instructions`, `capabilities`, and `serverVersion`.
 *   - `mcp.connect` returns `{ name, status, toolCount, tools: string[] }`
 *     (handler line 119-124). `tools` is a `string[]` of tool NAMES, not
 *     the full McpToolDefinition objects — handler maps via
 *     `result.value.tools.map((t) => t.name)`.
 *   - `mcp.disconnect` returns `{ name, status }` (handler line 138).
 *     Both are strings — `status` is always `"disconnected"` on success;
 *     failure paths throw.
 *   - `mcp.reconnect` returns the same shape as `mcp.connect`:
 *     `{ name, status, toolCount, tools: string[] }` (handler lines
 *     219-225 fallback path AND lines 229-234 reconnect-success path).
 *   - `mcp.test` returns `{ success, toolCount?, tools?, error? }`
 *     (handler lines 167-184). `success` is required; the other 3 fields
 *     are optional and conditional on success/failure paths.
 *
 * Status enum is the 5-value `McpConnectionStatus` from
 * `packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts`:
 * `"connected" | "disconnected" | "connecting" | "reconnecting" | "error"`.
 *
 * Capabilities is `Record<string, unknown>` from the SDK
 * (`getServerCapabilities()`), modelled as
 * `z.record(z.string(), z.unknown())`. The 12-shape allowlist permits
 * `ZodAny`/`ZodUnknown` ONLY as the value-type inside a `ZodRecord` (see
 * `scripts/contracts/walk-zod-schema.ts` line 25 RECORD_VALUE_ESCAPE_HATCH).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// Shared enums + sub-schemas (allowlist shapes only).
// ---------------------------------------------------------------------------

/**
 * MCP transport protocols. Mirrors the `McpServerConfig.transport` union
 * in `packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts`:
 * `"stdio" | "sse" | "http"`. The 12-shape allowlist permits `z.enum`.
 */
const McpTransportEnum = z.enum(["stdio", "sse", "http"]);

/**
 * MCP connection statuses. Mirrors `McpConnectionStatus` in
 * `packages/skills/src/skills/integrations/mcp-client/mcp-client-types.ts`.
 * The 5-value union is closed (no new states without an SDK change).
 */
const McpConnectionStatusEnum = z.enum([
  "connected",
  "disconnected",
  "connecting",
  "reconnecting",
  "error",
]);

/**
 * Server-info / serverVersion shape from the MCP SDK
 * (`getServerVersion()` returns `{ name, version }` or undefined).
 * Mirrors `McpConnection.serverInfo` in mcp-client/mcp-client-types.ts.
 */
const McpServerInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
});

/**
 * MCP tool-definition shape returned by the SDK after connect. Mirrors
 * `McpToolDefinition` in mcp-client/mcp-client-types.ts. The response side
 * for `mcp.status` projects the user-facing fields the handler exposes.
 * `inputSchema` is intentionally omitted from the wire response shape —
 * the handler does NOT serialize it.
 *
 * `callableName` is the name the agent must actually INVOKE the tool by
 * (`mcp__<server>--<tool>`), which differs from the advisory `qualifiedName`
 * (`mcp:<server>/<tool>`). Advertising it closes the naming mismatch that made
 * an agent copy the non-callable `qualifiedName` into a tool call and fail
 * (comis-daniel 2026-07-09).
 */
const McpToolProjectionSchema = z.object({
  name: z.string(),
  qualifiedName: z.string(),
  callableName: z.string(),
  description: z.string().optional(),
});

/**
 * `mcp.list` per-server row. Mirrors the projection in
 * mcp-handlers.ts:36-46. `capabilities` and `serverVersion` are forwarded
 * from the underlying `McpConnection` and may be undefined (the SDK
 * provides them only after a successful connect — `getServerCapabilities`
 * / `getServerVersion` are nullable per the SDK contract).
 */
const McpListServerEntrySchema = z.object({
  name: z.string(),
  status: McpConnectionStatusEnum,
  toolCount: z.number(),
  lastHealthCheck: z.number(),
  reconnectAttempt: z.number(),
  error: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  serverVersion: McpServerInfoSchema.optional(),
});

/**
 * `mcp.status` per-server row. Superset of `McpListServerEntrySchema` —
 * adds `tools` (projected tool list), `maxReconnectAttempts`,
 * `generation`, `serverInfo`, `instructions`. Mirrors the response
 * builder in mcp-handlers.ts:60-78.
 */
const McpStatusServerSchema = z.object({
  name: z.string(),
  status: McpConnectionStatusEnum,
  toolCount: z.number(),
  tools: z.array(McpToolProjectionSchema),
  lastHealthCheck: z.number(),
  reconnectAttempt: z.number(),
  maxReconnectAttempts: z.number(),
  error: z.string().optional(),
  generation: z.number(),
  serverInfo: McpServerInfoSchema.optional(),
  instructions: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  serverVersion: McpServerInfoSchema.optional(),
});

// ---------------------------------------------------------------------------
// mcp.list
// ---------------------------------------------------------------------------

/**
 * `mcp.list` — enumerate active MCP server connections. Admin-only.
 *
 * Request: `{}` — no parameters.
 *
 * Response: `{ servers: McpListServerEntry[], total: number }`. The
 * handler projects every entry from `McpClientManager.getAllConnections()`
 * to the per-server row shape (mcp-handlers.ts:36-46). `total` mirrors
 * `servers.length` (mcp-handlers.ts:47).
 */
export const McpListContract = defineContract({
  method: "mcp.list",
  request: z.object({}),
  response: z.object({
    servers: z.array(McpListServerEntrySchema),
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// mcp.status
// ---------------------------------------------------------------------------

/**
 * `mcp.status` — detailed status for one MCP server. Admin-only.
 *
 * Request: `{ server_name: string }`. The handler reads `server_name`
 * (mcp-handlers.ts:51) and raises `"Missing required parameter:
 * server_name"` when absent (line 52). Non-empty by contract via
 * `z.string().min(1)`; bespoke pre-Zod guard at handler line 52 produces
 * the user-friendly UX. The handler reads `server_name` REQUIRED;
 * mcp-handlers.test.ts lines 149-200 all assert on `server_name`.
 *
 * Response: full `McpStatusServerSchema` projection. Empty `tools` array
 * is permitted (a connected server may export no tools — see
 * mcp-handlers.test.ts:194-199).
 */
export const McpStatusContract = defineContract({
  method: "mcp.status",
  request: z.object({
    server_name: z.string().min(1),
  }),
  response: McpStatusServerSchema,
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// mcp.connect
// ---------------------------------------------------------------------------

/**
 * `mcp.connect` — establish a connection to a new MCP server. Admin-only.
 *
 * Request: `{ server_name, transport, command?, args?, url?, env?, headers? }`.
 *   - `server_name` (string, min(1)) — server identifier (handler line 82).
 *   - `transport` (enum stdio|sse|http) — required (handler line 83-85).
 *   - `command` (string, optional) — stdio executable.
 *   - `args` (string[], optional) — stdio command-line args.
 *   - `url` (string, optional) — sse/http endpoint.
 *   - `env` (`Record<string, string>`, optional) — child-process env.
 *     Pre-spawn validation rejects unresolved `${VAR}` references when
 *     a secretManager is wired (handler lines 105-112).
 *   - `headers` (`Record<string, string>`, optional) — custom HTTP
 *     headers for remote transports (passed through to `requestInit.headers`
 *     by the SDK transport — see mcp-handlers.test.ts:241-256).
 *
 * Response: `{ name, status, toolCount, tools: string[] }` (handler lines
 * 119-124). `tools` is a `string[]` of tool NAMES (NOT
 * `McpToolDefinition[]`) — handler maps `result.value.tools.map((t) =>
 * t.name)`. The handler reads `server_name` REQUIRED; this matches both
 * the existing mcp-handlers.test.ts assertions and the actual RPC wire
 * format consumed by the web SPA.
 */
export const McpConnectContract = defineContract({
  method: "mcp.connect",
  request: z.object({
    server_name: z.string().min(1),
    transport: McpTransportEnum,
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // Per-server stdio rlimits override accepted on `mcp.connect` so callers
    // can supply rlimits at first-connect time. Mirrors
    // McpServerEntrySchema.rlimits. Partial overrides allowed. The handler
    // forwards to both the spawn-time McpServerConfig (wrapStdioCommand)
    // and the persisted McpServerEntry.
    rlimits: z
      .object({
        as: z.number().int().positive().optional(),
        nofile: z.number().int().positive().optional(),
        cpu: z.number().int().positive().optional(),
      })
      .optional(),
    // Per-server opt-out for the plaintext-secret heuristic. Accepted on
    // `mcp.connect` and PERSISTED to the McpServerEntry so the opt-out
    // survives a daemon restart. Default: false (heuristic enforced).
    // Mirrors McpServerEntrySchema.
    disablePlaintextSecretCheck: z.boolean().optional(),
    // Per-server reliability overrides accepted on `mcp.connect` so callers
    // can supply them at first-connect time. Mirrors McpServerEntrySchema.
    // The handler forwards each into both the spawn-time McpServerConfig
    // (consumed by start/stop keepalive + circuit-breaker pre-check) AND
    // the persisted McpServerEntry (so the override survives a daemon
    // restart). Undefined => fall back to the McpConfigSchema global defaults
    // at the call site.
    keepaliveIntervalMs: z.number().int().nonnegative().optional(),
    circuitBreakerThreshold: z.number().int().positive().optional(),
    circuitBreakerCooldownMs: z.number().int().positive().optional(),
    // Auth scheme for remote transports. When "oauth", the daemon promotes
    // the new entry to auth:"oauth" and `mcp.oauth_login` can drive the PKCE
    // flow via `mcp_login`. When "headers" (or absent), credential injection
    // via the `headers` field is used (the default behaviour). Accepted on
    // `mcp.connect` and PERSISTED so the auth requirement survives a daemon
    // restart (first-install OAuth promotion). The field MUST be
    // included in the contract schema or z.object strict-parsing strips it
    // before it reaches the handler.
    auth: z.enum(["headers", "oauth"]).optional(),
  }),
  response: z.object({
    name: z.string(),
    status: McpConnectionStatusEnum,
    toolCount: z.number(),
    tools: z.array(z.string()),
    // Outcome of the persistToConfig call that accompanies mcp.connect.
    // "persisted" = config.yaml updated. "runtime_only" = connected in
    // memory but config write failed (warning carries the persistToConfig
    // error). "skipped" = persistDeps was not wired (test harness).
    persistence: z.enum(["persisted", "runtime_only", "skipped"]).optional(),
    warning: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// mcp.disconnect
// ---------------------------------------------------------------------------

/**
 * `mcp.disconnect` — tear down a named MCP server connection. Admin-only.
 *
 * Request: `{ server_name: string }`. The handler reads `server_name`
 * (mcp-handlers.ts:128) and raises `"Missing required parameter:
 * server_name"` when absent (line 129). Non-empty by contract.
 *
 * Response: `{ name: string, status: string }`. The handler returns
 * `{ name, status: "disconnected" }` on success (line 138); failure paths
 * (server not found) throw "MCP server not found" before the return — so
 * `status` is effectively the literal `"disconnected"`. Modeled as
 * `z.literal("disconnected")` to capture the success-only shape (same
 * pattern as `TokensRevokeContract.response.revoked: z.literal(true)`).
 */
export const McpDisconnectContract = defineContract({
  method: "mcp.disconnect",
  request: z.object({
    server_name: z.string().min(1),
  }),
  response: z.object({
    name: z.string(),
    status: z.literal("disconnected"),
    // Outcome of the persistToConfig call that accompanies mcp.disconnect.
    // Same semantics as McpConnectContract.
    persistence: z.enum(["persisted", "runtime_only", "skipped"]).optional(),
    warning: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// mcp.reconnect
// ---------------------------------------------------------------------------

/**
 * `mcp.reconnect` — reconnect a named MCP server. Admin-only.
 *
 * Request: `{ server_name, transport?, command?, args?, url?, env?, headers? }`.
 *   - `server_name` (string, min(1)) — required (handler line 191-192).
 *   - All other fields are OPTIONAL fallback-path config. The handler
 *     first attempts `manager.reconnect(server_name)` using the stored
 *     config; if the manager returns `"no stored config"` (handler line
 *     200), the handler reads the remaining fields and falls through to
 *     a full `manager.connect(...)` call (lines 201-225). When no
 *     transport is provided AND no stored config exists, the handler
 *     raises `"MCP server <name> not found and no transport specified"`
 *     (line 203).
 *   - `headers` mirrors `mcp.connect`: pass-through for remote
 *     transports (mcp-handlers.test.ts:446-463 verifies the pass-through
 *     on the fallback reconnect path).
 *
 * Response: same as `mcp.connect`: `{ name, status, toolCount, tools:
 * string[] }` (handler lines 219-225 fallback path AND 229-234
 * reconnect-success path return the same shape).
 */
export const McpReconnectContract = defineContract({
  method: "mcp.reconnect",
  request: z.object({
    server_name: z.string().min(1),
    transport: McpTransportEnum.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  response: z.object({
    name: z.string(),
    status: McpConnectionStatusEnum,
    toolCount: z.number(),
    tools: z.array(z.string()),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// mcp.test
// ---------------------------------------------------------------------------

/**
 * `mcp.test` — probe a server config without registering it. Admin-only.
 *
 * Request: `{ name, transport, command?, args?, url?, env?, headers? }`.
 *   - `name` (string, min(1)) — server identifier. NOTE the handler reads
 *     `name` (NOT `server_name`) — mcp-handlers.ts line 142. The handler
 *     internally namespaces the test connection to `__test__<name>` (line
 *     148) to avoid collision with a production server of the same
 *     identifier.
 *   - `transport` (enum stdio|sse|http) — required (handler line 144-145).
 *   - All other fields mirror `mcp.connect`'s optional fallback shape.
 *
 * Response: `{ success: boolean, toolCount?, tools?, error? }`.
 *   - `success: true` path: returns `{ success: true, toolCount, tools }`
 *     where `tools` is a `string[]` of tool names (handler lines 173-177).
 *   - `success: false` path: returns `{ success: false, error: string }`
 *     (handler lines 167-170 OR catch block lines 179-184).
 *   - Unlike `mcp.connect`, this method NEVER throws — failure paths are
 *     surfaced via the response payload.
 */
export const McpTestContract = defineContract({
  method: "mcp.test",
  request: z.object({
    name: z.string().min(1),
    transport: McpTransportEnum,
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // mcp.test applies the same pre-spawn safety controls as mcp.connect,
    // including caller-supplied rlimits and the per-server
    // plaintext-secret opt-out. Both fields mirror McpConnectContract.request.
    rlimits: z
      .object({
        as: z.number().int().positive().optional(),
        nofile: z.number().int().positive().optional(),
        cpu: z.number().int().positive().optional(),
      })
      .optional(),
    disablePlaintextSecretCheck: z.boolean().optional(),
  }),
  response: z.object({
    success: z.boolean(),
    toolCount: z.number().optional(),
    tools: z.array(z.string()).optional(),
    error: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

/**
 * MCP-domain contract array. Registered into
 * `API_CONTRACTS_ORDERED` by `packages/core/src/api-contracts/index.ts`.
 */
export const MCP_CONTRACTS = [
  McpListContract,
  McpStatusContract,
  McpConnectContract,
  McpDisconnectContract,
  McpReconnectContract,
  McpTestContract,
] as const;
