// SPDX-License-Identifier: Apache-2.0
// @allow-throw: skill bridge / integration boundary; throws caught by AgentTool wrapper or skill loader boundary.
/**
 * Server discovery + tool listing helpers.
 *
 * Transport construction, MCP client construction (with listChanged
 * handler), server metadata extraction, stdio stderr capture, and the
 * cross-server tool aggregation getter. Used by mcp-client-connect.ts
 * during the connect/reconnect lifecycle.
 *
 * State-first protocol: helpers that touch closure state take
 * `state: McpClientManagerState` as their first parameter; pure helpers
 * (createTransport, extractServerMetadata, wireStderrCapture) take only
 * the inputs they need.
 *
 * @module
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mcpStderrLooksLikeError } from "./mcp-client-connect-classify.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash } from "node:crypto";
import { isMcpInstructionTextSafe, systemNowMs } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpServerConfig,
  McpToolDefinition,
} from "./mcp-client-types.js";
import { qualifyToolName } from "./mcp-client-types.js";
import { createRedirectPolicyFetch } from "./mcp-client-redirect-policy.js";
import {
  getPrlimitAvailableCached,
  getPrlimitWarnEmitted,
  setPrlimitWarnEmitted,
} from "./mcp-client-prlimit-probe.js";
// Re-export the prlimit probe public + test surface so existing callers
// (and the co-located mcp-client-discover.test.ts) continue to import
// from this leaf — the helpers were moved to a sibling leaf to keep this
// file under the 500-line per-subdirectory cap, not to change the API.
export {
  getPrlimitAvailable,
  refreshPrlimitAvailable,
  __resetPrlimitWarnForTests,
  __resetPrlimitProbeForTests,
} from "./mcp-client-prlimit-probe.js";

// Logger shape used by the prlimit WARN-skip path; matches the
// `McpClientManagerDeps["logger"]` two-arg overload threaded through from
// the connect / reconnect call sites.
type ComisLoggerLike = McpClientManagerDeps["logger"];

// The stdio env allowlist + interpreter-control blocklist + `scrubStdioEnv`
// builder were moved to a sibling leaf to keep this file under the 500-line
// per-subdirectory cap (the tools/list_changed diff helpers pushed it over).
// Re-exported here so existing callers and the co-located
// mcp-client-discover.test.ts keep importing from this leaf — not an API change.
import { scrubStdioEnv, MCP_STDIO_BUILTIN_ENV_ALLOWLIST } from "./mcp-client-stdio-env.js";
export { scrubStdioEnv, MCP_STDIO_BUILTIN_ENV_ALLOWLIST };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum character length for server instructions to prevent preamble budget issues. */
const MAX_INSTRUCTIONS_CHARS = 4096;
const INSTRUCTIONS_TRUNCATED_SUFFIX = " [truncated]";

// ---------------------------------------------------------------------------
// Transport creation helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a stdio command so:
 *   1. NODE_OPTIONS strip — child Node process does NOT inherit the daemon's
 *      `--permission` flags. `env -u NODE_OPTIONS` clears it before Node reads
 *      it. Non-Node servers (uvx, Python) pass through as no-op.
 *   2. Per-server rlimits via `prlimit(1)`. When `rlimits`
 *      is set AND prlimit is available, prepends `prlimit --as=N --nofile=N
 *      --cpu=N --`. Partial overrides accepted (`{ cpu: 600 }` → only `--cpu`).
 *      When `rlimits` is unset → no prlimit wrap. When prlimit is absent
 *      (macOS dev) → env-only wrap + ONE WARN per daemon process
 *      (`errorKind: "platform"`).
 *
 * Composition: `[prlimit --as=N --nofile=N --cpu=N --]  /usr/bin/env -u NODE_OPTIONS  <cmd> <args>`.
 * Exported for unit-test assertion.
 */
