// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the child-env scrubber — the BLOCKLIST that strips
 * interpreter-control vars + the net-new nested-CLI markers + Shellshock
 * function-exports from the env handed to the jailed CLI, while PRESERVING a rich
 * env (a driven full-screen CLI like `claude`/`vim` needs `TERM`/`LANG`/`PATH`/...).
 *
 * Pure function (env-in → env-out) → runs green on macOS. The VPS `env`-in-jail
 * probe is the enforcement backstop; this asserts the transform itself.
 *
 * CRITICAL CONTRAST: this is a BLOCKLIST (strip known-dangerous keys, keep the
 * rest), NOT the MCP allowlist (`scrubStdioEnv` / `MCP_STDIO_BUILTIN_ENV_ALLOWLIST`)
 * — reusing the MCP allowlist verbatim would strip the rich env a driven TUI needs.
 * The "rich env survives" case guards that regression.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import {
  scrubChildEnv,
  JAIL_UNSET_ENV_VARS,
  isDaemonSecretEnvKey,
  secretEnvKeysIn,
} from "./terminal-env-scrub.js";

describe("scrubChildEnv — interpreter-control blocklist", () => {
  it("strips EVERY interpreter-control var and keeps PATH", () => {
    const out = scrubChildEnv({
      NODE_OPTIONS: "--require /tmp/evil.js",
      BASH_ENV: "/tmp/e",
      ENV: "/tmp/e",
      PYTHONSTARTUP: "/tmp/p",
      RUBYOPT: "-r/tmp/x",
      JAVA_TOOL_OPTIONS: "-javaagent:/tmp/a.jar",
      _JAVA_OPTIONS: "-Dx=1",
      JDK_JAVA_OPTIONS: "-Dx=2",
      PERL5OPT: "-M/tmp/x",
      PATH: "/usr/bin",
    });

    // None of the interpreter-control vars survive (startup code-injection vectors).
    for (const blocked of [
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "PYTHONSTARTUP",
      "RUBYOPT",
      "JAVA_TOOL_OPTIONS",
      "_JAVA_OPTIONS",
      "JDK_JAVA_OPTIONS",
      "PERL5OPT",
    ]) {
      expect(out, `${blocked} must be stripped`).not.toHaveProperty(blocked);
    }
    // A benign var survives — this is a blocklist, not an allowlist.
    expect(out.PATH).toBe("/usr/bin");
  });
});

describe("scrubChildEnv — nested-CLI markers (net-new)", () => {
  it("strips CLAUDECODE (exact) + every CLAUDE_CODE_* (prefix) and keeps HOME", () => {
    const out = scrubChildEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "12345",
      HOME: "/home/agent",
    });

    // A driven `claude` must NOT mis-detect a nested session.
    expect(out).not.toHaveProperty("CLAUDECODE");
    expect(out).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(out).not.toHaveProperty("CLAUDE_CODE_SSE_PORT");
    expect(out.HOME).toBe("/home/agent");
  });

  it("does NOT strip a var that merely contains 'CLAUDECODE' as a substring (exact/prefix only)", () => {
    // Guard against an over-broad `includes` — only the exact name + the prefix match.
    const out = scrubChildEnv({ MY_CLAUDECODE_FLAG: "keep", PRE_CLAUDE_CODE: "keep" });
    expect(out.MY_CLAUDECODE_FLAG).toBe("keep");
    expect(out.PRE_CLAUDE_CODE).toBe("keep");
  });
});

describe("scrubChildEnv — Shellshock function-export skip", () => {
  it("drops a value starting with '()' (Bash CVE-2014-6271) and keeps a normal value", () => {
    const out = scrubChildEnv({ FOO: "() { :; }; echo pwned", BAR: "ok" });
    expect(out).not.toHaveProperty("FOO");
    expect(out.BAR).toBe("ok");
  });
});

