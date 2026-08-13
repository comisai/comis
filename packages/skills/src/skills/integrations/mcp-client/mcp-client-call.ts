// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.
/**
 * Tool-call helper.
 *
 * State-first protocol: callTool(state, deps, qualifiedName, args).
 * The pure qualifyToolName + parseQualifiedName helpers live in
 * mcp-client-types.ts to keep the dependency graph acyclic (see types
 * file's "Qualified name helpers" docblock).
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { systemNowMs, tryGetContext } from "@comis/core";

/**
 * Structured result tag for MCP tool-call 401 failures.
 * Mirrors the needs_oauth_login tag pattern from mcp-client-oauth-connect.ts.
 */
export const NEEDS_REAUTH = "needs_reauth" as const;
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpConnection,
  McpToolCallContent,
  McpToolCallResult,
} from "./mcp-client-types.js";
import { parseQualifiedName } from "./mcp-client-types.js";
import {
  MIN_VIABLE_CALL_BUDGET_MS,
  McpCallDeadlineError,
  McpCallQueueContentionError,
  emitMcpBreakerOpened,
  mcpCallQueueExhaustedHint,
  mcpCallTimeoutHint,
} from "./mcp-client-call-diagnostics.js";
import { handleDisconnection } from "./mcp-client-reconnect.js";
import { reconnectServer } from "./mcp-client-connect.js";
import { resetIdleActivity } from "./mcp-client-idle-eviction.js";

// ---------------------------------------------------------------------------
// Lazy reconnect
// ---------------------------------------------------------------------------

/**
 * Resolve a live connection for a server, lazily reconnecting when it is
 * missing. A server that was idle-evicted has its connection deleted but its
 * serverConfig RETAINED and userDisconnectedFlags UNSET — so a subsequent
 * callTool transparently reconnects via reconnectServer.
 *
 * Synchronous fast path: when the connection is already present this returns
 * `ok(conn)` WITHOUT awaiting (it is not async), so the overwhelmingly common
 * case introduces no extra microtask tick before the PQueue drain — preserving
 * the timing the generation-counter fake-timer tests rely on. Only the
 * missing-connection path is async (reconnectLazily).
 *
 * Returns err("...not connected") for the two cases that must NOT reconnect:
 * no stored config, or an operator-initiated disconnect (flag set). On a
 * successful reconnect, re-fetches the connection from state so the caller
 * operates on the fresh generation (never reuse a pre-reconnect conn reference).
 */
function getOrReconnect(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  serverName: string,
): Result<McpConnection, Error> | Promise<Result<McpConnection, Error>> {
  const existing = state.connections.get(serverName);
  if (existing) return ok(existing);
  return reconnectLazily(state, deps, serverName);
}

async function reconnectLazily(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  serverName: string,
): Promise<Result<McpConnection, Error>> {
  const storedConfig = state.serverConfigs.get(serverName);
  if (!storedConfig || state.userDisconnectedFlags.has(serverName)) {
    return err(new Error(`MCP server "${serverName}" not connected`));
  }
  const reconnectResult = await reconnectServer(state, deps, serverName);
  if (!reconnectResult.ok) {
    return err(
      new Error(`MCP server "${serverName}" idle-reconnect failed: ${reconnectResult.error.message}`),
    );
  }
  const conn = state.connections.get(serverName);
  return conn
    ? ok(conn)
    : err(new Error(`MCP server "${serverName}" reconnected but state missing — race`));
}

// ---------------------------------------------------------------------------
// callTool (state-first)
// ---------------------------------------------------------------------------

/**
 * Call a tool by its qualified name. Routes through the per-server PQueue
 * for serialization, captures the connection generation to detect stale
 * connections after the call resolves, and converts MCP SDK errors into
 * structured Result rejections.
 *
 * Detects session-expiry errors (StreamableHTTPError 404 + McpError
 * RequestTimeout with "session"/"connection closed" messages) and
 * triggers an automatic reconnection via handleDisconnection.
 */
