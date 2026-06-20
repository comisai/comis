// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory event-bus bridge.
 *
 * Subscribes to the typed `EventBus` and translates each mapped event
 * into a trajectory `recordEvent` call. The bridge avoids N call-site
 * instrumentations — one subscription per session is the entire surface.
 *
 * The mapping is declared as a single `TRAJECTORY_BRIDGE_MAPPING`
 * record so the architecture test (`trajectory-event-types-known.test.ts`)
 * can enumerate it at test time. Every EventBus emit site in
 * `packages/agent` and `packages/orchestrator` whose name is in
 * `EventMap` (compile-time enforced) must EITHER appear as a key here
 * OR appear in the `EVENTS_NOT_TRAJECTORY_MAPPED` allowlist
 * (defined in the architecture test).
 *
 * Dedup contract:
 *   - `tool:executed{errorKind:"timeout"}` AND `tool:timeout` are
 *     BOTH mapped. They share `toolCallId` — downstream consumers
 *     join on that key to dedupe. The architecture test enforces
 *     both events have entries in this table.
 *   - `model:lkw_fallback_attempt` AND `model:fallback_attempt` both
 *     map to `model.fallback_attempt`; the LKW variant emits a
 *     `data.lkw: true` flag so the trajectory consumer can
 *     distinguish.
 *
 * @module
 */

import type { EventMap, TypedEventBus } from "@comis/core";

import type { TrajectoryEventType, TrajectoryRecorder } from "./types.js";
// The exhaustive payload translators live in `translate-payload.ts` (extracted
// for the file-size cap); `TrajectoryBridgedEventName` (the switch's
// exhaustiveness key) stays here and is type-imported back there.
import { translatePayload } from "./translate-payload.js";

// ---------------------------------------------------------------------------
// Mapping table (EventName → TrajectoryEventType)
// ---------------------------------------------------------------------------

/**
 * Bridge mapping table — keys are `EventMap` event names that the bridge
 * translates into trajectory events. Architecture test enumerates this.
 *
 * NOTE: events not in this table AND not explicitly allowlisted (in the
 * architecture test's `EVENTS_NOT_TRAJECTORY_MAPPED` set) will fail the
 * architecture test if used at an `eventBus.emit(...)` site. Add new
 * entries here when wiring a new EventMap event into the trajectory.
 */
