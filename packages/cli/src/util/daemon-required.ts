// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-required precondition for store-backed CLI commands.
 *
 * Every store-backed `comis secrets *` subcommand and the encrypted-mode
 * branch of `comis auth {list,logout,status}` must:
 *   1. Probe the daemon with a ≤200ms ping deadline.
 *   2. Exit with code 4 ("daemon required") if unreachable.
 *   3. Print a fixed-format remediation message on stderr — NO auto-start.
 *
 * The remediation message is held as a module constant so it is byte-identical
 * across all daemon-required commands (the architecture test in
 * packages/cli/src/__tests__/architecture.test.ts asserts the help-text
 * pattern is present in every store-backed `description()`).
 *
 * @module
 */

import { isDaemonRunning } from "../sync-tooling/daemon-guard.js";
import { ExitCode } from "./exit-codes.js";

/**
 * Probe timeout for the daemon-required precondition. 200ms is the
 * contract cap (the daemon's `system.ping` handler returns synchronously
 * with no I/O — the only cost is mTLS handshake + JSON-RPC roundtrip on
 * localhost).
 */
export const DAEMON_PROBE_TIMEOUT_MS = 200;

/**
 * Fixed-format remediation message printed to stderr when the daemon is
 * unreachable. The exact text is a stable contract. Downstream tests grep
 * for the "ERROR: This command requires the comis daemon" prefix.
 */
export const REMEDIATION_MESSAGE = `\
ERROR: This command requires the comis daemon, which is not running.

Start it with:    comis start
Check status:     comis status
View logs:        comis logs --tail 50

To run secrets management without the daemon, see:
- \`comis secrets init\`   (generate/write master key)
- \`comis secrets audit\`  (scan files for plaintext)`;

/**
 * If the daemon is unreachable within `timeoutMs`, write the remediation
 * message to stderr and `process.exit(ExitCode.DaemonRequired)`. Otherwise
 * return normally.
 *
 * The regression budget on this probe is 75ms median. Default 200ms cap is
 * the ceiling; actual roundtrip on localhost mTLS is typically 30-80ms.
 */
export async function requireDaemonOrExit(
  timeoutMs: number = DAEMON_PROBE_TIMEOUT_MS,
): Promise<void> {
  const running = await isDaemonRunning(timeoutMs);
  if (!running) {
    process.stderr.write(REMEDIATION_MESSAGE + "\n");
    process.exit(ExitCode.DaemonRequired);
  }
}
