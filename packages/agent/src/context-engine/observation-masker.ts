// SPDX-License-Identifier: Apache-2.0
/**
 * Observation masker context engine layer.
 *
 * Replaces old tool result content with lightweight placeholders when total
 * context exceeds a configurable character threshold. Uses a three-tier
 * masking system (protected/standard/ephemeral) with per-tier position
 * counters for correct interleaved masking behavior.
 *
 * Key behaviors:
 * - Unseen protection: tool results after the last assistant message are never
 *   masked, since the model has not yet had a chance to analyze them.
 * - Digest placeholders: masked tool results contain a digest extracted from
 *   the model's own following assistant response, giving useful context about
 *   what was cleared. Falls back to head/tail preview when no assistant follows.
 *
 * Persistent write-back: when a SessionManager getter is provided, masked
 * entries are mutated in `fileEntries` and `_rewriteFile()` is called to
 * persist the changes. This ensures subsequent turns load pre-masked history,
 * eliminating redundant re-processing and enabling stable prompt cache prefixes.
 *
 * - Three-tier system (protected/standard/ephemeral) replaces flat keep window
 * - Masking only triggers above configurable char threshold
 * - Per-tier position counters for correct interleaved masking
 * - Masked entries persistently written back via SessionManager
 * - Dual token estimation with 2x weighting for tool result chars
 * - Monotonic masking exempts protected-tier tools from force-masking
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextLayer, TokenBudget } from "./types.js";
import { resolveToolMaskingTier, EPHEMERAL_TOOL_KEEP_WINDOW, OBSERVATION_MASKING_DEACTIVATION_CHARS } from "./constants.js";
import { estimateContextCharsWithDualRatio } from "../safety/token-estimator.js";
import { getToolResultText, isAlreadyOffloaded, isAlreadyMasked } from "./cleanup-helpers.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the observation masker layer. */
export interface ObservationMaskerConfig {
  /** Number of most recent tool results to keep with full content (standard tier). */
  observationKeepWindow: number;
  /** Character threshold before observation masking activates. */
  observationTriggerChars: number;
  /** Character threshold below which observation masking deactivates (hysteresis). */
  observationDeactivationChars?: number;
  /** Keep window for ephemeral-tier tools. Default: EPHEMERAL_TOOL_KEEP_WINDOW (10). */
  ephemeralKeepWindow?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Maximum digest length extracted from assistant response. */
const MAX_DIGEST_CHARS = 800;

/** Maximum total chars for head/tail preview fallback. */
const MAX_PREVIEW_CHARS = 500;

/** Head portion of the preview (chars). */
const PREVIEW_HEAD_CHARS = 350;

/** Tail portion of the preview (chars). */
const PREVIEW_TAIL_CHARS = 150;

/**
 * Find the index of the last assistant message in the array.
 * Returns -1 if no assistant messages exist.
 */
function findLastAssistantIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return i; // eslint-disable-line security/detect-object-injection
  }
  return -1;
}

/**
 * Extract a digest string from an assistant message by concatenating
 * thinking and text blocks. Truncates to MAX_DIGEST_CHARS.
 */
function extractDigestFromAssistant(msg: AgentMessage): string {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const content = (msg as any).content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content.slice(0, MAX_DIGEST_CHARS) : "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    } else if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }

  const joined = parts.join("\n");
  if (joined.length <= MAX_DIGEST_CHARS) return joined;
  return joined.slice(0, MAX_DIGEST_CHARS) + "...";
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Find the digest for a tool result by looking for the next assistant message
 * after it (that the model has already seen, i.e. at or before lastAssistantIndex).
 *
 * Returns null if no suitable assistant message follows.
 */
function findDigestForToolResult(
  messages: AgentMessage[],
  toolResultIndex: number,
  lastAssistantIndex: number,
): string | null {
  for (let j = toolResultIndex + 1; j < messages.length && j <= lastAssistantIndex; j++) {
    if (messages[j]!.role === "assistant") { // eslint-disable-line security/detect-object-injection
      return extractDigestFromAssistant(messages[j]!); // eslint-disable-line security/detect-object-injection
    }
  }
  return null;
}

/**
 * Build a head/tail preview of original tool result text.
 * If text is short enough, returns it as-is.
 */
function buildHeadTailPreview(text: string, maxChars = MAX_PREVIEW_CHARS): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, PREVIEW_HEAD_CHARS);
  const tail = text.slice(-PREVIEW_TAIL_CHARS);
  return head + "\n...\n" + tail;
}

