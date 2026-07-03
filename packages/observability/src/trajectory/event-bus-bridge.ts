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
  // Breaker transitions.
  "tool:breaker_opened": "tool.breaker_opened",
  "tool:breaker_reset": "tool.breaker_reset",
  // Result offload.
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
  // The per-turn used-skill attribution — the INLINE-surfaced reuse credit.
  // Bridged so the credit shows on a one-call `comis explain`. AGENT-emitted (postExecution) → it IS
  // arch-scanned, so it is NOT in the arch allowlist (the disjoint invariant). Content-free: opaque skill
  // ids + count ONLY (same id-class as skill.prompt_invoked.skillName; never a procedure body).
  "memory:skill_used": "memory.skill_used",

  // The full per-turn topic-match reuse CENSUS,
  // so a surfaced-but-uncredited NEAR-MISS is diagnosable (memory:skill_used only fires on a
  // credit). Content-free: skill NAMES (id-class) + coverage/sharedCount NUMBERS + flags — never a
  // procedure body. Mapped, so NOT in the arch NOT-MAPPED allowlist (disjoint invariant).
  "memory:skill_surfaced": "memory.skill_surfaced",

  // ---- Session + prompt lifecycle ----
  "prompt:submitted": "prompt.submitted",
  "session:started": "session.started",
  "session:ended": "session.ended",
  // Per-session health rollup emitted once at agent-end.
  "session:summary": "session.summary",
  "memory:injected": "memory.injected",
  // The per-recall lane/candidate/final counts +
  // rerank outcome. Content-free (counts/booleans only).
  "memory:recalled": "memory.recalled",
  "memory:reranked": "memory.reranked",

  // A memory-generation pass (consolidation /
  // reasoning / user-representation) produced output whose quality diverged from
  // its source. Emitted only on an issue. Content-free (closed
  // enums + booleans); the source/generated body never crosses the bus.
  "memory:generation_quality": "memory.generation_quality",

  // A detected prompt-cache
  // break (15 CacheBreakReason values), emitted in packages/agent. Bridged so the
  // cost-relevant break shows on the per-session timeline beside the
  // obs_diagnostics category:'cache_break' row. Content-free (the closed reason + the
  // tokenDrop/relative counts + a changed-dims DIGEST); the translator drops
  // the toolsAdded/Removed/SchemaChanged tool-NAME arrays and the system text entirely.
  "observability:cache_break": "cache.break",

  // A `pipeline` tool invocation was authored —
  // counts-only (action / capabilityClass tier / schemaValid / repaired). Mapped
  // here for trajectory-type ARCH closure (every EventMap member is mapped-or-
  // allowlisted) and to reserve the `pipeline.authored` trajectory type. The live
  // per-session recordEvent emit is a DEFERRED follow-up: `getRecorder` is
  // NOT reachable on the graph-handler deps (it rides the image-handler slice, not
  // the createGraphHandlers spread). Content-free (closed enums + booleans);
  // no pipeline body / type_config value / node task crosses the bus.
  "pipeline:authored": "pipeline.authored",

  // The two authoring-AUDIT events
  // emitted DAEMON-SIDE on a conservative repair / intent-synthesis.
  // APPEND-ONLY beside pipeline:authored. Mapped here for trajectory-type
  // ARCH closure (every EventMap member is mapped-or-allowlisted) + to reserve the
  // graph.repaired / graph.synthesized_from_intent trajectory types. NOTE: these
  // emit from @comis/daemon (graph-helpers.ts), so the trajectory-event-types-known
  // arch gate — which walks only packages/agent + packages/orchestrator — does not
  // require them; the registration is for consistency with pipeline:authored AND
  // arch-test closure of the keyof TrajectoryBridgedEventName. Content-free (closed
  // enums + numbers); no graph body / type_config / node task / intent text
  // crosses the bus.
  "graph:repaired": "graph.repaired",
  "graph:synthesized_from_intent": "graph.synthesized_from_intent",

  // A running sub-agent was steered IN-FLIGHT (a
  // high-priority message injected at the child's next step boundary, transcript
  // preserved) instead of kill+respawn. Emitted DAEMON-SIDE at the inject site
  // (subagent-handlers.ts), so the trajectory-event-types-known arch gate
  // — which walks only packages/agent + packages/orchestrator — does NOT require it
  // (the unmapped subagent:budget_exceeded precedent); the registration here is
  // purely for OPERATOR TRAJECTORY VISIBILITY (a steer is a meaningful per-session
  // event in `comis explain`), mirroring the graph:repaired entry above. Content-free
  // (runId + the closed-union mode steer|followup); the steer MESSAGE BODY never
  // crosses the bus.
  "subagent:steered": "subagent.steered",

  // Three sub-agent-lifecycle
  // events bridged for per-session `comis explain` visibility (the subagent:steered
  // precedent). security:sandbox_downgrade_refused is agent-emitted (sub-agent-runner.ts)
  // and fires WITHIN the spawning session → lands cleanly in that trajectory;
  // subagent:delivery_deadlettered (orchestrator) + subagent:budget_exceeded (daemon
  // coordinator) ride whichever session bridge is active. Content-free translators
  // (translate-orchestration-payload.ts) forward closed labels/ids/numbers ONLY — never
  // a path/host/uid value, an announcement body, or a task. These ALSO feed
  // the fleet lens via obs-persistence-wiring (the daemon-wide aggregate surface).
  "security:sandbox_downgrade_refused": "security.sandbox_downgrade_refused",
  "subagent:delivery_deadlettered": "subagent.delivery_deadlettered",
  // The self-healing transient RETRY
  // — the sibling of subagent:delivery_deadlettered. Emitted by the announcement-batcher
  // via `?.emit`. Bridged here for
  // per-session visibility (how many retries a completion took before landing). Content-free
  // (translate-orchestration-payload.ts): runId + closed channelType + attempt count + transient tag
  // ONLY. NOTE: unlike its deadlettered sibling, retried is trajectory-only for now (NOT yet a fleet
  // health_signal/finding — a self-healed retry as a daemon-wide aggregate is a follow-up).
  "subagent:delivery_retried": "subagent.delivery_retried",
  "subagent:budget_exceeded": "subagent.budget_exceeded",

  // The per-capability authorization
  // decision for a gated call (allow + deny) — the spawn-tree's per-node
  // producer (the tree fold groups these by leaseId). DAEMON-emitted
  // (rpc-dispatch.ts / setup-capability-endpoint.ts), so the trajectory-event-
  // types-known arch gate — which walks only packages/agent + packages/
  // orchestrator — does NOT require it (the subagent:budget_exceeded daemon-
  // emitted precedent); the registration here is for OPERATOR TRAJECTORY
  // VISIBILITY (`comis explain` spawn tree) + arch closure of the keyof
  // TrajectoryBridgedEventName. Content-free (translate-orchestration-payload.ts):
  // caps + tool NAME + decision + lease/root ids ONLY — NEVER the tool.invoke
  // args, a message body, or a secret name.
  "capability:audited": "capability.audited",

  // A graph DAG node spawn — the spawn-tree's
  // per-graph-node producer. A graph node spawns in-process (gatedSpawn) and never
  // crosses the socket chokepoint that emits capability:audited, so without this the
  // `comis explain` spawn-tree showed only the root. DAEMON-emitted (graph-node-
  // lifecycle.ts), so the agent/orchestrator emit-scanner arch gate does not require
  // it (the subagent:budget_exceeded / capability:audited daemon-emitted precedent).
  // Content-free (translate-orchestration-payload.ts): graph/node ids + child agentId
  // + rootRunId + the per-node token cap ONLY — NEVER a node task or output.
  "graph:node_spawned": "graph.node_spawned",

  // A finished trajectory's resolved net
  // task-outcome, emitted DAEMON-SIDE after OutcomeSignalPort.resolve (learningOutcome.
  // enabled-gated, default OFF). DAEMON emit (NOT agent/orchestrator) so the arch
  // emit-scanner does not require it; mapped here so `comis explain` can
  // reconstruct it. Content-free: ids/counts/closed-enums ONLY (no body/alpha).
  "learning:outcome_observed": "learning.outcome_observed",

  // The lifecycle-sweep soft-eviction
  // telemetry. learning:memory_* are daemon emit (NOT arch-scanned). Counts/ids/closed-enums
  // ONLY — never a memory body. Mapped here so `comis explain` can reconstruct
  // them.
  "learning:memory_demoted": "learning.memory_demoted",
  "learning:memory_evicted": "learning.memory_evicted",
  "learning:memory_failure_attributed": "learning.memory_failure_attributed",

  // The reflection-run funnel telemetry (reflect:admitted / reflect:funnel).
  // Both DAEMON-emitted (the reflection cron
  // handler, NOT agent/orchestrator) after runReflection → the arch emit-scanner does
  // not require them; mapped here so `comis explain` can reconstruct a
  // reflection run. The forget (learning:memory_*) + outcome (learning:outcome_observed)
  // events KEEP their learning:* names. Content-free: counts (synthesized/
  // validated/admitted) + maxClusterCardinality + the admissionOutcome closed-enum ONLY
  // — NEVER a doc body, a script, or a finding.
  "reflect:admitted": "reflect.admitted",
  "reflect:funnel": "reflect.funnel",

  // The skill promote/demote
  // telemetry. Both DAEMON-emitted (the promote/demote loop — NOT agent/
  // orchestrator) so the arch emit-scanner does not require them; mapped here so
  // `comis explain` can reconstruct a promotion/demotion. Content-free: the COUNT ONLY —
  // NEVER an id-list, a procedure body, or a script. They fold into the
  // shared { count } translator case (translate-payload.ts).
  "learning:skill_promoted": "learning.skill_promoted",
  "learning:skill_demoted": "learning.skill_demoted",

  // ---- Background task lifecycle ----
  // The promote/complete/fail transitions of a long-running tool detached past the
  // execute() boundary. Content-free: closed ids (taskId/toolName) + durationMs ONLY —
  // never a result/error body; agentId/origin are envelope correlation ids.
  "background_task:promoted": "background_task.promoted",
  "background_task:completed": "background_task.completed",
  "background_task:failed": "background_task.failed",

  // ---- Terminal drive lifecycle ----
  // A long coding-CLI drive backgrounded at the inline→detached boundary.
  // Content-free (the reason enum only — see translate-payload). Emitted from packages/skills,
  // which the trajectory-event arch test does NOT scan (it walks agent+orchestrator),
  // so this mapping is what the bridge relies on to record it.
  "terminal:drive_promoted": "terminal.drive_promoted",

  // The reaper evicted a durable drive (idle-TTL / max_sessions / wall_clock /
  // max_interactions cap). Bridged so `explain` can name a reaper-killed autonomous
  // drive (otherwise an idle-reap that stranded a producing drive root-caused nothing).
  // Content-free (reason enum + durationMs — see translate-payload). Emitted from the
  // daemon reaper wiring (setup-terminal-tools) AND packages/skills, both OUTSIDE the
  // agent/orchestrator emit-scanner, so — like drive_promoted — no arch allowlist entry
  // is needed; this mapping is the bridge.
  "terminal:session_evicted": "terminal.session_evicted",

  // A completed `orchestrate` run's content-free per-run summary. Emitted from
  // the orchestrate TOOL (packages/skills), which the trajectory-event arch test
  // does NOT scan (it walks agent+orchestrator) — so, like drive_promoted, this
  // mapping is what the bridge relies on to record it (no arch allowlist entry).
  // Content-free (translate-orchestration-payload.ts): ids + the closed
  // failureClass enum + counts + token estimates ONLY — NEVER the stderr tail,
  // the script body, or tool params (which stay on the bounded tool-error surface).
  "orchestrate:run_summary": "orchestrate.run_summary",

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
  // GBNF strip-retry self-heal. Payload is already content-free
  // (tool + keyword NAMES only) — translator forwards all 4 data fields.
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
  // Per-LLM-call budget equation from the LCD
  // pre-flight — lets obs.explain reconstruct a context_exhausted abort.
  "context:budget_computed": "context.budget",
  "context:evicted": "context.evicted",
  "context:masked": "context.masked",
  "context:reread": "context.reread",
  "context:overflow": "context.overflow",
  "context:integrity": "context.integrity",
  "context:rehydrated": "context.rehydrated",
  // The two multilingual signals on the explain path — declared/mapped here
  // (ahead of the emit sites) so the
  // trajectory bridge records them the moment they fire. NOT added to
  // EVENTS_NOT_TRAJECTORY_MAPPED (these are mapping entries, not allowlist entries).
  "context:script_zero_hit": "context.script_zero_hit",
  "context:summary_language_mismatch": "context.summary_language_mismatch",

  // Approval / human-in-the-loop (events-infra.ts; emitter packages/core/approval — not arch-scanned)
  // SECURITY INVARIANT: approval:requested.params is raw unconstrained tool arguments
  // (file paths, message bodies, credentials — the highest-risk field here).
  // Translator MUST omit params entirely — sanitizeForPersistence is defense-in-depth only.
  "approval:requested": "approval.requested",
  "approval:resolved": "approval.resolved",

  // Duplicate inbound detection (events-channel.ts; emitter packages/orchestrator — arch-scanned)
  // firstSeenAt and duplicateAt omitted by translator — envelope ts covers timing.
  "dedup:duplicate_inbound": "dedup.duplicate_inbound",

  // Health budget exceeded (events-infra.ts; emitter packages/observability/health-aggregator)
  // timestamp is envelope-only — stripped from data.
  "health:budget_exceeded": "health.budget_exceeded",

  // ---- Image generation (events-media.ts) ----
  // DIRECT-emitted by the daemon image RPC handler via the per-session recorder
  // (the daemon RPC context has NO bus bridge — the comis-session-manager.ts:298
  // precedent), NOT through an eventBus.emit in packages/agent/orchestrator. The
  // mapping is declared here for trajectory-type ARCH closure (the arch test
  // enumerates it) and so a future bus emitter is wired. The `observability:
  // token_usage → model.completed` cost-carry precedent (:69) is mirrored here:
  // image.generated carries `costUsd`. Content-free translators
  // (translate-payload.ts) forward only ids/labels/numbers/booleans.
  "image:requested": "image.requested",
  "image:generated": "image.generated",
  "image:delivered": "image.delivered",
  "image:failed": "image.failed",

  // ---- Vision analysis (events-media.ts) ----
  // APPEND-ONLY alongside the image:* section above — never a rename. Like image.*,
  // these are DIRECT-emitted by the
  // daemon vision RPC handler (image.analyze / media.describe_video) via the
  // per-session recorder (NO bus bridge in the daemon RPC context); declared here
  // for trajectory-type ARCH closure + a future bus emitter. media.vision.completed
  // carries `costUsd` (optional, absent on registry/gemini-video).
  // Content-free translators (translate-payload.ts) forward only the
  // ids/labels/path/numbers/outcome/errorKind.
  "media.vision:requested": "media.vision.requested",
  "media.vision:completed": "media.vision.completed",
  "media.vision:failed": "media.vision.failed",

  // ---- Video generation (events-media.ts) ----
  // APPEND-ONLY alongside the image:*/media.vision:* sections above — never a
  // rename. Like image.*/media.vision.*,
  // these are DIRECT-emitted by the daemon video RPC handler (in-turn) AND the
  // off-turn background poller via the per-session recorder (NO bus bridge in the
  // daemon RPC/poller context); declared here for trajectory-type ARCH closure +
  // a future bus emitter ONLY. video.generated carries `costUsd` (FAL/Veo estimate,
  // Grok actual, optional). Content-free translators
  // (translate-payload.ts) forward only the ids/labels/numbers/outcome/errorKind.
  "video:requested": "video.requested",
  "video:submitted": "video.submitted",
  "video:generated": "video.generated",
  "video:delivered": "video.delivered",
  "video:failed": "video.failed",

  // ---- Voice STT/TTS (events-media.ts) ----
  // APPEND-ONLY alongside the image:*/media.vision:*/video:* sections above —
  // never a rename. Like those, these are DIRECT-emitted by the
  // daemon voice RPC handler (media.transcribe / tts.synthesize) via the
  // per-session recorder (NO bus bridge in the daemon RPC context); declared here
  // for trajectory-type ARCH closure + a future bus emitter ONLY.
  // media.*.completed carries `costUsd` (keyless = 0 explicit);
  // media.*.requested carries the `onSkip` reasons. Content-free
  // translators (translate-voice-payload.ts) forward only the
  // ids/labels/numbers/booleans/closed-enum-reasons. KEY is COLON, VALUE is DOT.
  "media.stt:requested": "media.stt.requested",
  "media.stt:completed": "media.stt.completed",
  "media.stt:failed": "media.stt.failed",
  "media.tts:requested": "media.tts.requested",
  "media.tts:completed": "media.tts.completed",
  "media.tts:failed": "media.tts.failed",

  // The spend kill-switch's three signals. AGENT-emitted
  // (pi-event-bridge.ts), so they ARE arch-scanned. Mapped here (and NOT in the
  // arch allowlist — the disjoint invariant) so a spend-killed session is
  // diagnosable via `comis explain`. The terminal ABORT is ALSO on the
  // trajectory via execution:aborted(reason:"spend_exceeded"); these carry the
  // per-scope $ counts the verdict needs. Content-free translators forward the
  // closed SpendScopeKind enum + dollar NUMBERS + provider/model config ids ONLY
  // — never a message/prompt/query body.
  "observability:spend_warning": "spend.warning",
  "observability:spend_exceeded": "spend.exceeded",
  "observability:spend_unpriceable": "spend.unpriceable",
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
