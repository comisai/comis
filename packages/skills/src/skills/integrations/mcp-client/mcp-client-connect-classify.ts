// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by the AgentTool wrapper.
/**
 * Connect-FAILURE classification + recording.
 *
 * Split out of mcp-client-connect.ts to keep that leaf under the 500-line
 * per-subdirectory cap (the OAuth-seam split precedent). Owns:
 *  - classifyConnectFailure — PURE: a raw connect error (+ any sanitized stdio
 *    stderr tail) → a fault CLASS + an enriched message + a class-specific hint.
 *  - recordConnectFailure — the generic (non-OAuth) failure path: classify, write
 *    the error-state connection entry, log the ERROR, emit
 *    mcp:server:connect_failed, and return the enriched err Result. The OAuth
 *    needs_oauth_login path stays inline in connectServer.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { err } from "@comis/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { systemNowMs, sanitizeLogString } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpConnection,
  McpServerConfig,
} from "./mcp-client-types.js";

interface ClassifiedConnectFailure {
  /** Closed fault class — rides the mcp:server:connect_failed event + health signal. */
  readonly reason: "command_not_found" | "server_exited" | "handshake_timeout" | "transport_error";
  /** Operator-facing next step, branched by class (never the old generic string). */
  readonly hint: string;
  /** Enriched message for the caller + the error-state entry (folds in stderr). */
  readonly message: string;
  /** Bounded stderr tail for the log `stderr` field (empty when none captured). */
  readonly stderrTail: string;
}

const STDERR_TAIL_MAX = 1500;

/**
 * Floor for redacting a KNOWN configured secret VALUE out of the stderr tail. The
 * pattern scrubber (sanitizeLogString) only catches credential FORMATS; a plain
 * configured secret (a password echoed as `KEY=value`) matches nothing, so we also
 * strip the exact env/header values this server was given. The floor keeps trivial
 * values (`"1"`, `"true"`, a short flag) from nuking legitimate diagnostic text.
 */
const MIN_KNOWN_SECRET_LEN = 4;

/**
 * Redact the server's KNOWN configured secret values (env + header values) out of a
 * captured stderr tail — literal, substring-exact replacement (no regex, so a value
 * with regex metacharacters is handled verbatim). Complements sanitizeLogString: this
 * catches format-less secrets the pattern scrubber cannot. Skips short values and
 * still-unresolved `${VAR}` placeholders (not secrets).
 */
function scrubKnownSecretValues(text: string, config: McpServerConfig): string {
  if (!text) return text;
  const values = [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})];
  let out = text;
  for (const v of values) {
    if (typeof v !== "string" || v.length < MIN_KNOWN_SECRET_LEN || v.includes("${")) continue;
    // eslint-disable-next-line no-restricted-syntax -- known-secret redaction sentinel (not the Pino censor literal)
    if (out.includes(v)) out = out.split(v).join("[REDACTED]");
  }
  return out;
}

/**
 * Turn a raw connect error (+ any captured stdio stderr) into a fault CLASS, an
 * enriched message, and a class-specific hint. The bare SDK error for a stdio
 * crash is the opaque "MCP error -32000: Connection closed"; the child's own
 * stderr ("… is required") is the real cause and belongs in the message the
 * operator/agent sees — not a separate log line to hand-correlate. PURE.
 */
