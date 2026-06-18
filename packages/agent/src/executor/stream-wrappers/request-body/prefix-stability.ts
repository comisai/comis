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

/** Role + FULL content of a single message, for hashing/diffing (catches byte mutations
 *  anywhere in the body, incl. tool_result/tool_use, that a short sample would miss). */
function messageSignature(m: Record<string, unknown>): string {
  const c = m.content;
  const text = typeof c === "string" ? c :
    Array.isArray(c) ? (c as Array<Record<string, unknown>>).map(b =>
      `${(b as any).type}:${String((b as any).text ?? (b as any).thinking ?? "")}:${JSON.stringify((b as any).content ?? (b as any).input ?? "")}`
    ).join("|") : "";
  return `${m.role}:${text}`;
}

/** Per-message hashes for the prefix [0..endIdx] — lets the diagnostic name the FIRST divergent message. */
function hashEachMessage(messages: Array<Record<string, unknown>>, endIdx: number): number[] {
  return messages.slice(0, endIdx + 1).map(m => computeHash([messageSignature(m)]));
}

/**
 * Redaction-safe STRUCTURAL signature of a message: role + block count + thinking-block
 * count + total content length. Carries NO message text — only shape/size — so it is safe
 * to log, yet reveals what changed (e.g. a cleared thinking block → t-count drops; an
 * offloaded tool_result → length drops). Format: `<role>|b<blocks>|t<thinking>|len<chars>`.
 */
function messageStructSig(m: Record<string, unknown>): string {
  const c = m.content;
  let blocks = 1, thinking = 0, len = 0;
  if (typeof c === "string") {
    len = c.length;
  } else if (Array.isArray(c)) {
    const arr = c as Array<Record<string, unknown>>;
    blocks = arr.length;
    for (const b of arr) {
      if (b.type === "thinking") thinking++;
      len += String(b.text ?? b.thinking ?? b.content ?? "").length;
    }
  }
  return `${m.role}|b${blocks}|t${thinking}|len${len}`;
}

/** Per-message structural sigs for the prefix [0..endIdx]. */
function structEachMessage(messages: Array<Record<string, unknown>>, endIdx: number): string[] {
  return messages.slice(0, endIdx + 1).map(messageStructSig);
}

/** Parse the `t<n>`/`len<n>` fields out of a struct sig (returns {t,len} or undefined). */
function parseSig(sig: string | undefined): { t: number; len: number } | undefined {
  if (!sig) return undefined;
  const t = /\|t(\d+)\|/.exec(sig); const len = /\|len(\d+)$/.exec(sig);
  return { t: t ? Number(t[1]) : 0, len: len ? Number(len[1]) : 0 };
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
function classifyPrefixMutation(
  msg: Record<string, unknown> | undefined,
  prevSig?: string,
  currSig?: string,
): string {
  if (!msg) return "unknown";
  const classes: string[] = [];

  // Structural delta first (the cause C-FIX-3's content-pattern classifier missed):
  // a thinking block disappearing or content shrinking between turns means microcompaction
  // (clearStaleThinkingBlocks / clearStaleToolResults) mutated a CACHED message.
  const p = parseSig(prevSig); const c = parseSig(currSig);
  if (p && c) {
    if (p.t > c.t) classes.push("thinking-cleared");
    else if (p.len - c.len > 500) classes.push("content-cleared");
  }

  // Content-pattern classes (per-request-varying injected content).
  const sig = messageSignature(msg);
  if (/\[Relevant context from memory:/.test(sig)) classes.push("inline-recall");
  if (/## Current Date & Time/.test(sig)) classes.push("datetime-preamble");
  if (classes.length === 0 && Array.isArray(msg.content) &&
      (msg.content as Array<Record<string, unknown>>).some(b => b.type === "thinking")) {
    classes.push("thinking-block");
  }
  return classes.length > 0 ? classes.join(",") : "unknown";
}

/**
 * Hash role + first 200 chars of content for messages up to endIdx (inclusive).
 */
function hashMessageSlice(messages: Array<Record<string, unknown>>, endIdx: number): number {
  return computeHash(messages.slice(0, endIdx + 1).map(messageSignature));
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
  const msgSigs = structEachMessage(msgs, diagFenceIdx);
  const prev = sessionPrefixStability.get(config.sessionKey);

  if (!prev) {
    // First observation -- store baseline, no comparison needed
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0, msgHashes, msgSigs });
    return;
  }

  if (diagFenceIdx < prev.fenceIdx) {
    // Case C: Fence shrank (compaction reset) -- reset counter entirely
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0, msgHashes, msgSigs });
    return;
  }

  if (diagFenceIdx > prev.fenceIdx) {
    // Case A: Fence grew (normal conversation growth).
    // Re-hash using the old fence boundary to check if old prefix content is intact.
    const oldRangeHash = hashMessageSlice(msgs, prev.fenceIdx);
    if (oldRangeHash === prev.hash) {
      // Old prefix content unchanged -- benign growth, reset counter
      sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0, msgHashes, msgSigs });
    } else {
      // Old prefix content was mutated -- genuine instability
      const changes = prev.consecutiveChanges + 1;
      sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: changes, msgHashes, msgSigs });
      if (changes >= 3) emitUnstableWarn(logger, config.sessionKey, changes, msgs, prev.msgHashes, msgHashes, prev.msgSigs, msgSigs);
    }
    return;
  }

  // Case B: Same fence position -- direct hash comparison
  if (prev.hash !== prefixHash) {
    const changes = prev.consecutiveChanges + 1;
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: changes, msgHashes, msgSigs });
    if (changes >= 3) emitUnstableWarn(logger, config.sessionKey, changes, msgs, prev.msgHashes, msgHashes, prev.msgSigs, msgSigs);
  } else {
    // Prefix stable -- reset counter
    sessionPrefixStability.set(config.sessionKey, { hash: prefixHash, fenceIdx: diagFenceIdx, consecutiveChanges: 0, msgHashes, msgSigs });
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
  prevMsgSigs: string[] | undefined,
  currMsgSigs: string[],
): void {
  const firstDivergentIndex = firstDivergentMessage(prevMsgHashes, currMsgHashes);
  const prevSig = firstDivergentIndex >= 0 ? prevMsgSigs?.[firstDivergentIndex] : undefined;
  const currSig = firstDivergentIndex >= 0 ? currMsgSigs[firstDivergentIndex] : undefined;
  const mutationClass = firstDivergentIndex >= 0
    ? classifyPrefixMutation(msgs[firstDivergentIndex], prevSig, currSig)
    : "unknown";
  logger.warn(
    {
      sessionKey,
      consecutiveChanges: changes,
      firstDivergentIndex,
      mutationClass,
      // Redaction-safe structural sigs (counts + length only, NO message text) so an
      // operator sees exactly what changed at the divergent message without ad-hoc logging.
      prevSig,
      currSig,
      hint: `Cache prefix changing every turn — first divergent message #${firstDivergentIndex} [${mutationClass}] mutated ${prevSig ?? "?"} → ${currSig ?? "?"}; this per-request-varying/cleared content must stay OUT of the cached prefix (see C-FIX-3). Cache writes are wasted.`,
      errorKind: "internal" as const,
    },
    "Unstable prefix detected",
  );
}
