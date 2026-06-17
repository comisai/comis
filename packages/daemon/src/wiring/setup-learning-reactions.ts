// SPDX-License-Identifier: Apache-2.0
/**
 * Reaction + correction outcome wiring (Verified Learning WS1, Phase 199 P0.5).
 *
 * Co-located beside {@link wireLearningOutcome} (setup-learning.ts) — the daemon
 * composition root holds BOTH the bus AND the `OutcomeSignalPort` adapter (the
 * agent↛memory cut). This module adds the TWO corroborating outcome sources that
 * the deterministic tool/pipeline signal (Phase 198) already outranks at fusion:
 *
 *  - REACTION (`channel:reaction_received`): a chat reaction on an agent-authored
 *    OUTBOUND message. The `messageId → trajectory scope` map (captured ONLY at the
 *    outbound delivery ack — {@link ReactionTrajectoryMap}) resolves the trajectory;
 *    a reaction on a USER message / unknown id has NO entry → fail-closed SKIP
 *    (REACT-02 keystone). The emoji is matched against a CLOSED reactionMap
 *    (unmapped → skip); confidence is SCALED by the channel-sender trust
 *    (`external` → near-zero, REACT-03/04); a per-sender rate limit caps a flood.
 *    Then `observe({ source: "reaction" })`.
 *
 *  - CORRECTION (`message:received`): a follow-up user turn classified by the
 *    cost-gated detector seam (Plan 03). The prior completed trajectory for the
 *    session is recorded from `graph:completed` keyed on the ALS `sessionKey`
 *    (WARNING-2) — the SAME key the reader formats off the `message:received`
 *    payload (`formatSessionKey(p.sessionKey)`). `observe({ source: "correction",
 *    outcome: "corrected" })` is a SOFT-FAILURE of that prior trajectory; the
 *    deterministic sources always outrank it.
 *
 * Counts/ids/closed-enums ONLY ever cross the bus or reach the store (AGENTS.md
 * §2.7 / SEC-01) — the emoji is matched against the closed map and never flows
 * into a prompt; no sender display names, no message bodies. Every observe is
 * fire-and-forget / non-fatal (WARN+errorKind+hint, never throws — the turn
 * already completed). `senderTrust` is provenance, NEVER raises authority.
 *
 * BYTE-IDENTITY (default-OFF): every handler short-circuits on
 * `learningOutcomeEnabled`/`correctionEnabled` (default false); the delivery
 * `recordOutboundMessage` callback is `undefined` when disabled so the drain does
 * ZERO extra work. The corroborating signal ships LIVE-but-dormant.
 *
 * @module
 */

import {
  tryGetContext,
  formatSessionKey,
  type TypedEventBus,
  type OutcomeSignalPort,
  type ClockPort,
  type ComisLogger,
  type TimerPort,
  type TimerHandle,
  type InjectionRateLimiter,
} from "@comis/core";
import type { CorrectionVerdict } from "@comis/agent";

// ===========================================================================
// 1. messageId → trajectory-scope map (bounded, in-memory daemon-lifetime)
// ===========================================================================

/** The trajectory scope an agent-authored outbound message maps to (REACT-02). */
export interface OutboundTrajectoryEntry {
  /** The trajectory identity (=== traceId; the trajectory + `comis explain` key). */
  traceId: string;
  /** Tenant partition (isolation boundary for the eventual observe). */
  tenantId: string;
  /** Agent partition (isolation boundary; the byte-identity gate keys on it). */
  agentId: string;
  /** Conversation/session identity (falls back to the trajectory id at capture). */
  sessionId: string;
}

/**
 * A bounded in-memory `messageId → {@link OutboundTrajectoryEntry}` map. Built
 * ONLY at the agent-authored outbound delivery ack; a reacted messageId that is
 * not present (a user message, an evicted/expired entry, a post-restart miss) is
 * a fail-closed SKIP. Copies the {@link createInjectionRateLimiter} bounded-Map +
 * TTL + maxEntries + evict-oldest discipline (no unbounded growth; the per-entry
 * timer is `unref()`'d so it never pins the daemon process).
 */
