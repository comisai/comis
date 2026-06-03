// SPDX-License-Identifier: Apache-2.0
/**
 * Child-env scrubber for the driven CLI (SEC-07) — a BLOCKLIST.
 *
 * The worker forwards its inherited env to the jailed CLI (`bwrap` inherits the
 * spawner env by default, no `--clearenv`, so the env handed to `pty.spawn(bwrap,…)`
 * IS the child env). This strips the known-dangerous keys from that env before the
 * spawn (the worker wires it in 122-06):
 *   - interpreter-control vars (`NODE_OPTIONS`, `BASH_ENV`, `PYTHONSTARTUP`, …) that
 *     instruct a runtime to load attacker-controlled code at startup → code exec
 *     (Elevation; e.g. a daemon `NODE_OPTIONS=--require evil.js` leaking in);
 *   - the net-new nested-CLI markers `CLAUDECODE` (exact) + `CLAUDE_CODE_*` (prefix)
 *     so a driven `claude` does not mis-detect a nested session (Tampering);
 *   - Shellshock function-export values (starting with `()`, Bash CVE-2014-6271).
 *
 * It is a BLOCKLIST (strip the known-dangerous keys, COPY everything else) — NOT an
 * env allowlist like the MCP stdio scrubber. A driven full-screen CLI (`claude`,
 * `vim`, `top`) needs a far richer env than a headless MCP stdio server (`TERM`,
 * `LANG`, `COLORTERM`, `SSH_AUTH_SOCK`, operator vars, …); reusing an env allowlist
 * verbatim would break the driven TUI (RESEARCH Anti-Pattern). The interpreter-var
 * blocklist below mirrors the MCP stdio interpreter-control set (the same vars a
 * stdio server strips) — but the keep-policy is deliberately inverted.
 *
 * Pure function (env-in → env-out): it does NOT read the ambient/system env (the
 * caller — the 122-06 worker — passes its `envSnapshot()`), holds NO module-global
 * state, and does NOT depend on the infra package. Imported DIRECTLY by the worker
 * via `./terminal-env-scrub.js` (NOT re-exported through the barrel — 122-01 is the
 * sole Wave-1 barrel writer).
 *
 * @module
 */

/**
 * Interpreter-control vars stripped from the child env unconditionally — these
 * instruct runtimes to load attacker-controlled code at startup. MIRRORS the MCP
 * `INTERPRETER_CONTROL_BLOCKLIST` (`mcp-client-discover.ts`); NEVER remove a member
 * without a security review.
 */
const INTERPRETER_CONTROL_BLOCKLIST: ReadonlySet<string> = new Set([
  "BASH_ENV",
  "ENV", // sh/bash startup-file injection
  "PYTHONSTARTUP", // Python startup code
  "RUBYOPT", // Ruby option injection (-r loads modules)
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS", // JVM agent injection
  "PERL5OPT", // Perl option injection (-M loads modules)
  "NODE_OPTIONS", // Node.js --require / --experimental-* injection
]);

/**
 * Net-new (terminal-driver-only) nested-CLI marker prefixes — stripped so a driven
 * `claude` does not inherit the daemon's `CLAUDE_CODE_ENTRYPOINT`/`CLAUDE_CODE_SSE_PORT`/…
 * and mis-detect a nested session. Grep-confirmed absent from the MCP blocklist.
 */
const NESTED_CLI_PREFIXES: readonly string[] = ["CLAUDE_CODE_"];

/** Net-new nested-CLI marker (exact match) — the bare `CLAUDECODE` sentinel. */
const NESTED_CLI_EXACT: ReadonlySet<string> = new Set(["CLAUDECODE"]);

/**
 * Scrub the env handed to the jailed child (SEC-07).
 *
 * COPIES every key EXCEPT: a non-string value; an interpreter-control key; the
 * exact `CLAUDECODE`; any `CLAUDE_CODE_*` key; a `()`-prefixed (Shellshock)
 * function-export value. Everything else is preserved (a rich env for the driven
 * TUI). Pure — no env read, no mutation of the input.
 */
export function scrubChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue; // non-string (undefined) → skip
    if (INTERPRETER_CONTROL_BLOCKLIST.has(key)) continue; // startup code-injection vector
    if (NESTED_CLI_EXACT.has(key)) continue; // CLAUDECODE
    if (NESTED_CLI_PREFIXES.some((p) => key.startsWith(p))) continue; // CLAUDE_CODE_*
    if (value.startsWith("()")) continue; // Shellshock function-export (CVE-2014-6271)
    out[key] = value;
  }
  return out;
}