/** Build the placeholder text for a masked tool result with digest. */
function buildPlaceholder(toolName: string, originalChars: number, digestOrPreview: string): string {
  return `[Tool result summarized: ${toolName} \u2014 ${originalChars} chars cleared]\n${digestOrPreview}`;
}

/**
 * Create a new AgentMessage with masked content (immutable -- does not mutate input).
 */
function createMaskedMessage(original: AgentMessage, digestOrPreview: string): AgentMessage {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const o = original as any;
  const toolName = o.toolName ?? "unknown";
  const originalText = getToolResultText(original);
  const originalChars = originalText.length;
  const placeholder = buildPlaceholder(toolName, originalChars, digestOrPreview);

  // Build a shallow copy preserving all original fields except content
  const masked: Record<string, unknown> = {
    role: o.role,
    toolCallId: o.toolCallId,
    toolName: o.toolName,
    content: [{ type: "text", text: placeholder }],
    isError: o.isError,
  };

  // Preserve timestamp if present
  if (o.timestamp !== undefined) {
    masked.timestamp = o.timestamp;
  }

  return masked as unknown as AgentMessage;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Persist masked entries back to the SessionManager's fileEntries array.
 *
 * Finds entries in `fileEntries` matching the masked toolCallIds, mutates
 * their content in-place, and calls `_rewriteFile()` once after all mutations.
 *
 * This is safe because `transformContext` runs within the `withSession()` write lock.
 */
function persistMaskedEntries(
  sm: unknown,
  persistInfo: Map<string, { toolName: string; originalChars: number; digest: string }>,
): void {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sessionManager = sm as any;
  const fileEntries = sessionManager.fileEntries;
  if (!Array.isArray(fileEntries)) return;

  let anyMutated = false;
  for (const entry of fileEntries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult") continue;
    const info = persistInfo.get(msg.toolCallId);
    if (!info) continue;

    // Mutate in-place (safe within withSession write lock)
    msg.content = [{ type: "text", text: buildPlaceholder(info.toolName, info.originalChars, info.digest) }];
    anyMutated = true;
  }

  if (anyMutated && typeof sessionManager._rewriteFile === "function") {
    sessionManager._rewriteFile();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an observation masker context layer.
 *
 * @param config - Observation masking configuration (keep window, trigger threshold)
 * @param getSessionManager - Optional getter for SessionManager (enables persistent write-back)
 * @returns ContextLayer that masks old tool results with placeholders
 */
export function createObservationMaskerLayer(
  config: ObservationMaskerConfig,
  getSessionManager?: () => unknown,
  onMasked?: (stats: { maskedCount: number; totalChars: number; persistedToDisk: boolean }) => void,
): ContextLayer {
  // Stateful hysteresis -- persists across LLM calls within the same session
  let maskingActive = false;
  const everMaskedIds = new Set<string>();
  const deactivationThreshold = config.observationDeactivationChars ?? OBSERVATION_MASKING_DEACTIVATION_CHARS;

  return {
    name: "observation-masker",

    async apply(messages: AgentMessage[], budget: TokenBudget): Promise<AgentMessage[]> {
      // Threshold check -- skip masking for short sessions (zero overhead)
      // AgentMessage extends Message with custom message types; estimator only reads .role and .content
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const totalChars = estimateContextCharsWithDualRatio(messages as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */
      // Hysteresis band -- activate at trigger, deactivate at lower threshold
      if (maskingActive) {
        if (totalChars < deactivationThreshold) {
          maskingActive = false;
          return messages;
        }
        // Stay active, proceed with masking
      } else {
        if (totalChars < config.observationTriggerChars) {
          return messages;
        }
        maskingActive = true;
      }

      // Compute the last assistant message index for unseen protection
      const lastAssistantIdx = findLastAssistantIndex(messages);

      // Walk messages newest-to-oldest with per-tier counters
      let ephemeralCount = 0;
      let standardCount = 0;
      const ephemeralKeepWindow = config.ephemeralKeepWindow ?? EPHEMERAL_TOOL_KEEP_WINDOW;
      const maskIndices: number[] = [];
      const maskedToolCallIds = new Set<string>();
      // Map from index -> digestOrPreview string
      const digestMap = new Map<number, string>();
      // Map from toolCallId -> persist info for write-back
      const persistInfoMap = new Map<string, { toolName: string; originalChars: number; digest: string }>();

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!; // eslint-disable-line security/detect-object-injection
        if (msg.role !== "toolResult") continue;

        // Messages at or before the cache fence must not be masked.
        // Fence takes priority over everMaskedIds -- a previously-masked message
        // that is now in the fence zone must not be re-masked.
        // No tier counters incremented -- fenced messages are invisible to the window.
        if (i <= budget.cacheFenceIndex) {
          continue;
        }

        // Unseen protection: tool results after the last assistant message
        // have never been analyzed by the model -- skip masking.
        // If lastAssistantIdx is -1 (no assistant messages), protect everything.
        if (lastAssistantIdx < 0 || i > lastAssistantIdx) {
          continue;
        }

        /* eslint-disable @typescript-eslint/no-explicit-any */
        const toolName = (msg as any).toolName ?? "";
        const toolCallId = (msg as any).toolCallId ?? "";
        /* eslint-enable @typescript-eslint/no-explicit-any */

        const tier = resolveToolMaskingTier(toolName);

        // Monotonic masking -- once masked in this session, always re-mask
        // EXCEPTION: Protected tier tools are NEVER masked regardless of everMaskedIds
        if (everMaskedIds.has(toolCallId)) {
          if (tier === "protected") {
            // Protected tools exempt from monotonic masking -- NEVER mask
            continue;
          }
          // Non-protected: force mask as before
          if (!isAlreadyMasked(msg) && !isAlreadyOffloaded(msg)) {
            const originalText = getToolResultText(msg);
            const digest = findDigestForToolResult(messages, i, lastAssistantIdx);
            const preview = digest ?? buildHeadTailPreview(originalText);
            digestMap.set(i, preview);
            persistInfoMap.set(toolCallId, { toolName: toolName || "unknown", originalChars: originalText.length, digest: preview });
            maskIndices.push(i);
            maskedToolCallIds.add(toolCallId);
          }
          if (tier === "ephemeral") ephemeralCount++;
          else standardCount++;
          continue;
        }

        // Protected: ALWAYS keep, never count toward any window
        if (tier === "protected") {
          continue;
        }

        // Tier-specific window check
        const count = tier === "ephemeral" ? ephemeralCount : standardCount;
        const window = tier === "ephemeral" ? ephemeralKeepWindow : config.observationKeepWindow;

        if (count < window) {
          // Within this tier's keep window -- KEEP
          if (tier === "ephemeral") ephemeralCount++;
          else standardCount++;
          continue;
        }

        // (c) Already offloaded by microcompaction: SKIP
        if (isAlreadyOffloaded(msg)) {
          if (tier === "ephemeral") ephemeralCount++;
          else standardCount++;
          continue;
        }

        // (d) Already masked: SKIP (no double-masking)
        if (isAlreadyMasked(msg)) {
          if (tier === "ephemeral") ephemeralCount++;
          else standardCount++;
          continue;
        }

        // (e) MASK this tool result -- compute digest
        const originalText = getToolResultText(msg);
        const digest = findDigestForToolResult(messages, i, lastAssistantIdx);
        const preview = digest ?? buildHeadTailPreview(originalText);
        digestMap.set(i, preview);
        persistInfoMap.set(toolCallId, { toolName: toolName || "unknown", originalChars: originalText.length, digest: preview });

        maskIndices.push(i);
        maskedToolCallIds.add(toolCallId);
        everMaskedIds.add(toolCallId);
        if (tier === "ephemeral") ephemeralCount++;
        else standardCount++;
      }

      // If nothing to mask, return unchanged
      if (maskIndices.length === 0) {
        return messages;
      }

      // Persistent write-back (runs in both modes -- session reloads need masked JSONL)
      const persistedToDisk = !!getSessionManager;
      if (getSessionManager) {
        try {
          const sm = getSessionManager();
          if (sm) {
            persistMaskedEntries(sm, persistInfoMap);
          }
        } catch {
          // Persistent write-back is best-effort -- masking still applies in-memory
        }
      }

      // Report masking stats via callback
      onMasked?.({ maskedCount: maskIndices.length, totalChars, persistedToDisk });

      // Build new message array with masked results (immutable -- never mutate input)
      const maskSet = new Set(maskIndices);
      const result: AgentMessage[] = new Array(messages.length);
      /* eslint-disable security/detect-object-injection -- array index access */
      for (let i = 0; i < messages.length; i++) {
        if (maskSet.has(i)) {
          result[i] = createMaskedMessage(messages[i]!, digestMap.get(i) ?? "");
        } else {
          result[i] = messages[i]!;
        }
      }
      /* eslint-enable security/detect-object-injection */

      return result;
    },
  };
}
