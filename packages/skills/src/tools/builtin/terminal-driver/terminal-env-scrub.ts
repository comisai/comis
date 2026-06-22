// SPDX-License-Identifier: Apache-2.0
/**
 * Child-env scrubber for the driven CLI — a BLOCKLIST.
 *
 * The worker forwards its inherited env to the jailed CLI (`bwrap` inherits the
 * spawner env by default, no `--clearenv`, so the env handed to `pty.spawn(bwrap,…)`
 * IS the child env). This strips the known-dangerous keys from that env before the
 * spawn (the worker wires it in):
 *   - interpreter-control vars (`NODE_OPTIONS`, `BASH_ENV`, `PYTHONSTARTUP`, …) that
 *     instruct a runtime to load attacker-controlled code at startup → code exec
 *     (Elevation; e.g. a daemon `NODE_OPTIONS=--require evil.js` leaking in);
 *   - the interpreter-vector PREFIX families `LD_*`/`DYLD_*`/`PIP_*`/`UV_*`
 *     (dynamic-linker preload / package-index redirection → RCE, JAIL-04) —
 *     stripped on BOTH env sources, regardless of origin;
 *   - the whole `COMIS_*` operational prefix WHEN scrubbing an UNTRUSTED
 *     workspace-loaded `.env` (`source: "workspace"`) — a forged `COMIS_CAP_LEASE`
 *     (or a future runtime-control var) must not ride attacker-supplied content
 *     into the jail (JAIL-04 / Open Q3). The daemon's OWN `COMIS_CAP_LEASE`/
 *     `COMIS_ORCH_SOCKET` injection rides the trusted inherited path and is NOT
 *     blocked (it authenticates the cap socket — see {@link scrubChildEnv});
 *   - the net-new nested-CLI markers `CLAUDECODE` (exact) + `CLAUDE_CODE_*` (prefix)
 *     so a driven `claude` does not mis-detect a nested session (Tampering);
 *   - Shellshock function-export values (starting with `()`, Bash CVE-2014-6271).
 *
 * It is a BLOCKLIST (strip the known-dangerous keys, COPY everything else) — NOT an
 * env allowlist like the MCP stdio scrubber. A driven full-screen CLI (`claude`,
 * `vim`, `top`) needs a far richer env than a headless MCP stdio server (`TERM`,
 * `LANG`, `COLORTERM`, `SSH_AUTH_SOCK`, operator vars, …); reusing an env allowlist
 * verbatim would break the driven TUI. The interpreter-var
 * blocklist below mirrors the MCP stdio interpreter-control set (the same vars a
 * stdio server strips) — but the keep-policy is deliberately inverted.
 *
 * Pure function (env-in → env-out): it does NOT read the ambient/system env (the
 * caller — the worker — passes its `envSnapshot()`), holds NO module-global
 * state, and does NOT depend on the infra package. Imported DIRECTLY by the worker
 * via `./terminal-env-scrub.js` (NOT re-exported through the barrel — the barrel is
 * written by a single Wave-1 module).
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
 * Interpreter-control PREFIX families stripped from the child env unconditionally
 * (both env sources — dangerous regardless of origin). Unlike the exact-name
 * {@link INTERPRETER_CONTROL_BLOCKLIST}, these are open-ended families with many
 * concrete keys, so they are matched by `startsWith` (JAIL-04):
 *   - `LD_*`  (`LD_PRELOAD`/`LD_LIBRARY_PATH`/…) — glibc dynamic-linker preload /
 *     search-path injection: load an attacker `.so` at every dynamically-linked
 *     exec → code exec (Elevation).
 *   - `DYLD_*` (`DYLD_INSERT_LIBRARIES`/`DYLD_LIBRARY_PATH`/…) — the macOS
 *     dyld equivalent (kept for parity; the jailed child is Linux, but the scrub
 *     is the same chokepoint).
 *   - `PIP_*` (`PIP_INDEX_URL`/`PIP_EXTRA_INDEX_URL`/…) — pip package-index
 *     redirection → install a malicious package → supply-chain RCE.
 *   - `UV_*`  (`UV_INDEX_URL`/`UV_EXTRA_INDEX_URL`/…) — the `uv` (Python) index
 *     equivalent.
 * NEVER remove a member without a security review. bwrap `--unsetenv` takes a
 * NAME not a glob, so these families live ONLY in {@link scrubChildEnv}'s
 * prefix check — they are deliberately absent from {@link JAIL_UNSET_ENV_VARS}.
 */
const INTERPRETER_CONTROL_PREFIXES: readonly string[] = ["LD_", "DYLD_", "PIP_", "UV_"];

/**
 * The reserved operational prefix the daemon's OWN runtime-control vars use
 * (`COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET`/…). Fail-closed-blocked from a
 * `source: "workspace"` scrub ONLY — see the {@link scrubChildEnv} doc for the
 * load-bearing source-distinction (RESEARCH Open Q3 / v8 §4.7).
 */
const COMIS_OPERATIONAL_PREFIX = "COMIS_";

/**
 * Net-new (terminal-driver-only) nested-CLI marker prefixes — stripped so a driven
 * `claude` does not inherit the daemon's `CLAUDE_CODE_ENTRYPOINT`/`CLAUDE_CODE_SSE_PORT`/…
 * and mis-detect a nested session. Grep-confirmed absent from the MCP blocklist.
 */
