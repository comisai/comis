// SPDX-License-Identifier: Apache-2.0
/**
 * CLI exit-code constants — single source of truth.
 *
 * Canonical meanings for `process.exit(N)` codes:
 *   - 1: general failure (default for unknown errors; many sites still exit 1 inline)
 *   - 2: validation/usage error (e.g., commands/auth.ts:247,259,265,280)
 *   - 3: config error (commands/config.ts:457,479,484)
 *   - 4: daemon required but unreachable
 *   - 42: daemon SIGUSR2 self-restart (wizard/steps/11-daemon-start.ts:356)
 *
 * @module
 */

export const ExitCode = {
  Success: 0,
  GeneralFailure: 1,
  UsageError: 2,
  ConfigError: 3,
  /** Daemon required but unreachable. */
  DaemonRequired: 4,
  /** Daemon SIGUSR2 self-restart signal — the installed systemd unit pins RestartForceExitStatus=42; do not reassign. */
  DaemonRestartSignal: 42,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