export function wrapStdioCommand(
  command: string,
  args: readonly string[] | undefined,
  rlimits: { as?: number; nofile?: number; cpu?: number } | undefined,
  logger: ComisLoggerLike,
  serverName: string,
): { command: string; args: string[] } {
  const innerArgs = ["-u", "NODE_OPTIONS", command, ...(args ?? [])];

  // No rlimits requested: return the existing env-only wrap unchanged.
  if (
    !rlimits ||
    (rlimits.as === undefined &&
      rlimits.nofile === undefined &&
      rlimits.cpu === undefined)
  ) {
    return { command: "/usr/bin/env", args: innerArgs };
  }

  // Rlimits requested but prlimit unavailable (macOS dev): WARN once + degrade.
  // Read the lazily-cached probe result. The very first call to
  // wrapStdioCommand triggers the probe; subsequent calls hit the cache.
  // Operators who install util-linux post-hoc can force a re-probe via
  // refreshPrlimitAvailable().
  if (!getPrlimitAvailableCached()) {
    if (!getPrlimitWarnEmitted()) {
      logger.warn(
        {
          serverName,
          hint:
            "prlimit(1) not on PATH; rlimits not applied (Linux util-linux required). " +
            "Production target is Linux; macOS dev runs without rlimit defense-in-depth. " +
            "If util-linux was installed AFTER daemon start, call refreshPrlimitAvailable() to re-probe.",
          errorKind: "platform" as const,
        },
        "MCP rlimits skipped — prlimit unavailable",
      );
      setPrlimitWarnEmitted();
    }
    return { command: "/usr/bin/env", args: innerArgs };
  }

  // Build prlimit flag set — emit ONLY the flags for fields explicitly set
  // (partial-override semantics).
  const prlimitFlags: string[] = [];
  if (rlimits.as !== undefined) prlimitFlags.push(`--as=${rlimits.as}`);
  if (rlimits.nofile !== undefined) prlimitFlags.push(`--nofile=${rlimits.nofile}`);
  if (rlimits.cpu !== undefined) prlimitFlags.push(`--cpu=${rlimits.cpu}`);

  return {
    command: "prlimit",
    args: [...prlimitFlags, "--", "/usr/bin/env", ...innerArgs],
  };
}

/** No-op fallback logger for createTransport callers that don't thread one (test fixtures). */
const NO_OP_LOGGER: ComisLoggerLike = {
  info: () => { /* noop */ },
  warn: () => { /* noop */ },
  error: () => { /* noop */ },
  debug: () => { /* noop */ },
};

export function createTransport(
  config: McpServerConfig,
  logger: ComisLoggerLike = NO_OP_LOGGER,
) {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new Error(`MCP server "${config.name}": stdio transport requires "command"`);
    }
    const wrapped = wrapStdioCommand(
      config.command,
      config.args,
      config.rlimits,
      logger,
      config.name,
    );
    return new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      stderr: "pipe",  // capture stderr for debugging
      // Strict allowlist + operator-extension scrub. Replaces the prior
      // `{ ...systemEnvSnapshot(), ...config.env }` spread, which leaked
      // every daemon-process credential env var into every spawned MCP child.
      // The architecture-test dangerous-key negative-control list at
      // test/architecture/mcp-prespawn-allowlist.test.ts enforces the denylist.
      env: scrubStdioEnv(config.env, config.safetyAllowedEnvKeys),
      ...(config.cwd ? { cwd: config.cwd } : {}),
    });
  } else if (config.transport === "sse") {
    if (!config.url) {
      throw new Error(`MCP server "${config.name}": sse transport requires "url"`);
    }
    return new SSEClientTransport(new URL(config.url), {
      requestInit: config.headers
        ? { headers: config.headers }
        : undefined,
      // An auth:"oauth" server with the OAuth seam wired uses the deduped-refresh
      // fetch (which itself composes the redirect-policy fetch inside it, so
      // cross-host header scrub still applies). The bare redirect-policy fetch is
      // the legacy/non-OAuth fallback.
      // Cross-host redirect header scrub: strips Authorization / Cookie /
      // Proxy-Authorization on cross-host redirect (URL.host string mismatch
      // including port); preserves on same-host (including http to https upgrade);
      // throws [max_redirects_exceeded] after 20 hops. See
      // mcp-client-redirect-policy.ts for the full policy.
      fetch: config.oauthFetch ?? createRedirectPolicyFetch({ maxRedirections: 20 }),
      // Attach the OAuthClientProvider adapter ONLY for auth:"oauth" servers with
      // a constructed provider (threaded onto the runtime config by connectServer).
      // The SDK then drives tokens()/saveTokens() and, on a 401, the auth()
      // refresh path. requestInit + fetch above are untouched.
      ...(config.auth === "oauth" && config.oauthProvider
        ? { authProvider: config.oauthProvider }
        : {}),
    });
  } else if (config.transport === "http") {
    if (!config.url) {
      throw new Error(`MCP server "${config.name}": http transport requires "url"`);
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers
        ? { headers: config.headers }
        : undefined,
      // Deduped-refresh fetch for auth:"oauth" (symmetric with the SSE branch).
      // The wrapper composes on top of the redirect-policy fetch so cross-host
      // header scrub still applies. Same policy as the SSE branch above;
      // see mcp-client-redirect-policy.ts.
      fetch: config.oauthFetch ?? createRedirectPolicyFetch({ maxRedirections: 20 }),
      // Attach the OAuthClientProvider adapter ONLY for auth:"oauth" servers with
      // a constructed provider (symmetric with the SSE branch). requestInit +
      // fetch above are untouched.
      ...(config.auth === "oauth" && config.oauthProvider
        ? { authProvider: config.oauthProvider }
        : {}),
    });
  }
  throw new Error(`MCP server "${config.name}": unsupported transport "${config.transport as string}"`);
}

