// SPDX-License-Identifier: Apache-2.0
/**
 * Architecture test: MCP_STDIO_BUILTIN_ENV_ALLOWLIST membership invariant.
 *
 * The hardcoded built-in allowlist for stdio MCP child env must include
 * the keys listed in REQUIRED_ALLOWLIST_MEMBERS below. Removing any
 * silently breaks specific MCP servers in production:
 *   - Locale (LANG, LC_*) — Notion / Linear servers crash on non-ASCII
 *     without it.
 *   - npm_config_* prefix — npx-launched servers respect npm_config_cache
 *     and npm_config_user_agent.
 *   - PYTHONIOENCODING / PYTHONPATH — uvx-launched Python MCP servers.
 *   - XDG_* — config / data / cache lookup.
 *
 * The negative-control assertion (last `it`) is the security-side gate —
 * accidental addition of a credential key to the built-in allowlist would
 * leak it back into every spawned child.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { MCP_STDIO_BUILTIN_ENV_ALLOWLIST, scrubStdioEnv } from "@comis/skills";

const REQUIRED_ALLOWLIST_MEMBERS: readonly string[] = [
  // POSIX baseline (MCP SDK's getDefaultEnvironment subset)
  "HOME", "PATH", "USER", "SHELL", "TERM", "LOGNAME",
  // Locale — required by real-world MCP servers
  "LANG", "LC_ALL", "LC_CTYPE",
  // XDG (literal entries; XDG_* prefix-match also covered via scrubStdioEnv)
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // Temp
  "TMPDIR",
  // Node
  "NODE_ENV", "NODE_PATH",
  // Python (uvx-launched servers)
  "PYTHONIOENCODING", "PYTHONPATH",
];

describe("MCP stdio env allowlist — required membership invariant", () => {
  it("MCP_STDIO_BUILTIN_ENV_ALLOWLIST contains every required POSIX/locale/XDG/Node/Python key", () => {
    const allowSet = new Set(MCP_STDIO_BUILTIN_ENV_ALLOWLIST);
    const missing = REQUIRED_ALLOWLIST_MEMBERS.filter((k) => !allowSet.has(k));
    expect(missing, `Missing required allowlist members: ${missing.join(", ")}`).toEqual([]);
  });

  it("scrubStdioEnv symbol is re-exported through @comis/skills as a function", () => {
    // Indirect — proves the symbol exists and the runtime prefix check is
    // enabled. Concrete prefix-behavior testing lives in the co-located
    // mcp-client-discover.test.ts unit test.
    expect(typeof scrubStdioEnv).toBe("function");
  });

  it("MCP_STDIO_BUILTIN_ENV_ALLOWLIST does NOT include dangerous credential keys", () => {
    const dangerous: readonly string[] = [
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "DISCORD_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "STRIPE_SECRET_KEY",
      "COMIS_GATEWAY_TOKEN",
      "SECRETS_MASTER_KEY",
    ];
    const allowSet = new Set(MCP_STDIO_BUILTIN_ENV_ALLOWLIST);
    const leaked = dangerous.filter((k) => allowSet.has(k));
    expect(leaked, `Dangerous keys must NOT be in the allowlist: ${leaked.join(", ")}`).toEqual([]);
  });
});
