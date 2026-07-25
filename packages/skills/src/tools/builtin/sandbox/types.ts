// SPDX-License-Identifier: Apache-2.0
/**
 * Sandbox runtime types for exec tool OS-level isolation.
 *
 * These interfaces define the contract between the daemon (which detects
 * and creates sandbox providers at startup) and the exec tool (which uses
 * them to wrap child process spawns). The Zod config schema lives in
 * @comis/core; these are runtime-only types.
 *
 * @module
 */

import type { LazyPaths } from "../file/safe-path-wrapper.js";

/** Options passed to SandboxProvider.buildArgs() to generate sandbox CLI arguments. */
export interface SandboxOptions {
  /** Workspace directory (read-write unless `workspaceReadOnly` is set). */
  workspacePath: string;
  /** Bind the workspace read-only. Used by deterministic replay staging. */
  workspaceReadOnly?: boolean;
  /** Additional directories with read-write access (e.g., graph pipeline shared dirs). */
  sharedPaths: string[];
  /** Directories with read-only access inside sandbox. */
  readOnlyPaths: string[];
  /** Working directory for the sandboxed command. */
  cwd: string;
  /** Temp directory inside workspace for spillover files. */
  tempDir: string;
  /**
   * Network isolation mode for the sandbox.
   * Default undefined/"open" = existing --share-net behaviour (no regression).
   * "broker-only" = --unshare-net + unix-socket bind for broker-only egress.
   * "none" = --unshare-net with NO socket and NO proxy (kernel-enforced deny-all
   *   egress; the skill-validation jail uses this so a synthesized script cannot
   *   reach the network to exfiltrate during dynamic validation).
   * "cap-socket" = --unshare-net + unix-socket bind for the capability-lease
   *   loopback endpoint. Mirrors broker-only arg-order:
   *   the bound unix socket stays reachable under netns (netns affects IP sockets
   *   only) so the jailed orchestrate child can dial the lease endpoint while all
   *   general IP egress stays cut.
   * Consumed by BwrapProvider.buildArgs(); other providers ignore it.
   */
  network?:
    | { mode: "open" }
    | { mode: "broker-only"; brokerSocketPath: string }
    | { mode: "none" }
    | { mode: "cap-socket"; capSocketPath: string };
  /**
   * When true, skip the ~/.local/share RW bind so credential material living
   * under that XDG dir is not read-write-exposed inside the sandbox.
   * Consumed by BwrapProvider.buildArgs(); other providers ignore it.
   * (Hardcoded ~/.claude* binds are no longer emitted by any provider, so this
   * flag no longer needs to gate them.)
   */
  secureCredentialHome?: boolean;
  /**
   * Open file descriptor to a precompiled raw-BPF seccomp blob.
   * bwrap `--seccomp N` takes an FD to raw BPF bytecode (NOT a JSON profile).
   * The caller/provider resolves this via loadSeccompProfileFd() (so buildArgs
   * stays a PURE arg generator with no live fs probe). When a number, buildArgs
   * emits `--seccomp <fd>`; when undefined/null the blob is absent and buildArgs
   * OMITS --seccomp (graceful degrade — the other sandbox controls still apply).
   * Consumed by BwrapProvider.buildArgs(); other providers ignore it.
   */
  seccompFd?: number | null;
  /**
   * The user HOME against which the credential-denylist backstop
   * screens caller-supplied binds. `validateBindMount(hostPath, home)`
   * treats `home` as the trusted base for the `~/.ssh`/`~/.config`/… denylist —
   * so it MUST be an explicit, trusted value, not an ambient read buried inside
   * the otherwise-pure `buildArgs` generator. Resolve it once from trusted
   * config at the provider's call site and pass it in. When OMITTED, buildArgs
   * falls back to `os.homedir()` (the production daemon's HOME) so existing
   * callers are unaffected — but the fallback is now an EXPLICIT, documented
   * default rather than a hidden ambient dependency, and tests inject a fixed
   * `home` to make the screen-vs-bind interaction deterministic.
   * Consumed by BwrapProvider.buildArgs(); other providers ignore it.
   */
  home?: string;
  /**
   * Resolved Node-runtime placement for the jail.
   * The provider resolves this via resolveJailNode() (probe node on the jail
   * PATH → bind process.execPath → mark unavailable) and passes the result in,
   * so buildArgs stays a pure arg generator (no live fs probe). buildArgs emits
   * `--ro-bind execPath execPath` ONLY when mode === "bind" (the binary is bound
   * READ-ONLY — a writable interpreter is a host-RCE vector). "path" means node
   * already resolves under the bound RO paths (no bind needed); "unavailable"
   * means surfaces 2/3 (orchestrate/CLI) cannot run inside the jail — the caller
   * surfaces a loud doctor/boot signal and NEVER claims a bundled Node.
   * Consumed by BwrapProvider.buildArgs(); other providers ignore it.
   */
  jailNode?: JailNodeResolution;
  /**
   * Resolved comis-agent CLI-binary placement for the jail.
   * The provider resolves this via resolveJailAgentCli() — hash-verify the
   * comis-built `comis-agent-entry.js` against the committed manifest pin, then
   * bind / unavailable-missing / unavailable-hash-mismatch — and passes the
   * result in, so buildArgs stays a pure arg generator (no live fs probe / hash).
   * buildArgs emits `--ro-bind binPath binPath` ONLY when mode === "bind" (the
   * binary is bound READ-ONLY — a writable binary is a host-RCE vector, and
   * src==dest so COMIS_AGENT_BIN/PATH resolves it in-jail). "unavailable" (a
   * missing OR tampered binary) emits NO bind — the orchestrate-tool then makes
   * ONLY the CLI surface unavailable with a loud signal, while the
   * orchestrate SCRIPT surface still runs. Unlike jailNode, an unavailable
   * comis-agent binary does NOT refuse the whole jail (the script surface is
   * independent of the CLI surface).
   * Consumed by BwrapProvider.buildArgs(); other providers ignore it.
   */
  jailAgentCli?: JailAgentCliResolution;
}