describe("scrubChildEnv — BLOCKLIST not allowlist: a rich env survives (own-goal guard)", () => {
  it("preserves a rich driven-CLI env WHOLLY (an allowlist would drop these)", () => {
    // The explicit contrast with the MCP scrubber: a full-screen TUI needs a far
    // richer env than a headless MCP stdio server. Every benign var must survive.
    const rich = {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      COLORTERM: "truecolor",
      SSH_AUTH_SOCK: "/run/ssh-agent.sock",
      CUSTOM_APP_VAR: "v",
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/agent",
    };
    const out = scrubChildEnv(rich);
    expect(out).toEqual(rich); // nothing dropped, nothing added
  });
});

describe("scrubChildEnv — non-string values are skipped", () => {
  it("drops keys whose value is not a string (typeof guard)", () => {
    const out = scrubChildEnv({
      KEEP: "yes",
      UNDEF: undefined,
    } as NodeJS.ProcessEnv);
    expect(out.KEEP).toBe("yes");
    expect(out).not.toHaveProperty("UNDEF");
  });
});

// ---------------------------------------------------------------------------
// The interpreter-vector prefix families (LD_/DYLD_/PIP_/UV_) — a
// dynamic-linker preload / package-index redirection that loads attacker code
// at child startup → RCE. Stripped on BOTH sources (dangerous regardless of
// origin).
// ---------------------------------------------------------------------------
describe("scrubChildEnv — interpreter-vector prefix families (LD_/DYLD_/PIP_/UV_)", () => {
  it("strips EVERY LD_/DYLD_/PIP_/UV_ prefixed key and keeps a benign TERM", () => {
    const out = scrubChildEnv({
      LD_PRELOAD: "/tmp/evil.so",
      LD_LIBRARY_PATH: "/tmp",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      DYLD_LIBRARY_PATH: "/tmp",
      PIP_INDEX_URL: "http://evil/simple",
      PIP_EXTRA_INDEX_URL: "http://evil/simple",
      UV_INDEX_URL: "http://evil/simple",
      UV_EXTRA_INDEX_URL: "http://evil/simple",
      TERM: "xterm-256color",
    });

    for (const blocked of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "PIP_INDEX_URL",
      "PIP_EXTRA_INDEX_URL",
      "UV_INDEX_URL",
      "UV_EXTRA_INDEX_URL",
    ]) {
      expect(out, `${blocked} (interpreter vector) must be stripped`).not.toHaveProperty(blocked);
    }
    // A benign var still survives — this stays a blocklist.
    expect(out.TERM).toBe("xterm-256color");
  });

  it("regression: still strips NODE_OPTIONS and still copies a benign LANG", () => {
    // The new prefix families must not regress the shipped exact-name blocklist.
    const out = scrubChildEnv({ NODE_OPTIONS: "--require /tmp/evil.js", LANG: "en_US.UTF-8" });
    expect(out).not.toHaveProperty("NODE_OPTIONS");
    expect(out.LANG).toBe("en_US.UTF-8");
  });
});

// ---------------------------------------------------------------------------
// The source-distinction correctness point. The
// COMIS_ fail-closed block applies to an UNTRUSTED workspace .env source ONLY,
// NEVER to the daemon's own COMIS_CAP_LEASE/COMIS_ORCH_SOCKET injection (which
// rides the trusted placeholders/inherited path).
// ---------------------------------------------------------------------------
describe("scrubChildEnv — the COMIS_ block is source-distinct (workspace-gated)", () => {
  it("default/inherited source PRESERVES the daemon-injected COMIS_CAP_LEASE/COMIS_ORCH_SOCKET", () => {
    // The daemon's own lease vars ride the trusted inherited/placeholders path —
    // blocking them would break the cap socket. They MUST survive the default scrub.
    const out = scrubChildEnv({
      COMIS_CAP_LEASE: "lease-bearer-abc",
      COMIS_ORCH_SOCKET: "/run/comis/cap.sock",
      TERM: "xterm-256color",
    });
    expect(out.COMIS_CAP_LEASE).toBe("lease-bearer-abc");
    expect(out.COMIS_ORCH_SOCKET).toBe("/run/comis/cap.sock");
    expect(out.TERM).toBe("xterm-256color");
  });

  it('workspace source FAIL-CLOSED-blocks the whole COMIS_ prefix while keeping a benign FOO', () => {
    // An attacker-supplied workspace .env must not smuggle a COMIS_ runtime-control
    // var (or an interpreter vector) into the jailed child.
    const out = scrubChildEnv(
      { COMIS_CAP_LEASE: "forged-by-attacker", FOO: "keep", LD_PRELOAD: "/tmp/evil.so" },
      { source: "workspace" },
    );
    expect(out).not.toHaveProperty("COMIS_CAP_LEASE");
    expect(out).not.toHaveProperty("LD_PRELOAD");
    expect(out.FOO).toBe("keep");
  });

  it("default source does NOT block a benign COMIS_-prefixed key (the block is workspace-gated)", () => {
    // Explicit contrast: only the workspace source applies the COMIS_ block.
    const out = scrubChildEnv({ COMIS_DATA_DIR: "/var/lib/comis" });
    expect(out.COMIS_DATA_DIR).toBe("/var/lib/comis");
  });
});

