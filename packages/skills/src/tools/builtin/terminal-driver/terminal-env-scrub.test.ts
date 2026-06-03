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

import { scrubChildEnv } from "./terminal-env-scrub.js";

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
