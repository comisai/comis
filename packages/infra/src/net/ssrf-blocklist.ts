// SPDX-License-Identifier: Apache-2.0
// SSRF blocklist — compose-compatible undici interceptor.
//
// This interceptor depends on undici's `Dispatcher` types, so it stays in
// @comis/infra. The pure predicate it uses (`isSsrfBlocked`) lives in
// @comis/core/net.
import type { Dispatcher } from "undici";
import { isSsrfBlocked } from "@comis/core";

// ---------------------------------------------------------------------------
// ssrfBlockInterceptor — compose-compatible dispatch interceptor
// blocks BEFORE connect; wired onto the dispatcher at install time.
// ---------------------------------------------------------------------------

/**
 * Build a `dispatcher.compose()`-compatible interceptor that blocks any dispatch
 * to a destination that `isSsrfBlocked` returns true for.
 *
 * Blocks BEFORE connect — handler.onResponseError() is called and the wrapped
 * dispatch is NOT invoked for blocked or malformed origins.
 *
 * `allowHosts` is the trusted loopback/gateway carve-out. The SSRF predicate
 * blocks ALL loopback (localhost, 127.0.0.0/8, ::1) unconditionally, but in the
 * default `gateway-only` (and opt-in `proxy`) loopback modes the local gateway
 * and Ollama MUST stay reachable when a proxy is installed — the interceptor
 * runs above the NO_PROXY routing decision, so routing loopback "direct" is not
 * enough; the host has to be exempt from the block too. `installGlobalProxyDispatcher`
 * passes `resolveLoopbackExemptHosts(config)` here (empty in `block` mode, so
 * loopback stays blocked there as documented). Hostnames must be lowercased and
 * bracket-free to match `new URL(origin).hostname`.
 *
 * Usage:
 *   const guardedAgent = agent.compose(createSsrfBlockInterceptor(exemptHosts));
 *   setGlobalDispatcher(guardedAgent);
 */
export function createSsrfBlockInterceptor(
  allowHosts?: ReadonlySet<string>,
): (dispatch: Dispatcher["dispatch"]) => Dispatcher["dispatch"] {
  return function ssrfBlockInterceptorImpl(dispatch) {
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

      // Trusted loopback/gateway carve-out — exempt before the SSRF block so the
      // local gateway + Ollama remain reachable in gateway-only / proxy modes.
      if (allowHosts !== undefined && allowHosts.has(hostname)) {
        return dispatch(opts, handler);
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
  };
}

/**
 * SSRF interceptor with NO loopback carve-out — blocks every `isSsrfBlocked`
 * destination including loopback. Equivalent to `createSsrfBlockInterceptor()`.
 * Retained for callers that compose the bare interceptor directly.
 */
export function ssrfBlockInterceptor(
  dispatch: Dispatcher["dispatch"],
): Dispatcher["dispatch"] {
  return createSsrfBlockInterceptor()(dispatch);
}
