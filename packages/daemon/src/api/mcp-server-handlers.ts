// SPDX-License-Identifier: Apache-2.0
/**
 * buildMcpServerForClient factory.
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
 *                                              the CI gate makes
 *                                              "undefined" impossible in
 *                                              committed code)
 *
 * The filtered registration set IS the exposed surface — never-export tools
 * never reach the SDK's tool index, so they cannot leak via `tools/list` or
 * be invoked via `tools/call`.
 *
 * The `tools/call` callback runs the five-step pipeline:
 *
 *   1. Live policy re-check (defense-in-depth — rejects `never-export` and
 *      missing-policy entries even if the registration-time filter let
 *      them through).
 *   2. Per-client per-tool minute-bucket rate limit (default 30/min;
 *      `client.mcpClient.toolRateLimit[name]` overrides).
 *   3. Per-tool `validateInput` (existing pre-flight from ComisToolMetadata).
 *   4. Dispatch via `deps.daemonRpcForMcpClient(method, params)` — a NEW
 *      indirection that NEVER injects `_trustLevel:"admin"` and STRIPS any
 *      `_trustLevel` field a hostile MCP client passes in `args`.
 *   5. Wrap the result via `wrapExternalContent` (`source: "mcp_tool"`) so
 *      prompt-injection text in tool output gets the SECURITY NOTICE +
 *      random-hex markers (defense-in-depth against prompt injection).
 *
 * @module
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getAllToolMetadata,
  getToolMetadata,
  systemSetInterval,
  wrapExternalContent,
  type ComisToolMetadata,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { TokenClient } from "@comis/gateway";

import {
  checkAndIncrement,
  createRateLimitState,
  nextResetAt,
  pruneOldBuckets,
  type RateLimitState,
} from "./mcp-server-rate-limit.js";
import { registerMcpResourcesForClient } from "./mcp-server-resources.js";

// ---------------------------------------------------------------------------
// Singleton rate-limit state
// ---------------------------------------------------------------------------

/**
 * Singleton rate-limit state shared across every `buildMcpServerForClient`
 * invocation. A new McpServer is constructed per HTTP request (stateless
 * StreamableHTTP transport), so the rate-limit counters MUST
 * live at module scope to survive across requests for the same client.
 *
 * Bucket key: `${clientId}:${toolName}`.
 * Pruner: runs every 5 minutes, keeps the last 10 minutes of buckets. The
 * setInterval handle is unref'd so it does not keep the event loop alive on
 * SIGTERM.
 */
const rateLimitState: RateLimitState = createRateLimitState();
const PRUNE_INTERVAL_MS = 5 * 60_000;
const PRUNE_KEEP_MINUTES = 10;

let prunerStarted = false;
function ensurePrunerStarted(): void {
  if (prunerStarted) return;
  prunerStarted = true;
  const handle = systemSetInterval(() => {
    pruneOldBuckets(rateLimitState, PRUNE_KEEP_MINUTES);
  }, PRUNE_INTERVAL_MS);
  // Unref so the pruner does not keep the daemon alive on SIGTERM. The
  // unref() method is present on Node's NodeJS.Timeout (returned by
  // setInterval), but the TS type narrows to a structural shape -- safe-call
  // via optional chaining for environments that lack it (test harnesses).
  (handle as { unref?: () => void }).unref?.();
}

/**
 * Test-only: reset the singleton rate-limit state. Underscore prefix signals
 * internal use; import directly from this module in unit tests, NOT from a
 * public index.
 *
 * Also resets the `prunerStarted` flag so the next
 * `buildMcpServerForClient` invocation re-registers a fresh interval. Without
 * this, the module-level `prunerStarted` boolean stays `true` for the
 * lifetime of the forked vitest worker, masking pruner-cold-start behaviour
 * in any later test that needs to reproduce it.
 */
export function _resetRateLimitStateForTest(): void {
  rateLimitState.buckets.clear();
  prunerStarted = false;
}

// ---------------------------------------------------------------------------
// Permissive input schema
// ---------------------------------------------------------------------------

