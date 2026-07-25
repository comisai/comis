// SPDX-License-Identifier: Apache-2.0
/**
 * Request-body injector factory.
 *
 * Composition root for the four concerns the wrapper consolidates:
 *  1. Cache breakpoints (Anthropic-family) -- breakpoint-orchestration.ts
 *  2. 1M beta header (direct Anthropic only) -- context-window.ts
 *  3. service_tier injection (Responses API + fastMode) -- service-tier.ts
 *  4. store flag injection (Responses API + storeCompletions) -- store-flag.ts
 *
 * The onPayload pipeline composes sibling phase modules:
 *   - tool-cache.ts           (rendered tool memoization)
 *   - microcompact.ts         (TTL + token-ceiling triggers)
 *   - prefix-stability.ts     (cache-prefix instability diagnostic)
 *   - breakpoint-orchestration.ts  (Concern 1, ~280L)
 *   - cadence-tracking.ts     (post-payload cadence promote/demote)
 *   - marker-upgrade.ts       (SDK 5m → 1h upgrade)
 *   - skip-cache-write-marker.ts   (shared-prefix anchor)
 *   - kill-switch.ts          (retention="none" strip)
 *   - ttl-split-estimation.ts (per-TTL token attribution)
 *
 * `createRequestBodyInjector` returns a `requestBodyInjector` named
 * StreamFnWrapper.
 *
 * @module
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ComisLogger } from "@comis/core";

import type { StreamFnWrapper } from "../types.js";
import { createAccumulativeLatch } from "../../session-latch.js";
import { isAnthropicFamily } from "../../../provider/capabilities.js";

import type { RequestBodyInjectorConfig } from "./types.js";
import { getMinCacheableTokens } from "./cache-breakpoints.js";
import {
  CONTEXT_1M_BETA,
  parseHeaderList,
  sessionBetaHeaderLatches,
} from "./context-window.js";
import { isResponsesApiProvider, usesResponsesInputApi, injectStoreFlag } from "./store-flag.js";
import { injectServiceTier } from "./service-tier.js";
import { reorderContentForStablePrefix, stripTransientRecallFromHistory, stripReplayThinking, deferRecallToUncachedTail, stripTransientRecallFromResponsesInput, deferRecallToTrailingResponsesItem, stripReplayReasoningFromResponsesInput } from "./tool-result-clearing.js";
import { sortToolsForCacheStability } from "./cache-breakpoints.js";
import { applyRenderedToolCache } from "./tool-cache.js";
import {
  runTimeBasedMicrocompact,
  runTokenCeilingMicrocompact,
  runEveryTurnMicrocompact,
} from "./microcompact.js";
import { runPrefixStabilityDiagnostic } from "./prefix-stability.js";
import { runCacheBreakpointPhase } from "./breakpoint-orchestration.js";
import { maybePromoteBreakpoints } from "./cache-breakpoints.js";
import { enforceMonotonicTtlOrdering } from "./monotonic-ttl.js";
import { trackRecentZoneCadence } from "./cadence-tracking.js";
import { upgradeSdkMarkers } from "./marker-upgrade.js";
import { placeSkipCacheWriteMarker } from "./skip-cache-write-marker.js";
import { applyKillSwitch } from "./kill-switch.js";
import { estimateTtlSplit } from "./ttl-split-estimation.js";
import { stripBedrockToolHistory } from "./bedrock-tool-history.js";

/**
 * Create a stream wrapper that mutates the outgoing request body via the
 * onPayload hook. Consolidates four concerns:
 *
 * 1. **Cache breakpoints** (Anthropic-family): injects cache_control markers
 *    at strategic positions in the message array.
 * 2. **1M beta header** (direct Anthropic only): appends the context-1m beta
 *    header for 1M context window models.
 * 3. **service_tier** (Responses API + fastMode): injects service_tier: "auto".
 * 4. **store** (Responses API + storeCompletions): injects store: true.
 *
 * The wrapper only activates when the model matches at least one concern;
 * for non-Anthropic non-Responses providers, it passes through unchanged.
 *
 * @param config - Request body injector configuration
 * @param logger - Logger for debug output
 * @returns A named StreamFnWrapper ("requestBodyInjector")
 */