const NESTED_CLI_PREFIXES: readonly string[] = ["CLAUDE_CODE_"];

/** Net-new nested-CLI marker (exact match) — the bare `CLAUDECODE` sentinel. */
const NESTED_CLI_EXACT: ReadonlySet<string> = new Set(["CLAUDECODE"]);

/**
 * The fixed-name env keys to clear from the JAILED CLI via bwrap `--unsetenv` (emitted by
 * `terminal-scope-args`). This is the BACKEND-INDEPENDENT half of {@link scrubChildEnv}: that
 * function scrubs the `env` OBJECT the worker hands to the PTY backend's `pty.spawn`, but the
 * DEFAULT tmux/durable backend runs `tmux new-session -- bwrap …` and the new session inherits the
 * tmux SERVER env, bypassing the scrubbed object entirely (real-VPS 2026-06-17: the daemon's
 * `NODE_OPTIONS=--permission …` leaked into a driven claude, and CLAUDE_CODE_BUBBLEWRAP never
 * reached it → its Bash/SessionStart hook EROFS'd). Emitting `--unsetenv` for these in the bwrap
 * argv clears them on EVERY backend. NAMES ONLY (bwrap `--unsetenv` takes a key, not a glob): the
 * interpreter-control vectors + the exact `CLAUDECODE` sentinel. The `CLAUDE_CODE_*` PREFIX glob +
 * the Shellshock value check stay prefix/value-based in {@link scrubChildEnv} (and are absent from
 * a prod systemd daemon's env anyway). Single source of truth — the same sets scrubChildEnv enforces.
 */
export const JAIL_UNSET_ENV_VARS: readonly string[] = [
  ...INTERPRETER_CONTROL_BLOCKLIST,
  ...NESTED_CLI_EXACT,
];

/** Where the env being scrubbed came from — gates the {@link COMIS_OPERATIONAL_PREFIX} block. */
export type ScrubEnvSource =
  /**
   * The trusted daemon-inherited env (the default). Carries the daemon's OWN
   * `COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET` injection (the cap-socket bearer +
   * path, merged LAST into the `placeholders` slot by `buildExecEnv`). The
   * `COMIS_` block is NOT applied here — those lease vars MUST survive (blocking
   * them would break the cap socket).
   */
  | "inherited"
  /**
   * An UNTRUSTED, workspace-loaded `.env`/config (attacker-controllable content).
   * The whole `COMIS_` prefix is fail-closed-blocked from this source so a forged
   * `COMIS_CAP_LEASE` (or a future runtime-control `COMIS_` var) can never be
   * smuggled into the jailed child via workspace content.
   */
  | "workspace";

/**
 * Scrub the env handed to the jailed child.
 *
 * COPIES every key EXCEPT: a non-string value; an exact interpreter-control key
 * (`NODE_OPTIONS`/`BASH_ENV`/…); an interpreter-control PREFIX family
 * (`LD_*`/`DYLD_*`/`PIP_*`/`UV_*` — dynamic-linker preload / package-index
 * redirection → RCE, JAIL-04); the exact `CLAUDECODE`; any `CLAUDE_CODE_*` key;
 * a `()`-prefixed (Shellshock) function-export value. Everything else is
 * preserved (a rich env for the driven TUI). Pure — no env read, no mutation of
 * the input.
 *
 * SOURCE-DISTINCTION (RESEARCH Open Q3 / v8 §4.7 — the load-bearing correctness
 * point): the `COMIS_*` fail-closed block is applied ONLY when
 * `opts.source === "workspace"` (an untrusted workspace-loaded `.env`). The
 * default (`"inherited"`) does NOT block `COMIS_*`, so the daemon's OWN
 * `COMIS_CAP_LEASE`/`COMIS_ORCH_SOCKET` injection — which rides the trusted
 * inherited/`placeholders` path, a DIFFERENT code path from the workspace `.env`
 * loader — survives the scrub. Keep the two env sources distinct: block
 * attacker-supplied `COMIS_*`, allow daemon-injected. The interpreter-vector
 * families above are dangerous regardless of origin and are stripped on BOTH
 * sources (they are NOT behind the source flag).
 *
 * @param env the env to scrub (env-in → env-out).
 * @param opts.source the env's origin (default `"inherited"` — the trusted path).
 */
export function scrubChildEnv(
  env: NodeJS.ProcessEnv,
  opts?: { source?: ScrubEnvSource },
): NodeJS.ProcessEnv {
  const blockComis = opts?.source === "workspace";
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue; // non-string (undefined) → skip
    if (INTERPRETER_CONTROL_BLOCKLIST.has(key)) continue; // exact-name startup code-injection vector
    if (INTERPRETER_CONTROL_PREFIXES.some((p) => key.startsWith(p))) continue; // LD_/DYLD_/PIP_/UV_ family (JAIL-04, both sources)
    if (blockComis && key.startsWith(COMIS_OPERATIONAL_PREFIX)) continue; // COMIS_* from an untrusted workspace .env ONLY (Open Q3)
    if (NESTED_CLI_EXACT.has(key)) continue; // CLAUDECODE
    if (NESTED_CLI_PREFIXES.some((p) => key.startsWith(p))) continue; // CLAUDE_CODE_*
    if (value.startsWith("()")) continue; // Shellshock function-export (CVE-2014-6271)
    out[key] = value;
  }
  return out;
}
