// SPDX-License-Identifier: Apache-2.0
/**
 * Test-support: inject the held `_capabilities` a gated orchestration handler
 * requires, mirroring what `createAgentRpcCall` does in production
 * (`setup-tools.ts`).
 *
 * Every gated orchestration handler carries a `requireCapability(rawParams._capabilities, <cap>)`
 * gate at its top (session.spawn, the graph.* /
 * cron.* / message.* / skills.* mutating families). Existing handler unit tests
 * call those handlers directly with a bare params object and therefore never
 * carry `_capabilities` — in production the in-process injector always supplies
 * it. This wrapper grants the held set the gated method needs (resolved from
 * `HANDLER_CAPABILITY_MAP`) so those tests exercise the handler BODY, not the
 * gate. The gate itself is proven RED-first in the dedicated capability-gate tests.
 *
 * @module
 */
import { HANDLER_CAPABILITY_MAP } from "@comis/core";

type Handler = (rawParams: Record<string, unknown>) => unknown;

/** True when the classification value is an orchestration capability. */
function isAgentCapability(value: string): boolean {
  return value !== "deny-by-origin" && value !== "ungated";
}

/**
 * Wrap a handler record so every invocation carries the `_capabilities` the
 * called method's gate requires (per `HANDLER_CAPABILITY_MAP`). A method already
 * carrying `_capabilities` is left untouched (so a test can still assert the
 * deny path by passing its own `_capabilities: []`). Read-only / ungated
 * methods are passed through unchanged.
 */
export function withHeldCapabilities<T extends Record<string, Handler | undefined>>(
  handlers: T,
): T {
  const out: Record<string, Handler | undefined> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    if (handler === undefined) {
      out[method] = handler;
      continue;
    }
    const classification = (HANDLER_CAPABILITY_MAP as Record<string, string>)[method];
    if (classification === undefined || !isAgentCapability(classification)) {
      out[method] = handler;
      continue;
    }
    out[method] = (rawParams: Record<string, unknown>) => {
      const withCaps =
        rawParams && Object.prototype.hasOwnProperty.call(rawParams, "_capabilities")
          ? rawParams
          : { ...rawParams, _capabilities: [classification] };
      return handler(withCaps);
    };
  }
  return out as T;
}
