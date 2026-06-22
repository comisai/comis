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
  /** Agent workspace directory (read-write inside sandbox). */
  workspacePath: string;
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
   *   reach the network to exfiltrate during dynamic validation, T-201-35).
   * "cap-socket" = --unshare-net + unix-socket bind for the capability-lease
   *   loopback endpoint (Phase 211, ENDPOINT-03). Mirrors broker-only arg-order:
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
}

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
