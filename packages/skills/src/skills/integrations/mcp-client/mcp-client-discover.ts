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

import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { systemEnvSnapshot, systemNowMs } from "@comis/core";
import type {
  McpClientManagerDeps,
  McpClientManagerState,
  McpServerConfig,
  McpToolDefinition,
} from "./mcp-client-types.js";
import { qualifyToolName } from "./mcp-client-types.js";
import { createRedirectPolicyFetch } from "./mcp-client-redirect-policy.js";

// Logger shape used by the Phase 63 SAFETY-08 WARN-skip path; matches the
// `McpClientManagerDeps["logger"]` two-arg overload threaded through from
// the connect / reconnect call sites.
type ComisLoggerLike = McpClientManagerDeps["logger"];

// ---------------------------------------------------------------------------
// Phase 63 SAFETY-01/02: stdio env allowlist
// ---------------------------------------------------------------------------

/**
 * Built-in safe-to-pass-through env keys for stdio MCP children.
 *
 * Superset of the MCP SDK's `DEFAULT_INHERITED_ENV_VARS` (POSIX baseline:
 * HOME, LOGNAME, PATH, SHELL, TERM, USER). Extended for:
 *
 *   - Locale (LC_*, LANG): real MCP servers (Notion, Linear) crash on
 *     non-ASCII without locale set.
 *   - XDG Base Directory: config/data/cache lookup broken without these.
 *   - TMPDIR / TMP / TEMP: child cannot create temp files.
 *   - NODE_ENV / NODE_PATH: Node MCP servers respect for module resolution.
 *   - PYTHON{IOENCODING,PATH}: Python MCP servers (uvx) need.
 *   - npm_config_*: npx-launched servers respect npm_config_user_agent
 *     and npm_config_cache (matched by PREFIX, not literal key).
 *
 * Operator-extension via `config.integrations.mcp.safetyAllowedEnvKeys` is
 * additive — the built-in allowlist always applies.
 *
 * Per RESEARCH.md Pattern 5 + REQUIREMENTS.md SAFETY-01.
 */
export const MCP_STDIO_BUILTIN_ENV_ALLOWLIST: readonly string[] = [
  // Standard POSIX (SDK's default 6)
  "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER",
  // Locale
  "LANG", "LC_ALL", "LC_CTYPE", "LC_NUMERIC", "LC_TIME", "LC_COLLATE",
  "LC_MONETARY", "LC_MESSAGES", "LC_PAPER", "LC_NAME", "LC_ADDRESS",
  "LC_TELEPHONE", "LC_MEASUREMENT", "LC_IDENTIFICATION",
  // XDG Base Directory (literals; XDG_* prefix-match handled below too)
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS",
  // Temp
  "TMPDIR", "TMP", "TEMP",
  // Node
  "NODE_ENV", "NODE_PATH",
  // Python
  "PYTHONIOENCODING", "PYTHONPATH",
];

const NPM_CONFIG_PREFIX = "npm_config_";
const XDG_PREFIX = "XDG_";

/**
 * Build the stdio-child env from the allowlist + operator extension +
 * explicit config.env passthrough.
 *
 * Order of precedence (later overrides earlier):
 *   1. Daemon env keys matching MCP_STDIO_BUILTIN_ENV_ALLOWLIST (or the
 *      XDG_ / npm_config_ prefix predicate).
 *   2. Daemon env keys matching extraAllowedKeys (operator-extension from
 *      `config.integrations.mcp.safetyAllowedEnvKeys`).
 *   3. Explicit `config.env` (operator-named per-server pairs).
 *
 * Function-export values (starting with `()`) are SKIPPED — matches the
 * MCP SDK's own behavior and avoids Shellshock-style command injection
 * (Bash CVE-2014-6271).
 *
 * Pure function; the only side-effect is the `systemEnvSnapshot()` read,
 * which is the sanctioned env-access path per AGENTS.md §2.2.
 */
