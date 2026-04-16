/**
 * Gemini cache injector stream wrapper.
 *
 * Injects CachedContent name into Gemini API payloads and atomically strips
 * the three inherited fields (systemInstruction, tools, toolConfig) to avoid
 * double-billing. Operates inside the onPayload hook (post-buildParams) per D-04.
 *
 * Handles cache injection, inherited field stripping, and staleness recovery.
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import { suppressError } from "@comis/shared";

import type { StreamFnWrapper } from "./stream-wrappers/types.js";
import type { GeminiCacheManager, CacheEntry } from "./gemini-cache-manager.js";
import { computeCacheContentHash } from "./gemini-cache-manager.js";
import { isGoogleFamily, isGoogleAIStudio } from "../provider/capabilities.js";
import { CHARS_PER_TOKEN_RATIO_STRUCTURED } from "../context-engine/constants.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeminiCacheInjectorConfig {
  /** Whether Gemini explicit caching is enabled (from geminiCache.enabled config). */
  enabled: boolean;
  /** The GeminiCacheManager instance for cache lifecycle. */
  cacheManager: GeminiCacheManager;
  /** Current session key for cache scoping. */
  sessionKey: string;
  /** Current agent ID for cache scoping. */
  agentId: string;
  /** Callback when a Gemini CachedContent entry is successfully injected.
   *  Called with the CacheEntry so the caller can capture cache hit stats for logging. */
  onCacheHit?: (entry: CacheEntry) => void;
  /** Callback for cache break detection Phase 1.
   *  Called with the API-ready payload AFTER any cache injection. */
  onPayloadForCacheDetection?: (
    params: Record<string, unknown>,
    model: { id: string; provider: string; [key: string]: unknown },
  ) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Gemini cache injector stream wrapper.
 *
 * The wrapper intercepts Gemini API calls to:
 * 1. Look up or create a CachedContent entry via the GeminiCacheManager
 * 2. Inject the cache name into the payload's config.cachedContent field
 * 3. Strip systemInstruction, tools, and toolConfig from config (already in cache)
 *
 * Provider guard ensures this is a no-op for non-Google providers.
 * Mutual exclusion with requestBodyInjector is guaranteed by provider family guards.
 *
 * @param config - Injector configuration
 * @param logger - Logger instance for debug/warn output
 * @returns StreamFnWrapper for the wrapper chain
 */
export function createGeminiCacheInjector(
  config: GeminiCacheInjectorConfig,
  logger: ComisLogger,
): StreamFnWrapper {
  return function geminiCacheInjector(next: StreamFn): StreamFn {
    // Use implicit parameter types from StreamFn (same pattern as createRequestBodyInjector)
    return (model, context, options) => {
      // Provider guard -- no-op for non-Google providers
      if (!isGoogleFamily(model.provider)) {
        return next(model, context, options);
      }

      // Enabled guard
      if (!config.enabled) {
        return next(model, context, options);
      }

      // AI Studio guard -- only AI Studio supports the Caches API
      if (!isGoogleAIStudio(model.provider)) {
        return next(model, context, options);
      }

      // Chain onPayload callback (preserve any existing onPayload from upstream wrappers)
      const existingOnPayload = (options as Record<string, unknown>)?.onPayload as
        | ((params: unknown, model: unknown) => Promise<unknown> | unknown)
        | undefined;

      const injectedOptions = {
        ...options,
        onPayload: async (payload: unknown, payloadModel: unknown) => {
          // Run existing onPayload first (if any)
          const resolvedParams = (existingOnPayload
            ? await Promise.resolve(existingOnPayload(payload, payloadModel))
            : payload) as Record<string, unknown>;

          // Cast payloadModel for field access
          const modelInfo = payloadModel as { id: string; provider: string; [key: string]: unknown };

          // Extract config sub-object from Gemini payload
          const configObj = resolvedParams.config as Record<string, unknown> | undefined;
          if (!configObj) {
            // No config object -- pass through
            config.onPayloadForCacheDetection?.(resolvedParams, modelInfo);
            return resolvedParams;
          }

          const systemInstruction = configObj.systemInstruction;
          const tools = configObj.tools as unknown[] | undefined;
          const toolConfig = configObj.toolConfig;

          // Estimate tokens from cacheable content
          const estimatedTokens = Math.ceil(
            JSON.stringify({ systemInstruction, tools, toolConfig }).length / CHARS_PER_TOKEN_RATIO_STRUCTURED,
          );

          // Compute content hash for cache invalidation
          const contentHash = computeCacheContentHash(
            systemInstruction,
            tools ?? [],
            toolConfig,
          );

          // Request cache entry from manager
          const cacheResult = await config.cacheManager.getOrCreate({
            sessionKey: config.sessionKey,
            agentId: config.agentId,
            model: modelInfo.id,
            provider: modelInfo.provider,
            systemInstruction,
            tools: tools ?? [],
            toolConfig,
            contentHash,
            estimatedTokens,
          });

          // Handle getOrCreate error -- log WARN, evict stale, pass through uncached
          if (!cacheResult.ok) {
            logger.warn(
              {
                err: cacheResult.error,
                sessionKey: config.sessionKey,
                hint: "Cache injection failed, passing through uncached",
                errorKind: "provider" as ErrorKind,
              },
              "Gemini cache injector: getOrCreate failed",
            );
            suppressError(
              config.cacheManager.dispose(config.sessionKey),
              "stale-cache-eviction",
            );
            config.onPayloadForCacheDetection?.(resolvedParams, modelInfo);
            return resolvedParams;
          }

          // Below min tokens or no API key -- pass through uncached
          const entry: CacheEntry | undefined = cacheResult.value;
          if (!entry) {
            config.onPayloadForCacheDetection?.(resolvedParams, modelInfo);
            return resolvedParams;
          }

          // D-03: Assertion -- all three fields must be present for stripping
          if (
            configObj.systemInstruction === undefined ||
            configObj.tools === undefined ||
            configObj.toolConfig === undefined
          ) {
            logger.warn(
              {
                sessionKey: config.sessionKey,
                cacheName: entry.name,
                hint: "Expected fields missing from config -- cache entry stale, evicting",
                errorKind: "validation" as ErrorKind,
              },
              "Gemini cache injector: stale cache detected (D-03)",
            );
            suppressError(
              config.cacheManager.dispose(config.sessionKey),
              "stale-cache-eviction-d03",
            );
            config.onPayloadForCacheDetection?.(resolvedParams, modelInfo);
            return resolvedParams;
          }

          // Inject cachedContent and strip inherited fields atomically
          configObj.cachedContent = entry.name;
          delete configObj.systemInstruction;
          delete configObj.tools;
          delete configObj.toolConfig;

          logger.debug(
            {
              cachedContent: entry.name,
              cachedTokens: entry.cachedTokens,
              sessionKey: config.sessionKey,
            },
            "Gemini cache injector: injected cached content",
          );

          // Notify caller of successful cache injection for observability
          config.onCacheHit?.(entry);

          // D-07: Phase 1 cache break detection callback
          config.onPayloadForCacheDetection?.(resolvedParams, modelInfo);
          return resolvedParams;
        },
      };

      return next(model, context, injectedOptions);
    };
  };
}