// ---------------------------------------------------------------------------
// The bwrap `--unsetenv` half takes a NAME (not a glob), so the prefix
// families stay in the scrub-object check ONLY — JAIL_UNSET_ENV_VARS lists the
// exact-named interpreter vars + the exact CLAUDECODE sentinel, never a prefix.
// ---------------------------------------------------------------------------
describe("scrubChildEnv — JAIL_UNSET_ENV_VARS stays exact-name-only (bwrap --unsetenv)", () => {
  it("lists the exact-named interpreter vars (NODE_OPTIONS etc.) but NOT the prefix families", () => {
    // Exact names bwrap can --unsetenv are present.
    expect(JAIL_UNSET_ENV_VARS).toContain("NODE_OPTIONS");
    expect(JAIL_UNSET_ENV_VARS).toContain("BASH_ENV");
    expect(JAIL_UNSET_ENV_VARS).toContain("CLAUDECODE");
    // The prefix-family STEMS are NOT names — bwrap --unsetenv can't glob them.
    for (const prefixStem of ["LD_", "DYLD_", "PIP_", "UV_", "COMIS_"]) {
      expect(JAIL_UNSET_ENV_VARS).not.toContain(prefixStem);
    }
    // And no concrete prefix-family instance leaked in either (it would be a NAME,
    // but the family is open-ended — only the exact-name blocklist belongs here).
    expect(JAIL_UNSET_ENV_VARS).not.toContain("LD_PRELOAD");
  });
});

