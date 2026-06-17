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
 *    session is recorded from `diagnostic:message_processed` — the per-turn
 *    completion event that fires for single-agent turns too and carries
 *    agentId/sessionKey/traceId on its PAYLOAD (CR-02; the prior `graph:completed`
 *    + ALS wiring never fired for a single-agent turn and had no ALS at the emit).
 *    The recorded sessionKey is the SAME `formatSessionKey(...)` string the reader
 *    formats off the `message:received` payload (`formatSessionKey(p.sessionKey)`).
 *    `observe({ source: "correction", outcome: "corrected" })` is a SOFT-FAILURE of
 *    that prior trajectory; the deterministic sources always outrank it.
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
  formatSessionKey,
  createInjectionRateLimiter,
  KEYLESS_PROVIDER_TYPES,
  KEYLESS_API_KEY_SENTINEL,
  type TypedEventBus,
  type OutcomeSignalPort,
  type ClockPort,
  type ComisLogger,
  type TimerPort,
  type TimerHandle,
  type InjectionRateLimiter,
} from "@comis/core";
import {
  createCorrectionDetectorSeam,
  resolveOperationModel,
  resolveProviderFamily,
  type CorrectionVerdict,
} from "@comis/agent";
import { deriveTenantFromSessionKey } from "./setup-memory-usefulness-wiring.js";

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
   * on the `formatSessionKey(...)` string carried by the per-turn completion event
   * (CR-02). The full scope is stored so the reader attributes the correction to
   * the trajectory's OWN (tenant, agent) — not the follow-up turn's ALS (which may
   * differ / be absent at the bus boundary).
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
 * (`diagnostic:message_processed` — the per-turn completion event — CR-02) and
 * observe a `corrected` outcome on a classified follow-up turn (`message:received`).
 */
