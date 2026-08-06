// SPDX-License-Identifier: Apache-2.0
/**
 * Cache-breakpoint orchestration stage of the request-body factory pipeline.
 *
 * Hosts "Concern 1: Cache breakpoints (Anthropic-family)":
 *  1. Resolve per-model retention + latch
 *  2. Multi-block system prompt injection
 *  3. First system block hash debug log
 *  4. Upgrade system prompt TTL for monotonicity
 *  5. Count existing breakpoints + breakpoint budget audit log
 *  6. Inject defer_loading (delegates to tool-deferral-injection.ts)
 *  7. Graph-context breakpoint placement
 *  8. Eviction cooldown gating + placeCacheBreakpoints call
 *  9. Cache fence callback (highest message breakpoint scan)
 * 10. SDK auto-marker fallback fence
 * 11. Mature-conversation diagnostics (fence-unset + budget-exhausted)
 *
 * Returns the resolved retention so the factory can pass it to downstream
 * stages (marker upgrade, skipCacheWrite shared-prefix, kill switch,
 * adaptive TTL promotion).
 *
 * @module
 */

import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ComisLogger } from "@comis/core";

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY, resolveBreakpointStrategy } from "../config-resolver.js";
import { djb2 } from "../../cache-detection/index.js";
import { supportsExtendedCacheTtl } from "../../../provider/capabilities.js";

import { addCacheControlToLastBlock } from "./cache-control-block.js";
import { placeCacheBreakpoints } from "./breakpoint-placement.js";
import {
  countCacheBreakpoints,
  resolveCacheRetention,
} from "./cache-breakpoints.js";
import { injectToolDeferral } from "./tool-deferral-injection.js";
import { enforceMonotonicTtlOrdering } from "./monotonic-ttl.js";
import type { RequestBodyInjectorConfig } from "./types.js";

/** Message count at which a conversation counts as "mature": the fence-unset WARN threshold and
 *  the point from which a fence is guaranteed rather than merely attempted. One constant so the
 *  diagnostic and the guarantee cannot drift apart. */
const MATURE_CONVERSATION_MESSAGES = 10;

/**
 * Run the cache-breakpoint orchestration stage. Mutates `result.system`,
 * `result.tools`, and `result.messages` in place. Returns the
 * resolvedRetention for downstream stages.
 *
 * No-op (returns undefined) when `!needsCacheBreakpoints`.
 */
