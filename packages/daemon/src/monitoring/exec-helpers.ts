// SPDX-License-Identifier: Apache-2.0
/**
 * Helpers for spawning short-lived child processes from monitoring sources
 * without inheriting service-manager notification variables.
 *
 * The installer-generated unit uses `Type=exec`, so it does not provide a
 * notify socket or watchdog interval. A custom `Type=notify` unit or another
 * supervisor may still supply these variables. If a monitoring child inherits
 * them, a systemd-aware executable can send status messages as though it were
 * the daemon. Strip the variables only from the child environment; the
 * daemon's process environment is unchanged.
 *
 * This only applies to monitoring sources. MCP children and exec-tool
 * sandbox children are out of scope — MCP children carry their own env
 * block from config.yaml, and bwrap exec children live behind the sandbox.
 */

import { systemEnvSnapshot } from "@comis/core";

const SYSTEMD_NOTIFY_VARS = [
  "NOTIFY_SOCKET",
  "MAINPID",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
] as const;

/**
 * Return a copy of `process.env` with service-manager notify vars removed.
 * Use as the `env` option of execFile / spawn for monitoring commands.
 */
export function envWithoutSystemdNotify(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = systemEnvSnapshot();
  for (const key of SYSTEMD_NOTIFY_VARS) {
    delete env[key];
  }
  return env;
}
