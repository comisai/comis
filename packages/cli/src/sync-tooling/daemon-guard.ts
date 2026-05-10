// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-active guard for sync-tooling `--write` operations.
 *
 * Probes the local daemon via the `system.ping` JSON-RPC method
 * (NOT the older "health" namespace — see drift item 1 in
 * 25-RESEARCH.md; the daemon registers `system.ping` at scope "rpc"
 * in `packages/daemon/src/wiring/setup-gateway-rpc.ts`).
 *
 * Wraps `withClient` in `Promise.race` with a 1-second `setTimeout`
 * because `withClient`'s underlying `CONNECTION_TIMEOUT_MS` is hardcoded
 * to 2000ms (drift item 4 in 25-RESEARCH.md). To enforce the 1s deadline
 * required by CONTEXT D-14 we need an explicit race.
 *
 * Returns `true` ONLY when the RPC call resolves successfully. Any
 * error path — ECONNREFUSED, timeout, parse error, method-not-found —
 * returns `false` (fail-closed: if we cannot prove the daemon is live,
 * we assume it is not).
 *
 * @module
 */

import { withClient } from "../client/rpc-client.js";

/**
 * Probe the daemon and return whether it is reachable.
 *
 * @param timeoutMs - Deadline in milliseconds (default 1000).
 *                    The 1s default is intentionally tighter than
 *                    `withClient`'s 2s connection timeout so the CLI
 *                    fails fast when the daemon is down.
 */
export async function isDaemonRunning(timeoutMs = 1000): Promise<boolean> {
  const probe = withClient(async (client) => {
    // Drift item 1 (RESEARCH §Pitfall 1): the daemon registers
    // `system.ping` at scope "rpc" — see
    // packages/daemon/src/wiring/setup-gateway-rpc.ts:78. SPEC §8 and
    // CONTEXT D-13 are wrong on the method name; the codebase is the
    // source of truth.
    await client.call("system.ping");
  });

  // Drift item 4 (RESEARCH §Pitfall 2): withClient's underlying
  // CONNECTION_TIMEOUT_MS is hardcoded to 2000ms. Enforce the
  // CONTEXT-D-14 1s deadline with an explicit Promise.race.
  const timeoutToken = Symbol("daemon-guard-timeout");
  const timeout = new Promise<symbol>((resolve) => {
    setTimeout(() => resolve(timeoutToken), timeoutMs);
  });

  try {
    const result = await Promise.race([probe, timeout]);
    if (result === timeoutToken) {
      // 1s elapsed without a response — fail-closed: treat as down.
      return false;
    }
    // probe resolved (rather than rejected) → daemon is reachable.
    return true;
  } catch {
    // Any RPC error (ECONNREFUSED, method-not-found, parse error,
    // InsecureTransportError, etc.) means we cannot prove the daemon
    // is live → fail-closed.
    return false;
  }
}