/**
 * The three-mode result of resolveJailNode(). Exhaustive: there is no
 * "bundled Node" mode — that claim is a spoofing vector.
 */
export type JailNodeResolution =
  | { mode: "path" }
  | { mode: "bind"; execPath: string }
  | { mode: "unavailable"; hint: string };

/**
 * The two-mode result of resolveJailPython(). Unlike JailNodeResolution there
 * is NO bind mode: the daemon is Node, so there is no daemon-python binary to
 * RO-bind as a fallback. "path" therefore carries the absolute `pythonBin` to
 * invoke (a bare `python3` name is not safe to mirror node's `{mode:"path"}` —
 * it could resolve off the child PATH to an unintended interpreter or exit
 * 127). "unavailable" is the honest degrade: a missing interpreter is ALWAYS a
 * LOUD unavailable with an operator hint — never a silent unjailed run.
 */
export type JailPythonResolution =
  | { mode: "path"; pythonBin: string }
  | { mode: "unavailable"; hint: string };

/**
 * The two-mode result of resolveJailAgentCli(). "bind" only when the
 * comis-agent binary EXISTS and its sha256 matches the committed manifest pin;
 * "unavailable" (with a content-free operator hint) when the binary is MISSING
 * or its bytes do NOT match the pin (tamper). There is no silent third state —
 * a missing/tampered binary is always a LOUD unavailable, never a silent bind.
 */
export type JailAgentCliResolution =
  | { mode: "bind"; binPath: string }
  | { mode: "unavailable"; hint: string };

/** Platform-specific sandbox provider (bwrap on Linux, sandbox-exec on macOS). */
export interface SandboxProvider {
  /** Provider name for logging (e.g., "bwrap", "sandbox-exec"). */
  readonly name: string;
  /** Whether the sandbox binary is available on this system. Result may be cached. */
  available(): boolean;
  /** Build CLI arguments to wrap a command in the sandbox. */
  buildArgs(opts: SandboxOptions): string[];
  /** Optional: modify environment variables for sandboxed process (e.g., redirect cache dirs). */
  wrapEnv?(env: Record<string, string>, workspacePath: string): Record<string, string>;
}

/** Runtime sandbox configuration passed to createExecTool(). */
export interface ExecSandboxConfig {
  /** The platform sandbox provider instance. */
  sandbox: SandboxProvider;
  /** Read-write shared directories (from graph pipeline or assembleToolsForAgent). Supports lazy resolution. */
  sharedPaths: LazyPaths;
  /** Read-only directories (from skill discovery paths). */
  readOnlyPaths: string[];
  /** Read-only directories from operator config (execSandbox.readOnlyAllowPaths). */
  configReadOnlyPaths: string[];
  /** Packages to pip-install into workspace venv on first creation (from execSandbox.warmVenvSeed config).
   *  Undefined means the config field was absent (legacy); empty array means seeding is disabled. */
  warmVenvSeed?: string[];
  /**
   * Network isolation mode forwarded to SandboxOptions.network.
   * When undefined, the sandbox defaults to "open" (--share-net) — existing behavior.
   * Set to broker-only for driven-CLI spawns requiring credential injection via the broker.
   * The daemon wiring activates this; making the path reachable comes first.
   */
  network?: SandboxOptions["network"];
  /**
   * When true, skip the ~/.local/share RW bind so credential material under it
   * is not read-write-exposed inside the sandbox.
   * Forwarded to SandboxOptions.secureCredentialHome. Defaults to false/undefined.
   * The daemon wiring activates this; making the path reachable comes first.
   */
  secureCredentialHome?: boolean;
}