export async function callTool(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  qualifiedName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Result<McpToolCallResult, Error>> {
  const { logger } = deps;
  // The deadline clock starts HERE, not at the SDK request. `callToolTimeoutMs` is
  // documented as the call deadline and is reconciled against the enclosing sub-agent
  // stall budget, but the interval a caller (and that budget) experiences also covers
  // lazy reconnect and the per-server PQueue wait — concurrency 1 for stdio. Budgeting
  // only the request let N sub-agents fanning out onto one server serialize into
  // N x deadline of caller-visible latency: a 120000ms deadline produced a 186570ms
  // observed call, 55% over, which is precisely the overrun the collision check exists
  // to prevent. Measuring from entry makes the configured number mean what it says.
  const callStartedAtMs = systemNowMs();
  const requestTraceId = tryGetContext()?.traceId;
  const parsed = parseQualifiedName(qualifiedName);
  if (!parsed) {
    return err(new Error(`Invalid MCP tool qualified name: "${qualifiedName}"`));
  }

  const { serverName, toolName } = parsed;
  const cancelledError = (): Error =>
    new Error(`MCP tool "${toolName}" on server "${serverName}" was cancelled by the caller`);
  if (signal?.aborted) return err(cancelledError());

  // Resolve the connection, lazily reconnecting an idle-evicted server
  // (connection gone, config retained, flag unset). The happy path is
  // synchronous (no extra await before the PQueue drain); only the
  // missing-connection path returns a Promise.
  const resolved = getOrReconnect(state, deps, serverName);
  const connResult = resolved instanceof Promise ? await resolved : resolved;
  if (!connResult.ok) return err(connResult.error);
  const conn = connResult.value;

  if (conn.status !== "connected") {
    return err(
      new Error(`MCP server "${serverName}" is ${conn.status}, cannot call tool "${toolName}"`),
    );
  }

  // Serialize through per-server concurrency queue.
  // By this point getOrReconnect has returned a connected conn, so "never
  // connected" framing would be misleading on the lazy-reconnect path
  // (the caller DID go through connect). A missing queue here means the queue
  // was torn down concurrently (e.g. a racing disconnect/eviction) or PQueue
  // setup failed during (re)connect — say so.
  const queue = state.callQueues.get(serverName);
  if (!queue) {
    return err(new Error(`MCP server "${serverName}" has no call queue — connection torn down or setup failed during (re)connect; retry`));
  }

  // Resolve per-server breaker overrides (?? preserves 0 → falls through to global).
  const config = state.serverConfigs.get(serverName);
  const breakerThreshold = config?.circuitBreakerThreshold ?? state.options.circuitBreakerThreshold;
  const breakerCooldownMs = config?.circuitBreakerCooldownMs ?? state.options.circuitBreakerCooldownMs;

  // Per-server circuit breaker pre-check.
  //
  // When status === "open" AND cooldown not elapsed, return a synthetic
  // [server_unavailable] tool-call result IMMEDIATELY (no queue slot
  // occupied). The bracketed-sentinel return is ok({ isError: true })
  // -- NOT err(...) -- so the LLM sees a normal-shape tool result with
  // a readable hint and can self-correct.
  //
  // When status === "open" AND cooldown elapsed, transition to "half-open"
  // and fall through (one probe attempt allowed).
  //
  // Revisit if supportsParallelToolCalls lands -- today stdio concurrency = 1
  // makes per-call breaker semantics straightforward.
  const breaker = state.circuitBreakers.get(serverName) ?? { status: "closed" as const, failureCount: 0 };
  if (breaker.status === "open") {
    const elapsed = systemNowMs() - breaker.openedAtMs;
    if (elapsed >= breakerCooldownMs) {
      state.circuitBreakers.set(serverName, { status: "half-open", failureCount: breaker.failureCount });
      // fall through -- half-open allows one probe
    } else {
      const remainingS = Math.ceil((breakerCooldownMs - elapsed) / 1000);
      // When the breaker was tripped by an auth failure (reason="auth"), return
      // needs_reauth instead of server_unavailable so the agent gets an actionable stop signal.
      const text = breaker.reason === "auth"
        ? `[needs_reauth] MCP server "${serverName}" requires re-authentication (circuit open). ` +
          `Run \`comis mcp login ${serverName}\` to authenticate. Do NOT retry this tool.`
        : `[server_unavailable] MCP server "${serverName}" circuit breaker is open (${remainingS}s until half-open probe).`;
      return ok({
        content: [{ type: "text" as const, text }],
        isError: true,
      });
    }
  }

  const queuedResult = await fromPromise(queue.add(async () => {
    // Re-check connection status -- may have changed while queued
    const currentConn = state.connections.get(serverName);
    if (!currentConn || currentConn.status !== "connected") {
      return err(new Error(
        `MCP server "${serverName}" disconnected while call to "${toolName}" was queued`,
      ));
    }

    // Capture generation before call for stale-connection detection
    const callGeneration = currentConn.generation;

    // Charge the reconnect + queue wait against the deadline before issuing the
    // request, so the SDK budget is what is LEFT of the caller's deadline.
    const waitedMs = systemNowMs() - callStartedAtMs;
    const remainingMs = state.options.callToolTimeoutMs - waitedMs;
    // Clamp by the configured deadline so a deliberately shorter deadline does not
    // refuse every call before issuance.
    const viableFloorMs = Math.min(MIN_VIABLE_CALL_BUDGET_MS, state.options.callToolTimeoutMs);
    // At or below the floor, any non-zero wait makes `remainingMs < viableFloorMs`.
    // Use the operator's budget as the only bar there, so an empty-queue 1ms wait is
    // not misreported as concurrency contention.
    const floorApplies = viableFloorMs < state.options.callToolTimeoutMs;
    if (floorApplies ? remainingMs < viableFloorMs : remainingMs <= 0) {
      // Issuing here would burn a slot on a request that cannot finish in time and would
      // then surface as a plain deadline expiry — telling the agent to narrow a request
      // scope that was never the problem. Blame contention explicitly instead.
      const queueHint = mcpCallQueueExhaustedHint(
        serverName, toolName, queue.concurrency,
        state.options.callToolTimeoutMs,
        waitedMs, viableFloorMs,
      );
      logger.warn(
        {
          serverName,
          toolName,
          waitedMs,
          remainingMs,
          viableFloorMs,
          configuredConcurrency: queue.concurrency,
          timeoutMs: state.options.callToolTimeoutMs,
          hint: queueHint,
          errorKind: "resource" as const,
          step: "mcp_call_queue_wait",
        },
        "MCP call deadline consumed by the per-server queue wait before the request was issued",
      );
      return err(new McpCallQueueContentionError(
        queueHint,
        serverName,
        queue.concurrency,
        state.options.callToolTimeoutMs,
        waitedMs,
        viableFloorMs,
      ));
    }

    try {
      const result = await currentConn.client.callTool(
        {
          name: toolName,
          arguments: args,
          ...(requestTraceId
            ? {
                _meta: {
                  "comis.ai/requestTraceId": requestTraceId,
                },
              }
            : {}),
        },
        undefined,
        {
          // What is LEFT of the caller's deadline, not the whole of it — the reconnect
          // and queue wait already consumed `waitedMs` of the same budget.
          timeout: remainingMs,
          ...(signal === undefined ? {} : { signal }),
          // The absolute ceiling is UNCONDITIONAL — it is not part of the
          // tracing branch. `resetTimeoutOnProgress` restarts `timeout` on every
          // progress notification and the SDK applies no ceiling of its own
          // ("If not specified, there is no maximum total timeout"), so without
          // this the configured deadline degrades into a per-progress-GAP
          // timeout and a chatty server holds one call open for a whole turn.
          // Live: a 120000ms cap with observed 200877ms and 296481ms calls.
          //
          // Scoping it to `requestTraceId` (as the first cut did) tied the
          // deadline's enforcement to whether a trace context happened to
          // exist — so the paths WITHOUT one, which is exactly where a
          // long-running background call runs, kept no ceiling at all. A
          // deadline that applies only when tracing is on is not a deadline.
          maxTotalTimeout: remainingMs,
          // UNCONDITIONAL, for the same reason as the ceiling above. The SDK only
          // accepts a progress notification when the request registered a handler
          // for it; gating this on a trace context meant that on any UNTRACED
          // path — which is exactly where a backgrounded call runs — a server
          // that reports progress produced "Received a progress notification for
          // an unknown token" and the client CLOSED THE CONNECTION, failing the
          // tool with -32000 and forcing a reconnect. Live: a progress-reporting MCP tool on a background path.
          onprogress: () => {},
          resetTimeoutOnProgress: true,
        },
      );

      // Verify generation hasn't changed during the call (stale connection guard)
      const postCallConn = state.connections.get(serverName);
      if (!postCallConn || postCallConn.generation !== callGeneration) {
        return err(new Error(
          `MCP server "${serverName}" connection recycled during tool call (gen ${callGeneration} -> ${postCallConn?.generation ?? "gone"}). Retry safely.`,
        ));
      }

      // Map MCP SDK result to our McpToolCallResult
      const content: McpToolCallContent[] = [];
      if ("content" in result && Array.isArray(result.content)) {
        for (const item of result.content) {
          content.push({
            type: item.type,
            text: "text" in item ? (item.text as string) : undefined,
            data: "data" in item ? (item.data as string) : undefined,
            mimeType: "mimeType" in item ? (item.mimeType as string) : undefined,
          });
        }
      }

      // Successful tool call resets consecutive error counter
      state.consecutiveErrors.set(serverName, 0);
      // Pair breaker reset with consecutiveErrors reset.
      state.circuitBreakers.set(serverName, { status: "closed", failureCount: 0 });
      // A successful call is the idle-eviction activity signal — refresh
      // lastActivityMs (NO-OP when no idle ticker is armed).
      resetIdleActivity(state, serverName);

      return ok({
        content,
        isError: "isError" in result ? (result.isError as boolean) === true : false,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        logger.debug?.({ serverName, toolName }, "MCP tool call cancelled by caller");
        return err(cancelledError());
      }

      // Intercept 401/UnauthorizedError FIRST — return structured needs_reauth result,
      // trip the circuit breaker IMMEDIATELY (bypass threshold), and record reason="auth" so
      // subsequent open-state calls return needs_reauth instead of server_unavailable.
      const isUnauthorized =
        error instanceof UnauthorizedError ||
        (error instanceof Error &&
          (error.message.includes("401") ||
            (error as { status?: number }).status === 401));

      if (isUnauthorized) {
        const existing = state.circuitBreakers.get(serverName);
        state.circuitBreakers.set(serverName, {
          status: "open",
          failureCount: (existing?.failureCount ?? 0) + 1,
          openedAtMs: systemNowMs(),
          reason: "auth",
        });
        emitMcpBreakerOpened(
          deps,
          qualifiedName,
          (existing?.failureCount ?? 0) + 1,
          "mcp_auth_rejected",
          error,
        );
        deps.logger.warn(
          {
            serverName,
            toolName,
            hint: `Re-authentication required — run \`comis mcp login ${serverName}\``,
            errorKind: "auth" as const,
          },
          "MCP tool call returned 401 — needs_reauth; circuit breaker tripped immediately",
        );
        return ok({
          content: [{
            type: "text" as const,
            text:
              `[needs_reauth] MCP server "${serverName}" requires re-authentication. ` +
              `Run \`comis mcp login ${serverName}\` to authenticate. Do NOT retry this tool.`,
          }],
          isError: true,
        });
      }

      // Detect session expiry BEFORE timeout check
      const isSessionExpired =
        (error instanceof StreamableHTTPError && error.code === 404) ||
        (error instanceof McpError && error.code === ErrorCode.RequestTimeout &&
         (error.message.toLowerCase().includes("session") || error.message.toLowerCase().includes("connection closed")));

      if (isSessionExpired) {
        logger.info(
          { serverName, toolName, err: message, hint: "Session expired; automatic reconnection will be attempted", errorKind: "dependency" as const },
          "MCP session expired, triggering reconnection",
        );
        handleDisconnection(state, deps, serverName, "client_closed");
        return err(new Error(`MCP server "${serverName}" session expired during tool call "${toolName}". Reconnection initiated -- retry shortly.`));
      }

      const isTimeout =
        (error instanceof McpError && error.code === ErrorCode.RequestTimeout) ||
        (error instanceof Error && error.message.includes("timed out"));

      if (!isTimeout) {
        const latestConn = state.connections.get(serverName);
        if (latestConn) {
          state.connections.set(serverName, {
            ...latestConn,
            status: "error",
            lastHealthCheck: systemNowMs(),
          });
        }
      } else {
        logger.debug?.({ serverName, toolName }, "Tool call timed out, connection status preserved");
      }


      // Increment breaker on non-session-expired failures (includes timeouts +
      // post-call generation mismatches). isSessionExpired is EXEMPT above --
      // it routes through handleDisconnection and the reconnect-success block
      // re-closes the breaker.
      const cur = state.circuitBreakers.get(serverName) ?? { status: "closed" as const, failureCount: 0 };
      const newCount = cur.failureCount + 1;
      if (newCount >= breakerThreshold) {
        state.circuitBreakers.set(serverName, {
          status: "open",
          failureCount: newCount,
          openedAtMs: systemNowMs(),
        });
        logger.warn(
          { serverName, toolName, failureCount: newCount, threshold: breakerThreshold, hint: "Circuit breaker tripped; tool calls will return [server_unavailable] for cooldown", errorKind: "dependency" as const },
          "MCP circuit breaker opened",
        );
        emitMcpBreakerOpened(deps, qualifiedName, newCount, "mcp_failure_threshold", error);
      } else if (cur.status === "open") {
        // Half-open probe failed -> reopen with refreshed openedAtMs. A distinct reason:
        // triage needs "the recovery probe failed again" to read differently from a first
        // trip, since it means the cooldown did not help.
        state.circuitBreakers.set(serverName, {
          status: "open",
          failureCount: newCount,
          openedAtMs: systemNowMs(),
        });
        emitMcpBreakerOpened(deps, qualifiedName, newCount, "mcp_half_open_probe_failed", error);
      } else {
        state.circuitBreakers.set(serverName, { status: cur.status, failureCount: newCount });
      }

      // A deadline expiry is DETERMINISTIC for the same call: the bare SDK string
      // ("MCP error -32001: Request timed out") names neither the knob nor the
      // value, so an agent reads it as transient and retries unchanged. Live
      // (comis-moshe 2026-07-26): a month-wide 165-vehicle report re-expired the
      // same 120s deadline FOUR times — 8 minutes of the user's time and a tripped
      // breaker — because the surfaced hint said "retry the underlying operation
      // when appropriate". Name the knob + the value that expired, and say plainly
      // that an unchanged retry re-expires it. (AGENTS.md §2.7: a hint names the
      // exact config key and the numbers that conflicted.)
      //
      // Placed AFTER the breaker accounting above so a timeout still counts toward
      // the threshold exactly as before — only the surfaced message changes.
      if (isTimeout) {
        const timeoutMs = state.options.callToolTimeoutMs;
        const timeoutHint = mcpCallTimeoutHint(
          serverName,
          toolName,
          timeoutMs,
          Object.keys(args).length > 0,
          waitedMs,
        );
        logger.warn(
          {
            serverName,
            toolName,
            timeoutMs,
            hint: timeoutHint,
            errorKind: "dependency" as const,
          },
          "MCP tool call timed out at the configured call deadline",
        );
        return err(new McpCallDeadlineError(timeoutHint, timeoutMs, waitedMs));
      }

      return err(error instanceof Error ? error : new Error(message));
    }
  }, { signal }) as Promise<Result<McpToolCallResult, Error>>);
  if (!queuedResult.ok) {
    return signal?.aborted ? err(cancelledError()) : err(queuedResult.error);
  }
  return queuedResult.value ?? err(new Error(
    `MCP server "${serverName}" call queue ended without a result for tool "${toolName}"`,
  ));
}