/**
 * Permissive Zod schema passed to every `mcp.registerTool({ inputSchema: ... })`
 * call. The SDK's executeToolHandler invokes our callback with the parsed
 * args ONLY when `tool.inputSchema` is defined (see
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:executeToolHandler`).
 * Without inputSchema, the SDK passes the RequestHandlerExtra (containing
 * an AbortSignal) as the sole callback argument, which breaks the dispatch
 * pipeline because the closure cannot distinguish "no args" from "args is
 * the extra object".
 *
 * The schema is intentionally maximally permissive (any object) because
 * Comis's per-tool `validateInput` (read at dispatch time from the
 * tool-metadata registry) is the actual semantic validator. The SDK-level
 * schema exists solely to flip the SDK's `(args, extra)` vs `(extra)` arity
 * dispatch.
 *
 * Use `as` cast because the SDK's `inputSchema?: ZodRawShapeCompat |
 * AnySchema` accepts Zod v3/v4 schemas but the type union does not surface
 * `z.ZodObject` directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional permissive any for AnySchema slot
const MCP_PERMISSIVE_INPUT_SCHEMA = z.record(z.string(), z.unknown()) as any;

// ---------------------------------------------------------------------------
// Deps + factory
// ---------------------------------------------------------------------------

/**
 * Dependencies for `buildMcpServerForClient`.
 *
 * Includes `logger` + `daemonVersion` and the live dispatcher deps:
 * `daemonRpcForMcpClient` (the trust-flag-isolated indirection),
 * `defaultToolRateLimit` (the per-client/per-tool ceiling applied when the
 * client config has no override), and `toolNameToRpcMethod` (mapping from the
 * MCP tool name to the underlying RPC method on the daemon).
 */
