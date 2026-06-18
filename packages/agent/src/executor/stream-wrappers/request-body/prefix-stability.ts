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

/** Role + first 200 chars of a single message's content, for hashing/diffing. */
function messageSignature(m: Record<string, unknown>): string {
  const c = m.content;
  const text = typeof c === "string" ? c.slice(0, 200) :
    Array.isArray(c) ? (c as Array<Record<string, unknown>>).map(b => String(b.text ?? b.type ?? "")).join("").slice(0, 200) : "";
  return `${m.role}:${text}`;
}

/** Per-message hashes for the prefix [0..endIdx] — lets the diagnostic name the FIRST divergent message. */
function hashEachMessage(messages: Array<Record<string, unknown>>, endIdx: number): number[] {
  return messages.slice(0, endIdx + 1).map(m => computeHash([messageSignature(m)]));
}

/**
 * Index of the first message whose hash diverges from the previous turn, or -1
 * if no per-message divergence is found (e.g. a length change only).
 */
function firstDivergentMessage(prev: number[] | undefined, curr: number[]): number {
  if (!prev) return -1;
  const n = Math.min(prev.length, curr.length);
  for (let i = 0; i < n; i++) if (prev[i] !== curr[i]) return i;
  return prev.length === curr.length ? -1 : n; // diverged by length past the common range
}

/**
 * Classify the cache-poison content carried by a divergent prefix message —
 * the known per-request-varying classes that destabilize the cached prefix.
 * Productizes the ad-hoc PREFIXDBG instrumentation used to root-cause C-FIX-3:
 * the next prefix-instability incident is diagnosable from this one WARN line.
 */
function classifyPrefixMutation(msg: Record<string, unknown> | undefined): string {
  if (!msg) return "unknown";
  const sig = messageSignature(msg);
  const classes: string[] = [];
  if (/\[Relevant context from memory:/.test(sig)) classes.push("inline-recall");
  if (/## Current Date & Time/.test(sig)) classes.push("datetime-preamble");
  if (Array.isArray(msg.content) &&
      (msg.content as Array<Record<string, unknown>>).some(b => b.type === "thinking")) {
    classes.push("thinking-block");
  }
  return classes.length > 0 ? classes.join(",") : "unknown";
}

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
  const msgHashes = hashEachMessage(msgs, diagFenceIdx);
  const prev = sessionPrefixStability.get(config.sessionKey);

  if (!prev) {
    // First observation -- store baseline, no comparison needed
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0, msgHashes });
    return;
  }

  if (diagFenceIdx < prev.fenceIdx) {
    // Case C: Fence shrank (compaction reset) -- reset counter entirely
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0, msgHashes });
    return;
  }

  if (diagFenceIdx > prev.fenceIdx) {
    // Case A: Fence grew (normal conversation growth).
    // Re-hash using the old fence boundary to check if old prefix content is intact.
    const oldRangeHash = hashMessageSlice(msgs, prev.fenceIdx);
    if (oldRangeHash === prev.hash) {
      // Old prefix content unchanged -- benign growth, reset counter
      sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0, msgHashes });
    } else {
      // Old prefix content was mutated -- genuine instability
      const changes = prev.consecutiveChanges + 1;
      sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: changes, msgHashes });
      if (changes >= 3) emitUnstableWarn(logger, config.sessionKey, changes, msgs, prev.msgHashes, msgHashes);
    }
    return;
  }

  // Case B: Same fence position -- direct hash comparison
  if (prev.hash !== prefixHash) {
    const changes = prev.consecutiveChanges + 1;
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: changes, msgHashes });
    if (changes >= 3) emitUnstableWarn(logger, config.sessionKey, changes, msgs, prev.msgHashes, msgHashes);
  } else {
    // Prefix stable -- reset counter
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0, msgHashes });
  }
}

/**
 * Emit the "Unstable prefix detected" WARN, naming the FIRST divergent prefix
 * message and its cache-poison class. This is the productized PREFIXDBG: an
 * operator reading this one line knows WHICH message mutated and WHY (inline-recall
 * / datetime-preamble / thinking-block), instead of re-deriving it with ad-hoc logging.
 */
function emitUnstableWarn(
  logger: ComisLogger,
  sessionKey: string,
  changes: number,
  msgs: Array<Record<string, unknown>>,
  prevMsgHashes: number[] | undefined,
  currMsgHashes: number[],
): void {
  const firstDivergentIndex = firstDivergentMessage(prevMsgHashes, currMsgHashes);
  const mutationClass = firstDivergentIndex >= 0
    ? classifyPrefixMutation(msgs[firstDivergentIndex])
    : "unknown";
  logger.warn(
    {
      sessionKey,
      consecutiveChanges: changes,
      firstDivergentIndex,
      mutationClass,
      hint: `Cache prefix changing every turn — first divergent message #${firstDivergentIndex} carries [${mutationClass}]; this per-request-varying content must stay OUT of the cached prefix (see C-FIX-3). Cache writes are wasted.`,
      errorKind: "internal" as const,
    },
    "Unstable prefix detected",
  );
}
