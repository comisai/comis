// SPDX-License-Identifier: Apache-2.0
// SSRF blocklist — compose-compatible undici interceptor.
//
// This interceptor depends on undici's `Dispatcher` types, so it stays in
// @comis/infra. The pure predicate it uses (`isSsrfBlocked`) lives in
// @comis/core/net.
import type { Dispatcher } from "undici";
import { isSsrfBlocked } from "@comis/core";

/**
 * Type alias for undici's compose-compatible interceptor function.
 * Equivalent to `Dispatcher.DispatcherComposeInterceptor`.
 * @deprecated Use `Dispatcher.DispatcherComposeInterceptor` directly from undici.
 */
export type DispatchFn = Dispatcher["dispatch"];

// ---------------------------------------------------------------------------
// ssrfBlockInterceptor — compose-compatible dispatch interceptor
// blocks BEFORE connect; wired onto the dispatcher at install time.
// ---------------------------------------------------------------------------

/**
 * A `dispatcher.compose()`-compatible interceptor that blocks any dispatch
 * to a destination that `isSsrfBlocked` returns true for.
 *
 * Blocks BEFORE connect — handler.onError() is called and the wrapped
 * dispatch is NOT invoked for blocked or malformed origins.
 *
 * Usage:
 *   const guardedAgent = agent.compose(ssrfBlockInterceptor);
 *   setGlobalDispatcher(guardedAgent);
 */
export function ssrfBlockInterceptor(
  dispatch: Dispatcher["dispatch"],
): Dispatcher["dispatch"] {
  return function ssrfGuardedDispatch(opts, handler) {
    const origin =
      typeof opts.origin === "string"
        ? opts.origin
        : opts.origin instanceof URL
          ? opts.origin.href
          : "";

    let hostname: string;
    try {
      hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    } catch {
      // malformed origin — block by default (tampering via malformed origin)
      // Note: onResponseError is optional in the DispatchHandler interface; we call it
      // with null controller (matching the dns interceptor pattern in undici source).
      handler.onResponseError?.(
        null as unknown as Dispatcher.DispatchController,
        new Error(`SSRF: blocked malformed origin: ${origin}`),
      );
      return false;
    }

    if (isSsrfBlocked(hostname)) {
      handler.onResponseError?.(
        null as unknown as Dispatcher.DispatchController,
        new Error(`SSRF: blocked destination ${hostname}`),
      );
      return false;
    }

    return dispatch(opts, handler);
  };
}
