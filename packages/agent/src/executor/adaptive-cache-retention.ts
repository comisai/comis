/**
 * Adaptive cache retention strategy for Anthropic cache breakpoints.
 *
 * Starts with "short" (5m) TTL on cold-start to minimize write costs,
 * then escalates to "long" (1h) after observing sufficient cache reads
 * (indicating the cache is being utilized and worth investing in).
 *
 * @module
 */

import type { CacheRetention } from "@mariozechner/pi-ai";

/** Cache write token threshold for fast-path escalation.
 *  When the first turn writes >20K tokens, promote to "long" immediately
 *  on turn 2 instead of waiting for the standard 3-turn threshold.
 *  20K tokens = ~70K chars = typical large system prompt + tools. */
export const FAST_PATH_CACHE_WRITE_THRESHOLD = 20_000;

export interface AdaptiveCacheRetentionConfig {
  /** Retention for first call (cold cache). Default: "short" */
  coldStartRetention: CacheRetention;
  /** Retention after cache reads confirmed. Default: "long" */
  warmRetention: CacheRetention;
  /** Minimum cumulative cacheRead tokens before escalating. Default: 1000 */
  escalationThreshold: number;
  /** Called once when retention escalates from cold to warm. */
  onEscalated?: () => void;
  /** Design 2.4: Escalation mode -- "turns" requires N turns before promoting, "tokens" uses cumulative cache reads. Default: "turns". */
  escalationMode?: "tokens" | "turns";
  /** Design 2.4: Minimum turns before escalation when escalationMode is "turns". Default: 3. */
  escalationTurnThreshold?: number;
}

/** Threshold for consecutive baseline-only cache reads
 *  before forcing retention downgrade. When cacheRead is stuck at system-prompt
 *  baseline for this many turns, the prefix is unstable and 1h writes are wasted. */
export const PREFIX_INSTABILITY_THRESHOLD = 5;

export interface AdaptiveCacheRetention {
  /** Get current effective retention for tool/system prompt breakpoints. */
  getRetention(): CacheRetention;
  /** Record cache reads from a turn_end event. Escalates when threshold met. */
  recordCacheReads(tokens: number): void;
  /** Returns zone-aware retention -- "long" after escalation, "short" before.
   *  placeCacheBreakpoints applies per-zone distinction (recent zone always "short"). */
  getMessageRetention(): CacheRetention;
  /** Whether escalation from cold-start to warm retention has occurred. */
  hasEscalated(): boolean;
  /** Reset to cold-start state. Called by TTL guard when cache expires. */
  reset(): void;
  /** Set cost gate state. When false, escalation requires
   *  escalationTurnThreshold + 2 turns. The fast-path is exempt. */
  setCostGateOpen(open: boolean): void;
  /** Design 2.4: Record a completed turn for turn-count-based escalation. */
  recordTurn(): void;
  /** Record a completed turn with its cache write token count.
   *  Fast-path: if first turn wrote >FAST_PATH_CACHE_WRITE_THRESHOLD tokens,
   *  escalate on turn 2 (large system prompts benefit from 1h TTL immediately). */
  recordTurnWithCacheWrite(cacheWriteTokens: number): void;
  /** Record observed cache reads for prefix instability detection.
   *  When cacheRead is at/below the baseline for PREFIX_INSTABILITY_THRESHOLD
   *  consecutive turns, forces retention back to cold-start to reduce write costs.
   *  @param cacheReadTokens - Cache read tokens from the current turn
   *  @param baselineTokens - System prompt baseline (stable cached prefix size)
   *  @returns true if retention was forced to "short" due to instability */
  recordCacheReadForStability(cacheReadTokens: number, baselineTokens: number): boolean;
}