// ---------------------------------------------------------------------------
// tools/list_changed diff (pure)
// ---------------------------------------------------------------------------

/**
 * Stable, content-free fingerprint of a tool's MUTABLE contract surface
 * (`description` + `inputSchema`). Two tools sharing a name are "changed"
 * iff their fingerprints differ. JSON.stringify gives a deterministic
 * serialization for the plain JSON-Schema objects MCP servers return
 * (object/array/string/number/boolean/null — no functions, no symbols).
 */
function toolContractFingerprint(tool: McpToolDefinition): string {
  return JSON.stringify({
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}

/**
 * Diff a previous vs. new MCP tool list by NAME, plus detect IN-PLACE
 * mutation of a surviving tool's contract.
 *
 *   - addedTools:   names present in `next` but not `previous`
 *   - removedTools: names present in `previous` but not `next`
 *   - changedTools: names present in BOTH whose `description` or `inputSchema`
 *     changed — the CVE-2025-54136 "rug-pull" (a tool approved/seen with one
 *     schema is silently swapped for another mid-session). A name-only diff
 *     misses this entirely.
 *
 * Returns NAMES ONLY in every bucket — never the (untrusted, server-controlled)
 * schemas/descriptions themselves, so the result is safe to put on an event
 * payload / log line. Pure: no I/O, no state.
 */
export function diffToolLists(
  previousTools: readonly McpToolDefinition[],
  newTools: readonly McpToolDefinition[],
): { addedTools: string[]; removedTools: string[]; changedTools: string[] } {
  const previousByName = new Map(previousTools.map((t) => [t.name, t] as const));
  const currentNames = new Set(newTools.map((t) => t.name));

  const addedTools = newTools.filter((t) => !previousByName.has(t.name)).map((t) => t.name);
  const removedTools = previousTools
    .filter((t) => !currentNames.has(t.name))
    .map((t) => t.name);

  const changedTools: string[] = [];
  for (const t of newTools) {
    const prev = previousByName.get(t.name);
    if (!prev) continue; // added — handled above
    if (toolContractFingerprint(prev) !== toolContractFingerprint(t)) {
      changedTools.push(t.name);
    }
  }

  return { addedTools, removedTools, changedTools };
}

// ---------------------------------------------------------------------------
// MCP Client creation helper (with listChanged handler)
// ---------------------------------------------------------------------------

/**
 * Create an MCP SDK Client wired with a tools/list_changed handler that
 * refreshes the cached tool definitions for the given server. Touches
 * state.connections to swap in the new tool list and emits a
 * mcp:server:tools_changed event when eventBus is configured.
 */
export function createClient(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  serverName: string,
) {
  const { logger } = deps;
  return new Client(
    { name: "comis", version: "1.0.0" },
    {
      capabilities: {},
      ...(deps.eventBus ? {
        listChanged: {
          tools: {
            onChanged: (listChangeError, newToolList) => {
              if (listChangeError) {
                logger.warn(
                  { serverName, err: listChangeError.message, hint: "MCP server tool list refresh failed", errorKind: "dependency" as const },
                  "tools/list_changed refresh failed",
                );
                return;
              }
              const conn = state.connections.get(serverName);
              if (!conn || conn.status !== "connected") return;

              const previousTools = conn.tools;
              const newTools: McpToolDefinition[] = (newToolList ?? []).map((tool) => ({
                name: tool.name,
                qualifiedName: qualifyToolName(serverName, tool.name),
                description: tool.description,
                inputSchema: tool.inputSchema as Record<string, unknown>,
              }));

              state.connections.set(serverName, {
                ...conn,
                tools: newTools,
                lastHealthCheck: systemNowMs(),
              });

              // Diff BY NAME (added/removed) AND detect in-place mutation of a
              // surviving tool's contract (changedTools) — the CVE-2025-54136
              // "rug-pull" a name-only diff would miss.
              const { addedTools, removedTools, changedTools } = diffToolLists(
                previousTools,
                newTools,
              );

              // Fire only when something actually changed (add / remove /
              // in-place schema-or-description mutation). A bare
              // tools/list_changed notification that resolves to an identical
              // list emits no signal.
              if (addedTools.length || removedTools.length || changedTools.length) {
                deps.eventBus!.emit("mcp:server:tools_changed", {
                  serverName,
                  previousToolCount: previousTools.length,
                  currentToolCount: newTools.length,
                  addedTools,
                  removedTools,
                  changedTools,
                  timestamp: systemNowMs(),
                });

                logger.info(
                  { serverName, previousCount: previousTools.length, currentCount: newTools.length, added: addedTools, removed: removedTools, changed: changedTools },
                  "MCP server tool list changed",
                );
              }
            },
          },
        },
      } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Server metadata extraction helper (pure)
// ---------------------------------------------------------------------------

export function extractServerMetadata(client: Client) {
  const rawInstructions: unknown = client.getInstructions();
  const serverCaps = client.getServerCapabilities();
  const serverImpl = client.getServerVersion();

  const capabilities = serverCaps ? (serverCaps as Record<string, unknown>) : undefined;
  const serverInfo = serverImpl ? { name: serverImpl.name, version: serverImpl.version } : undefined;

  let instructions: string | undefined;
  let instructionHash: string | undefined;
  let instructionValidation: "absent" | "included" | "truncated" | "rejected" = "absent";
  if (rawInstructions !== undefined && rawInstructions !== null) {
    if (typeof rawInstructions !== "string") {
      instructionValidation = "rejected";
    } else {
      const trimmed = rawInstructions.trim();
      if (trimmed.length > 0 && !isMcpInstructionTextSafe(trimmed)) {
        instructionValidation = "rejected";
      } else if (trimmed.length > 0) {
        const truncated = trimmed.length > MAX_INSTRUCTIONS_CHARS;
        instructions = truncated
          ? trimmed.slice(0, MAX_INSTRUCTIONS_CHARS - INSTRUCTIONS_TRUNCATED_SUFFIX.length)
            + INSTRUCTIONS_TRUNCATED_SUFFIX
          : trimmed;
        instructionHash = createHash("sha256").update(instructions, "utf-8").digest("hex");
        instructionValidation = truncated ? "truncated" : "included";
      }
    }
  }

  return { instructions, instructionHash, instructionValidation, capabilities, serverInfo };
}

// ---------------------------------------------------------------------------
// Stdio stderr capture helper
// ---------------------------------------------------------------------------

export function wireStderrCapture(
  state: McpClientManagerState,
  deps: McpClientManagerDeps,
  config: McpServerConfig,
  transport: ReturnType<typeof createTransport>,
): void {
  if (config.transport !== "stdio") return;
  const stdioTransport = transport as { stderr?: NodeJS.ReadableStream };
  if (!stdioTransport.stderr) return;

  const { logger } = deps;
  const MAX_STDERR_BYTES = 64 * 1024; // 64KB cap
  let stderrBuffer = "";
  let stderrOverflowed = false;

  stdioTransport.stderr.on("data", (chunk: Buffer) => {
    if (stderrOverflowed) return;
    const text = chunk.toString("utf-8");
    if (stderrBuffer.length + text.length > MAX_STDERR_BYTES) {
      stderrBuffer += text.slice(0, MAX_STDERR_BYTES - stderrBuffer.length);
      stderrOverflowed = true;
      logger.warn(
        { serverName: config.name, hint: "MCP server stderr output exceeded 64KB cap", errorKind: "resource" as const },
        "MCP server stderr truncated at 64KB",
      );
    } else {
      stderrBuffer += text;
    }
    // Stash the running buffer on state so a connect-time failure (the catch in
    // connectServer) can fold the child's OWN error text into the returned error
    // — without this, a stdio failure surfaces only the opaque SDK "Connection
    // closed" and the "why" (e.g. a missing required env var) is a separate log
    // line the operator has to hand-correlate.
    state.lastStderr.set(config.name, stderrBuffer);
  });

  // On transport close, surface accumulated stderr. Classify it: genuine
  // crash/error output logs at WARN ("crash diagnostics"); a benign banner /
  // "ready" line logs at INFO ("informational") so a healthy server's startup
  // banner does not read as a fault on every restart. Child output stays in the
  // bounded in-memory failure classifier and never enters a durable log sink.
  stdioTransport.stderr.on("end", () => {
    if (stderrBuffer.trim()) {
      if (mcpStderrLooksLikeError(stderrBuffer)) {
        logger.warn(
          { serverName: config.name, stderrLength: stderrBuffer.length, truncated: stderrOverflowed, hint: "Review stderr output for crash diagnostics", errorKind: "dependency" as const },
          "MCP stdio server stderr captured",
        );
      } else {
        logger.info(
          { serverName: config.name, stderrLength: stderrBuffer.length, truncated: stderrOverflowed, hint: "Server wrote to stderr with no error markers — likely a startup banner, not a crash" },
          "MCP stdio server stderr (informational)",
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Cross-server tool aggregation getter (state-first)
// ---------------------------------------------------------------------------

/**
 * Aggregate tool definitions from every currently-connected server.
 * Disconnected servers (status !== "connected") contribute zero tools.
 */
export function listAllTools(state: McpClientManagerState): McpToolDefinition[] {
  const allTools: McpToolDefinition[] = [];
  for (const conn of state.connections.values()) {
    if (conn.status === "connected") {
      allTools.push(...conn.tools);
    }
  }
  return allTools;
}
