// SPDX-License-Identifier: Apache-2.0
/**
 * Diagnostics and operator/agent-facing messages for MCP tool calls.
 *
 * Split out of `mcp-client-call.ts` to keep that module under its size cap. These belong
 * together: each one exists so a failure names the knob or the cause an operator can act on
 * instead of surfacing a bare SDK string.
 *
 * @module
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { systemNowMs } from "@comis/core";
import type { McpClientManagerDeps } from "./mcp-client-types.js";

/**
 * Smallest budget worth issuing a request with. Below this the request cannot plausibly
 * complete, so spending a concurrency slot on it only delays the calls behind it and
 * converts a contention problem into a misleading deadline expiry.
 */
export const MIN_VIABLE_CALL_BUDGET_MS = 250;

/**
 * Below this, a queue wait is not worth reporting in an expiry hint — it is scheduling
 * noise rather than contention, and naming it would distract from the real cause.
 */
const QUEUE_WAIT_DISCLOSURE_FLOOR_MS = 1000;

/**
 * Typed form of a deterministic MCP call deadline. The bridge keeps this error
 * as a cause so the background runtime can retain the safe knob and timing
 * numbers while omitting the external error body from trajectories.
 */
export class McpCallDeadlineError extends Error {
  readonly code = "mcp_call_deadline_exceeded" as const;
  readonly configKey = "integrations.mcp.callToolTimeoutMs" as const;
  readonly requestBudgetMs: number;

  constructor(
    message: string,
    readonly configuredMs: number,
    readonly queueWaitedMs: number,
  ) {
    super(message);
    this.name = "McpCallDeadlineError";
    this.requestBudgetMs = Math.max(0, configuredMs - queueWaitedMs);
  }
}

/** Typed local refusal when the per-server queue consumes the call budget. */
export class McpCallQueueContentionError extends Error {
  readonly code = "mcp_queue_contention" as const;
  readonly configKey = "integrations.mcp.servers[].maxConcurrency" as const;
  readonly requestBudgetMs: number;

  constructor(
    message: string,
    readonly serverName: string,
    readonly configuredConcurrency: number,
    readonly configuredMs: number,
    readonly queueWaitedMs: number,
    readonly minViableMs: number,
  ) {
    super(`[mcp_queue_contention] ${message}`);
    this.name = "McpCallQueueContentionError";
    this.requestBudgetMs = Math.max(0, configuredMs - queueWaitedMs);
  }
}

/**
 * Coarse, allowlisted classification of what tripped the breaker. Deliberately a fixed
 * vocabulary rather than anything derived from the error body: this rides an event onto the
 * trajectory, so it must never carry a server's raw message.
 */
function mcpBreakerErrorTag(error: unknown): string {
  if (error instanceof UnauthorizedError) return "unauthorized";
  if (!(error instanceof Error)) return "unknown";
  if (error.message.includes("401")) return "unauthorized";
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return "timeout";
  if (/timed out|timeout/i.test(error.message)) return "timeout";
  if (/ECONN|ENOTFOUND|EPIPE|socket|closed/i.test(error.message)) return "transport";
  return "server_error";
}

/**
 * Publish an MCP per-server breaker open transition onto the event bus.
 *
 * There are two breakers, and only the agent-side tool-retry one was wired to observability.
 * `tool:breaker_opened` is what feeds `bridgeResult.breakerTripCount` → the session-health
 * rollup → the trajectory `tool.breaker_opened` record → the OTel `comis.breaker_trips`
 * metric → `system-health`'s breaker trips and `explain`'s breaker timeline. This breaker
 * emitted nothing: it flipped its own map, started returning `[server_unavailable]`, logged a
 * WARN, and left every one of those counters at zero — so a session whose MCP server was
 * circuit-broken still reported `breakerTripCount: 0`, which triage trusts and stops looking.
 *
 * `seq` is 0 because it is documented as execution-scoped and this manager is daemon-scoped
 * (shared across sessions); the same convention the other out-of-executor emitter uses. The
 * emit runs inside the caller's async context, so trace correlation comes from there.
 */
export function emitMcpBreakerOpened(
  deps: McpClientManagerDeps,
  qualifiedName: string,
  consecutiveFailures: number,
  reason: string,
  error: unknown,
): void {
  deps.eventBus?.emit("tool:breaker_opened", {
    toolName: qualifiedName,
    consecutiveFailures,
    errorTag: mcpBreakerErrorTag(error),
    reason,
    seq: 0,
    timestamp: systemNowMs(),
  });
}

