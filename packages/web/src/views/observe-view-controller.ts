// SPDX-License-Identifier: Apache-2.0
/**
 * Observe-view controller.
 *
 * Thin RPC façade — the observe view retains @state for its tab-based
 * dashboard (overview/billing/diagnostics/delivery/channels/health) because
 * its existing test suite (61 priv() calls) relies on direct state
 * assertions and its data primarily flows via SSE events + apiClient
 * higher-level wrappers (which the boundary regex doesn't match). The
 * controller's job is to keep the 1 raw `rpcClient.call(...)` site out of
 * `observe-view.ts` so the boundary test passes.
 *
 * Errors propagate verbatim (callers handle).
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Controller interface                                               */
/* ------------------------------------------------------------------ */

export interface ObserveViewController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Reset observability counters (obs.reset). */
  resetObservability(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createObserveViewController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): ObserveViewController {
  const controller: ObserveViewController = {
    hostConnected(): void {
      /* no-op; the view drives loading via its own lifecycle */
    },
    hostDisconnected(): void {
      /* no-op; the view manages its own listeners */
    },

    async resetObservability(): Promise<void> {
      await rpcClient.call("obs.reset");
    },
  };

  host.addController(controller);
  return controller;
}
