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
      `${String(b.type)}:${String(b.text ?? b.thinking ?? "")}:${JSON.stringify(b.content ?? b.input ?? "")}`
    ).join("|") : "";
  return `${m.role}:${text}`;
}

/** Per-message hashes for the prefix [0..endIdx] — lets the diagnostic name the FIRST divergent message. */
function hashEachMessage(messages: Array<Record<string, unknown>>, endIdx: number): number[] {
  return messages.slice(0, endIdx + 1).map(m => computeHash([messageSignature(m)]));
}

/**
 * Redaction-safe STRUCTURAL signature of a message: role + block count + thinking-block
 * count + a had-inline-recall bit + total content length. Carries NO message text — only
 * shape/size/flags — so it is safe to log, yet reveals what changed (a cleared thinking
 * block → t drops; an offloaded tool_result → len drops; a stripped inline-recall block →
 * r drops 1→0). Format: `<role>|b<blocks>|t<thinking>|r<0|1>|len<chars>`.
 */
function messageStructSig(m: Record<string, unknown>): string {
  const c = m.content;
  let blocks = 1, thinking = 0, len = 0, hadRecall = 0;
  const RECALL_RE = /\[Relevant context from memory:/;
  if (typeof c === "string") {
    len = c.length;
    if (RECALL_RE.test(c)) hadRecall = 1;
  } else if (Array.isArray(c)) {
    const arr = c as Array<Record<string, unknown>>;
    blocks = arr.length;
    for (const b of arr) {
      if (b.type === "thinking") thinking++;
      const text = String(b.text ?? b.thinking ?? b.content ?? "");
      len += text.length;
      if (RECALL_RE.test(text)) hadRecall = 1;
    }
  }
  return `${m.role}|b${blocks}|t${thinking}|r${hadRecall}|len${len}`;
}

/** Per-message structural sigs for the prefix [0..endIdx]. */
function structEachMessage(messages: Array<Record<string, unknown>>, endIdx: number): string[] {
  return messages.slice(0, endIdx + 1).map(messageStructSig);
}

/** Parse the `t<n>`/`r<n>`/`len<n>` fields out of a struct sig (returns {t,r,len} or undefined). */
function parseSig(sig: string | undefined): { t: number; r: number; len: number } | undefined {
  if (!sig) return undefined;
  const t = /\|t(\d+)\|/.exec(sig); const r = /\|r(\d+)\|/.exec(sig); const len = /\|len(\d+)$/.exec(sig);
  return { t: t ? Number(t[1]) : 0, r: r ? Number(r[1]) : 0, len: len ? Number(len[1]) : 0 };
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
 * Productizes the ad-hoc instrumentation used to root-cause a live
 * prefix-instability incident: the next one is diagnosable from this one WARN line.
 */
export function classifyPrefixMutation(
  msg: Record<string, unknown> | undefined,
  prevSig?: string,
  currSig?: string,
): string {
  if (!msg) return "unknown";
  const classes: string[] = [];

  // Role change FIRST — the dominant, non-benign signal. When the message at a
  // cached index changed ROLE between turns (e.g. assistant tool-use → user
  // turn), the message is a DIFFERENT message, not an in-place edit: a
  // STRUCTURAL index-shift (LCD condense/re-admit or history restructure shifted
  // everything below the fence). It must be detected before the content-pattern
  // classifier, because a shifted-in user turn carries the dynamic preamble
  // (which holds `## Current Date & Time`) and would otherwise be mislabeled
  // "datetime-preamble" — the misleading label that sent the comis-harel
  // investigation the wrong way (the datetime is already relocated below the
  // fence; the real cost is the index shift, not the timestamp).
  const prevRole = prevSig ? prevSig.split("|")[0] : undefined;
  const currRole = currSig ? currSig.split("|")[0] : undefined;
  const roleChanged = !!prevRole && !!currRole && prevRole !== currRole;
  if (roleChanged) classes.push("structural-shift");

  // Structural delta next (a cause a content-pattern-only classifier misses):
  // a thinking block disappearing or content shrinking between turns means microcompaction
  // (clearStaleThinkingBlocks / clearStaleToolResults) mutated a CACHED message.
  const p = parseSig(prevSig); const c = parseSig(currSig);
  if (p && c) {
    // r1→r0 = the inline-recall block was stripped as a user message went historical
    // — a one-time transient-by-design transition, benign ONLY when it is NOT
    // also a structural shift (a role change is never benign).
    if (!roleChanged && p.r > c.r) return "inline-recall";
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
 * Run the prefix-stability diagnostic. Mutates the module-level
 * `sessionPrefixStability` map. Logs a WARN when a cached-region message mutates on
 * THRESHOLD+ calls within a recent WINDOW — catching both a persistent same-message
 * mutation and a once-per-turn mutation at a different message each turn (the
 * replay-thinking incident shape), across the FULL cached prefix (not just the
 * previous fence region).
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
  const lastIdx = msgs.length - 1;
  // FULL-array per-message hashes/sigs (NOT fence-limited). A check that only
  // re-verifies [0..prev.fence] is blind to a mutation in the newly-promoted
  // (prev.fence, fence] region — exactly where the replay-thinking strip transition lives.
  const fullHashes = hashEachMessage(msgs, lastIdx);
  const fullSigs = structEachMessage(msgs, lastIdx);
  const prev = sessionPrefixStability.get(config.sessionKey);
  const callCount = (prev?.callCount ?? 0) + 1;

  // Accumulate cached-region mutations over a WINDOW of recent calls rather than
  // CONSECUTIVE calls. The replay-thinking incident mutated a DIFFERENT historical assistant
  // at each turn boundary while within-turn calls were clean; a consecutive counter resets on
  // every benign within-turn call, so a once-per-turn mutation never reaches its threshold.
  const WINDOW = 10;
  const THRESHOLD = 3;

  if (!prev || diagFenceIdx < prev.fenceIdx) {
    // First observation, or fence shrank (compaction) — (re)baseline, empty mutation window.
    sessionPrefixStability.set(config.sessionKey, { hash: 0, fenceIdx: diagFenceIdx, consecutiveChanges: 0, fullHashes, fullSigs, callCount, cacheMutations: [] });
    return;
  }

  // First message that DIFFERS from the previous request across the FULL common prefix.
  const fd = firstDivergentMessage(prev.fullHashes, fullHashes);
  let mutations = (prev.cacheMutations ?? []).filter(c => c > callCount - WINDOW);

  // A divergence at/below the fence is a mutation of content we are trying to CACHE — a
  // wasted cache write. (A divergence ABOVE the fence is just new tail content = benign growth.)
  if (fd >= 0 && fd <= diagFenceIdx) {
    const pSig = prev.fullSigs?.[fd];
    const cSig = fullSigs[fd];
    const mutationClass = classifyPrefixMutation(msgs[fd], pSig, cSig);
    // inline-recall is transient BY DESIGN — the history strip removes it from a user message
    // the turn AFTER it carried the current turn's recall. That is a one-time transition per message,
    // not a recurring bug, so it must NOT accumulate toward the WARN — UNLESS it is also a
    // structural-shift (a role change is a real cache invalidation, never benign).
    const benignInlineRecall = mutationClass.includes("inline-recall") && !mutationClass.includes("structural-shift");
    if (!benignInlineRecall) {
      mutations = [...mutations, callCount];
      if (mutations.length >= THRESHOLD) {
        emitUnstableWarn(logger, config.sessionKey, mutations.length, WINDOW, fd, pSig, cSig, mutationClass);
        // Surface the churn to the system health view (content-free) so a recurring
        // cache-prefix collapse is a `comis system-health` finding, not a log-only WARN.
        config.onPrefixUnstable?.({
          sessionKey: config.sessionKey,
          firstDivergentIndex: fd,
          cacheRegionMutations: mutations.length,
          mutationClass,
        });
      }
    }
  }

  sessionPrefixStability.set(config.sessionKey, {
    hash: 0,
    fenceIdx: diagFenceIdx,
    consecutiveChanges: mutations.length,
    fullHashes,
    fullSigs,
    callCount,
    cacheMutations: mutations,
  });
}

/**
 * Emit the "Unstable prefix detected" WARN, naming the divergent prefix message and its
 * cache-poison class. An operator reading this one line knows WHICH
 * message mutated and WHY (inline-recall / datetime-preamble / thinking-block / content-cleared),
 * instead of re-deriving it with ad-hoc logging. Fires on a windowed count of cached-region
 * mutations (not consecutive), so a ONCE-PER-TURN mutation at a different message each turn
 * accumulates here instead of slipping past a consecutive counter.
 */
function emitUnstableWarn(
  logger: ComisLogger,
  sessionKey: string,
  mutationCount: number,
  window: number,
  firstDivergentIndex: number,
  prevSig: string | undefined,
  currSig: string | undefined,
  mutationClass: string,
): void {
  logger.warn(
    {
      sessionKey,
      cacheRegionMutations: mutationCount,
      window,
      firstDivergentIndex,
      mutationClass,
      // Redaction-safe structural sigs (counts + length only, NO message text) so an
      // operator sees exactly what changed at the divergent message without ad-hoc logging.
      prevSig,
      currSig,
      hint: `Cached-prefix content mutated at message #${firstDivergentIndex} [${mutationClass}] (${mutationCount} cached-region mutations in the last ${window} calls): ${prevSig ?? "?"} → ${currSig ?? "?"}. Already-sent content inside the cache fence must be byte-stable — re-sending it changed wastes the cache write (see stripReplayThinking). A once-per-turn mutation at a DIFFERENT message each turn still accumulates here.`,
      errorKind: "internal" as const,
    },
    "Unstable prefix detected",
  );
}