export interface ReactionTrajectoryMap {
  /** Record an agent-authored outbound message's (messageId → trajectory scope). */
  record(messageId: string, entry: OutboundTrajectoryEntry): void;
  /** Look up the trajectory scope for a reacted messageId; undefined = not agent-authored / evicted (fail-closed). */
  lookup(messageId: string): OutboundTrajectoryEntry | undefined;
  /** Clear all entries + timers (shutdown). */
  destroy(): void;
}

interface MapBucket {
  entry: OutboundTrajectoryEntry;
  insertedAt: number;
  timer: TimerHandle;
}

/** Evict the entry whose insert timestamp is the oldest (bounded growth). */
function evictOldestMapEntry(buckets: Map<string, MapBucket>): void {
  let oldestKey: string | undefined;
  let oldest = Infinity;
  for (const [key, b] of buckets) {
    if (b.insertedAt < oldest) {
      oldest = b.insertedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    buckets.get(oldestKey)!.timer.cancel();
    buckets.delete(oldestKey);
  }
}

export function createReactionTrajectoryMap(
  deps: { clock: ClockPort; timers: TimerPort },
  config?: { entryTtlMs?: number; maxEntries?: number },
): ReactionTrajectoryMap {
  // A reaction usually arrives soon after the message; a day is generous. The map
  // is in-memory daemon-lifetime (resolved decision A1) — a post-restart reaction
  // simply has no entry → fail-closed skip.
  const entryTtlMs = config?.entryTtlMs ?? 86_400_000; // 24h
  const maxEntries = config?.maxEntries ?? 50_000;
  const buckets = new Map<string, MapBucket>();

  function createTtlTimer(key: string): TimerHandle {
    const timer = deps.timers.setTimeout(() => {
      buckets.delete(key);
    }, entryTtlMs);
    timer.unref(); // never pin the daemon process
    return timer;
  }

  return {
    record(messageId: string, entry: OutboundTrajectoryEntry): void {
      const existing = buckets.get(messageId);
      if (existing) existing.timer.cancel();
      else if (buckets.size >= maxEntries) evictOldestMapEntry(buckets);
      buckets.set(messageId, { entry, insertedAt: deps.clock.now(), timer: createTtlTimer(messageId) });
    },
    lookup(messageId: string): OutboundTrajectoryEntry | undefined {
      return buckets.get(messageId)?.entry;
    },
    destroy(): void {
      for (const b of buckets.values()) b.timer.cancel();
      buckets.clear();
    },
  };
}

// ===========================================================================
// 2. Reaction + correction wiring deps + the trust/emoji tables
// ===========================================================================

/** The closed emoji → outcome map (Unicode defaults; REACT-03). */
export interface ReactionEmojiMap {
  success: string[];
  failure: string[];
}

/** Base confidence for a clean reaction before trust scaling (REACT-03). */
const REACTION_BASE_CONFIDENCE = 0.6;

/**
 * Channel-sender trust → confidence weight (REACT-03/04). The vocabulary is the
 * channel-sender ladder (owner/admin/trusted/known/external) — NOT the tool-gate
 * guest/user/admin narrowing (Pitfall 4). An `external`/unknown reactor is
 * near-zero (a spoofed 👍 can never mint a strong reward; deterministic outranks
 * it regardless).
 */
function trustWeight(trust: string): number {
  switch (trust) {
    case "owner":
    case "admin":
      return 0.9;
    case "trusted":
      return 0.7;
    case "known":
      return 0.4;
    default: // external / unknown
      return 0.05;
  }
}

/**
 * Slack delivers `event.reaction` as a SHORT NAME ("thumbsup"); the reactionMap
 * default is Unicode ("👍"). Match the emoji against the configured arrays AND a
 * small built-in short-name alias table for the defaults so a Slack 👍 maps
 * without forcing operators to add short names.
 */
const SHORT_NAME_ALIASES: Record<string, string> = {
  thumbsup: "👍",
  "+1": "👍",
  white_check_mark: "✅",
  heavy_check_mark: "✅",
  thumbsdown: "👎",
  "-1": "👎",
  x: "❌",
  negative_squared_cross_mark: "❌",
};

/** Map an inbound emoji (Unicode or Slack short name) to a closed outcome. */
function matchEmoji(emoji: string, map: ReactionEmojiMap): "success" | "failure" | undefined {
  const unicode = SHORT_NAME_ALIASES[emoji] ?? emoji;
  if (map.success.includes(emoji) || map.success.includes(unicode)) return "success";
  if (map.failure.includes(emoji) || map.failure.includes(unicode)) return "failure";
  return undefined;
}

/** Dependencies for {@link wireLearningReactions} + {@link wireLearningCorrection}. */
export interface LearningReactionsWiringDeps {
  /** The daemon's typed event bus (source of channel:reaction_received / message:received / graph:completed). */
  eventBus: TypedEventBus;
  /** The sole @comis/memory adapter for the outcome port (the observe target). */
  outcomeStore: OutcomeSignalPort;
  /** Injected clock for `observedAt`. */
  clock: ClockPort;
  /** Structured logger (OBS-01 INFO/durationMs + the non-fatal failure WARN). */
  logger: ComisLogger;
  /** Per-agent effective learning-outcome enable (the byte-identity gate). */
  learningOutcomeEnabled: (agentId: string) => boolean;
  /** The bounded outbound-trajectory map (REACT-02 fail-closed resolution). */
  reactionTrajectoryMap: ReactionTrajectoryMap;
  /** Dedicated per-sender rate limiter for reactions (separate counters from injection detection). */
  reactionRateLimiter: InjectionRateLimiter;
  /** The closed emoji → outcome map (success/failure arrays). */
  reactionMap: ReactionEmojiMap;
  /** Resolve the RAW channel-sender trust string for a reactor (senderTrustMap[id] ?? defaultTrustLevel). */
  resolveSenderTrust: (agentId: string, reactorId: string) => string;
  /** The cost-gated correction detector — `undefined` when disabled (no-op branch). */
  correctionDetector?: (followUpUserTurn: string) => Promise<CorrectionVerdict | undefined>;
  /** Per-agent effective correction enable (the byte-identity gate for the correction path). */
  correctionEnabled: (agentId: string) => boolean;
  /**
   * Record the most-recent completed trajectory + its scope for a session, keyed
   * on the ALS sessionKey string (WARNING-2). The full scope is stored so the
   * reader attributes the correction to the trajectory's OWN (tenant, agent) — not
   * the follow-up turn's ALS (which may differ / be absent at the bus boundary).
   */
  recordSessionTrajectory?: (sessionKey: string, scope: OutboundTrajectoryEntry) => void;
  /** Look up the prior completed trajectory scope for a session (keyed identically to the writer). */
  lastTrajectoryForSession?: (sessionKey: string) => OutboundTrajectoryEntry | undefined;
}

/**
 * Persist a reaction observation, fire-and-forget / non-fatal. NEVER throws out
 * of the bus handler. The WARN `hint` carries the descriptive label; `errorKind`
 * stays the closed union ("internal") — there is NO `reaction_unresolved_trajectory`
 * ErrorKind member.
 */
function observeReactionNonFatal(
  deps: LearningReactionsWiringDeps,
  entry: OutboundTrajectoryEntry,
  outcome: "success" | "failure",
  confidence: number,
  senderTrust: string,
): Promise<void> {
  const start = deps.clock.now();
  return deps.outcomeStore
    .observe({
      tenantId: entry.tenantId,
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      trajectoryId: entry.traceId,
      outcome,
      source: "reaction",
      confidence,
      senderTrust,
      observedAt: start,
    })
    .then((r) => {
      if (!r.ok) {
        deps.logger.warn(
          {
            agentId: entry.agentId,
            source: "reaction",
            senderTrust,
            errorKind: "internal" as const,
            hint: "reaction observe failed for an agent-authored-outbound trajectory; the reaction signal was not persisted",
          },
          "reaction observe failed (non-fatal)",
        );
        return;
      }
      // OBS-01: one INFO line per recorded reaction — counts/ids/closed-enums only
      // (the observe latency as durationMs, the resolved senderTrust). Never the
      // emoji-as-content beyond the closed map, never a sender display name.
      deps.logger.info(
        { agentId: entry.agentId, outcome, source: "reaction", senderTrust, durationMs: deps.clock.now() - start },
        "Reaction outcome observed for trajectory",
      );
    })
    .catch((e: unknown) => {
      deps.logger.warn(
        {
          agentId: entry.agentId,
          source: "reaction",
          err: e instanceof Error ? e : new Error(String(e)),
          errorKind: "internal" as const,
          hint: "reaction observe threw for an agent-authored-outbound trajectory; the reaction signal was not persisted",
        },
        "reaction observe threw (non-fatal)",
      );
    });
}

/** Persist a correction observation, fire-and-forget / non-fatal. NEVER throws. */
function observeCorrectionNonFatal(
  deps: LearningReactionsWiringDeps,
  scope: { tenantId: string; agentId: string; sessionId: string; trajectoryId: string },
  confidence: number,
): Promise<void> {
  const start = deps.clock.now();
  return deps.outcomeStore
    .observe({
      tenantId: scope.tenantId,
      agentId: scope.agentId,
      sessionId: scope.sessionId,
      trajectoryId: scope.trajectoryId,
      outcome: "corrected",
      source: "correction",
      confidence,
      observedAt: start,
    })
    .then((r) => {
      if (!r.ok) {
        deps.logger.warn(
          {
            agentId: scope.agentId,
            source: "correction",
            errorKind: "internal" as const,
            hint: "correction observe failed against the prior trajectory; the correction signal was not persisted",
          },
          "correction observe failed (non-fatal)",
        );
        return;
      }
      deps.logger.info(
        { agentId: scope.agentId, outcome: "corrected", source: "correction", durationMs: deps.clock.now() - start },
        "Correction outcome observed for prior trajectory",
      );
    })
    .catch((e: unknown) => {
      deps.logger.warn(
        {
          agentId: scope.agentId,
          source: "correction",
          err: e instanceof Error ? e : new Error(String(e)),
          errorKind: "internal" as const,
          hint: "correction observe threw against the prior trajectory; the correction signal was not persisted",
        },
        "correction observe threw (non-fatal)",
      );
    });
}

/**
 * Stand up the `channel:reaction_received` → observe(source:"reaction") subscriber.
 *
 * Order (REACT-02/03/04):
 *  1. Resolve the trajectory FIRST via the map — a miss (user message / unresolvable
 *     id) is a fail-closed SKIP (the keystone). The reaction NEVER calls resolve();
 *     the existing graph:completed resolve (198) fuses the reaction row with the
 *     deterministic rows, and a reaction NEVER outranks tool/pipeline.
 *  2. Byte-identity gate (now agentId is known from the entry).
 *  3. emoji → outcome via the closed reactionMap (unmapped → skip).
 *  4. RAW channel-sender trust → a confidence weight (external → near-zero).
 *  5. per-sender rate limit (flood → skip).
 *  6. observe (fire-and-forget / non-fatal).
 */
export function wireLearningReactions(deps: LearningReactionsWiringDeps): void {
  deps.eventBus.on("channel:reaction_received", (p) => {
    // 1. Fail-closed trajectory resolution (REACT-02 keystone).
    const entry = deps.reactionTrajectoryMap.lookup(p.messageId);
    if (entry === undefined) return; // user message / unresolvable / evicted → SKIP

    // 2. Byte-identity short-circuit (default OFF) — observe NOTHING.
    if (!deps.learningOutcomeEnabled(entry.agentId)) return;

    // 3. emoji → outcome via the CLOSED reactionMap (unmapped → skip).
    const outcome = matchEmoji(p.emoji, deps.reactionMap);
    if (outcome === undefined) return;

    // 4. RAW channel-sender trust → a confidence weight (external → near-zero).
    const trust = deps.resolveSenderTrust(entry.agentId, p.reactorId);
    const confidence = REACTION_BASE_CONFIDENCE * trustWeight(trust);

    // 5. per-sender rate limit (anti-spoof-flood DoS) — past audit → skip.
    const rl = deps.reactionRateLimiter.record(entry.tenantId, p.reactorId);
    if (rl.level === "audit") {
      deps.logger.warn(
        {
          agentId: entry.agentId,
          source: "reaction",
          errorKind: "internal" as const,
          hint: "reaction rate limit exceeded for this sender; the reaction was skipped (anti-flood)",
        },
        "reaction over rate limit (non-fatal skip)",
      );
      return;
    }

    // 6. observe (fire-and-forget / non-fatal).
    void observeReactionNonFatal(deps, entry, outcome, confidence, trust);
  });
}

/**
 * Stand up the correction path: record the prior completed trajectory per session
 * (`graph:completed`, keyed on the ALS `sessionKey` — WARNING-2) and observe a
 * `corrected` outcome on a classified follow-up turn (`message:received`).
 */
export function wireLearningCorrection(deps: LearningReactionsWiringDeps): void {
  // WRITER — record the most-recent completed trajectory for the session, keyed
  // on the ALS `sessionKey` SPECIFICALLY (NOT resolveScope's trajectory-id
  // fallback), so it matches the reader's `formatSessionKey(p.sessionKey)`. When
  // the ALS sessionKey is ABSENT, record NOTHING (a later correction for that
  // session then fails-closed — never mis-joined to the trajectory-id fallback).
  deps.eventBus.on("graph:completed", () => {
    if (deps.recordSessionTrajectory === undefined) return;
    const ctx = tryGetContext();
    const agentId = ctx?.agentId;
    const sk = ctx?.sessionKey;
    const trajectoryId = ctx?.traceId;
    if (agentId === undefined || !deps.correctionEnabled(agentId)) return;
    if (sk === undefined || sk.length === 0) return; // cannot reliably join → skip
    if (trajectoryId === undefined || trajectoryId.length === 0) return;
    const tenantId = ctx?.tenantId ?? "default";
    deps.recordSessionTrajectory(sk, { traceId: trajectoryId, tenantId, agentId, sessionId: sk });
  });

  // READER — classify a follow-up user turn and observe a correction against the
  // prior trajectory recorded under the SAME session key.
  deps.eventBus.on("message:received", (p) => {
    if (deps.correctionDetector === undefined || deps.lastTrajectoryForSession === undefined) return;

    // The reader keys on `formatSessionKey(p.sessionKey)` — the SAME string the
    // writer stored under (the ALS sessionKey is the formatSessionKey(...) string,
    // per execution-pipeline.ts:227). A miss → no prior trajectory → fail-closed.
    // The scope (tenant, agent) comes from the recorded PRIOR trajectory (its own
    // partition), NOT the follow-up turn's ALS — which may be absent/different.
    const sessionKeyStr = formatSessionKey(p.sessionKey);
    const prior = deps.lastTrajectoryForSession(sessionKeyStr);
    if (prior === undefined) return;
    if (!deps.correctionEnabled(prior.agentId)) return; // byte-identity gate on the trajectory's agent

    const detector = deps.correctionDetector;
    void (async (): Promise<void> => {
      try {
        const verdict = await detector(p.message.text);
        if (verdict === undefined || !verdict.isCorrection) return; // undefined non-fatal; not-a-correction → skip
        await observeCorrectionNonFatal(
          deps,
          { tenantId: prior.tenantId, agentId: prior.agentId, sessionId: sessionKeyStr, trajectoryId: prior.traceId },
          verdict.cappedConfidence,
        );
      } catch (e: unknown) {
        deps.logger.warn(
          {
            agentId: prior.agentId,
            source: "correction",
            err: e instanceof Error ? e : new Error(String(e)),
            errorKind: "internal" as const,
            hint: "correction detector/observe threw on a follow-up turn; the prior outcome stays unflipped",
          },
          "correction path threw (non-fatal)",
        );
      }
    })();
  });
}

// (Task 3 appends `buildReactionWiringDeps` — the daemon composition helper —
//  below this point, keeping the bulk OUT of setup-memory.ts.)