// ---------------------------------------------------------------------------
// TERM-ENV-GATEWAY-TOKEN-LEAK (HIGH, security): the daemon's admin gateway token
// (+ secret-store master key) must NEVER reach a jailed CLI's env. The jail masks
// secrets.db (--tmpfs ~/.comis) but the env-scrub COPIED COMIS_GATEWAY_TOKEN /
// GWTOKEN / GATEWAY_TOKEN_<id> through on the `inherited` source → with
// network:full a prompt-injected driven CLI could `curl` the loopback gateway
// (the `default` token's scope is `*`) and seize the WHOLE control plane. The
// daemon-boot scrub (daemon.ts scrubProcessEnv) deliberately PRESERVES the COMIS_
// namespace ("layout pointers … excluded from untrusted children AT THE SPAWN
// SITE") — this scrubber IS that spawn site, so the gateway token is exactly the
// credential the boot layer trusted it to exclude (a layer mismatch). Stripped on
// BOTH sources (a secret regardless of origin); the broker/cap-lease vars + a
// layout pointer + the rich TUI env survive.
// (Live-confirmed: a jailed claude's /proc/<pid>/environ carried
//  COMIS_GATEWAY_TOKEN + GWTOKEN before this scrub landed.)
// ---------------------------------------------------------------------------
describe("scrubChildEnv — daemon-secret blocklist (TERM-ENV-GATEWAY-TOKEN-LEAK)", () => {
  const LEAKY: NodeJS.ProcessEnv = {
    // The daemon secrets that must be stripped:
    COMIS_GATEWAY_TOKEN: "admin-bearer-scope-star",
    GWTOKEN: "ops-alias-of-the-gateway-token",
    GATEWAY_TOKEN_DEFAULT: "minted-token-default",
    GATEWAY_TOKEN_OPS: "minted-token-ops",
    SECRETS_MASTER_KEY: "decrypts-the-whole-store",
    // Must SURVIVE — broker/cap path, a benign layout pointer, and the rich TUI env:
    COMIS_CAP_LEASE: "lease-bearer-keep",
    COMIS_BROKER_TOKEN: "broker-keep",
    COMIS_CONFIG_PATHS: "/home/comis/.comis/config.yaml",
    TERM: "xterm-256color",
    PATH: "/usr/bin",
  };

  it("strips the gateway-token family + master key on the DEFAULT (inherited) source — the live leak path", () => {
    const out = scrubChildEnv(LEAKY); // default source === "inherited" — the exact live path
    for (const secret of [
      "COMIS_GATEWAY_TOKEN",
      "GWTOKEN",
      "GATEWAY_TOKEN_DEFAULT",
      "GATEWAY_TOKEN_OPS",
      "SECRETS_MASTER_KEY",
    ]) {
      expect(out, `${secret} must NOT reach the jailed CLI env`).not.toHaveProperty(secret);
    }
    // No over-scrub: the broker/cap-lease path + a layout pointer + the rich TUI env survive.
    expect(out.COMIS_CAP_LEASE).toBe("lease-bearer-keep");
    expect(out.COMIS_BROKER_TOKEN).toBe("broker-keep");
    expect(out.COMIS_CONFIG_PATHS).toBe("/home/comis/.comis/config.yaml");
    expect(out.TERM).toBe("xterm-256color");
    expect(out.PATH).toBe("/usr/bin");
  });

  it("strips them on the workspace source too (a secret is a secret regardless of origin)", () => {
    const out = scrubChildEnv(LEAKY, { source: "workspace" });
    for (const secret of ["COMIS_GATEWAY_TOKEN", "GWTOKEN", "GATEWAY_TOKEN_DEFAULT", "SECRETS_MASTER_KEY"]) {
      expect(out).not.toHaveProperty(secret);
    }
  });

  it("isDaemonSecretEnvKey: true for the gateway-token family + master key, false for layout/broker vars + look-alikes", () => {
    for (const k of ["COMIS_GATEWAY_TOKEN", "GWTOKEN", "GATEWAY_TOKEN_DEFAULT", "GATEWAY_TOKEN_X", "SECRETS_MASTER_KEY"]) {
      expect(isDaemonSecretEnvKey(k), `${k} is a daemon secret`).toBe(true);
    }
    // Layout pointers + broker/cap vars + substring look-alikes are NOT secrets (no over-match).
    for (const k of [
      "COMIS_CAP_LEASE",
      "COMIS_BROKER_TOKEN",
      "COMIS_CONFIG_PATHS",
      "COMIS_DATA_DIR",
      "GATEWAY_URL",
      "MY_GATEWAY_TOKEN_NOTE",
      "TERM",
    ]) {
      expect(isDaemonSecretEnvKey(k), `${k} is NOT a daemon secret`).toBe(false);
    }
  });

  it("secretEnvKeysIn: returns exactly the secret KEY NAMES present (for the bwrap --unsetenv enumeration)", () => {
    expect(secretEnvKeysIn(LEAKY).sort()).toEqual(
      ["COMIS_GATEWAY_TOKEN", "GATEWAY_TOKEN_DEFAULT", "GATEWAY_TOKEN_OPS", "GWTOKEN", "SECRETS_MASTER_KEY"].sort(),
    );
    // None of the surviving vars are enumerated for --unsetenv.
    expect(secretEnvKeysIn({ COMIS_CAP_LEASE: "x", COMIS_CONFIG_PATHS: "y", TERM: "z" })).toEqual([]);
  });
});