export function scrubStdioEnv(
  configEnv: Record<string, string> | undefined,
  extraAllowedKeys: readonly string[] | undefined,
): Record<string, string> {
  const allowlist = new Set<string>([
    ...MCP_STDIO_BUILTIN_ENV_ALLOWLIST,
    ...(extraAllowedKeys ?? []),
  ]);
  const result: Record<string, string> = {};
  const snapshot = systemEnvSnapshot();
  for (const key of Object.keys(snapshot)) {
    const passes =
      allowlist.has(key) ||
      key.startsWith(NPM_CONFIG_PREFIX) ||
      key.startsWith(XDG_PREFIX);
    if (!passes) continue;
    const v = snapshot[key];
    if (typeof v !== "string") continue;
    if (v.startsWith("()")) continue; // Shellshock / function-export skip
    result[key] = v;
  }
  // Operator-named config.env passes through unconditionally.
  if (configEnv) {
    for (const [key, value] of Object.entries(configEnv)) {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 63 SAFETY-08: prlimit availability probe (module-init, cached)
// ---------------------------------------------------------------------------

/**
 * Whether `prlimit(1)` is on PATH at daemon startup. Cached at module load
 * to avoid spawnSync cost per connect. Linux util-linux ships it; macOS dev
 * does not. When false, wrapStdioCommand skips rlimit application with a
 * single WARN per daemon process. Per RESEARCH.md §"Pattern 3" + Pitfall 5.
 */
const PRLIMIT_AVAILABLE: boolean = (() => {
  try {
    const result = spawnSync("prlimit", ["--version"], { encoding: "utf-8", timeout: 1000 });
    return result.status === 0;
  } catch {
    return false;
  }
})();

/** Guard ensuring the prlimit-unavailable WARN fires AT MOST ONCE per daemon process. */
let prlimitWarnEmitted = false;

/** Test seam: returns the module-init `PRLIMIT_AVAILABLE` probe result. */
export function getPrlimitAvailable(): boolean {
  return PRLIMIT_AVAILABLE;
}

/** @internal test-only — resets the module-level WARN-once flag for deterministic tests. */
export function __resetPrlimitWarnForTests(): void {
  prlimitWarnEmitted = false;
}

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
 *      it. Non-Node servers (uvx, Python) pass through as no-op. See
 *      COMIS-E2E-FOLLOWUP-DESIGN.md Issue 2.
 *   2. Per-server rlimits via `prlimit(1)` (Phase 63 SAFETY-08). When `rlimits`
 *      is set AND prlimit is available, prepends `prlimit --as=N --nofile=N
 *      --cpu=N --`. Partial overrides accepted (`{ cpu: 600 }` → only `--cpu`).
 *      When `rlimits` is unset → no prlimit wrap. When prlimit is absent
 *      (macOS dev) → env-only wrap + ONE WARN per daemon process
 *      (`errorKind: "platform"`).
 *
 * Composition: `[prlimit --as=N --nofile=N --cpu=N --]  /usr/bin/env -u NODE_OPTIONS  <cmd> <args>`.
 * Exported for unit-test assertion. Per RESEARCH.md §"Pattern 3" + SAFETY-08.
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
  if (!PRLIMIT_AVAILABLE) {
    if (!prlimitWarnEmitted) {
      logger.warn(
        {
          serverName,
          hint:
            "prlimit(1) not on PATH; rlimits not applied (Linux util-linux required). " +
            "Production target is Linux; macOS dev runs without rlimit defense-in-depth.",
          errorKind: "platform" as const,
        },
        "MCP rlimits skipped — prlimit unavailable",
      );
      prlimitWarnEmitted = true;
    }
    return { command: "/usr/bin/env", args: innerArgs };
  }

  // Build prlimit flag set — emit ONLY the flags for fields explicitly set
  // (partial-override semantics per Plan 06 must_haves).
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
      // Phase 63 SAFETY-01/02: strict allowlist + operator-extension scrub.
      // Replaces the prior `{ ...systemEnvSnapshot(), ...config.env }`
      // spread, which leaked every daemon-process credential env var into
      // every spawned MCP child. See REQUIREMENTS.md SAFETY-01 + the
      // architecture-test dangerous-key negative-control list at
      // test/architecture/mcp-prespawn-allowlist.test.ts for the
      // enforced denylist.
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
      // Phase 63 SAFETY-07: cross-host redirect header scrub. Strips
      // Authorization / Cookie / Proxy-Authorization on cross-host redirect
      // (URL.host string mismatch including port); preserves on same-host
      // (including http to https upgrade); throws [max_redirects_exceeded]
      // after 20 hops. See mcp-client-redirect-policy.ts for the full policy.
      fetch: createRedirectPolicyFetch({ maxRedirections: 20 }),
    });
  } else if (config.transport === "http") {
    if (!config.url) {
      throw new Error(`MCP server "${config.name}": http transport requires "url"`);
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers
        ? { headers: config.headers }
        : undefined,
      // Phase 63 SAFETY-07: cross-host redirect header scrub. Same policy as
      // the SSE branch above; see mcp-client-redirect-policy.ts.
      fetch: createRedirectPolicyFetch({ maxRedirections: 20 }),
    });
  }
  throw new Error(`MCP server "${config.name}": unsupported transport "${config.transport as string}"`);
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

              const previousNames = new Set(previousTools.map(t => t.name));
              const currentNames = new Set(newTools.map(t => t.name));
              const addedTools = newTools.filter(t => !previousNames.has(t.name)).map(t => t.name);
              const removedTools = previousTools.filter(t => !currentNames.has(t.name)).map(t => t.name);

              deps.eventBus!.emit("mcp:server:tools_changed", {
                serverName,
                previousToolCount: previousTools.length,
                currentToolCount: newTools.length,
                addedTools,
                removedTools,
                timestamp: systemNowMs(),
              });

              logger.info(
                { serverName, previousCount: previousTools.length, currentCount: newTools.length, added: addedTools, removed: removedTools },
                "MCP server tool list changed",
              );
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
  const instructions = client.getInstructions();
  const serverCaps = client.getServerCapabilities();
  const serverImpl = client.getServerVersion();

  const capabilities = serverCaps ? (serverCaps as Record<string, unknown>) : undefined;
  const serverInfo = serverImpl ? { name: serverImpl.name, version: serverImpl.version } : undefined;

  // Cap instructions to prevent preamble budget issues
  const cappedInstructions = instructions && instructions.length > MAX_INSTRUCTIONS_CHARS
    ? instructions.slice(0, MAX_INSTRUCTIONS_CHARS - INSTRUCTIONS_TRUNCATED_SUFFIX.length) + INSTRUCTIONS_TRUNCATED_SUFFIX
    : instructions;

  return { instructions: cappedInstructions, capabilities, serverInfo };
}

// ---------------------------------------------------------------------------
// Stdio stderr capture helper
// ---------------------------------------------------------------------------

export function wireStderrCapture(
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
    // Log each stderr line at DEBUG level for real-time visibility
    for (const line of text.split("\n").filter(Boolean)) {
      logger.debug?.({ serverName: config.name, stderr: line }, "MCP server stderr");
    }
  });

  // On transport close, log accumulated stderr at WARN if non-empty
  stdioTransport.stderr.on("end", () => {
    if (stderrBuffer.trim()) {
      logger.warn(
        { serverName: config.name, stderrLength: stderrBuffer.length, truncated: stderrOverflowed, hint: "Review stderr output for crash diagnostics", errorKind: "dependency" as const },
        "MCP stdio server stderr captured",
      );
      logger.info(
        { serverName: config.name, stderr: stderrBuffer.trim() },
        "MCP stdio server stderr output",
      );
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