export interface BuildMcpServerForClientDeps {
  /** Logger bound with `module: "mcp-server"`. */
  readonly logger: ComisLogger;
  /** Daemon package version (read once at composition root from
   *  `packages/daemon/package.json`). Advertised as `serverInfo.version`. */
  readonly daemonVersion: string;
  /**
   * Trust-flag-isolated RPC indirection. The composition root wires
   * this to `(method, params) => rpcCall(method, params)` -- the ABSENCE of
   * `_trustLevel:"admin"` is the security feature. The dispatcher inside
   * this factory ALSO strips any `_trustLevel` field a hostile MCP client
   * might inject in `args` BEFORE invoking this function, so even if the
   * underlying daemon RPC handler honored `_trustLevel` from params, the
   * MCP path could not reach the admin trust level.
   */
  readonly daemonRpcForMcpClient: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  /** Default rate-limit ceiling (calls/min/tool) when the client config has
   *  no `mcpClient.toolRateLimit[name]` override. Default = 30. */
  readonly defaultToolRateLimit: number;
  /** Map an MCP tool name to the underlying daemon RPC method name. The
   *  default identity mapping suffices for tools whose MCP name matches the
   *  RPC method (e.g., `web_search`); tools that bridge MCP-name -> dotted-
   *  RPC-name (e.g., `memory_search` -> `memory.search_files`) need an
   *  explicit mapping. The mapping table is owned by the composition root
   *  (`packages/daemon/src/wiring/setup-gateway/setup-gateway-routes.ts`). */
  readonly toolNameToRpcMethod: (toolName: string) => string;
  /** Page size for the resources/read session.history fetch. A single-page
   *  snapshot suffices for the resource view; if a session exceeds this cap,
   *  the last N CONFIRMED messages are returned. Wired from the composition
   *  root with MCP_RESOURCE_READ_LIMIT. */
  readonly resourceReadLimit: number;
  /**
   * SECURITY — the trust-flag-FREE direct invocation of the
   * `obs.explain` ASSEMBLER (`assembleIncidentReportFromSources`), built at the
   * composition root over the obsStore + dataDir. The `obs_explain` MCP tool's
   * dispatch branch calls THIS (not {@link daemonRpcForMcpClient}) so it runs
   * under DAEMON authority WITHOUT touching the admin-gated `obs.explain` RPC
   * and WITHOUT injecting `_trustLevel:"admin"`. Its authorization is the
   * per-client `mcpClient.allowlist` (the compensating control) + the
   * digest-only/bounded report — NOT admin trust.
   *
   * OPTIONAL: an obsStore-less boot (or a wiring gap) leaves it `undefined`;
   * the dispatch branch then fails CLOSED with a generic `dispatch_error`
   * sentinel rather than falling through to the admin RPC indirection.
   *
   * `params` arrive ALREADY `_trustLevel`-stripped (the dispatcher strips at
   * Step 4 for every tool); the closure validates the `{sessionKey?,traceId?,
   * depth?}` shape via the contract `request.parse` before assembling.
   */
  readonly obsExplainForMcpClient?: (
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  /**
   * SECURITY — the trust-flag-FREE direct invocation of the
   * `obs.fleet.health` ASSEMBLER (`assembleFleetHealthReport`), the cross-session
   * fleet sibling of {@link obsExplainForMcpClient}. Built at the composition
   * root over the obsStore + dataDir + boot.clock. The `obs_fleet_health` MCP
   * tool's dispatch branch calls THIS (not {@link daemonRpcForMcpClient}) so it
   * runs under DAEMON authority WITHOUT touching the admin-gated
   * `obs.fleet.health` RPC and WITHOUT injecting `_trustLevel:"admin"`. Its
   * authorization is the per-client `mcpClient.allowlist` (the compensating
   * control) + the digest-only/bounded report — NOT admin trust.
   *
   * OPTIONAL: an obsStore-less boot (or a wiring gap) leaves it `undefined`; the
   * dispatch branch then fails CLOSED with a generic `dispatch_error` sentinel
   * rather than falling through to the admin RPC indirection.
   *
   * `params` arrive ALREADY `_trustLevel`-stripped (the dispatcher strips at
   * Step 4 for every tool); the closure validates the `{sinceHours?}` shape via
   * the contract `request.parse` before assembling.
   */
  readonly obsFleetHealthForMcpClient?: (
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Build a fresh per-request `McpServer` instance scoped to the supplied
 * authenticated MCP client.
 *
 * The caller (the Hono `/mcp/v1` route handler) is responsible for
 * connecting the returned `McpServer` to a `StreamableHTTPServerTransport`
 * via `mcp.connect(transport)`.
 */
export function buildMcpServerForClient(
  deps: BuildMcpServerForClientDeps,
  client: TokenClient,
): McpServer {
  ensurePrunerStarted();

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
      // Default-deny safety net. The CI gate makes this impossible in
      // committed code; if it does fire at runtime, treat as a defense-in-
      // depth assertion.
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
    //
    // inputSchema: a permissive Zod record so the SDK invokes our callback
    // with (args, extra) instead of (extra) alone. The SDK's
    // executeToolHandler conditional at @modelcontextprotocol/sdk/dist/esm/
    // server/mcp.js:executeToolHandler reads `if (tool.inputSchema)` and only
    // forwards parsed args when an inputSchema is present. Comis's own
    // `validateInput` (read at dispatch time from getToolMetadata) is the
    // actual per-tool input validator; the inputSchema here is intentionally
    // permissive so the SDK accepts any well-formed object and delegates
    // semantic validation to Comis.
    mcp.registerTool(
      name,
      {
        description: describeTool(name, meta),
        inputSchema: MCP_PERMISSIVE_INPUT_SCHEMA,
      },
      buildDispatchCallback({ deps, client, allowlist, toolName: name }),
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
    "MCP server tool registration complete",
  );

  // Register resources/list + resources/read surface. The advertised
  // `resources` capability was set above; this registers the handlers +
  // the per-client sessionAllowlist + CONFIRMED filter. The McpServer is
  // already wired -- registerResource is additive to the request-handler
  // index inside the SDK.
  registerMcpResourcesForClient(
    mcp,
    {
      logger,
      daemonRpcForMcpClient: deps.daemonRpcForMcpClient,
      resourceReadLimit: deps.resourceReadLimit,
    },
    client,
  );

  return mcp;
}

// ---------------------------------------------------------------------------
// Live dispatcher
// ---------------------------------------------------------------------------

/**
 * Tool-callback return shape (subset of MCP `CallToolResult`).
 *
 * The SDK's `CallToolResult` includes an index signature
 * `[x: string]: unknown`; mirror it here so the closure assigns into
 * `mcp.registerTool(...).cb` without an unsafe cast.
 */
interface ToolCallbackResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
  [k: string]: unknown;
}

/**
 * Per-tool dispatch callback factory. Returns the closure that the SDK
 * invokes when `tools/call` lands for `toolName`. The closure runs the
 * five-step pipeline documented in the module-level docblock.
 */
function buildDispatchCallback(args: {
  readonly deps: BuildMcpServerForClientDeps;
  readonly client: TokenClient;
  readonly allowlist: ReadonlySet<string>;
  readonly toolName: string;
}): (toolArgs: unknown) => Promise<ToolCallbackResult> {
  const { deps, client, allowlist, toolName } = args;
  const { logger } = deps;

  return async (toolArgs: unknown): Promise<ToolCallbackResult> => {
    // ----- Step 1 -- Live policy re-check (defense-in-depth) ---------------
    const liveMeta = getToolMetadata(toolName);
    const livePolicy = liveMeta?.mcpExportPolicy;
    if (!livePolicy || livePolicy === "never-export") {
      logger.warn(
        {
          clientId: client.id,
          toolName,
          submodule: "dispatch",
          errorKind: "auth" as const,
          hint:
            "Tool registration filter let an unexposable tool through; investigate buildMcpServerForClient and tool-metadata-registry",
        },
        "MCP tools/call rejected by live policy re-check",
      );
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `[policy_violation] tool ${toolName} is not exportable (policy=${livePolicy ?? "undefined"})`,
          },
        ],
      };
    }
    if (livePolicy === "permission-gated" && !allowlist.has(toolName)) {
      logger.warn(
        {
          clientId: client.id,
          toolName,
          submodule: "dispatch",
          errorKind: "auth" as const,
          hint:
            "Issue a new mcp-client token with this tool in mcpClient.allowlist, or downgrade the tool to mcpExportPolicy:safe",
        },
        "MCP tools/call rejected -- permission-gated tool not in per-client allowlist",
      );
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `[policy_violation] tool ${toolName} is not allowlisted for this MCP client`,
          },
        ],
      };
    }

    // ----- Step 2 -- Per-client per-tool minute-bucket rate limit ----------
    const ceiling =
      client.mcpClient?.toolRateLimit?.[toolName] ?? deps.defaultToolRateLimit;
    const key = `${client.id}:${toolName}`;
    if (!checkAndIncrement(rateLimitState, key, ceiling)) {
      const resetAt = nextResetAt();
      logger.warn(
        {
          clientId: client.id,
          toolName,
          ceiling,
          resetAt,
          submodule: "rate-limit",
          errorKind: "validation" as const,
          hint:
            "Reduce request rate or raise mcpClient.toolRateLimit override for this client",
        },
        "MCP tools/call rate-limited",
      );
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `[rate_limit_exceeded] tool ${toolName} exceeded ${ceiling}/min for this client; resetAt=${resetAt}`,
          },
        ],
      };
    }

    // ----- Step 3 -- Per-tool validateInput (existing pre-flight) ----------
    const argsRecord = isPlainObject(toolArgs)
      ? toolArgs
      : ({} as Record<string, unknown>);
    if (liveMeta?.validateInput) {
      try {
        const validationError = await liveMeta.validateInput(argsRecord);
        if (validationError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `[invalid_args] ${validationError}`,
              },
            ],
          };
        }
      } catch (err) {
        logger.warn(
          {
            clientId: client.id,
            toolName,
            err,
            submodule: "dispatch",
            errorKind: "validation" as const,
            hint:
              "validateInput threw -- review the per-tool validator at tool-metadata-registry.ts",
          },
          "MCP tools/call validateInput threw",
        );
        // Do NOT surface the raw err.message verbatim to the external MCP
        // client. The structured `err` is captured on the WARN log above
        // (server-side only); the on-wire response carries only the sentinel
        // + correlation handles (clientId + toolName) so an operator can grep
        // logs without exposing internal hints, file paths, or session keys.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[invalid_args] validator threw; check daemon logs (clientId=${client.id} toolName=${toolName})`,
            },
          ],
        };
      }
    }

    // ----- Step 4 -- Dispatch via daemonRpcForMcpClient (trust-flag isolated)
    // STRIP any _trustLevel a hostile caller might have injected in args. The
    // composition-root wiring of daemonRpcForMcpClient already never sets
    // _trustLevel:"admin"; stripping HERE is defense-in-depth so the field
    // never even reaches the indirection. (This strip runs for EVERY tool,
    // including obs_explain below.)
    const safeParams: Record<string, unknown> = stripTrustLevel(argsRecord);

    // ----- Step 4 (obs_explain) -- direct-assembler dispatch -----------------
    // SECURITY: obs_explain reaches the IncidentReport assembler with NO new
    // privilege. It does NOT route through daemonRpcForMcpClient -> the
    // admin-gated obs.explain RPC; instead it invokes the trust-flag-FREE
    // assembler closure DIRECTLY under daemon authority. Its boundary is the
    // per-client mcpClient.allowlist (enforced above at Steps 1+the registration
    // filter) + the digest-only/bounded report. `safeParams` is already
    // _trustLevel-stripped, so no admin trust can be smuggled in.
    if (toolName === "obs_explain") {
      if (!deps.obsExplainForMcpClient) {
        // obsStore-less boot or wiring gap — fail CLOSED, not crash, and do NOT
        // fall through to the trust-isolated daemonRpcForMcpClient indirection
        // (which would hit the admin-gated obs.explain RPC and be rejected).
        logger.warn(
          {
            clientId: client.id,
            toolName,
            submodule: "dispatch",
            errorKind: "internal" as const,
            hint:
              "obs_explain reached dispatch but obsExplainForMcpClient is unwired; check daemon.ts setupGateway obsStore wiring",
          },
          "MCP obs_explain dispatch skipped -- assembler closure unavailable",
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[dispatch_error] obs_explain unavailable; check daemon logs (clientId=${client.id})`,
            },
          ],
        };
      }
      let report: unknown;
      try {
        report = await deps.obsExplainForMcpClient(safeParams);
      } catch (err) {
        logger.warn(
          {
            clientId: client.id,
            toolName,
            err,
            submodule: "dispatch",
            errorKind: "internal" as const,
            hint:
              "obs_explain assembler threw; inspect the obs-explain assembler (resolve/read/assemble) and the request shape",
          },
          "MCP obs_explain dispatch error",
        );
        // Same posture as the generic dispatch_error: never surface raw
        // err.message (it can carry sessionKeys/file paths); a neither-id
        // contract .refine failure also collapses here.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[dispatch_error] tool invocation failed; check daemon logs (clientId=${client.id} toolName=${toolName})`,
            },
          ],
        };
      }
      // Step 5 (same wrap as every other tool): digest-only report flows through
      // wrapExternalContent so prompt-injection text in it gets the SECURITY
      // NOTICE + hex markers.
      const serialized =
        typeof report === "string" ? report : safeStringify(report);
      const wrapped = wrapExternalContent(serialized, {
        source: "mcp_tool",
        sender: `mcp-tool:${toolName}`,
      });
      return { content: [{ type: "text", text: wrapped }] };
    }

    // ----- Step 4 (obs_fleet_health) -- direct-assembler dispatch -------------
    // SECURITY: the cross-session fleet sibling of obs_explain. It reaches the
    // FleetHealthReport with NO new privilege — it does NOT route through
    // daemonRpcForMcpClient -> the admin-gated obs.fleet.health RPC; instead it
    // invokes the trust-flag-FREE assembler closure DIRECTLY under daemon
    // authority. Its boundary is the per-client mcpClient.allowlist (enforced
    // above at Steps 1 + the registration filter) + the digest-only/bounded
    // report. `safeParams` is already _trustLevel-stripped, so no admin trust can
    // be smuggled in.
    if (toolName === "obs_fleet_health") {
      if (!deps.obsFleetHealthForMcpClient) {
        // obsStore-less boot or wiring gap — fail CLOSED, not crash, and do NOT
        // fall through to the trust-isolated daemonRpcForMcpClient indirection
        // (which would hit the admin-gated obs.fleet.health RPC and be rejected).
        logger.warn(
          {
            clientId: client.id,
            toolName,
            submodule: "dispatch",
            errorKind: "internal" as const,
            hint:
              "obs_fleet_health reached dispatch but the closure is unwired; check daemon.ts setupGateway wiring",
          },
          "MCP obs_fleet_health dispatch skipped -- closure unavailable",
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[dispatch_error] obs_fleet_health unavailable; check daemon logs (clientId=${client.id})`,
            },
          ],
        };
      }
      let report: unknown;
      try {
        report = await deps.obsFleetHealthForMcpClient(safeParams);
      } catch (err) {
        logger.warn(
          {
            clientId: client.id,
            toolName,
            err,
            submodule: "dispatch",
            errorKind: "internal" as const,
            hint:
              "obs_fleet_health assembler threw; inspect the fleet-health assembler + request shape",
          },
          "MCP obs_fleet_health dispatch error",
        );
        // NEVER surface raw err.message (it can carry sessionKeys/file paths);
        // a contract request.parse failure also collapses here.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `[dispatch_error] tool invocation failed; check daemon logs (clientId=${client.id} toolName=${toolName})`,
            },
          ],
        };
      }
      // Step 5 (same wrap as every other tool): the digest-only report flows
      // through wrapExternalContent so prompt-injection text in it gets the
      // SECURITY NOTICE + hex markers.
      const serialized =
        typeof report === "string" ? report : safeStringify(report);
      const wrapped = wrapExternalContent(serialized, {
        source: "mcp_tool",
        sender: `mcp-tool:${toolName}`,
      });
      return { content: [{ type: "text", text: wrapped }] };
    }

    const method = deps.toolNameToRpcMethod(toolName);

    let rpcResult: unknown;
    try {
      rpcResult = await deps.daemonRpcForMcpClient(method, safeParams);
    } catch (err) {
      logger.warn(
        {
          clientId: client.id,
          toolName,
          method,
          err,
          submodule: "dispatch",
          errorKind: "internal" as const,
          hint:
            "Inspect daemon RPC handler for the tool's underlying RPC method; the dispatcher does not pass _trustLevel:'admin'",
        },
        "MCP tools/call dispatch error",
      );
      // Do NOT surface the raw err.message verbatim to the external MCP
      // client. Daemon RPC handlers throw messages that can include session
      // keys, user IDs, file paths, and internal configuration hints (e.g.,
      // "Session not found: tenant-abc:user-123:channel-456. Available session
      // keys: ..."). Mirror the WS RPC posture (ws-handler.ts:384 ->
      // "Internal error") and emit a generic response. The structured `err` is
      // captured on the WARN log above; clientId + toolName are correlation
      // handles for log search.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `[dispatch_error] tool invocation failed; check daemon logs (clientId=${client.id} toolName=${toolName})`,
          },
        ],
      };
    }

    // ----- Step 5 -- Wrap output via wrapExternalContent -------------------
    // Defense-in-depth against prompt injection via tool result text.
    // The wrapper prepends a SECURITY NOTICE block + random-hex markers; the
    // MCP client's LLM is responsible for treating wrapped content as data.
    const serialized =
      typeof rpcResult === "string"
        ? rpcResult
        : safeStringify(rpcResult);
    const wrapped = wrapExternalContent(serialized, {
      source: "mcp_tool",
      sender: `mcp-tool:${toolName}`,
    });
    return {
      content: [{ type: "text", text: wrapped }],
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeTool(name: string, _meta: ComisToolMetadata): string {
  return `${name} (from Comis)`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip the `_trustLevel` field from a params record before dispatch. The
 * trust-flag indirection at the composition root never SETS this field;
 * stripping at dispatch time prevents a hostile MCP client from THREADING
 * an admin trust flag through `tools/call` arguments.
 */
function stripTrustLevel(
  params: Record<string, unknown>,
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional discard
  const { _trustLevel, ...rest } = params;
  return rest;
}

/**
 * JSON.stringify with a fallback for circular structures and the
 * `undefined` value. Returns `"[unserializable]"` on failure so the wrapped
 * content is always a string (the `: string` return type is binding).
 *
 * Info-leak defense: `JSON.stringify(undefined)` returns the value
 * `undefined`, not the string `"null"`. A naive
 * `try { return JSON.stringify(v); }` therefore violates the `: string`
 * contract when `v === undefined` (a legal return value for the
 * `Promise<unknown>` indirection backing `daemonRpcForMcpClient`). The
 * `undefined` then propagates into `wrapExternalContent`, which calls
 * `content.replace(...)` and throws a `TypeError`. The MCP SDK catches the
 * throw and surfaces the raw `TypeError` message to the external MCP client
 * (information disclosure). Guard explicitly: callers receive `"undefined"`
 * as the serialized form, which `wrapExternalContent` handles correctly.
 */
function safeStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  try {
    const s = JSON.stringify(v);
    // JSON.stringify can still return undefined for values whose toJSON()
    // returns undefined (e.g., functions, symbols nested in an array slot).
    // Treat any non-string result as the "[unserializable]" sentinel.
    return typeof s === "string" ? s : "[unserializable]";
  } catch {
    return "[unserializable]";
  }
}