export function createRequestBodyInjector(
  config: RequestBodyInjectorConfig,
  logger: ComisLogger,
): StreamFnWrapper {
  return function requestBodyInjector(next: StreamFn): StreamFn {
    return (model, context, options) => {
      const needsCacheBreakpoints = config.modelProfile?.supportsPromptCache
        ?? isAnthropicFamily(model.provider);
      const needsResponsesApiInjection = isResponsesApiProvider(model as { api?: string });

      // ALL OpenAI Responses-family providers drive the same `input` item array and need the
      // auto-cached prefix stabilised: native openai (`openai-responses`),
      // Azure (`azure-openai-responses`), and codex (`openai-codex-responses` /
      // provider:"openai-codex"). The cache-breakpoint machinery is correctly skipped for them
      // (running cache_control on a Responses body strips type:"function" tools -> backend 400);
      // we install onPayload only to defer the per-turn inline-recall block off the user turns
      // onto an uncached trailing item so the prefix does not collapse to the instructions+tools
      // floor every time the recalled memory rotates (see the deferral block below). NOTE: the
      // gate must cover the whole Responses family — gating on `provider === "openai-codex"`
      // alone leaves the native `openai` provider (gpt-5.5 -> openai-responses) unstabilised
      // (5 floor-collapses observed live).
      const needsResponsesInputStabilizer = usesResponsesInputApi(model as { api?: string; provider?: string });
      const needsBedrockToolHistoryRepair = (model as { api?: string }).api === "bedrock-converse-stream";

      if (
        !needsCacheBreakpoints
        && !needsResponsesApiInjection
        && !needsResponsesInputStabilizer
        && !needsBedrockToolHistoryRepair
      ) {
        return next(model, context, options);
      }

      const minTokens = config.getMinTokensOverride?.() ?? getMinCacheableTokens(model.id);

      // Concern 2: 1M beta header (direct Anthropic only -- NOT Bedrock/Vertex)
      // Must be injected as HTTP headers via options.headers, NOT in the request body.
      // The pi-ai SDK passes options.headers to createClient() for HTTP transport,
      // while onPayload mutates the JSON body -- putting headers there causes
      // Anthropic API to reject with "headers: Extra inputs are not permitted".
      let mergedHeaders: Record<string, string> | undefined;
      if (model.provider === "anthropic") {
        const existingHeaders = (options as Record<string, unknown>)?.headers as Record<string, string> | undefined;
        const headers = { ...(existingHeaders ?? {}) };
        const existingBetas = parseHeaderList(headers["anthropic-beta"]);
        if (!existingBetas.includes(CONTEXT_1M_BETA)) {
          existingBetas.push(CONTEXT_1M_BETA);
          headers["anthropic-beta"] = existingBetas.join(", ");
          mergedHeaders = headers;
        }
        // Latch beta header on first use
        const betaLatch = config.getBetaHeaderLatch?.();
        if (betaLatch) {
          if (mergedHeaders) {
            const betaValue = mergedHeaders["anthropic-beta"];
            if (betaValue) {
              mergedHeaders["anthropic-beta"] = betaLatch.setOnce(betaValue);
            }
          } else {
            // No new headers to merge but latch has a value -- use latched value
            const latched = betaLatch.get();
            if (latched) {
              mergedHeaders = { ...(existingHeaders ?? {}), "anthropic-beta": latched };
            }
          }
        }

        // Sticky-on beta header latches -- accumulate individual beta
        // values across calls. Unlike the set-once latch (set-once for entire string), this
        // tracks individual values and ensures once-seen-always-included semantics.
        if (config.sessionKey) {
          // Ensure mergedHeaders exists (even if CONTEXT_1M_BETA was already present)
          if (!mergedHeaders) {
            mergedHeaders = { ...(existingHeaders ?? {}) };
          }
          const currentBetas = parseHeaderList(mergedHeaders["anthropic-beta"]);

          let latched = sessionBetaHeaderLatches.get(config.sessionKey);
          if (!latched) {
            latched = createAccumulativeLatch<string>();
            sessionBetaHeaderLatches.set(config.sessionKey, latched);
          }

          // Latch all current beta values (sticky-on: once seen, always included)
          for (const beta of currentBetas) {
            latched.add(beta);
          }

          // Merge any previously-latched values not in current set
          let changed = false;
          for (const beta of latched.getAll()) {
            if (!currentBetas.includes(beta)) {
              currentBetas.push(beta);
              changed = true;
            }
          }

          if (changed) {
            mergedHeaders["anthropic-beta"] = currentBetas.join(", ");
          }
        }
      }

      // Chain onPayload: preserve any existing onPayload callback
      const existingOnPayload = (options as Record<string, unknown>)?.onPayload as
        ((payload: unknown, model: unknown) => Promise<unknown> | unknown) | undefined;

      const enhancedOptions = {
        ...options,
        ...(mergedHeaders ? { headers: mergedHeaders } : {}),
        onPayload: async (payload: unknown, payloadModel: unknown) => {
          // Let existing onPayload run first
          const transformed = existingOnPayload
            ? await existingOnPayload(payload, payloadModel)
            : undefined;
          const params = (transformed ?? payload) as Record<string, unknown>;

          // Clone mutable sub-structures before any mutation.
          // Prevents contaminating reused content in secondary queries (title generation, compaction)
          // that may share the original params reference. The SDK builds params fresh each call
          // via buildParams(), but we must not mutate SDK-owned objects to prevent stale marker
          // accumulation if the SDK ever caches or reuses params across calls.
          const result: Record<string, unknown> = { ...params };
          if (needsCacheBreakpoints) {
            if (Array.isArray(params.system)) {
              result.system = structuredClone(params.system);
            }
            if (Array.isArray(params.tools)) {
              result.tools = structuredClone(params.tools);
            }
          }
          if (
            (needsCacheBreakpoints || needsBedrockToolHistoryRepair)
            && Array.isArray(params.messages)
          ) {
            result.messages = structuredClone(params.messages);
          }

          if (
            needsBedrockToolHistoryRepair
            && result.toolConfig === undefined
            && Array.isArray(result.messages)
          ) {
            const rewrite = stripBedrockToolHistory(
              result.messages as Array<Record<string, unknown>>,
            );
            result.messages = rewrite.messages;
            if (rewrite.toolBlocksStripped > 0) {
              logger.debug(
                {
                  toolBlocksStripped: rewrite.toolBlocksStripped,
                  messagesDropped: rewrite.messagesDropped,
                  messagesMerged: rewrite.messagesMerged,
                  sessionKey: config.sessionKey,
                },
                "Historical Bedrock tool protocol removed for a tool-disabled turn",
              );
            }
          }

          // Reorder content blocks for stable prefix (before any cache marker placement)
          if (needsCacheBreakpoints && Array.isArray(result.messages)) {
            reorderContentForStablePrefix(result.messages as Array<Record<string, unknown>>);
            // Strip the TRANSIENT inline-recall block from historical user messages so
            // the cached prefix is byte-stable turn-over-turn. The block is per-turn,
            // query-varying recall (kept only on the latest user message for attention);
            // left on history it mutates the prefix every request → cache_creation churn.
            const recallStripped = stripTransientRecallFromHistory(result.messages as Array<Record<string, unknown>>);
            if (recallStripped > 0) {
              logger.debug(
                { recallStripped, sessionKey: config.sessionKey },
                "Stripped transient inline-recall from cached prefix",
              );
            }
            // Strip thinking from EVERY replayed assistant message
            // (including the active/last one) so the cached prefix matches the durable (LCD)
            // no-thinking form and never mutates when an assistant transitions active→historical.
            const thinkingStripped = stripReplayThinking(result.messages as Array<Record<string, unknown>>);
            if (thinkingStripped > 0) {
              // Notify the cache-break detector: this is a DELIBERATE content modification
              // (matching the durable LCD form), so a one-time read-token change as a message's
              // thinking is stripped must be SUPPRESSED, not flagged as a server eviction.
              config.onContentModification?.();
              logger.debug(
                { thinkingStripped, sessionKey: config.sessionKey },
                "Stripped replay thinking from cached prefix",
              );
            }
            // Move the current turn's inline-recall block onto the UNCACHED tail
            // (a trailing block after the cache fence) so it's visible to the model but never
            // cached — preventing the prefix mutation when the history strip removes it next turn.
            const recallDeferred = deferRecallToUncachedTail(result.messages as Array<Record<string, unknown>>);
            if (recallDeferred > 0) {
              logger.debug(
                { recallDeferred, sessionKey: config.sessionKey },
                "Deferred inline-recall to the uncached tail",
              );
            }
          }

          // TTL expiry guard for skipCacheWrite -- when the parent's cache write
          // timestamp indicates the shared prefix cache has likely expired (>80% of TTL
          // elapsed), disable skipCacheWrite so the sub-agent creates its own cache entry
          // instead of referencing a stale one. Prevents 100% cache misses on round-2
          // sub-agents where the 5-minute TTL expired between rounds.
          // Computed early so the tool-breakpoint guard below can defer to the sub-agent
          // bypass path (line ~1854) for SDK-placed tool markers.
          let effectiveSkipCacheWrite = config.skipCacheWrite ?? false;
          if (effectiveSkipCacheWrite && config.cacheWriteTimestamp != null) {
            const TTL_MAP: Record<string, number> = { short: 300_000, long: 3_600_000 };
            const ttlMs = TTL_MAP[config.parentCacheRetention ?? "short"] ?? 300_000;
            const SAFETY_MARGIN = 0.8;
            const elapsed = config.clock.now() - config.cacheWriteTimestamp;
            if (elapsed > ttlMs * SAFETY_MARGIN) {
              effectiveSkipCacheWrite = false;
              logger.debug(
                { elapsed, ttlMs, safetyMargin: SAFETY_MARGIN, sessionKey: config.sessionKey },
                "TTL likely expired, disabling skipCacheWrite",
              );
            }
          }

          // pi-ai 0.67.4+ auto-places cache_control on the last tool in
          // convertTools(). Tools are kept at zero breakpoints (cached
          // implicitly via the cumulative hash at the system breakpoint), so
          // strip the auto-placed marker before our budget + zone strategy runs.
          //
          // Skipped for effectiveSkipCacheWrite=true (sub-agent path): single-turn
          // sub-agents need SDK-placed markers intact to match the parent's cached
          // prefix; multi-turn sub-agents strip+re-place at line ~1874 anyway.
          if (needsCacheBreakpoints && !effectiveSkipCacheWrite && Array.isArray(result.tools)) {
            for (const tool of result.tools as Array<Record<string, unknown>>) {
              if (tool.cache_control) delete tool.cache_control;
            }
          }

          // Sort tools for cache-stable prefix: builtins first, MCP alphabetically
          if (needsCacheBreakpoints && Array.isArray(result.tools) && result.tools.length > 0) {
            result.tools = sortToolsForCacheStability(result.tools as Array<Record<string, unknown>>);
          }

          // Rendered tool cache -- ensures byte-identical tool JSON across turns
          applyRenderedToolCache(result, config, needsCacheBreakpoints, logger);

          // Time-based microcompact (TTL trigger)
          if (needsCacheBreakpoints) runTimeBasedMicrocompact(result, config, logger);

          // Token-ceiling microcompact (size trigger)
          if (needsCacheBreakpoints) runTokenCeilingMicrocompact(result, config, logger);

          // Every-turn microcompact -- unconditional Tier-0 pass, fence-protected.
          // Keeps the coordinator's context flat every turn, not just after an
          // idle gap; cache-stable (clears nothing at/below the fence; byte-stable placeholder).
          if (needsCacheBreakpoints) runEveryTurnMicrocompact(result, config, logger);

          // Prefix stability diagnostic
          if (needsCacheBreakpoints) runPrefixStabilityDiagnostic(result, config, logger);

          // Concern 1: Cache breakpoints (Anthropic-family) — returns the
          // resolvedRetention for downstream phases.
          const resolvedRetention: CacheRetention | undefined = runCacheBreakpointPhase(
            result,
            model,
            config,
            needsCacheBreakpoints,
            effectiveSkipCacheWrite,
            minTokens,
            logger,
          );

          // Promote stable message breakpoints from 5m to 1h TTL
          // Skip breakpoint TTL promotion during eviction cooldown (conservative caching).
          {
            const cooldownForPromotion = config.getEvictionCooldown?.();
            const promotionBlocked = cooldownForPromotion != null && cooldownForPromotion.turnsRemaining > 0;
            if (config.blockStabilityTracker && config.sessionKey && !effectiveSkipCacheWrite && !promotionBlocked) {
              const promotionThreshold = config.stabilityThreshold ?? 3;
              const promotedCount = maybePromoteBreakpoints(
                result.messages as Array<Record<string, unknown>>,
                config.blockStabilityTracker,
                config.sessionKey,
                promotionThreshold,
                resolvedRetention,
              );
              if (promotedCount > 0) {
                logger.debug(
                  { promoted: promotedCount, threshold: promotionThreshold, modelId: model.id },
                  "Message breakpoints promoted to 1h TTL",
                );
                // Promotion may have produced an out-of-order layout (some
                // markers now 1h, earlier ones still 5m). Re-run the safety
                // net so any stray 5m-before-1h gets upgraded before the
                // request leaves the wrapper. The sweep is a no-op when the
                // promoted layout happens to remain monotonic.
                enforceMonotonicTtlOrdering(result, logger);
              }
            }
          }

          // Sticky-on sweep -- capture any beta headers modified inside onPayload
          // and merge previously-latched values. Ensures consistency regardless of where
          // beta headers are added (outer scope or inside onPayload callbacks).
          if (config.sessionKey && mergedHeaders) {
            const allBetas = parseHeaderList(mergedHeaders["anthropic-beta"]);
            let latched = sessionBetaHeaderLatches.get(config.sessionKey);
            if (!latched) {
              latched = createAccumulativeLatch<string>();
              sessionBetaHeaderLatches.set(config.sessionKey, latched);
            }
            for (const beta of allBetas) latched.add(beta);
            // Inject any previously latched values not yet in current headers
            let changed = false;
            for (const beta of latched.getAll()) {
              if (!allBetas.includes(beta)) {
                allBetas.push(beta);
                changed = true;
              }
            }
            if (changed) {
              mergedHeaders["anthropic-beta"] = allBetas.join(", ");
            }
          }

          // Feed payload to cache break detector (after breakpoint placement)
          if (config.onPayloadForCacheDetection) {
            config.onPayloadForCacheDetection(result, model, mergedHeaders);
          }

          // Track cadence for recent-zone promotion (symmetric: promote slow, demote on fast).
          // Runs after onPayloadForCacheDetection so the detection snapshot reflects the
          // pre-mutation state. Mutation takes effect on the next turn's placeCacheBreakpoints().
          trackRecentZoneCadence(config, logger);

          // Upgrade SDK auto-placed 5m markers to 1h when retention is long.
          // callCount comes from the cache-break detector (incremented by
          // onPayloadForCacheDetection above) so the gate sees the
          // post-increment value for THIS turn. The gate suppresses
          // promotion when callCount < 2 to avoid paying the 1h premium
          // on first-turn writes that may be evicted server-side.
          const callCountForUpgrade = config.getCallCount?.();
          upgradeSdkMarkers({
            result,
            modelId: model.id,
            sessionKey: config.sessionKey,
            resolvedRetention,
            needsCacheBreakpoints,
            effectiveSkipCacheWrite,
            ...(callCountForUpgrade !== undefined && { callCount: callCountForUpgrade }),
            logger,
          });

          // skipCacheWrite places marker at shared-prefix point instead of stripping all.
          placeSkipCacheWriteMarker(
            result,
            model.id,
            config.sessionKey,
            resolvedRetention,
            needsCacheBreakpoints,
            effectiveSkipCacheWrite,
            logger,
          );

          // Kill switch -- strip ALL cache_control when resolved retention is "none".
          // Must run AFTER all breakpoint/marker placement (system, tools, messages) so
          // nothing gets re-added after the strip pass.
          applyKillSwitch(
            result,
            model.id,
            config.sessionKey,
            resolvedRetention,
            needsCacheBreakpoints,
            logger,
          );

          // Count per-TTL token distribution from final cache_control markers.
          // Runs AFTER all breakpoint placement and kill-switch stripping so counts
          // reflect the exact markers sent to the API.
          estimateTtlSplit(result, config, needsCacheBreakpoints);

          // Concern 3: service_tier (Responses API + fastMode)
          injectServiceTier(result, needsResponsesApiInjection, config.fastMode);

          // Concern 4: store (Responses API + storeCompletions)
          injectStoreFlag(result, needsResponsesApiInjection, config.storeCompletions);

          // Stabilise the OpenAI Responses auto-cached prefix.
          // The per-turn inline-recall block ("[Relevant context from memory: ...]") is
          // prepended to the CURRENT user turn (envelope-wrapper) but recall is TRANSIENT —
          // the LCD/history rebuild emits each user turn CLEAN. So the latest user item is sent
          // WITH recall (cached this turn), then next turn it goes historical and is rebuilt
          // WITHOUT recall -> the auto-cached prefix diverges at that item -> cached_tokens
          // collapses to the instructions+tools floor (~21.5k) once per turn (confirmed live:
          // a clean A/B showed 4 floor-collapses with this OFF, 0 with it ON).
          // Fix (OpenAI analog of the Anthropic deferRecallToUncachedTail): strip recall off the
          // user items and re-attach the current-turn recall as a SEPARATE trailing item, so the
          // user turns are byte-identical to their future historical clean form and the prefix
          // is stable. The model still sees recall (trailing = freshest position); the trailing
          // item is transient (never persisted) so it never enters the cached prefix.
          // Tool-safe: matches role:"user" only (never function_call/reasoning items).
          // Unconditional (mirrors the always-on Anthropic deferRecallToUncachedTail).
          if (needsResponsesInputStabilizer && Array.isArray((result as Record<string, unknown>).input)) {
            result.input = structuredClone((result as Record<string, unknown>).input);
            const inputItems = result.input as Array<Record<string, unknown>>;
            // 1. Defensive: strip recall from any HISTORICAL user item (no-op when history is
            //    already clean, which it is when recall is transient).
            const strippedCount = stripTransientRecallFromResponsesInput(inputItems);
            // 2. Recall deferral: defer recall on the LATEST user item to a trailing (uncached,
            //    never persisted) item, so the latest item is byte-identical to its future
            //    historical clean form and the auto-cached prefix never mutates at the turn boundary.
            const deferred = deferRecallToTrailingResponsesItem(inputItems);
            // 3. Reasoning strip: strip ALL replayed reasoning items — ONLY on the native
            //    openai / Azure Responses path (needsResponsesApiInjection). With `store:false`
            //    the SDK keeps reasoning for recent turns but drops it from aging turns -> an
            //    early-index prefix mutation -> floor-collapse. Removing them consistently every
            //    call keeps the prefix byte-stable (verified: monotonic, 0 collapses, no 400).
            //    Codex (provider:"openai-codex") keeps its reasoning stable and was already
            //    optimal, so it is excluded to avoid the (bounded) reasoning-continuity cost.
            const reasoningStripped = needsResponsesApiInjection
              ? stripReplayReasoningFromResponsesInput(inputItems)
              : 0;
            if (strippedCount > 0 || deferred > 0 || reasoningStripped > 0) {
              logger.debug(
                { sessionKey: config.sessionKey, recallStrippedOai: strippedCount, recallDeferredOai: deferred, reasoningStrippedOai: reasoningStripped },
                "Stabilised OpenAI Responses prefix: deferred recall + stripped replayed reasoning",
              );
            }
          }

          return result;
        },
      };

      return next(model, context, enhancedOptions as typeof options);
    };
  };
}