export function runCacheBreakpointPhase(
  result: Record<string, unknown>,
  model: { id: string; provider: string },
  config: RequestBodyInjectorConfig,
  needsCacheBreakpoints: boolean,
  effectiveSkipCacheWrite: boolean,
  minTokens: number,
  logger: ComisLogger,
): CacheRetention | undefined {
  if (!needsCacheBreakpoints) return undefined;

  // Resolve per-model cache retention override before latching
  const baseRetention = config.getCacheRetention() ?? "long";
  const modelId = config.getModelId?.() ?? model.id;
  const effectiveRetention = resolveCacheRetention(
    modelId,
    baseRetention,
    config.getCacheRetentionOverrides?.(),
  );

  // Downgrade "long" to "short" on a provider that cannot honor the extended
  // TTL beta (Bedrock/Vertex). Done HERE, at the single point where retention is
  // resolved, so every downstream `=== "long"` site emits a plain 5m marker —
  // rather than adding a parallel provider guard at each of the four places that
  // write `ttl: "1h"`. An unhonored 1h marker is billed as a cache write and
  // never matched on the next request.
  const providerCappedRetention: CacheRetention =
    effectiveRetention === "long" && !supportsExtendedCacheTtl(model.provider)
      ? "short"
      : effectiveRetention;
  if (providerCappedRetention !== effectiveRetention) {
    logger.debug(
      {
        provider: model.provider,
        modelId,
        requested: effectiveRetention,
        applied: providerCappedRetention,
        hint: "provider does not support the extended cache TTL beta; using the 5m default",
        step: "cache-retention",
      },
      "Cache retention capped for provider",
    );
  }

  // Latch retention on first resolution
  const rawRetention = providerCappedRetention;
  const retentionLatch = config.getRetentionLatch?.();
  const resolvedRetention: CacheRetention = retentionLatch
    ? retentionLatch.setOnce(rawRetention)
    : rawRetention;

  // Replace single system block with multi-block for independent caching.
  // Must run AFTER structuredClone (operates on cloned system) and BEFORE the
  // TTL upgrade (so all new blocks get upgraded). The SDK-placed single-block
  // cache_control is discarded -- we inject cache_control on all blocks explicitly.
  const promptBlocks = config.getSystemPromptBlocks?.();
  if (promptBlocks && Array.isArray(result.system)) {
    const blocks: Array<Record<string, unknown>> = [
      { type: "text" as const, text: promptBlocks.staticPrefix + SYSTEM_PROMPT_DYNAMIC_BOUNDARY },
    ];
    // Attribution block only when non-empty (empty in "none" mode)
    if (promptBlocks.attribution) {
      blocks.push({ type: "text" as const, text: promptBlocks.attribution });
    }
    // Provider request schemas reject zero-length text members. Prompt
    // compilation can legitimately omit this section for minimal operations,
    // so preserve that omission instead of serializing an empty block.
    if (promptBlocks.semiStableBody) {
      blocks.push({ type: "text" as const, text: promptBlocks.semiStableBody });
    }
    result.system = blocks;
    // ONE cache_control for the whole system prompt -- the cumulative hash covers
    // every prior block, so a single marker frees 2 breakpoint slots for message
    // breakpoints. It must sit on the last STABLE block, never on the trailing
    // `semiStableBody`: Anthropic caching is prefix-based, so anchoring on the
    // runtime preamble puts the per-call date/time INSIDE the cached prefix and
    // the whole system prompt misses on every turn. Live, a 1-character date
    // delta dropped 100% of a 56,276-token prefix (cache.break system_changed,
    // tokenDropRelative 1). Leaving the preamble after the marker re-sends it
    // uncached each call -- correct, and far cheaper than re-writing the prefix.
    const sysBlocks = result.system as Array<Record<string, unknown>>;
    for (const block of sysBlocks) {
      delete block.cache_control;
    }
    const anchorIndex = promptBlocks.semiStableBody && sysBlocks.length > 1
      ? sysBlocks.length - 2
      : sysBlocks.length - 1;
    sysBlocks[anchorIndex]!.cache_control = resolvedRetention === "long"
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };
    logger.debug(
      {
        blockCount: blocks.length,
        anchorIndex,
        uncachedTailBlocks: sysBlocks.length - 1 - anchorIndex,
        retention: resolvedRetention,
        modelId: model.id,
      },
      "Multi-block system prompt injected",
    );
  }

  // Log only content-free structural metadata for prefix-matching diagnostics.
  // This runs after multi-block injection so the hash reflects the final static
  // prefix; the prompt text itself must never enter a log sink.
  if (Array.isArray(result.system)) {
    const sysBlocks = result.system as Array<Record<string, unknown>>;
    if (sysBlocks.length > 0 && typeof sysBlocks[0]?.text === "string") {
      const text = sysBlocks[0].text as string;
      logger.debug(
        {
          firstBlockHash: djb2(text),
          blockCount: sysBlocks.length,
          modelId: model.id,
        },
        "System prompt first-block hash",
      );
    }
  }

  // Upgrade system prompt TTL to satisfy monotonicity constraint.
  // The SDK always sets system blocks to { type: "ephemeral" } (5m) because
  // configResolver passes getMessageRetention() = "short" for the SDK's
  // cacheRetention option (we can't give the SDK different values for system
  // vs last-user-message). But after adaptive escalation, the tool breakpoint
  // uses ttl: "1h". Without this upgrade, system(5m) -> tools(1h) violates
  // Anthropic's non-increasing TTL requirement, causing the API to silently
  // downgrade tools to 5m.
  if (resolvedRetention === "long" && Array.isArray(result.system)) {
    for (const block of result.system as Array<Record<string, unknown>>) {
      if (block.cache_control) {
        block.cache_control = { type: "ephemeral", ttl: "1h" };
      }
    }
  }

  // Count breakpoints on `result` (post-clone, post-multi-block-injection)
  // not `params` (pre-clone). Multi-block injection may have added cache_control to
  // 2 system blocks that didn't exist in the original params.
  const existingCount = countCacheBreakpoints(result);
  let slotsAvailable = 4 - existingCount;
  // Tracks the message index where the UNTRUSTED_ anchor placed (or
  // upgraded) the 1h marker. Consumed by the recent-zone retention ternary
  // below so the earlier breakpoint placed by placeCacheBreakpoints uses 1h
  // instead of 5m — preventing a live-observed TTL ordering violation at the
  // source (the monotonic-ttl safety net remains as defense in depth).
  let eFixFiredAt: number | undefined;

  // Breakpoint budget audit -- 1 per API call.
  {
    let systemBpCount = 0;
    let toolBpCount = 0;
    if (Array.isArray(result.system)) {
      for (const block of result.system as Array<Record<string, unknown>>) {
        if (block.cache_control) systemBpCount++;
      }
    }
    if (Array.isArray(result.tools)) {
      for (const tool of result.tools as Array<Record<string, unknown>>) {
        if (tool.cache_control) toolBpCount++;
      }
    }
    logger.info(
      {
        existingCount,
        slotsAvailable,
        systemBreakpoints: systemBpCount,
        toolBreakpoints: toolBpCount,
        modelId: model.id,
      },
      "Breakpoint budget audit (pre-message-placement)",
    );
  }

  // Tool breakpoint removed -- tools cached implicitly via cumulative hash
  // at system breakpoint position (zero tool breakpoints).

  // Inject defer_loading on deferred tools for Anthropic non-Haiku models.
  // Runs after tool cache breakpoints so deferred marking doesn't pollute breakpoint logic.
  injectToolDeferral(result, model.id, config, logger);

  // Place a cache breakpoint on graph context envelope.
  // Subagents and graph-enabled sessions receive injected research
  // results as the first user message. This dynamic content (~100K+ tokens)
  // falls between the standard cache breakpoints, paying full uncached input
  // rate. Placing a breakpoint captures it under the cache prefix.
  // Must run INSIDE the budget-aware block to consume a slot from slotsAvailable.
  if (slotsAvailable > 0 && !effectiveSkipCacheWrite && Array.isArray(result.messages)) {
    const msgs = result.messages as Array<Record<string, unknown>>;
    for (let i = 0; i < Math.min(msgs.length, 3); i++) {
      const msg = msgs[i]!;
      if (msg.role !== "user") continue;
      const content = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
      const hasGraphContext = content.some((block: Record<string, unknown>) =>
        typeof block.text === "string" && (block.text as string).includes("## Graph Context"),
      );
      if (hasGraphContext) {
        addCacheControlToLastBlock(msg, resolvedRetention ?? "long");
        slotsAvailable--;
        logger.debug(
          { modelId: model.id, messageIndex: i, sessionKey: config.sessionKey },
          "GRAPH-BREAKPOINT: Placed cache breakpoint on graph context envelope message",
        );
        break;
      }
    }
  }

  // UNTRUSTED_ anchor: turns carrying a large stable untrusted block
  // (e.g., link-understanding output ~32KB) need a 1h cache anchor —
  // the default 5m TTL gets evicted under Anthropic capacity pressure
  // and the entire ~32KB re-uploads on every turn. Scan the last few
  // user messages for the UNTRUSTED_ marker; place (or upgrade) a
  // cache_control entry to { type: "ephemeral", ttl: "1h" } on that
  // message's last block. Skip when no slot is available — don't
  // blow the breakpoint budget.
  if (slotsAvailable > 0 && !effectiveSkipCacheWrite && Array.isArray(result.messages)) {
    const msgs = result.messages as Array<Record<string, unknown>>;
    for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 3; i--) {
      const msg = msgs[i]!;
      if (msg.role !== "user") continue;
      const content = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
      const hasUntrusted = content.some((b) => typeof b.text === "string" && (b.text as string).includes("<<<UNTRUSTED_"));
      if (!hasUntrusted) continue;
      // Only anchor a LARGE untrusted block — the ~32KB link-understanding case this anchor
      // exists for. A SMALL untrusted tool_result (e.g. an `echo` result) is cheap to re-upload and
      // the SDK's last-user marker already covers it; anchoring it would waste a breakpoint slot
      // that the lookback gap-bridge needs (observed live: small tool_results were stealing
      // the slot, leaving the mid-conversation gap unbridged on alternating tool turns). The
      // delimiter-wrap security is independent of this cost anchor, so gating on size is safe.
      const EFIX_MIN_UNTRUSTED_CHARS = 16384; // ~4K tokens — clearly "large", well below ~32KB
      const untrustedChars = content.reduce((sum, b) => sum + (typeof b.text === "string" ? (b.text as string).length : 0), 0);
      if (untrustedChars < EFIX_MIN_UNTRUSTED_CHARS) continue;
      // Place (or upgrade) cache_control to 1h on the last block of this message.
      const lastBlock = content[content.length - 1];
      const alreadyPlaced = lastBlock != null && lastBlock.cache_control != null;
      if (!alreadyPlaced) {
        addCacheControlToLastBlock(msg, "long");
        slotsAvailable--;
      } else {
        (lastBlock as Record<string, unknown>).cache_control = { type: "ephemeral", ttl: "1h" };
      }
      logger.debug(
        { messageIndex: i, modelId: model.id, sessionKey: config.sessionKey },
        "E-FIX: 1h cache anchor placed on user message carrying UNTRUSTED_ block",
      );
      // Record the message index so the recent-zone retention below
      // upgrades from "short" (5m) to "long" (1h) — keeping the
      // tools->system->messages TTL sequence monotonically non-increasing.
      eFixFiredAt = i;
      break;
    }
  }

  // The anchor above emits 1h regardless of the resolved retention, and the
  // system marker sits BEFORE every message marker in wire order — so on a
  // session still at "short" (a cold start, before the adaptive ladder
  // escalates) the payload went out as system(5m) -> message(1h), violating
  // Anthropic's non-increasing TTL rule. The earlier system upgrade cannot cover
  // it: that runs before this loop and only when retention is already "long".
  // enforceMonotonicTtlOrdering repaired it at the end of the phase and logged
  // "MONOTONIC-TTL: upgraded out-of-order 5m markers to 1h" naming system[1] —
  // an upstream-placement-bug WARN on every such turn. Promote here instead, the
  // same coordination the recent-zone retention below already performs.
  if (eFixFiredAt !== undefined && resolvedRetention !== "long" && Array.isArray(result.system)) {
    for (const block of result.system as Array<Record<string, unknown>>) {
      if (block.cache_control) {
        block.cache_control = { type: "ephemeral", ttl: "1h" };
      }
    }
  }

  // During eviction cooldown, limit to 1 breakpoint (recent zone) at "short" retention.
  const evictionCooldown = config.getEvictionCooldown?.();
  const inCooldown = evictionCooldown != null && evictionCooldown.turnsRemaining > 0;

  if (slotsAvailable > 0 && Array.isArray(result.messages)) {
    // Conversation breakpoints use zone-aware retention.
    // Recent zone always uses "short" (5m); semi-stable/mid zones get escalated retention.
    const messageRetention = config.getMessageRetention?.() ?? resolvedRetention;
    const placed = placeCacheBreakpoints(
      result.messages as Array<Record<string, unknown>>,
      {
        minTokens,
        maxBreakpoints: inCooldown ? 1 : slotsAvailable,
        // Recent zone defaults to 5m, but when the UNTRUSTED_ anchor placed 1h
        // on the latest user message, any earlier breakpoint must also be >= 1h
        // to satisfy Anthropic's monotonicity rule (tools->system->messages).
        // Without this coordination, enforceMonotonicTtlOrdering catches the
        // violation but logs a WARN — coordinating here makes the placement intent
        // correct at source so the safety net stays quiet in the common UNTRUSTED path.
        retention: eFixFiredAt !== undefined ? "long" : "short",
        resolvedRetention: inCooldown ? "short" : messageRetention, // Force "short" during cooldown
        strategy: resolveBreakpointStrategy(config.cacheBreakpointStrategy, model.provider),
        skipCacheWrite: effectiveSkipCacheWrite,
        promoteRecentZoneOnSlowCadence: config.promoteRecentZoneOnSlowCadence,
        sessionKey: config.sessionKey,
      },
    );
    if (placed > 0) {
      logger.debug(
        {
          placed,
          existingCount,
          totalBreakpoints: existingCount + placed,
          minTokens,
          modelId: model.id,
          strategy: resolveBreakpointStrategy(config.cacheBreakpointStrategy, model.provider),
        },
        "Message breakpoints placed",
      );
    } else if (Array.isArray(result.messages) && (result.messages as unknown[]).length >= 4) {
      logger.debug(
        { messageCount: (result.messages as unknown[]).length, minTokens, modelId: model.id, existingCount },
        "Cache breakpoints skipped: token gaps below minTokens threshold",
      );
    }

    // Unconditional scan for ANY message breakpoint (including SDK auto-marker).
    // Ensures cacheFenceIndex is set for all sessions, not just those with explicit placements.
    if (config.onBreakpointsPlaced && Array.isArray(result.messages)) {
      let highestBreakpointIdx = -1;
      const scanMsgs = result.messages as Array<Record<string, unknown>>;
      for (let i = scanMsgs.length - 1; i >= 0; i--) {
        const content = scanMsgs[i]!.content;
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block.cache_control) {
              highestBreakpointIdx = i;
              break;
            }
          }
        }
        if (highestBreakpointIdx >= 0) break;
      }
      // Last resort: a MATURE conversation must never be left without a fence. Short chat turns
      // can leave every token gap below minTokens, so placeCacheBreakpoints places nothing and no
      // SDK auto-marker exists either. The fence then stays -1 and every consumer takes its
      // fail-open branch, mutating already-cached content and forfeiting the cache write on each
      // turn. Anchor the newest user message so the fence is real and the prefix behind it frozen.
      if (highestBreakpointIdx < 0 && scanMsgs.length >= MATURE_CONVERSATION_MESSAGES) {
        for (let i = scanMsgs.length - 1; i >= 0; i--) {
          if (scanMsgs[i]!.role !== "user") continue;
          const content = scanMsgs[i]!.content;
          if (!Array.isArray(content) || content.length === 0) continue;
          // Skip tool_result carriers. A carrier sits AFTER an assistant turn that is still in an
          // unclosed tool-use cycle, and that turn keeps its thinking blocks only until the cycle
          // closes. Anchoring on the carrier would put the not-yet-final assistant turn INSIDE the
          // cached prefix, so the deferred strip would invalidate the whole write. Anchoring on the
          // last real user turn instead leaves the in-flight cycle outside the fence, where its
          // mutation is free.
          if ((content as Array<Record<string, unknown>>).every((b) => b.type === "tool_result")) continue;
          addCacheControlToLastBlock(scanMsgs[i]!, eFixFiredAt !== undefined ? "long" : "short");
          highestBreakpointIdx = i;
          logger.debug(
            { highestBreakpointIdx: i, messageCount: scanMsgs.length, modelId: model.id, minTokens },
            "Cache fence anchored on the newest user message (no gap met minTokens)",
          );
          break;
        }
      }

      if (highestBreakpointIdx >= 0) {
        config.onBreakpointsPlaced(highestBreakpointIdx);
        logger.debug(
          { highestBreakpointIdx, modelId: model.id },
          "Cache fence callback fired",
        );
      }
    }
  }

  // Fallback: when all breakpoint slots are consumed, still scan for SDK auto-marker
  // to set cache fence. The SDK always places a marker on the last user message.
  if (slotsAvailable <= 0 && config.onBreakpointsPlaced && Array.isArray(result.messages)) {
    let highestBreakpointIdx = -1;
    const fallbackMsgs = result.messages as Array<Record<string, unknown>>;
    for (let i = fallbackMsgs.length - 1; i >= 0; i--) {
      const content = fallbackMsgs[i]!.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.cache_control) {
            highestBreakpointIdx = i;
            break;
          }
        }
      }
      if (highestBreakpointIdx >= 0) break;
    }
    if (highestBreakpointIdx >= 0) {
      config.onBreakpointsPlaced(highestBreakpointIdx);
      logger.debug(
        { highestBreakpointIdx, modelId: model.id, source: "sdk-auto-marker" },
        "W12-FALLBACK: Cache fence set from SDK auto-marker (no explicit slots available)",
      );
    }
  }

  // Warn when cache fence remains unset in mature conversation.
  // This indicates no cache_control markers exist on any message -- neither explicit nor SDK auto.
  if (config.onBreakpointsPlaced && Array.isArray(result.messages) && (result.messages as unknown[]).length >= MATURE_CONVERSATION_MESSAGES) {
    const scanForFence = result.messages as Array<Record<string, unknown>>;
    let fenceFound = false;
    for (let i = scanForFence.length - 1; i >= 0; i--) {
      const content = scanForFence[i]!.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.cache_control) { fenceFound = true; break; }
        }
      }
      if (fenceFound) break;
    }
    if (!fenceFound) {
      logger.warn(
        {
          messageCount: (result.messages as unknown[]).length,
          modelId: model.id,
          hint: "No cache breakpoint found on any message in mature conversation. Cache fence is unset -- thinking block cleaner has no protection boundary.",
          errorKind: "internal" as const,
        },
        "Cache fence unset in mature session",
      );
    }
  }

  // Diagnostic WARN when breakpoint budget exhausted on mature conversation.
  if (slotsAvailable <= 0 && Array.isArray(result.messages) && (result.messages as unknown[]).length >= 20) {
    logger.warn(
      {
        existingCount,
        messageCount: (result.messages as unknown[]).length,
        modelId: model.id,
        hint: "Breakpoint budget exhausted before message breakpoints. System prompt may need consolidation or tool breakpoint reduction.",
        errorKind: "resource" as const,
      },
      "W7: Cache breakpoint budget exhausted -- no message breakpoints placed on mature conversation",
    );
  }

  // Safety-net sweep: enforce Anthropic's monotonic non-increasing TTL
  // invariant across tools->system->messages payload order. No-op when
  // layout is already monotonic; load-bearing defense even when the
  // anchor-aware retention above correctly coordinates the source placement.
  // Logs WARN with errorKind:"internal" if any upgrade fires — that
  // indicates an upstream placement bug.
  enforceMonotonicTtlOrdering(result, logger, supportsExtendedCacheTtl(model.provider));

  return resolvedRetention;
}