export function wireLearningCorrection(deps: LearningReactionsWiringDeps): void {
  // WRITER — record the most-recent completed trajectory for the session.
  //
  // CR-02: keys off the `diagnostic:message_processed` PAYLOAD, NOT the ALS. The
  // prior writer hooked `graph:completed`, which (a) is emitted from the graph
  // coordinator's async tick loop OUTSIDE any `runWithContext` (so `tryGetContext()`
  // was always undefined → the writer always early-returned) and (b) only fires for
  // DAG runs, never the common single-agent turn a correction follows.
  // `diagnostic:message_processed` fires once per turn for single-agent turns too,
  // and carries agentId/sessionKey/traceId on its payload (execution-pipeline.ts) —
  // so no ALS dependency. The sessionKey is already the `formatSessionKey(...)`
  // string the reader formats the `message:received` payload into. An absent
  // sessionKey OR traceId records NOTHING (a later correction then fails-closed —
  // never mis-joined). The tenant is derived from the sessionKey's first segment
  // (mirrors the 198 `deriveTenantFromSessionKey`).
  deps.eventBus.on("diagnostic:message_processed", (p) => {
    if (deps.recordSessionTrajectory === undefined) return;
    if (!deps.correctionEnabled(p.agentId)) return;
    const sk = p.sessionKey;
    const trajectoryId = p.traceId;
    if (sk === undefined || sk.length === 0) return; // cannot reliably join → skip
    if (trajectoryId === undefined || trajectoryId.length === 0) return;
    const tenantId = deriveTenantFromSessionKey(sk) ?? "default";
    deps.recordSessionTrajectory(sk, { traceId: trajectoryId, tenantId, agentId: p.agentId, sessionId: sk });
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

// ===========================================================================
// 3. Daemon composition — construct the map/limiter/detector behind the gate
// ===========================================================================

/** The slice of the daemon container {@link buildReactionWiringDeps} reads. */
export interface ReactionWiringContainer {
  config: {
    agents?: Record<string, AgentReactionConfig | undefined>;
    memory?: { costFeatures?: { enabled?: boolean } };
    providers?: { entries?: Record<string, { apiKeyName?: string } | undefined> };
  };
  secretManager: { get(name: string): string | undefined };
  /** The daemon bus (stored on the wiring deps; not invoked at build time). */
  eventBus: TypedEventBus;
  /** The sole @comis/memory outcome adapter (the observe target). */
  outcomeStore: OutcomeSignalPort;
  /** The structured logger for the wiring + the build-time WARN. */
  logger: ComisLogger;
}

/** The per-agent config fields the reaction/correction wiring reads. */
interface AgentReactionConfig {
  provider?: string;
  model?: string;
  operationModels?: Record<string, unknown>;
  learningOutcome?: {
    enabled?: boolean;
    correction?: { enabled?: boolean };
    reactionMap?: { success?: string[]; failure?: string[] };
  };
  elevatedReply?: { senderTrustMap?: Record<string, string>; defaultTrustLevel?: string };
}

/** Result of {@link buildReactionWiringDeps}: the wiring deps + the gated capture callback. */
export interface BuildReactionWiringResult {
  /** The deps to pass into {@link wireLearningReactions} + {@link wireLearningCorrection}. */
  deps: LearningReactionsWiringDeps;
  /**
   * The outbound-capture callback to thread into the delivery drain — `undefined`
   * when learning-outcome is disabled for every agent (byte-identity: the drain
   * does zero extra work). Calls {@link ReactionTrajectoryMap.record}.
   */
  recordOutboundMessage?: (
    messageId: string,
    scope: OutboundTrajectoryEntry,
  ) => void;
  /** The bounded session→trajectory map (returned so the daemon can destroy it on shutdown). */
  sessionTrajectoryMap: ReactionTrajectoryMap;
  /**
   * WR-01: tear down EVERY bounded-with-timers resource this wiring owns — the
   * reaction trajectory map, the session trajectory map, AND the dedicated
   * reaction rate limiter — cancelling each entry's `unref()`'d TTL timer. Threaded
   * into the daemon shutdown path beside the existing `injectionRateLimiter.destroy()`
   * so the maps + their pending timers do not accumulate across SIGUSR2 hot-reload
   * cycles within a process.
   */
  destroyReactionWiring: () => void;
}

/** Default reaction emoji map (mirrors the schema-learning-outcome.ts defaults). */
const DEFAULT_REACTION_MAP: ReactionEmojiMap = { success: ["👍", "✅"], failure: ["👎", "❌"] };
/** Per-call output bound for the cheap correction classification (a tiny JSON verdict). */
const CORRECTION_MAX_OUTPUT_TOKENS = 1024;
/** Reaction-tuned rate-limit thresholds (a flood of reactions from one sender is downweighted/skipped). */
const REACTION_RATE_LIMIT = { windowMs: 300_000, warnThreshold: 5, auditThreshold: 10, entryTtlMs: 600_000, maxEntries: 50_000 };

/**
 * Resolve + construct the cheap `fast`-tier correction detector for one agent
 * (the `outcomeJudge` operation tier — research A2, no new ModelOperationType).
 * Resolves the provider/modelId by NAME and the API key from the secret manager
 * (KEYLESS sentinel for keyless providers); returns `undefined` on a missing key
 * (a no-op branch — `Defer != Retry`). The seam itself is the Plan-03 clone.
 */
function resolveCorrectionDetector(
  agent: AgentReactionConfig,
  container: ReactionWiringContainer,
  agentId: string,
  clock: ClockPort,
  logger: ComisLogger,
): ((turn: string) => Promise<CorrectionVerdict | undefined>) | undefined {
  const agentProvider = agent.provider ?? "anthropic";
  const resolved = resolveOperationModel({
    operationType: "outcomeJudge",
    agentProvider,
    agentModel: agent.model ?? "anthropic:claude-sonnet-4-20250514",
    operationModels: (agent.operationModels ?? {}) as never,
    providerFamily: resolveProviderFamily(agentProvider),
  });
  const providerEntry = container.config.providers?.entries?.[resolved.provider];
  const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
  const apiKey =
    container.secretManager.get(apiKeyName) ??
    (KEYLESS_PROVIDER_TYPES.has(resolved.provider) ? KEYLESS_API_KEY_SENTINEL : "");
  if (!apiKey) return undefined; // no key → no-op detector (Defer != Retry)
  return createCorrectionDetectorSeam({
    provider: resolved.provider,
    modelId: resolved.modelId,
    apiKey,
    maxOutputTokens: CORRECTION_MAX_OUTPUT_TOKENS,
    clock,
    logger,
    agentId,
  });
}

/**
 * Construct the reaction/correction wiring deps daemon-side, behind the
 * byte-identity gate. Keeps the bulk OUT of setup-memory.ts (the 800-cap file) —
 * called in ONE line from the `setupLearningOutcomeWiring` site.
 *
 * Gates (mirror the 198 byte-identity computation):
 *  - `costFeaturesEnabled = memory.costFeatures.enabled !== false` (master switch).
 *  - `learningOutcomeEnabled(id) = costFeaturesEnabled && agent.learningOutcome.enabled`.
 *  - `correctionEnabled(id) = learningOutcomeEnabled(id) && agent.learningOutcome.correction.enabled`.
 *  - `recordOutboundMessage` is built ONLY when SOME agent has learning-outcome on
 *    (else `undefined` → the delivery drain does zero extra work).
 *  - the correction detector is built ONLY when SOME agent has correction on AND a
 *    cheap-model API key resolves (a missing key → `undefined`, a no-op branch:
 *    `Defer != Retry`).
 */
export function buildReactionWiringDeps(
  container: ReactionWiringContainer,
  clock: ClockPort,
  timers: TimerPort,
): BuildReactionWiringResult {
  const { eventBus, outcomeStore, logger } = container;
  const costFeaturesEnabled = container.config.memory?.costFeatures?.enabled !== false;
  const agents = container.config.agents ?? {};

  const learningOutcomeEnabled = (agentId: string): boolean =>
    costFeaturesEnabled && agents[agentId]?.learningOutcome?.enabled === true;
  const correctionEnabled = (agentId: string): boolean =>
    learningOutcomeEnabled(agentId) && agents[agentId]?.learningOutcome?.correction?.enabled === true;

  const someLearningOn = Object.keys(agents).some((id) => learningOutcomeEnabled(id));
  const someCorrectionOn = Object.keys(agents).some((id) => correctionEnabled(id));

  const reactionTrajectoryMap = createReactionTrajectoryMap({ clock, timers });
  // The session→trajectory map for the correction join (same bounded shape).
  const sessionTrajectoryMap = createReactionTrajectoryMap({ clock, timers });
  // A DEDICATED reaction rate limiter (separate counters from the injection-detection singleton).
  const reactionRateLimiter = createInjectionRateLimiter({ clock, timers }, REACTION_RATE_LIMIT);

  // Resolve the RAW channel-sender trust string (senderTrustMap[id] ?? defaultTrustLevel,
  // default "external") — the channel-sender vocabulary, NOT the tool-gate narrowing.
  const resolveSenderTrust = (agentId: string, reactorId: string): string => {
    const elev = agents[agentId]?.elevatedReply;
    return elev?.senderTrustMap?.[reactorId] ?? elev?.defaultTrustLevel ?? "external";
  };

  // The correction detector — built ONLY when some agent has correction on. Resolve
  // the cheap fast-tier model/key for the FIRST correction-enabled agent (the
  // detector is a shared cheap-tier seam; per-agent re-selection is deferred). A
  // missing key → undefined (a no-op branch: `Defer != Retry`).
  let correctionDetector: ((turn: string) => Promise<CorrectionVerdict | undefined>) | undefined;
  if (someCorrectionOn) {
    const firstAgentId = Object.keys(agents).find((id) => correctionEnabled(id));
    const agent = firstAgentId !== undefined ? agents[firstAgentId] : undefined;
    if (agent !== undefined) {
      correctionDetector = resolveCorrectionDetector(agent, container, firstAgentId ?? "default", clock, logger);
    }
    if (correctionDetector === undefined) {
      logger.warn(
        {
          errorKind: "config" as const,
          hint: "correction detector enabled but no cheap-model API key resolved; the correction signal is a no-op until a key is set",
        },
        "correction detector unavailable (non-fatal, default-deferred)",
      );
    }
  }

  // Pick a representative reactionMap (the FIRST learning-enabled agent's, else the default).
  const firstLearningAgentId = Object.keys(agents).find((id) => learningOutcomeEnabled(id));
  const agentMap = firstLearningAgentId !== undefined ? agents[firstLearningAgentId]?.learningOutcome?.reactionMap : undefined;
  const reactionMap: ReactionEmojiMap = {
    success: agentMap?.success ?? DEFAULT_REACTION_MAP.success,
    failure: agentMap?.failure ?? DEFAULT_REACTION_MAP.failure,
  };

  const deps: LearningReactionsWiringDeps = {
    eventBus,
    outcomeStore,
    clock,
    logger,
    learningOutcomeEnabled,
    reactionTrajectoryMap,
    reactionRateLimiter,
    reactionMap,
    resolveSenderTrust,
    correctionDetector,
    correctionEnabled,
    recordSessionTrajectory: (sessionKey, scope) => sessionTrajectoryMap.record(sessionKey, scope),
    lastTrajectoryForSession: (sessionKey) => sessionTrajectoryMap.lookup(sessionKey),
  };

  // Byte-identity: capture ONLY when some agent has learning-outcome on (else the
  // delivery drain does zero extra work).
  const recordOutboundMessage = someLearningOn
    ? (messageId: string, scope: OutboundTrajectoryEntry): void => reactionTrajectoryMap.record(messageId, scope)
    : undefined;

  // WR-01: one closure that cancels the timers of ALL THREE bounded resources.
  // The daemon shutdown path invokes it beside injectionRateLimiter.destroy().
  const destroyReactionWiring = (): void => {
    reactionTrajectoryMap.destroy();
    sessionTrajectoryMap.destroy();
    reactionRateLimiter.destroy();
  };

  return { deps, recordOutboundMessage, sessionTrajectoryMap, destroyReactionWiring };
}