export const TRAJECTORY_BRIDGE_MAPPING = {
  // ---- Tool lifecycle ----
  "tool:started": "tool.call",
  "tool:executed": "tool.result",
  "tool:timeout": "tool.timeout",
  "tool:policy_filtered": "tool.policy_filtered",
  // D3 breaker transitions (Phase 151).
  "tool:breaker_opened": "tool.breaker_opened",
  "tool:breaker_reset": "tool.breaker_reset",
  // D7 result offload (Phase 151).
  "tool:result_offloaded": "tool.result_offloaded",

  // ---- Model lifecycle ----
  // `observability:token_usage` is reused as `model.completed` — the
  // token-usage event already carries everything the trajectory needs
  // for a model-completed record. `model:fallback_attempt` and the LKW
  // variant both map to `model.fallback_attempt`; the LKW variant
  // attaches `lkw: true`.
  "observability:token_usage": "model.completed",
  "model:fallback_attempt": "model.fallback_attempt",
  "model:lkw_fallback_attempt": "model.fallback_attempt",
  "model:fallback_exhausted": "model.fallback_exhausted",
  "model:auth_cooldown": "model.auth_cooldown",

  // ---- Skill observability ----
  "skill:prompt_loaded": "skill.prompt_loaded",
  "skill:prompt_invoked": "skill.prompt_invoked",

  // ---- Session + prompt lifecycle ----
  "prompt:submitted": "prompt.submitted",
  "session:started": "session.started",
  "session:ended": "session.ended",
  // F2 (D5): per-session health rollup emitted once at agent-end.
  "session:summary": "session.summary",
  "memory:injected": "memory.injected",
  // RECALL-01 (observability-excellence): the per-recall lane/candidate/final counts +
  // rerank outcome — previously emitted but UNMAPPED (invisible to comis explain/trace,
  // the #1 troubleshooting blind spot). Content-free (counts/booleans only — H1).
  "memory:recalled": "memory.recalled",
  "memory:reranked": "memory.reranked",

  // GENQ-01 (observability-excellence): a memory-generation pass (consolidation /
  // reasoning / user-representation) produced output whose quality diverged from
  // its source — the F-ML1 class. Emitted only on an issue. Content-free (closed
  // enums + booleans — H1); the source/generated body never crosses the bus.
  "memory:generation_quality": "memory.generation_quality",

  // PERSIST-01 (Phase 176 Plan 04, observability-excellence): a detected prompt-cache
  // break (15 CacheBreakReason values) — emitted in packages/agent but previously
  // UNMAPPED (allowlisted as a daemon-level rollup), invisible to `comis explain`. Now
  // bridged so the cost-relevant break shows on the per-session timeline beside the
  // obs_diagnostics category:'cache_break' row. Content-free (the closed reason + the
  // tokenDrop/relative counts + a changed-dims DIGEST — H1/I3); the translator drops
  // the toolsAdded/Removed/SchemaChanged tool-NAME arrays and the system text entirely.
  "observability:cache_break": "cache.break",

  // TELEM-01 (v2.27 P1, Phase 173): a `pipeline` tool invocation was authored —
  // counts-only (action / capabilityClass tier / schemaValid / repaired). Mapped
  // here for trajectory-type ARCH closure (every EventMap member is mapped-or-
  // allowlisted) and to reserve the `pipeline.authored` trajectory type. The live
  // per-session recordEvent emit is a DEFERRED follow-up: at P1 `getRecorder` is
  // NOT reachable on the graph-handler deps (it rides the image-handler slice, not
  // the createGraphHandlers spread) — the P1 path is the FLEET aggregate (Plan
  // 03/04), which needs only eventBus. Content-free (closed enums + booleans —
  // H1); no pipeline body / type_config value / node task crosses the bus.
  "pipeline:authored": "pipeline.authored",

  // AUTHOR-01/02 (v2.27 P2, Phase 174): the two authoring-AUDIT events Plans 03/04
  // emit DAEMON-SIDE on a conservative repair / intent-synthesis (the repair +
  // synthesis producers the P1 pipeline:authored.repaired flag documented as
  // deferred). APPEND-ONLY beside pipeline:authored. Mapped here for trajectory-type
  // ARCH closure (every EventMap member is mapped-or-allowlisted) + to reserve the
  // graph.repaired / graph.synthesized_from_intent trajectory types. NOTE: these
  // emit from @comis/daemon (graph-helpers.ts), so the trajectory-event-types-known
  // arch gate — which walks only packages/agent + packages/orchestrator — does not
  // require them; the registration is for consistency with pipeline:authored AND
  // arch-test closure of the keyof TrajectoryBridgedEventName. Content-free (closed
  // enums + numbers — H1); no graph body / type_config / node task / intent text
  // crosses the bus.
  "graph:repaired": "graph.repaired",
  "graph:synthesized_from_intent": "graph.synthesized_from_intent",

  // STEER-01 (v2.27 P3, Phase 175): a running sub-agent was steered IN-FLIGHT (a
  // high-priority message injected at the child's next step boundary, transcript
  // preserved) instead of kill+respawn. Emitted DAEMON-SIDE at the inject site
  // (Plan 02, subagent-handlers.ts), so the trajectory-event-types-known arch gate
  // — which walks only packages/agent + packages/orchestrator — does NOT require it
  // (the unmapped subagent:budget_exceeded precedent); the registration here is
  // purely for OPERATOR TRAJECTORY VISIBILITY (a steer is a meaningful per-session
  // event in `comis explain`), mirroring the graph:repaired entry above. Content-free
  // (runId + the closed-union mode steer|followup — H1); the steer MESSAGE BODY never
  // crosses the bus.
  "subagent:steered": "subagent.steered",

  // ORCH-OBS (orchestration-observability): three previously-dark sub-agent-lifecycle
  // events bridged for per-session `comis explain` visibility (the subagent:steered
  // precedent). security:sandbox_downgrade_refused is agent-emitted (sub-agent-runner.ts)
  // and fires WITHIN the spawning session → lands cleanly in that trajectory;
  // subagent:delivery_deadlettered (orchestrator) + subagent:budget_exceeded (daemon
  // coordinator) ride whichever session bridge is active. Content-free translators
  // (translate-orchestration-payload.ts) forward closed labels/ids/numbers ONLY — never
  // a path/host/uid value, an announcement body, or a task (§2.7 / H1). These ALSO feed
  // the fleet lens via obs-persistence-wiring (the daemon-wide aggregate surface).
  "security:sandbox_downgrade_refused": "security.sandbox_downgrade_refused",
  "subagent:delivery_deadlettered": "subagent.delivery_deadlettered",
  "subagent:budget_exceeded": "subagent.budget_exceeded",

  // OUTCOME-08 (v2.26 Verified Learning WS1): a finished trajectory's resolved net
  // task-outcome, emitted DAEMON-SIDE after OutcomeSignalPort.resolve (learningOutcome.
  // enabled-gated, default OFF). DAEMON emit (NOT agent/orchestrator) so the arch
  // emit-scanner does not require it; mapped here so OBS-02 `comis explain` can
  // reconstruct it. Content-free: ids/counts/closed-enums ONLY (no body/alpha — SEC-01).
  "learning:outcome_observed": "learning.outcome_observed",

  // RANK-06 / FORGET-06 (v2.26 Verified Learning WS3/WS4, Phase 200): the bandit-applied +
  // soft-eviction telemetry. memory:online_tuning_applied is PROMOTED from an optional-chained
  // emit to a plain typed one (agent-side, so EMIT_REGEX sees it); learning:memory_* are NEW
  // (daemon emit, NOT arch-scanned). All counts/ids/closed-enums ONLY — never an alpha value or
  // memory body (SEC-01). Mapped here so OBS-02 `comis explain` can reconstruct them.
  "memory:online_tuning_applied": "memory.online_tuning_applied",
  "learning:memory_demoted": "learning.memory_demoted",
  "learning:memory_evicted": "learning.memory_evicted",

  // SKILL-09 (v2.26 Verified Learning WS2, Phase 201 Plan 07): the procedural-synthesis
  // telemetry. Both DAEMON-emitted (the __SKILL_SYNTHESIS__ cron handler, NOT agent/
  // orchestrator) after runSkillSynthesis → the arch emit-scanner does not require them;
  // mapped here so OBS-02 `comis explain` can reconstruct a synthesis run. Content-free:
  // counts (synthesized) + the static/dynamic verdict + the coverage closed-enum ONLY —
  // NEVER a procedure body, a script, or a finding (SEC-01 §7).
  "learning:skill_synthesized": "learning.skill_synthesized",
  "learning:skill_validated": "learning.skill_validated",

  // SURFACE-06 (v2.26 Verified Learning WS2, Phase 202 Plan 03): the promote/demote
  // telemetry. Both DAEMON-emitted (the promote/demote loop, Plan 05 — NOT agent/
  // orchestrator) so the arch emit-scanner does not require them; mapped here so OBS-02
  // `comis explain` can reconstruct a promotion/demotion. Content-free: the COUNT ONLY —
  // NEVER an id-list, a procedure body, or a script (SEC-01 §7). They fold into the
  // shared { count } translator case (translate-payload.ts).
  "learning:skill_promoted": "learning.skill_promoted",
  "learning:skill_demoted": "learning.skill_demoted",

  // REVISE-/GENERAL- (v2.26 Verified Learning WS6/WS7, Phase 203 Plan 05): the
  // user-model-revision + generalization telemetry. Both DAEMON-emitted (the
  // __USER_REPRESENTATION__ + __MEMORY_CONSOLIDATION__ cron handlers — NOT agent/
  // orchestrator) so the arch emit-scanner does not require them; mapped here so
  // OBS-02 `comis explain` can reconstruct a revision/generalization run.
  // Content-free: the COUNTS ONLY (superseded/corroborated/inserted +
  // generalized/clustersConsidered + durationMs) — NEVER a profile/memory body,
  // an entryType, or a source id (SEC-01 §7).
  "learning:user_model_revised": "learning.user_model_revised",
  "learning:memory_generalized": "learning.memory_generalized",

  // ---- Background task lifecycle (T2.2 / F9) ----
  // The promote/complete/fail transitions of a long-running tool detached past the
  // execute() boundary — previously emitted but UNMAPPED (invisible to comis explain; a
  // backgrounded wait's lifecycle could only be inferred from a rollup counter). Content-
  // free: closed ids (taskId/toolName) + durationMs ONLY — never a result/error body;
  // agentId/origin are envelope correlation ids (§2.7 / H1).
  "background_task:promoted": "background_task.promoted",
  "background_task:completed": "background_task.completed",
  "background_task:failed": "background_task.failed",

  // ---- Delivery lifecycle ----
  "delivery:enqueued": "delivery.queued",
  "delivery:complete": "delivery.dispatched",

  // ---- Context engine ----
  // Context pipeline runs once per turn (pre-LLM context assembly).
  // Mapping table entry: "(executor) prompt assembled (or context layer)
  // → context.compiled". The post-LLM `context:pipeline:cache` patch
  // event is NOT mapped here; its cache fields land in this initial
  // pipeline snapshot at emit time (the producer reuses the same
  // payload-fence semantics for both events).
  "context:pipeline": "context.compiled",

  // ---- Queue / Execution / Sender ----
  // Queue lifecycle — events-channel.ts
  "queue:enqueued": "queue.enqueued",
  "queue:dequeued": "queue.dequeued",
  "queue:overflow": "queue.overflow",
  "queue:coalesced": "queue.coalesced",

  // Execution control — events-messaging.ts
  "execution:aborted": "execution.aborted",
  "execution:budget_warning": "execution.budget_warning",
  "execution:prompt_timeout": "execution.prompt_timeout",
  "execution:output_escalated": "execution.output_escalated",
  // Maps to "execution.replay_recovered" (NOT "execution.signed_replay_recovered")
  // per canonical name.
  "execution:signed_replay_recovered": "execution.replay_recovered",
  // GBNF-02 strip-retry self-heal (Phase 175). Payload is already content-free
  // (tool + keyword NAMES only, I7) — translator forwards all 4 data fields.
  "execution:tool_schema_unsupported": "execution.tool_schema_unsupported",

  // Security + Sender (scanned subset)
  // patterns[] and senderId are intentionally omitted in translatePayload.
  "security:injection_detected": "security.injection_detected",
  "sender:blocked": "sender.blocked",

  // Delivery retry (events-channel.ts; emitter packages/core/delivery — not arch-scanned)
  // chatId (Telegram long-decimal ID) and channelId are intentionally omitted.
  "retry:attempted": "delivery.retry",
  "retry:exhausted": "delivery.retry_exhausted",
  "retry:markdown_fallback": "delivery.markdown_fallback",

  // MCP server reliability (events-infra.ts; emitter packages/skills — not arch-scanned)
  "mcp:server:disconnected": "mcp.disconnected",
  "mcp:server:reconnecting": "mcp.reconnecting",
  "mcp:server:reconnect_failed": "mcp.reconnect_failed",
  "mcp:server:reconnected": "mcp.reconnected",
  "mcp:server:tools_changed": "mcp.tools_changed",

  // Channel lifecycle + health (events-channel.ts; emitter packages/channels — not arch-scanned)
  // Both channel:registered and channel:deregistered map to the same trajectory type.
  // Translator adds a synthetic `event` discriminator: "registered" | "deregistered".
  // Precedent: model:fallback_attempt + model:lkw_fallback_attempt share model.fallback_attempt.
  "channel:health_changed": "channel.health_changed",
  "channel:registered": "channel.lifecycle",
  "channel:deregistered": "channel.lifecycle",

  // Security (non-scanned emitters — packages/daemon + packages/core/security)
  // SECURITY INVARIANT: patterns[] (verbatim taint strings) and message (may reference
  // secret names/config paths) are intentionally NOT forwarded.
  "security:memory_tainted": "security.memory_tainted",
  "security:warn": "security.warn",

  // Compaction signals (events-messaging.ts; emitters in packages/agent — arch-scanned)
  // All 3 are in EVENTS_NOT_TRAJECTORY_MAPPED and must be removed when bridged.
  "compaction:started": "compaction.started",
  "compaction:flush": "compaction.flush",
  "compaction:recommended": "compaction.recommended",

  // Context engine internals (events-messaging.ts; emitters in packages/agent — arch-scanned)
  // 5 of 6 are in EVENTS_NOT_TRAJECTORY_MAPPED and must be removed when bridged.
  // context:integrity uses optional chaining (?.emit) — not in arch-test scope; no allowlist change needed.
  // W2 (obs-llm-troubleshooting): per-LLM-call budget equation from the LCD
  // pre-flight — lets obs.explain reconstruct a context_exhausted abort.
  "context:budget_computed": "context.budget",
  "context:evicted": "context.evicted",
  "context:masked": "context.masked",
  "context:reread": "context.reread",
  "context:overflow": "context.overflow",
  "context:integrity": "context.integrity",
  "context:rehydrated": "context.rehydrated",
  // OBS-01 (Phase 180): the two multilingual signals on the explain path. Not
  // yet emitted (emit sites land in 180-08) — declared/mapped here so the
  // trajectory bridge records them the moment they fire. NOT added to
  // EVENTS_NOT_TRAJECTORY_MAPPED (these are mapping entries, not allowlist entries).
  "context:script_zero_hit": "context.script_zero_hit",
  "context:summary_language_mismatch": "context.summary_language_mismatch",

  // Approval / human-in-the-loop (events-infra.ts; emitter packages/core/approval — not arch-scanned)
  // SECURITY INVARIANT: approval:requested.params is raw unconstrained tool arguments
  // (file paths, message bodies, credentials — HIGHEST risk field in the phase).
  // Translator MUST omit params entirely — sanitizeForPersistence is defense-in-depth only.
  "approval:requested": "approval.requested",
  "approval:resolved": "approval.resolved",

  // Duplicate inbound detection (events-channel.ts; emitter packages/orchestrator — arch-scanned)
  // firstSeenAt and duplicateAt omitted by translator — envelope ts covers timing.
  "dedup:duplicate_inbound": "dedup.duplicate_inbound",

  // Health budget exceeded (events-infra.ts; emitter packages/observability/health-aggregator)
  // timestamp is envelope-only — stripped from data.
  "health:budget_exceeded": "health.budget_exceeded",

  // ---- Image generation (OBS-04, Phase 186; events-media.ts) ----
  // DIRECT-emitted by the daemon image RPC handler via the per-session recorder
  // (the daemon RPC context has NO bus bridge — the comis-session-manager.ts:298
  // precedent), NOT through an eventBus.emit in packages/agent/orchestrator. The
  // mapping is declared here for trajectory-type ARCH closure (the arch test
  // enumerates it) and so a future bus emitter is wired. The `observability:
  // token_usage → model.completed` cost-carry precedent (:69) is mirrored here:
  // image.generated carries `costUsd` (OBS-03 Route a). Content-free translators
  // (translate-payload.ts) forward only ids/labels/numbers/booleans.
  "image:requested": "image.requested",
  "image:generated": "image.generated",
  "image:delivered": "image.delivered",
  "image:failed": "image.failed",

  // ---- Vision analysis (VIS-04, Phase 187; events-media.ts) ----
  // APPEND-ONLY alongside the image:* section above — never a rename (Pitfall 5;
  // the v2.17-merge gate cascade). Like image.*, these are DIRECT-emitted by the
  // daemon vision RPC handler (image.analyze / media.describe_video) via the
  // per-session recorder (NO bus bridge in the daemon RPC context); declared here
  // for trajectory-type ARCH closure + a future bus emitter. media.vision.completed
  // carries `costUsd` (VIS-04 Route a — optional, absent on registry/gemini-video).
  // Content-free translators (translate-payload.ts) forward only the
  // ids/labels/path/numbers/outcome/errorKind.
  "media.vision:requested": "media.vision.requested",
  "media.vision:completed": "media.vision.completed",
  "media.vision:failed": "media.vision.failed",

  // ---- Video generation (OBS-04, Phase 192; events-media.ts) ----
  // APPEND-ONLY alongside the image:*/media.vision:* sections above — never a
  // rename (Pitfall 8; the v2.17-merge gate cascade). Like image.*/media.vision.*,
  // these are DIRECT-emitted by the daemon video RPC handler (in-turn) AND the
  // off-turn background poller via the per-session recorder (NO bus bridge in the
  // daemon RPC/poller context); declared here for trajectory-type ARCH closure +
  // a future bus emitter ONLY. video.generated carries `costUsd` (OBS-03 Route a —
  // FAL/Veo estimate, Grok actual, optional). Content-free translators
  // (translate-payload.ts) forward only the ids/labels/numbers/outcome/errorKind.
  "video:requested": "video.requested",
  "video:submitted": "video.submitted",
  "video:generated": "video.generated",
  "video:delivered": "video.delivered",
  "video:failed": "video.failed",

  // ---- Voice STT/TTS (OBS-02/03, Phase 196; events-media.ts) ----
  // APPEND-ONLY alongside the image:*/media.vision:*/video:* sections above —
  // never a rename (Pitfall 8). Like those, these are DIRECT-emitted by the
  // daemon voice RPC handler (media.transcribe / tts.synthesize) via the
  // per-session recorder (NO bus bridge in the daemon RPC context); declared here
  // for trajectory-type ARCH closure + a future bus emitter ONLY.
  // media.*.completed carries `costUsd` (keyless = 0 explicit — OBS-05 Route a);
  // media.*.requested carries the `onSkip` reasons (OBS-03). Content-free
  // translators (translate-voice-payload.ts) forward only the
  // ids/labels/numbers/booleans/closed-enum-reasons. KEY is COLON, VALUE is DOT.
  "media.stt:requested": "media.stt.requested",
  "media.stt:completed": "media.stt.completed",
  "media.stt:failed": "media.stt.failed",
  "media.tts:requested": "media.tts.requested",
  "media.tts:completed": "media.tts.completed",
  "media.tts:failed": "media.tts.failed",
} as const satisfies Record<string, TrajectoryEventType>;

