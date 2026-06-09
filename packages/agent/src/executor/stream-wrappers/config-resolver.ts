// SPDX-License-Identifier: Apache-2.0
/**
 * Config resolver stream wrapper.
 *
 * Injects provider-specific parameters (maxTokens, temperature, cacheRetention)
 * into stream options from Comis YAML per-agent config.
 *
 * @module
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ComisLogger } from "@comis/core";

import { isAnthropicFamily } from "../../provider/capabilities.js";
import type { StreamFnWrapper } from "./types.js";
import { MIN_VISIBLE_OUTPUT_TOKENS } from "../../context-engine/output-headroom.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Configuration for the config resolver wrapper.
 * Values come from Comis YAML per-agent config (maxTokens, temperature).
 */
export interface ConfigResolverConfig {
  /** Comis YAML maxTokens override. Undefined = do not inject. */
  maxTokens?: number;
  /** Comis YAML temperature override. Undefined = do not inject. */
  temperature?: number;
  /** Cache retention for Anthropic provider. Default: "long".
   *  Accepts a getter function for per-execution dynamic resolution. */
  cacheRetention?: CacheRetention | (() => CacheRetention | undefined);
  /** Phase 166 Fix 3: getter returning the assembled input token count for the current dispatch.
   *  Set by lcd-assembler.transformContext via the onAssembledInputTokens callback.
   *  When provided and > 0, max_tokens is clamped to effectiveWindow − assembledInputTokens.
   *  When absent or returns 0 (frontier/mid or pre-assembler call), falls back to static config.maxTokens. */
  getAssembledInputTokens?: () => number | undefined;
  /** Phase 166 Fix 3: getter for the effective context window.
   *  Source: effectiveWindowRef.current set by the onEffectiveWindow callback from lcd-assembler.
   *  When absent or returns Infinity, the dynamic clamp is skipped (frontier/mid byte-identical). */
  getEffectiveWindow?: () => number | undefined;
  /** Phase 166 Fix 3: reasoning-aware output headroom floor for dynamic max_tokens clamp.
   *  Computed from computeOutputHeadroom(reasoningStyle, thinkingLevel) before the dispatch. */
  getOutputHeadroom?: () => number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** SYS-BOUNDARY: Deterministic marker between static and dynamic system prompt blocks.
 *  Enables cache break diagnostics to identify whether changes are in the
 *  stable or dynamic portion. Appended to staticPrefix block. */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "\n\n---SYSTEM-PROMPT-DYNAMIC-BOUNDARY---\n\n";

/**
 * Resolve "auto" breakpoint strategy to concrete value
 * based on active provider.
 *
 * Direct Anthropic -> "single" (minimizes KV page waste)
 * Bedrock/Vertex -> "multi-zone" (proxy-based, broader cache coverage)
 * Explicit "single" or "multi-zone" -> pass through unchanged
 */
export function resolveBreakpointStrategy(
  strategy: "auto" | "multi-zone" | "single" | undefined,
  _provider: string,
): "multi-zone" | "single" {
  if (strategy === "single" || strategy === "multi-zone") {
    return strategy;
  }
  // W11: All providers use multi-zone strategy. Previous "single" for
  // direct anthropic caused breakpoint budget exhaustion.
  return "multi-zone";
}

/**
 * Create a wrapper that injects provider-specific parameters into stream options.
 *
 * For ALL providers: injects maxTokens and temperature from Comis config
 * when they are defined.
 *
 * For Anthropic-family providers: injects cacheRetention when the resolved
 * value is truthy (the config schema provides the default).
 *
 * Comis config values are operator overrides and WILL replace any existing
 * options values -- this is intentional. The operator's YAML config is the
 * authoritative source for these parameters.
 *
 * @param config - Config resolver configuration from Comis YAML
 * @param logger - Logger for debug output
 * @returns A named StreamFnWrapper ("configResolver")
 */
export function createConfigResolver(
  config: ConfigResolverConfig,
  logger: ComisLogger,
): StreamFnWrapper {
  return function configResolver(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const injected: Record<string, unknown> = {};

      // Inject maxTokens and temperature for all providers when configured.
      // Skip temperature for reasoning models (e.g. OpenAI o-series, gpt-5.4-mini)
      // -- they don't support the parameter and the API returns 400.

      // Phase 166 Fix 3: dynamic max_tokens clamp.
      // clamp(configuredMax, MIN_VISIBLE_OUTPUT_TOKENS, effectiveWindow − assembledInputTokens)
      // Guard: both assembled > 0 AND effectiveWindow < Infinity must hold;
      // otherwise fall back to static config.maxTokens (frontier/mid byte-identical path).
      const assembledInputTokens = config.getAssembledInputTokens?.();
      const effectiveWindow = config.getEffectiveWindow?.();
      if (
        assembledInputTokens !== undefined &&
        assembledInputTokens > 0 &&
        effectiveWindow !== undefined &&
        effectiveWindow < Infinity
      ) {
        const headroom = config.getOutputHeadroom?.() ?? MIN_VISIBLE_OUTPUT_TOKENS;
        const remainingRoom = Math.max(headroom, effectiveWindow - assembledInputTokens);
        const dynamicMax = config.maxTokens !== undefined
          ? Math.min(config.maxTokens, remainingRoom)
          : remainingRoom;
        injected.maxTokens = dynamicMax;
        logger.debug(
          { wrapperName: "configResolver", dynamicMax, remainingRoom, assembledInputTokens, effectiveWindow },
          "Config params injected (dynamic max_tokens)",
        );
      } else if (config.maxTokens !== undefined) {
        injected.maxTokens = config.maxTokens;  // static fallback: frontier/mid byte-identical
      }
      if (config.temperature !== undefined && !model.reasoning) {
        injected.temperature = config.temperature;
      }

      // Inject cacheRetention for Anthropic-family providers when truthy
      // Resolve dynamic getter for per-execution cache retention override
      if (isAnthropicFamily(model.provider)) {
        const retention = typeof config.cacheRetention === "function"
          ? config.cacheRetention()
          : config.cacheRetention;
        if (retention) {
          injected.cacheRetention = retention;
        }
      }

      const injectedKeys = Object.keys(injected);

      if (injectedKeys.length === 0) {
        logger.debug(
          { wrapperName: "configResolver", provider: model.provider, skipped: true },
          "Config resolution skipped",
        );
        return next(model, context, options);
      }

      logger.debug(
        { wrapperName: "configResolver", provider: model.provider, injected: injectedKeys },
        "Config params injected",
      );

      const mergedOptions = { ...options, ...injected };
      return next(model, context, mergedOptions);
    };
  };
}
