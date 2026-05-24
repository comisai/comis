// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit tests for `scrubStdioEnv` and the
 * `MCP_STDIO_BUILTIN_ENV_ALLOWLIST` constant introduced by Phase 63 plan 02
 * (SAFETY-01 / SAFETY-02).
 *
 * The legacy spread `{ ...systemEnvSnapshot(), ...config.env }` at
 * `mcp-client-discover.ts:80` leaked every daemon env var (OPENAI_API_KEY,
 * STRIPE_*, TELEGRAM_BOT_TOKEN, etc.) into every spawned MCP child process.
 * These tests pin the replacement allowlist + operator-extension model:
 *   - Built-in allowlist passes through standard POSIX/locale/XDG/Node/Python
 *     keys plus npm_config_* / XDG_* prefix matches.
 *   - Operator-supplied `safetyAllowedEnvKeys` extends the allowlist
 *     additively (built-in always applies).
 *   - `config.env` (operator-named per-server explicit pairs) always passes
 *     through unchanged regardless of allowlist membership.
 *   - Function-export values (Bash CVE-2014-6271 Shellshock pattern, value
 *     starting with `()`) are SKIPPED — matches MCP SDK behavior.
 *
 * The daemon env is read via `systemEnvSnapshot()` (the sanctioned
 * `packages/core/src/runtime/system-time.ts` accessor); these tests
 * temporarily mutate `process.env` per case and restore it in `afterEach`.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scrubStdioEnv, MCP_STDIO_BUILTIN_ENV_ALLOWLIST } from "./mcp-client-discover.js";

// ---------------------------------------------------------------------------
// Env-mutation harness
// ---------------------------------------------------------------------------
//
// systemEnvSnapshot() returns a shallow clone of `process.env`, so to
// simulate "daemon env X" each test rewrites process.env in beforeEach and
// restores in afterEach.
//
// Implementation: snapshot every key on entry, clear what we added, restore
// what we deleted on the way out.

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  // Wipe process.env so each test starts from a known-empty baseline. We
  // skip the few node-internal keys that vitest itself requires (e.g.,
  // NODE_OPTIONS for worker IPC), but in practice an empty baseline is
  // safe inside a worker process and keeps the matrix clean.
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
});

afterEach(() => {
  // Restore: clear what tests added, then re-set the original keys.
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  for (const key of Object.keys(originalEnv)) {
    process.env[key] = originalEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scrubStdioEnv — built-in allowlist enforcement (SAFETY-01)", () => {
  it("scrubStdioEnv strips OPENAI_API_KEY from daemon env spread when not allowlisted", () => {
    process.env.PATH = "/usr/bin";
    process.env.HOME = "/h";
    process.env.OPENAI_API_KEY = "secret";
    const result = scrubStdioEnv(undefined, undefined);
    expect(result).toEqual({ PATH: "/usr/bin", HOME: "/h" });
  });

  it("scrubStdioEnv strips all known dangerous credential daemon-env keys", () => {
    process.env.TELEGRAM_BOT_TOKEN = "x";
    process.env.STRIPE_KEY = "y";
    process.env.GITHUB_TOKEN = "z";
    process.env.AWS_ACCESS_KEY_ID = "w";
    process.env.DISCORD_TOKEN = "v";
    process.env.SECRETS_MASTER_KEY = "k";
    process.env.COMIS_GATEWAY_TOKEN = "t";
    const result = scrubStdioEnv(undefined, undefined);
    expect(result).toEqual({});
  });

  it("scrubStdioEnv passes XDG_* prefix keys through allowlist match", () => {
    process.env.XDG_CONFIG_HOME = "/cfg";
    process.env.XDG_DATA_HOME = "/data";
    process.env.XDG_RANDOM = "/r";
    const result = scrubStdioEnv(undefined, undefined);
    expect(result).toEqual({
      XDG_CONFIG_HOME: "/cfg",
      XDG_DATA_HOME: "/data",
      XDG_RANDOM: "/r",
    });
  });

  it("scrubStdioEnv passes npm_config_* prefix keys through allowlist match", () => {
    process.env.npm_config_user_agent = "foo";
    process.env.npm_config_cache = "/c";
    const result = scrubStdioEnv(undefined, undefined);
    expect(result).toEqual({
      npm_config_user_agent: "foo",
      npm_config_cache: "/c",
    });
  });
});

describe("scrubStdioEnv — operator passthrough + extension (SAFETY-02)", () => {
  it("scrubStdioEnv lets operator-named config.env keys through regardless of allowlist", () => {
    // Daemon env is empty; only operator-named per-server config.env is
    // provided. Both keys (including OPENAI_API_KEY, which is NOT in the
    // built-in allowlist) must appear in the result because explicit
    // operator intent overrides the allowlist gate.
    const result = scrubStdioEnv(
      { API_KEY: "override", OPENAI_API_KEY: "explicit" },
      undefined,
    );
    expect(result).toEqual({ API_KEY: "override", OPENAI_API_KEY: "explicit" });
  });

  it("scrubStdioEnv applies extraAllowedKeys additively over the built-in allowlist", () => {
    process.env.CUSTOM_CA_CERT_PATH = "/ca";
    process.env.FOO = "bar";
    // Only CUSTOM_CA_CERT_PATH is in the operator-extension; FOO is in
    // neither the built-in nor the extension, so it is stripped.
    const result = scrubStdioEnv(undefined, ["CUSTOM_CA_CERT_PATH"]);
    expect(result).toEqual({ CUSTOM_CA_CERT_PATH: "/ca" });
  });
});

describe("scrubStdioEnv — Shellshock-style function-export skip (SAFETY-01)", () => {
  it("scrubStdioEnv skips daemon env values starting with `()` (Bash CVE-2014-6271)", () => {
    process.env.PATH = "/u";
    process.env.LC_ALL = "() { :; }; echo pwned";
    const result = scrubStdioEnv(undefined, undefined);
    expect(result).toEqual({ PATH: "/u" });
  });
});

describe("MCP_STDIO_BUILTIN_ENV_ALLOWLIST — required-membership invariant", () => {
  it("MCP_STDIO_BUILTIN_ENV_ALLOWLIST exposes every required POSIX/locale/XDG/Node/Python key", () => {
    const required: readonly string[] = [
      // POSIX baseline (MCP SDK's getDefaultEnvironment subset)
      "HOME", "PATH", "USER", "SHELL", "TERM", "LOGNAME",
      // Locale
      "LANG", "LC_ALL", "LC_CTYPE",
      // XDG (literal entries; XDG_* prefix-match handled by scrubStdioEnv too)
      "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
      // Temp
      "TMPDIR",
      // Node
      "NODE_ENV", "NODE_PATH",
      // Python (uvx-launched servers)
      "PYTHONIOENCODING", "PYTHONPATH",
    ];
    const allowSet = new Set(MCP_STDIO_BUILTIN_ENV_ALLOWLIST);
    const missing = required.filter((k) => !allowSet.has(k));
    expect(missing, `Missing required allowlist members: ${missing.join(", ")}`).toEqual([]);
  });
});