/**
 * The message for a call whose deadline was consumed by the per-server queue wait before
 * its request could be issued.
 *
 * Distinct from {@link mcpCallTimeoutHint} because the remediation is the opposite: the
 * server was never asked, so narrowing the request scope changes nothing. What has to
 * change is concurrency (or the number of callers fanning out at once).
 *
 * Reports all three numbers the refusal turns on — waited, left, and the minimum a request
 * is issued with. Stating only "used up its Nms deadline" hid the floor: a call refused with
 * budget still on the clock read as a contradiction, and the floor's existence was
 * discoverable only by reading this module.
 *
 * @param serverName - the MCP server whose queue the call waited in.
 * @param toolName - the qualified tool name that never got issued.
 * @param configuredConcurrency - the resolved concurrency of the queue that refused the call.
 * @param timeoutMs - the resolved `integrations.mcp.callToolTimeoutMs`.
 * @param waitedMs - how long the call actually waited for a concurrency slot.
 * @param minViableMs - the budget floor the remainder fell under ({@link MIN_VIABLE_CALL_BUDGET_MS},
 *   clamped by `timeoutMs`).
 * @returns the hint text (also used verbatim as the Error message).
 */
export function mcpCallQueueExhaustedHint(
  serverName: string,
  toolName: string,
  configuredConcurrency: number,
  timeoutMs: number,
  waitedMs: number,
  minViableMs: number,
  implicitStdioConcurrency: boolean,
): string {
  const remainingMs = Math.max(0, timeoutMs - waitedMs);
  const concurrencyEntry =
    `integrations.mcp.servers[] entry named ${JSON.stringify(serverName)}`;
  return (
    `${concurrencyEntry} has maxConcurrency=${configuredConcurrency}; queueWaitedMs=${waitedMs}; ` +
    `requestBudgetMs=${remainingMs}; configuredMs=${timeoutMs}; minViableMs=${minViableMs}. ` +
    `MCP tool "${toolName}" on server "${serverName}" never ran: it waited ${waitedMs}ms for a ` +
    `concurrency slot, leaving ${remainingMs}ms of its ${timeoutMs}ms call deadline ` +
    `(\`integrations.mcp.callToolTimeoutMs\`) — under the ${minViableMs}ms a request needs to be ` +
    "worth issuing. The server was never asked, so this is contention " +
    "between callers, NOT a slow server or an over-broad request — narrowing the arguments will " +
    "not help. Unlike a deadline expiry this is not deterministic: the same call can succeed once " +
    "the calls ahead of it drain, so a retry is reasonable. To fix it for good, raise " +
    `\`maxConcurrency\` above ${configuredConcurrency} on ${concurrencyEntry}` +
    (implicitStdioConcurrency
      ? " or set `supportsParallelToolCalls: true` to opt into the implicit stdio concurrency default"
      : "") +
    ", or have " +
    "fewer callers hit this server at once."
  );
}

/**
 * The operator/agent-facing message for an MCP call that hit its configured
 * deadline.
 *
 * Exported so the log site, the returned `Error`, and the test all read the SAME
 * text — a duplicated literal is how "No action needed."-class hints drift.
 *
 * @param serverName - the MCP server whose call expired.
 * @param toolName - the qualified tool name that expired.
 * @param timeoutMs - the ACTUAL resolved `integrations.mcp.callToolTimeoutMs`.
 * @param hasInputArguments - whether this invocation supplied arguments whose
 *   scope can potentially be reduced or split.
 * @returns the hint text (also used verbatim as the Error message).
 */
export function mcpCallTimeoutHint(
  serverName: string,
  toolName: string,
  timeoutMs: number,
  hasInputArguments: boolean,
  queueWaitedMs = 0,
): string {
  // When a queue wait ate part of the budget, the request did NOT get `timeoutMs`. Saying
  // it did sends the agent to shrink a request that was already running against a short
  // clock. Below the reporting floor the difference is noise, so stay silent.
  const contention =
    queueWaitedMs >= QUEUE_WAIT_DISCLOSURE_FLOOR_MS
      ? `Note: ${queueWaitedMs}ms of that deadline was spent waiting for a concurrency slot on ` +
        `this server, so the request itself only had ${timeoutMs - queueWaitedMs}ms. Concurrent ` +
        "callers, not only this call's scope, are part of why it expired. "
      : "";
  const callerRemediation = hasInputArguments
    ? `Narrow the request scope or split it into smaller calls using this tool's input arguments ` +
      `so each call completes inside ${timeoutMs}ms. `
    : "This call supplied no input arguments. Check the MCP server's health and latency before " +
      "retrying; an unchanged retry will re-expire the same deadline. ";
  return (
    `MCP tool "${toolName}" on server "${serverName}" timed out — it exceeded the call ` +
    `deadline of ${timeoutMs}ms (\`integrations.mcp.callToolTimeoutMs\`, currently ${timeoutMs}). ` +
    "This deadline is deterministic — do not retry it unchanged, the same call re-expires it. " +
    contention +
    callerRemediation +
    "The deadline itself cannot be changed from here — it is an immutable config path, so only an " +
    "operator can adjust it by editing the config file and restarting the daemon."
  );
}