export function classifyConnectFailure(
  config: McpServerConfig,
  rawMessage: string,
  stderrTail: string,
  connectTimeoutMs: number,
): ClassifiedConnectFailure {
  // Fold in the child's stderr, but SANITIZE it first: a credentialed server can
  // echo a connection string / API key on the way down, and this tail flows into
  // the returned error, the mcp.list/status error-state, AND the failure log (its
  // `stderr` field is unstructured free-text, not a Pino-redacted key). Truncate
  // before sanitizing so the redaction input is always bounded under the ReDoS
  // cap, then scrub exactly what we expose.
  const rawTail =
    stderrTail.length > STDERR_TAIL_MAX ? `…${stderrTail.slice(-STDERR_TAIL_MAX)}` : stderrTail;
  // Two-layer scrub: strip this server's KNOWN configured secret values (catches
  // format-less secrets like a plain KEY=password echo), THEN the pattern scrubber
  // for anything credential-SHAPED the child emitted that we don't hold verbatim.
  const tail = sanitizeLogString(scrubKnownSecretValues(rawTail, config));
  const lower = rawMessage.toLowerCase();

  // A spawn ENOENT — the command (npx/uvx/binary) is missing or not on PATH.
  if (lower.includes("enoent")) {
    return {
      reason: "command_not_found",
      hint: `command "${config.command ?? "?"}" not found — install it and ensure it is on the daemon's PATH (npx/uvx must be resolvable by the daemon process)`,
      message: `MCP server "${config.name}" failed to spawn: ${rawMessage}`,
      stderrTail: tail,
    };
  }

  // Handshake / listTools timeout — the process is hung or slow to initialize.
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      reason: "handshake_timeout",
      hint: `server did not complete the MCP handshake within ${connectTimeoutMs}ms — the process may be hung or slow to start${tail ? " (see stderr)" : ""}`,
      message: tail
        ? `MCP server "${config.name}" handshake timed out after ${connectTimeoutMs}ms. Server stderr:\n${tail}`
        : `MCP server "${config.name}" handshake timed out after ${connectTimeoutMs}ms`,
      stderrTail: tail,
    };
  }

  // A stdio child that exited before the handshake — the "Connection closed" class.
  if (config.transport === "stdio") {
    if (tail) {
      return {
        reason: "server_exited",
        hint: "server process exited before the MCP handshake — see its stderr (a missing or invalid required env var is the most common cause; pass credentials via the connect env field as ${VAR} refs)",
        message: `MCP server "${config.name}" exited before the handshake. Server stderr:\n${tail}`,
        stderrTail: tail,
      };
    }
    return {
      reason: "server_exited",
      hint: "server process exited before the handshake with no stderr — verify command/args and any required env (a missing env var is the most common cause; pass it via the connect env field as ${VAR} refs)",
      message: `MCP server "${config.name}" exited before the handshake (no stderr captured): ${rawMessage}`,
      stderrTail: tail,
    };
  }

  // Remote transport (sse/http) — reachability / auth.
  return {
    reason: "transport_error",
    hint: "connection failed — verify the URL is reachable and any required auth/headers are set",
    message: `MCP server "${config.name}" connection failed: ${rawMessage}`,
    stderrTail: tail,
  };
}

/**
 * Record a generic (non-OAuth) connect failure: classify, write the error-state
 * connection entry (the ENRICHED message so mcp.list/status shows the real
 * cause), log the ERROR (reason + hint + sanitized stderr), emit
 * mcp:server:connect_failed (so a failed install is diagnosable via
 * `comis fleet`/`explain`, not only a raw daemon.log grep), and return the
 * enriched err (original error kept as `cause` for stack context).
 */
export function recordConnectFailure(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  config: McpServerConfig,
  rawMessage: string,
  error: unknown,
): Result<McpConnection, Error> {
  const stderrTail =
    config.transport === "stdio" ? (state.lastStderr.get(config.name)?.trim() ?? "") : "";
  const classified = classifyConnectFailure(config, rawMessage, stderrTail, state.options.connectTimeoutMs);

  state.connections.set(config.name, {
    name: config.name,
    client: null as unknown as Client,
    status: "error",
    tools: [],
    lastHealthCheck: systemNowMs(),
    reconnectAttempt: 0,
    maxReconnectAttempts: state.options.reconnectOpts.maxAttempts,
    error: classified.message,
    generation: state.generations.get(config.name) ?? 0,
  });

  deps.logger.error(
    {
      serverName: config.name,
      err: rawMessage,
      ...(classified.stderrTail ? { stderr: classified.stderrTail } : {}),
      reason: classified.reason,
      hint: classified.hint,
      errorKind: "dependency" as const,
    },
    "MCP server connection failed",
  );
  deps.eventBus?.emit("mcp:server:connect_failed", {
    serverName: config.name,
    transport: config.transport,
    reason: classified.reason,
    timestamp: systemNowMs(),
  });

  const outErr = new Error(classified.message);
  if (error instanceof Error) (outErr as Error & { cause?: unknown }).cause = error;
  return err(outErr);
}
