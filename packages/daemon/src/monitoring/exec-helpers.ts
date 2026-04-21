// SPDX-License-Identifier: Apache-2.0
/**
 * Helpers for spawning short-lived child processes from monitoring sources
 * without inheriting the daemon's systemd-watchdog env vars.
 *
 * Rationale: the daemon runs under `Type=notify` with `NotifyAccess=main`.
 * systemd sets NOTIFY_SOCKET + MAINPID + WATCHDOG_{PID,USEC} in the daemon's
 * environment. Child processes spawned via `execFile` inherit these by
 * default, and any child that is itself systemd-aware (apt-get, which
 * transitively invokes apt-listchanges / unattended-upgrades helpers on
 * Ubuntu) ends up sending a READY=/STATUS= datagram to NOTIFY_SOCKET. The
 * daemon then spams journal with:
 *
 *   systemd[1]: comis.service: Got notification message from PID X, but
 *   reception only permitted for main PID Y
 *
 * These messages are cosmetic but can mask legitimate denials and inflate
 * journal volume (one per 5-min heartbeat tick). Stripping the four env
 * vars in the monitoring-command env is the minimal, targeted fix; the
 * daemon's own sd-notify FD remains unaffected because sd-notify reads
 * NOTIFY_SOCKET from the *parent*'s process.env, not from the child env
 * we pass to execFile.
 *
 * This only applies to monitoring sources. MCP children and exec-tool
 * sandbox children are out of scope — MCP children carry their own env
 * block from config.yaml, and bwrap exec children live behind the sandbox.
 */

const SYSTEMD_NOTIFY_VARS = [
  "NOTIFY_SOCKET",
  "MAINPID",
  "WATCHDOG_PID",
  "WATCHDOG_USEC",
] as const;

/**
 * Return a copy of `process.env` with systemd-watchdog vars removed.
 * Use as the `env` option of execFile / spawn for monitoring commands.
 */
export function envWithoutSystemdNotify(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SYSTEMD_NOTIFY_VARS) {
    delete env[key];
  }
  return env;
}
