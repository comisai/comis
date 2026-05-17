// SPDX-License-Identifier: Apache-2.0
/**
 * Prefix-stability diagnostic.
 *
 * Detects when microcompaction changes the cache-fenced prefix between turns,
 * which indicates permanent cache collapse. Warns at WARN level when the
 * cache prefix changes on 3+ consecutive turns.
 *
 * Fence-index-aware:
 *  - Case A (fence grew): normal conversation growth. Hash the old fence
 *    boundary to check whether the old prefix content is intact; reset
 *    the counter if so, otherwise mark a change.
 *  - Case B (fence unchanged): direct hash comparison; counter increments
 *    on change.
 *  - Case C (fence shrank): compaction reset -- reset the counter.
 *
 * Skips detection when no fence is set yet (early bootstrap /
 * non-Anthropic provider).
 *
 * @module
 */

import type { ComisLogger } from "@comis/core";

import { computeHash } from "../../cache-detection/index.js";
import { sessionPrefixStability } from "./cache-breakpoints.js";
import type { RequestBodyInjectorConfig } from "./types.js";

/**
 * Hash role + first 200 chars of content for messages up to endIdx (inclusive).
 */
function hashMessageSlice(messages: Array<Record<string, unknown>>, endIdx: number): number {
  const slice = messages.slice(0, endIdx + 1);
  return computeHash(slice.map(m => {
    const c = m.content;
    const text = typeof c === "string" ? c.slice(0, 200) :
      Array.isArray(c) ? (c as Array<Record<string, unknown>>).map(b => String(b.text ?? b.type ?? "")).join("").slice(0, 200) : "";
    return `${m.role}:${text}`;
  }));
}

/**
 * Run the prefix-stability diagnostic. Mutates the module-level
 * `sessionPrefixStability` map. Logs a WARN when 3+ consecutive changes
 * are observed against the same fence position.
 */
export function runPrefixStabilityDiagnostic(
  result: Record<string, unknown>,
  config: RequestBodyInjectorConfig,
  logger: ComisLogger,
): void {
  if (!config.sessionKey || !Array.isArray(result.messages)) return;
  const diagFenceIdx = config.getCacheFenceIndex?.() ?? -1;
  if (diagFenceIdx < 0) return;

  const msgs = result.messages as Array<Record<string, unknown>>;
  const prefixHash = hashMessageSlice(msgs, diagFenceIdx);
  const prev = sessionPrefixStability.get(config.sessionKey);

  if (!prev) {
    // First observation -- store baseline, no comparison needed
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0 });
    return;
  }

  if (diagFenceIdx < prev.fenceIdx) {
    // Case C: Fence shrank (compaction reset) -- reset counter entirely
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0 });
    return;
  }

  if (diagFenceIdx > prev.fenceIdx) {
    // Case A: Fence grew (normal conversation growth).
    // Re-hash using the old fence boundary to check if old prefix content is intact.
    const oldRangeHash = hashMessageSlice(msgs, prev.fenceIdx);
    if (oldRangeHash === prev.hash) {
      // Old prefix content unchanged -- benign growth, reset counter
      sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0 });
    } else {
      // Old prefix content was mutated -- genuine instability
      const changes = prev.consecutiveChanges + 1;
      sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: changes });
      if (changes >= 3) {
        logger.warn(
          {
            sessionKey: config.sessionKey,
            consecutiveChanges: changes,
            hint: "Cache prefix changing every turn — microcompaction or content modification destabilizing the prefix. Cache writes are wasted.",
            errorKind: "internal" as const,
          },
          "Unstable prefix detected",
        );
      }
    }
    return;
  }

  // Case B: Same fence position -- direct hash comparison
  if (prev.hash !== prefixHash) {
    const changes = prev.consecutiveChanges + 1;
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: changes });
    if (changes >= 3) {
      logger.warn(
        {
          sessionKey: config.sessionKey,
          consecutiveChanges: changes,
          hint: "Cache prefix changing every turn — microcompaction or content modification destabilizing the prefix. Cache writes are wasted.",
          errorKind: "internal" as const,
        },
        "Unstable prefix detected",
      );
    }
  } else {
    // Prefix stable -- reset counter
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0 });
  }
}