export function createAdaptiveCacheRetention(
  config: AdaptiveCacheRetentionConfig,
): AdaptiveCacheRetention {
  const mode = config.escalationMode ?? "turns";   // Design 2.4: default to turn-based
  const turnThreshold = config.escalationTurnThreshold ?? 3;  // Design 2.4: require 3+ turns

  let totalCacheReads = 0;
  let turnCount = 0;
  let lastCacheWriteTokens = 0;
  let currentRetention = config.coldStartRetention;
  let escalated = false;
  let costGateOpen = true; // default open (no extra turns needed)
  let consecutiveBaselineReads = 0; // prefix instability counter
  let prefixInstabilityActive = false; // forced "short" state

  function tryEscalate(): void {
    if (escalated || currentRetention === config.warmRetention) return;

    if (mode === "tokens") {
      // Legacy mode: escalate based on cumulative cache reads only
      if (totalCacheReads >= config.escalationThreshold) {
        currentRetention = config.warmRetention;
        escalated = true;
        config.onEscalated?.();
      }
    } else {
      // Fast-path -- large first-turn cache write means big system prompt.
      // Escalate on turn 2 instead of waiting for turnThreshold (3).
      if (turnCount >= 2 && lastCacheWriteTokens > FAST_PATH_CACHE_WRITE_THRESHOLD && totalCacheReads > 0) {
        currentRetention = config.warmRetention;
        escalated = true;
        config.onEscalated?.();
        return;
      }
      // Standard path: require N turns (+2 when gate closed)
      const effectiveThreshold = costGateOpen ? turnThreshold : turnThreshold + 2;
      if (turnCount >= effectiveThreshold && totalCacheReads > 0) {
        currentRetention = config.warmRetention;
        escalated = true;
        config.onEscalated?.();
      }
    }
  }

  return {
    getRetention(): CacheRetention {
      // Override to "short" when prefix instability is detected
      if (prefixInstabilityActive) return config.coldStartRetention;
      return currentRetention;
    },
    recordCacheReads(tokens: number): void {
      totalCacheReads += tokens;
      tryEscalate();
    },
    recordTurn(): void {
      turnCount++;
      tryEscalate();
    },
    recordTurnWithCacheWrite(cacheWriteTokens: number): void {
      if (turnCount === 0) {
        // Capture first turn's cache write for fast-path evaluation on turn 2
        lastCacheWriteTokens = cacheWriteTokens;
      }
      turnCount++;
      tryEscalate();
    },
    getMessageRetention(): CacheRetention {
      // After escalation, semi-stable/mid zones deserve 1h TTL.
      // placeCacheBreakpoints handles zone-level distinction (recent stays "short").
      return escalated ? currentRetention : config.coldStartRetention;
    },
    hasEscalated(): boolean {
      return escalated;
    },
    reset(): void {
      totalCacheReads = 0;
      turnCount = 0;
      lastCacheWriteTokens = 0;
      currentRetention = config.coldStartRetention;
      escalated = false;
      costGateOpen = true; // reset to default open
      consecutiveBaselineReads = 0; // reset instability counter
      prefixInstabilityActive = false; // clear forced "short"
    },
    setCostGateOpen(open: boolean): void {
      costGateOpen = open;
    },
    recordCacheReadForStability(cacheReadTokens: number, baselineTokens: number): boolean {
      // Detect prefix instability — cacheRead stuck at system-prompt baseline.
      // "baseline" means reads are <= 110% of the system prompt size (only the prefix is cached).
      const isBaseline = cacheReadTokens <= baselineTokens * 1.1;
      if (isBaseline && escalated) {
        consecutiveBaselineReads++;
        if (consecutiveBaselineReads >= PREFIX_INSTABILITY_THRESHOLD) {
          prefixInstabilityActive = true;
          return true;
        }
      } else {
        // Recovery: cache prefix is being read beyond baseline — instability resolved
        consecutiveBaselineReads = 0;
        prefixInstabilityActive = false;
      }
      return false;
    },
  };
}

/**
 * Create a static (non-escalating) cache retention strategy.
 * Used for sub-agents that complete in <60s and never accumulate enough
 * cache reads to warrant adaptive escalation tracking.
 *
 * @param retention - Fixed retention value (typically "short" for sub-agents)
 * @returns An AdaptiveCacheRetention that always returns the fixed retention
 */
export function createStaticRetention(retention: CacheRetention): AdaptiveCacheRetention {
  return {
    getRetention: () => retention,
    recordCacheReads: () => {},  // no-op: static retention never escalates
    recordTurn: () => {},        // no-op: static retention never escalates
    recordTurnWithCacheWrite: () => {},  // no-op: static retention never escalates
    getMessageRetention: () => retention, // Match the static retention level
    hasEscalated: () => false,  // Static retention never escalates
    reset: () => {},  // no-op: nothing to reset
    setCostGateOpen: () => {},  // no-op: static retention ignores cost gate
    recordCacheReadForStability: () => false,  // no-op: static retention ignores instability
  };
}