/**
 * Closed string union of every EventBus event name the bridge maps.
 * Useful for callers that want to type-narrow without re-listing.
 */
export type TrajectoryBridgedEventName = keyof typeof TRAJECTORY_BRIDGE_MAPPING;

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

/** Parameters for `attachTrajectoryToEventBus`. */
export interface AttachTrajectoryParams {
  /** Typed event bus to subscribe to. */
  readonly eventBus: TypedEventBus;
  /** Per-session recorder built by `createTrajectoryRecorder`. */
  readonly recorder: TrajectoryRecorder;
  /**
   * Optional filter: when present, only event names that pass the
   * predicate are subscribed. The predicate runs ONCE per event name
   * at attach time — it does not run per event emit.
   */
  readonly filter?: (eventName: TrajectoryBridgedEventName) => boolean;
}

/**
 * Subscribe the bridge to the given event bus. Returns a single
 * `unsubscribe` function that removes every handler registered by
 * this call.
 *
 * Per-session lifecycle: pi-executor calls this once after `formattedKey`
 * materializes; the returned `unsubscribe()` runs in the `try/finally`
 * covering the runner block.
 */
export function attachTrajectoryToEventBus(
  params: AttachTrajectoryParams,
): () => void {
  const { eventBus, recorder, filter } = params;

  // Per-handler bag so unsubscribe can pop them all in one call.
  const subscriptions: Array<{
    eventName: TrajectoryBridgedEventName;
    handler: (payload: unknown) => void;
  }> = [];

  // Type assertion narrowing: the as-const mapping makes Object.entries
  // lose precision, so iterate over the typed keys instead.
  for (const eventName of Object.keys(TRAJECTORY_BRIDGE_MAPPING) as Array<TrajectoryBridgedEventName>) {
    if (filter !== undefined && !filter(eventName)) continue;

    const handler = (payload: unknown) => {
      const data = translatePayload(eventName, payload);
      const trajectoryType = TRAJECTORY_BRIDGE_MAPPING[eventName];
      recorder.recordEvent(trajectoryType, data);
    };

    // The `on` overload requires a typed handler per event key. Cast
    // here at the trust boundary: handler is typed against `unknown`
    // and translatePayload narrows internally.
    (eventBus as TypedEventBus).on(
      eventName as keyof EventMap,
      handler as (payload: EventMap[keyof EventMap]) => void,
    );
    subscriptions.push({ eventName, handler });
  }

  return function unsubscribe(): void {
    for (const sub of subscriptions) {
      eventBus.off(
        sub.eventName as keyof EventMap,
        sub.handler as (payload: EventMap[keyof EventMap]) => void,
      );
    }
    subscriptions.length = 0;
  };
}
