// SPDX-License-Identifier: Apache-2.0
/**
 * Stub-filter injector stream wrapper.
 *
 * Removes auto-discovery stub tools (see tool-deferral.ts createAutoDiscoveryStubs)
 * from the API-ready payload. Stubs are present in the SDK's tools array so
 * agent-loop.js tool lookup succeeds, but must not reach the API:
 *  - They consume input tokens (~100 tokens per stub schema).
 *  - For Anthropic models where supportsToolSearch() is true, unfiltered stub
 *    names would match in the DEFER-TOOL block (request-body-injector.ts
 *    lines 1599-1643), causing deferCount > 0 which REMOVES client-side
 *    discover_tools and APPENDS server-side tool_search_tool_regex —
 *    flipping the session to a different control path unintentionally.
 *  - For Google AI Studio, unfiltered stubs would be persisted into the
 *    Gemini CachedContent entry (gemini-cache-injector.ts line 191-195),
 *    bloating the cache for its entire lifetime.
 *
 * Provider-agnostic: filters both top-level `params.tools` (Anthropic,
 * OpenAI, xAI) and nested `params.config.tools` (Google AI Studio).
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ComisLogger } from "@comis/infra";
import type { StreamFnWrapper } from "./types.js";

export interface StubFilterInjectorConfig {
  /** Getter for stub tool names. Filtered from the rendered API payload. */
  getStubToolNames: () => ReadonlySet<string>;
}

export function createStubFilterInjector(
  config: StubFilterInjectorConfig,
  logger: ComisLogger,
): StreamFnWrapper {
  return function stubFilterInjector(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const existingOnPayload = (options as Record<string, unknown>)?.onPayload as
        | ((payload: unknown, model: unknown) => Promise<unknown> | unknown)
        | undefined;

      const enhancedOptions = {
        ...options,
        onPayload: async (payload: unknown, payloadModel: unknown) => {
          // Let any upstream onPayload run first (we are the innermost wrapper,
          // so upstream here is the SDK's own or a user-provided one).
          const resolvedParams = (existingOnPayload
            ? await Promise.resolve(existingOnPayload(payload, payloadModel))
            : payload) as Record<string, unknown>;

          const stubNames = config.getStubToolNames();
          if (stubNames.size === 0) return resolvedParams;

          let removed = 0;

          // Top-level tools (Anthropic, OpenAI, xAI)
          if (Array.isArray(resolvedParams.tools)) {
            const before = (resolvedParams.tools as unknown[]).length;
            resolvedParams.tools = (resolvedParams.tools as Array<Record<string, unknown>>)
              .filter(t => !stubNames.has(t.name as string));
            removed += before - (resolvedParams.tools as unknown[]).length;
          }

          // Nested config.tools (Google AI Studio / Gemini)
          const cfg = resolvedParams.config as Record<string, unknown> | undefined;
          if (cfg && Array.isArray(cfg.tools)) {
            const before = (cfg.tools as unknown[]).length;
            cfg.tools = (cfg.tools as Array<Record<string, unknown>>)
              .filter(t => !stubNames.has(t.name as string));
            removed += before - (cfg.tools as unknown[]).length;
          }

          if (removed > 0) {
            logger.debug(
              { removed, provider: (payloadModel as { provider?: string })?.provider },
              "Stub filter removed auto-discovery stubs from payload",
            );
          }

          return resolvedParams;
        },
      };

      return next(model, context, enhancedOptions);
    };
  };
}
