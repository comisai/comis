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
}
