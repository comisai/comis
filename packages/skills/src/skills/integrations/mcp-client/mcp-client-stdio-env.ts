// SPDX-License-Identifier: Apache-2.0
/**
 * Stdio MCP child env scrubbing.
 *
 * The built-in passthrough allowlist + interpreter-control blocklist and the
 * pure `scrubStdioEnv` builder that composes them with the operator extension
 * and explicit `config.env`. Extracted from mcp-client-discover.ts to keep that
 * leaf under the 500-line per-subdirectory file-size cap — pure, no behavior
 * change. Re-exported from mcp-client-discover.ts so existing callers (and the
 * co-located mcp-client-discover.test.ts) import from the same leaf as before.
 *
 * @module
 */

import { systemEnvSnapshot } from "@comis/core";

// ---------------------------------------------------------------------------
// Stdio env allowlist
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
 * Interpreter-control vars blocked from child env unconditionally.
 * These instruct runtimes to load attacker-controlled code at startup.
 * Blocked even via operator config.env — NEVER remove without security review.
 */
const INTERPRETER_CONTROL_BLOCKLIST: ReadonlySet<string> = new Set([
  "BASH_ENV", "ENV",          // sh/bash startup file injection
  "PYTHONSTARTUP",             // Python startup code
  "RUBYOPT",                   // Ruby option injection (-r loads modules)
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", // JVM agent injection
  "PERL5OPT",                  // Perl option injection (-M loads modules)
  "NODE_OPTIONS",              // Node.js --require / --experimental-* injection
]);

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
 * which is the sanctioned env-access path (always use systemEnvSnapshot, never process.env directly).
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
    // Interpreter-control vars are blocked even if they appear in the
    // allowlist or a prefix-match — defense-in-depth against accidental addition.
    if (INTERPRETER_CONTROL_BLOCKLIST.has(key)) continue;
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
  // Operator-named config.env passes through — EXCEPT interpreter-control vars
  // (these must never reach a child process even via explicit operator config).
  if (configEnv) {
    for (const [key, value] of Object.entries(configEnv)) {
      if (INTERPRETER_CONTROL_BLOCKLIST.has(key)) continue; // interpreter-control block
      result[key] = value;
    }
  }
  return result;
}
