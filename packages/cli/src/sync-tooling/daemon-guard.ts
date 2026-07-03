// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon-active guard for sync-tooling `--write` operations.
 *
 * Probes the local daemon via the `system.ping` JSON-RPC method
 * (NOT the older "health" namespace — the daemon registers
 * `system.ping` at scope "rpc" in
 * `packages/daemon/src/wiring/setup-gateway-api.ts`).
 *
 * Wraps `withClient` in `Promise.race` with a 1-second `setTimeout`
 * because `withClient`'s underlying `CONNECTION_TIMEOUT_MS` is hardcoded
 * to 2000ms. To enforce the 1s deadline we need an explicit race.
 *
 * Returns `true` ONLY when the RPC call resolves successfully. Any
 * error path — ECONNREFUSED, timeout, parse error, method-not-found —
 * returns `false` (fail-closed: if we cannot prove the daemon is live,
 * we assume it is not).
 *
 * @module
 */

import { SystemPingContract, systemSetTimeout } from "@comis/core";
import { withClient, callTyped, isGatewayAuthRejection } from "../client/rpc-client.js";

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
    // The contract registry is the single source of truth for the
    // method name; request/response Zod parses run in dev mode and
    // the wire shape is trusted in production.
    await callTyped(client, SystemPingContract, {});
  });

  // withClient's underlying CONNECTION_TIMEOUT_MS is hardcoded to
  // 2000ms. Enforce the 1s deadline with an explicit Promise.race.
  const timeoutToken = Symbol("daemon-guard-timeout");
  const timeout = new Promise<symbol>((resolve) => {
    systemSetTimeout(() => resolve(timeoutToken), timeoutMs);
  });

  try {
    const result = await Promise.race([probe, timeout]);
    if (result === timeoutToken) {
      // 1s elapsed without a response — fail-closed: treat as down.
      return false;
    }
    // probe resolved (rather than rejected) → daemon is reachable.
    return true;
  } catch (e) {
    // A gateway token-rejection (WS close 4001) is PROOF the daemon is up
    // — it answered the upgrade. Returning false here would make the CLI print
    // "daemon ... is not running" against a live daemon, hiding the real
    // (auth) problem. The follow-up RPC then fails with the token-naming error.
    if (isGatewayAuthRejection(e)) {
      return true;
    }
    // Any other RPC error (ECONNREFUSED, method-not-found, parse error,
    // InsecureTransportError, etc.) means we cannot prove the daemon
    // is live → fail-closed.
    return false;
  }
}
