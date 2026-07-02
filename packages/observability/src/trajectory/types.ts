// SPDX-License-Identifier: Apache-2.0
import type { ComisLogger } from "@comis/core";

/**
 * Trajectory event v1 schema — closed type union + payload shape.
 *
 * The trajectory is a per-session JSONL sidecar capturing the
 * model-visible state changes for a single agent run. Each event is
 * one JSONL line; the file is bounded (`maxRuntimeFileBytes`) and the
 * payload is bounded per-event (`maxRuntimeEventBytes`) — see
 * `runtime.ts` for the runtime contract.
 *
 * Closed enum invariant: `TRAJECTORY_EVENT_TYPES` is a literal `as const`
 * tuple so consumers can enumerate it at test time. The architecture
 * test `trajectory-event-types-known.test.ts` walks every
 * `eventBus.emit(...)` site and asserts each emitted name is either:
 *   1. mapped through `TRAJECTORY_BRIDGE_MAPPING` to one of these
 *      `TrajectoryEventType` values, or
 *   2. explicitly listed in the `EVENTS_NOT_TRAJECTORY_MAPPED`
 *      allowlist.
 *
 * Comis improvements over the OpenClaw original:
 *   - `agentId`, `tenantId`, `entryId`, `parentEntryId` — multi-tenant
 *     correlation across artifacts (cache-trace, system-prompt-report,
 *     config-audit) within the same session.
 *   - `traceSchema: "comis-trajectory"` + `schemaVersion: 1` — explicit
 *     schema fence so downstream parsers can reject foreign artifacts.
 *
 * @module
 */

/**
 * Closed enum of trajectory event types (45 total).
 *
 * Order is deliberate (life-cycle: session.* → prompt → model → tool →
 * skill → memory → delivery → lifecycle envelopes → control-plane sentinel).
 * Append-only — insertion order is part of the SemVer contract for v1.
 */
export const TRAJECTORY_EVENT_TYPES = [
  // Session lifecycle (one start + one end per agent run + one health rollup).
  "session.started",
  "session.ended",
  // F2 (D5): per-session health rollup emitted once at agent-end.
  "session.summary",

  // Context compilation outcome (one per turn; not always present).
  "context.compiled",

  // Prompt-submission boundary (one per turn before model call).
  "prompt.submitted",

  // Model results / fallbacks / cooldown.
  "model.completed",
  "model.fallback_attempt",
  "model.fallback_exhausted",
  "model.auth_cooldown",

  // Tool lifecycle.
  "tool.call",
  "tool.result",
  "tool.timeout",
  "tool.policy_filtered",
  // D3 breaker transitions (Phase 151).
  "tool.breaker_opened",
  "tool.breaker_reset",
  // D7 result offload (Phase 151).
  "tool.result_offloaded",

  // Skill invocation observability.
  "skill.prompt_loaded",
  "skill.prompt_invoked",
  // IMP-3 / PD-OBS-1: per-turn used-skill attribution (inline-surfaced reuse credit; ids + count only).
  "memory.skill_used",
  // Finding A: per-turn topic-match reuse census (surfaced-but-uncredited near-misses; names + numbers).
  "memory.skill_surfaced",

  // Memory injection observability.
  "memory.injected",
  // RECALL-01: per-recall lane/candidate/final counts + rerank outcome (content-free).
  "memory.recalled",
  "memory.reranked",
  // GENQ-01: a memory-generation pass's output diverged from its source (content-free).
  "memory.generation_quality",
  // PERSIST-01 (Phase 176 Plan 04): a detected prompt-cache break on the per-session
  // timeline — the closed reason + tokenDrop counts + a changed-dims DIGEST ONLY,
  // NEVER the tool-name arrays or system text (content-free, H1/I3).
  "cache.break",
  // OUTCOME-08 (v2.26 Verified Learning WS1): a finished trajectory's resolved net
  // task-outcome (daemon-side emit, learningOutcome.enabled-gated). Counts/ids/closed-enums
  // ONLY — no bodies/alpha (SEC-01). Bridged so `comis explain` can reconstruct it (OBS-02).
  "learning.outcome_observed",
  // FORGET-06 (v2.26 WS4): the lifecycle sweep demoted / soft-evicted N memories — counts
  // ONLY (daemon-side emit). Bridged for `comis explain` (OBS-02). (The RANK-06
  // memory.online_tuning_applied bandit type was removed in Phase 224 — the UCB
  // online-tuning bandit was deleted; recall is fixed-RRF.)
  "learning.memory_demoted",
  "learning.memory_evicted",
  "learning.memory_failure_attributed", // OBS-4b: corroborated-failure accrual (the eviction-causation precursor)
  // REFLECT (v2.31, Phase 226 SIMPLIFY-04): the reflection-run funnel telemetry, RENAMED
  // from the old synthesis-funnel types. reflect.admitted = admitted-doc count; reflect.funnel
  // = synthesized/validated/admitted + maxClusterCardinality + the admissionOutcome closed-enum
  // (counts only). Answers "why was 0 admitted" from the trajectory (maxClusterCardinality:1 =
  // uncorroborated → not admissible). Daemon-side emit; bridged for `comis explain` (OBS-02).
  // The vestigial sandbox-validation type was REMOVED in the same lockstep.
  "reflect.admitted",
  "reflect.funnel",
  // SURFACE-06 (v2.26 WS2, Phase 202): the promote/demote telemetry — the COUNT ONLY,
  // NEVER an id-list / procedure body / script (SEC-01). Daemon-side emit (Plan 05);
  // bridged for `comis explain` (OBS-02).
  "learning.skill_promoted",
  "learning.skill_demoted",
  // Phase 226 SIMPLIFY-04: the user-rep-revision + generalization types were DELETED with
  // their 0-emit events (those paths folded into the reflection engine in Phase 225).

  // TELEM-01 (v2.27 P1, Phase 173): a `pipeline` tool invocation was authored —
  // the reserved trajectory type for the counts-only pipeline:authored event
  // (action / capabilityClass tier / schemaValid / repaired). Mirrors the
  // memory.generation_quality triple. Content-free: closed enums + booleans ONLY,
  // never a pipeline body / type_config value / node task (§2.7 / H1). The bridge
  // mapping reserves this type for arch closure (every EventMap member is
  // mapped-or-allowlisted); the live per-session recordEvent emit is a documented
  // deferred follow-up (getRecorder is not reachable on the graph-handler deps at
  // P1 — the FLEET aggregate, Plan 03/04, is the P1 deliverable).
  "pipeline.authored",

  // AUTHOR-01/02 (v2.27 P2, Phase 174): the reserved trajectory types for the two
  // counts-only authoring-AUDIT events Plans 03/04 emit on a conservative repair /
  // intent-synthesis. APPEND-ONLY beside pipeline.authored. Content-free: closed
  // canonical-template pattern enum + numeric nodeCount (+ tier on repaired) ONLY,
  // never a graph body / type_config value / node task / intent text (§2.7 / H1).
  // Daemon-side emit (graph-helpers.ts); bridged for arch closure + `comis explain`.
  "graph.repaired",
  "graph.synthesized_from_intent",

  // STEER-01 (v2.27 P3, Phase 175): the reserved trajectory type for the
  // counts-only subagent:steered event Plan 02 emits when a running child is
  // steered in-flight (transcript preserved) instead of kill+respawn. APPEND-ONLY
  // beside the AUTHOR-01/02 types. Content-free: runId + the closed-union mode
  // (steer|followup) ONLY, never the steer message body (§2.7 / H1). Daemon-side
  // emit (subagent-handlers.ts); bridged for OPERATOR TRAJECTORY VISIBILITY
  // (`comis explain`).
  "subagent.steered",

  // ORCH-OBS (orchestration-observability): the reserved trajectory types for three
  // previously-dark sub-agent-lifecycle events — a fail-closed sandbox-downgrade spawn
  // refusal (SANDBOX-02), a dead-lettered sub-agent delivery (DELIVERY-02), and a
  // per-node token-budget breach (BUDGET-03). APPEND-ONLY beside subagent.steered.
  // Bridged for per-session `comis explain` visibility (the subagent.steered
  // daemon-side precedent); content-free: closed dimension/channel/capSource labels +
  // ids/numbers ONLY, NEVER a path/host/uid value, an announcement body, or a task
  // (§2.7 / H1). sandbox_downgrade_refused fires WITHIN the spawning session (clean
  // landing); the other two ride whichever session bridge is active when they fire.
  "security.sandbox_downgrade_refused",
  "subagent.delivery_deadlettered",
  // OE-6b (orchestration-excellence-20260701-fullregression): the self-healing transient
  // RETRY — the sibling of subagent.delivery_deadlettered. Emitted by the announcement-batcher
  // via `?.emit` (which the trajectory-event-types-known arch regex missed pre-fix), so it was
  // bridged to NOTHING while its terminal sibling was fully wired — P0-B's self-heal was invisible
  // to `comis explain` (spec §7/§10 + the "all 7 bridged" claim). Content-free: runId + closed
  // channelType + attempt count + the transient tag ONLY — never an announcement body / error string.
  "subagent.delivery_retried",
  "subagent.budget_exceeded",

  // AUDIT-01 / TREE (v2.29 Phase 215 Plan 01): the per-capability authorization
  // decision for a gated call — the spawn-tree's per-node producer (Plan 03's
  // TREE fold groups these by leaseId). DAEMON-emitted (rpc-dispatch.ts /
  // setup-capability-endpoint.ts), bridged for operator trajectory visibility +
  // arch closure (the subagent.budget_exceeded precedent). Content-free: caps +
  // tool NAME + method + decision + lease/root ids ONLY, NEVER the tool.invoke
  // args, a message body, or a secret name (§2.7 / H1 / T-215-01). In-process
  // records honestly omit leaseId/parentLeaseId/tool (no lease, G1).
  "capability.audited",

  // TREE-01 (finding D, 30uc-20260624): a graph DAG node spawn — the per-graph-node
  // spawn-tree producer. A graph node spawns in-process (gatedSpawn) and never crosses
  // the socket chokepoint that emits capability.audited, so without this the spawn-tree
  // omitted the graph children. DAEMON-emitted (graph-node-lifecycle.ts); the
  // signals fold keys it by graphId:nodeId. Content-free: graph/node ids + child
  // agentId + rootRunId + the per-node token cap ONLY — NEVER the node task or output.
  "graph.node_spawned",

  // Background task lifecycle (T2.2 / F9): promote/complete/fail of a long-running tool
  // detached past the execute() boundary (content-free — ids + durationMs only).
  "background_task.promoted",
  "background_task.completed",
  "background_task.failed",

  // Terminal-driver drive lifecycle (DRIVE-02): a long coding-CLI drive crossed the
  // inline→detached boundary and was backgrounded (reason: mode_detached | producing).
  // Content-free — the reason enum only.
  "terminal.drive_promoted",

  // Terminal-driver reaper eviction (EVICT-01): a durable drive was evicted by a cap
  // (idle-TTL | max_sessions | wall_clock | max_interactions). Content-free — the reason
  // enum + durationMs (total lifetime at eviction). Was a daemon WARN only; bridged so
  // `explain` can name a reaper-killed autonomous drive (the PRODUCING-01 obs completion).
  "terminal.session_evicted",

  // Delivery queue lifecycle.
  "delivery.queued",
  "delivery.dispatched",

  // Lifecycle envelopes. Direct-emit by the agent executor — NOT via the
  // EventBus bridge.
  "trace.metadata",
  "trace.artifacts",

  // Control-plane sentinel: writer ran out of room mid-stream.
  "trace.truncated",
  // Control-plane sentinel: queued writer rejected one or more lines
  // (e.g., symlinked parent, ENOSPC). Emitted at flushAndClose when
  // QueuedFileWriter.failureCount() > 0.
  "trace.write_failures",

  // Queue lifecycle
  "queue.enqueued",
  "queue.dequeued",
  "queue.overflow",
  "queue.coalesced",

  // Execution control
  "execution.aborted",
  "execution.budget_warning",
  "execution.prompt_timeout",
  "execution.output_escalated",
  "execution.replay_recovered",
  // GBNF-02 strip-retry self-heal (Phase 175): content-free counts/names only.
  "execution.tool_schema_unsupported",

  // Security + sender (scanned subset)
  "security.injection_detected",
  "sender.blocked",

  // Delivery retry
  "delivery.retry",
  "delivery.retry_exhausted",
  "delivery.markdown_fallback",

  // MCP server reliability
  "mcp.disconnected",
  "mcp.reconnecting",
  "mcp.reconnect_failed",
  "mcp.reconnected",
  "mcp.tools_changed",

  // Channel lifecycle + health
  // channel.lifecycle is shared by channel:registered and channel:deregistered
  // (dual-mapping; translator adds synthetic event discriminator).
  "channel.health_changed",
  "channel.lifecycle",

  // Security rest
  "security.memory_tainted",
  "security.warn",

  // Compaction
  "compaction.started",
  "compaction.flush",
  "compaction.recommended",

  // Context engine
  "context.budget",
  "context.evicted",
  "context.masked",
  "context.reread",
  "context.overflow",
  "context.integrity",
  "context.rehydrated",
  // OBS-01 (Phase 180): the two multilingual signals on the explain timeline.
  "context.script_zero_hit",
  "context.summary_language_mismatch",

  // Approval / human-in-the-loop
  "approval.requested",
  "approval.resolved",

  // Dedup
  "dedup.duplicate_inbound",

  // Health budget
  "health.budget_exceeded",

  // Session transcript.
  // Synthesized by buildTranscriptEvents in export.ts when the bundle
  // exporter merges session JSONL branch entries with runtime events.
  // The SDK SessionEntry.type is not in this closed union — it is carried
  // verbatim in data.entryType so downstream consumers can branch on it.
  // One literal covers all SDK entry types.
  "session.transcript.entry",

  // OBS-04 (Phase 186): image-generation lifecycle on the explain timeline.
  // Direct-emitted by the daemon image RPC handler via the per-session recorder
  // (the daemon RPC context has NO EventBus bridge — direct-emit is the
  // sanctioned path, the comis-session-manager.ts:298 precedent). Content-free:
  // ids/labels/counts/costUsd/booleans ONLY — never the prompt, image bytes, a
  // key, or a raw provider message (T-186-08). `image.generated` carries
  // `costUsd` so `comis explain` reconstructs the image turn's cost (OBS-03).
  "image.requested",
  "image.generated",
  "image.delivered",
  "image.failed",

  // VIS-04 (Phase 187): vision-analysis lifecycle on the explain timeline.
  // Direct-emitted by the daemon vision RPC handler (image.analyze /
  // media.describe_video) via the per-session recorder (the daemon RPC context
  // has NO EventBus bridge — direct-emit is the sanctioned path, the
  // image-handlers.ts:210 precedent). APPEND-ONLY alongside the SemVer-frozen
  // image.* tuple above — never a rename (Pitfall 5). Content-free:
  // ids/labels/path/costUsd/outcome/errorKind ONLY — never the image bytes, the
  // analysis prompt, the model answer, or a key (T-187-12). The `path` label is
  // VIS-03's "which path" signal; `media.vision.completed` carries `costUsd`
  // (optional — absent on the registry/gemini-video tiers) so `comis explain`
  // reconstructs the vision turn's cost (Route a).
  "media.vision.requested",
  "media.vision.completed",
  "media.vision.failed",

  // OBS-04 (Phase 192): video-generation lifecycle on the explain timeline.
  // Direct-emitted by the daemon video RPC handler (in-turn) AND the off-turn
  // background poller (setup-video-poller.ts) via the per-session recorder (the
  // daemon RPC/poller context has NO EventBus bridge — direct-emit is the
  // sanctioned path, the image-handlers.ts:210 precedent). APPEND-ONLY alongside
  // the SemVer-frozen image.*/media.vision.* tuples above — never a rename
  // (Pitfall 8). Content-free: ids/labels/counts/costUsd/outcome/errorKind/
  // booleans ONLY — never the prompt, video bytes, a key, the Veo keyed-URL, or a
  // raw provider message (T-192-01). `video.generated` carries `costUsd` so
  // `comis explain` reconstructs the video turn's cost (OBS-03 Route a),
  // INCLUDING a job that completed in the background after the turn ended.
  "video.requested",
  "video.submitted",
  "video.generated",
  "video.delivered",
  "video.failed",

  // OBS-02/03 (Phase 196): voice (STT/TTS) lifecycle on the explain timeline.
  // Direct-emitted by the daemon voice RPC handler (media.transcribe /
  // tts.synthesize) via the per-session recorder (the daemon RPC context has NO
  // EventBus bridge — direct-emit is the sanctioned path, the
  // image-handlers.ts:210 precedent). APPEND-ONLY alongside the SemVer-frozen
  // image.*/media.vision.*/video.* tuples above — never a rename (Pitfall 8).
  // Content-free: provider/keyless/model/durationMs/audioBytes/costUsd/source/
  // onSkip/outcome/errorKind ONLY — never the audio bytes, the transcript, the
  // synthesized audio, or a key (T-196-04). `media.*.completed` carries `costUsd`
  // (keyless = 0 explicit; keyed omitted — OBS-05 Route a) and `media.*.requested`
  // carries the `onSkip` reasons (OBS-03 — WHY auto picked the rung) so `comis
  // explain` reconstructs the voice turn including the selection provenance.
  "media.stt.requested",
  "media.stt.completed",
  "media.stt.failed",
  "media.tts.requested",
  "media.tts.completed",
  "media.tts.failed",

  // WR-4 (177-obs-loop): the spend kill-switch lifecycle on the explain timeline.
  // Previously the 3 observability:spend_* events were allowlisted as fleet-only
  // rollups (NOT on the trajectory) — so a spend-killed session's WARNING / ABORT /
  // UNPRICEABLE signals never reached `comis explain` or the deterministic verdict,
  // the security-review WR-4 blind spot. Now bridged. Content-free: the closed
  // SpendScopeKind enum + dollar amounts as NUMBERS + provider/model config ids
  // ONLY — never a message/prompt/query body (§2.7 / H1; the milestone invariant).
  "spend.warning",
  "spend.exceeded",
  "spend.unpriceable",
] as const;

/** Closed union of trajectory event type strings. */
export type TrajectoryEventType = (typeof TRAJECTORY_EVENT_TYPES)[number];

/**
 * Trajectory event source.
 *
 * - `"runtime"`    — emitted live by `createTrajectoryRecorder` during agent execution.
 * - `"transcript"` — emitted by the bundle exporter when merging session JSONL transcript
 *                   entries with runtime events.
 * - `"export"`     — emitted by the bundle exporter for synthesized records.
 *
 * On-disk JSONL files written before this widening lack ambient
 * "transcript"/"export" values — readers tolerate the narrower set per the
 * additive schema policy.
 */
export type TrajectoryEventSource = "runtime" | "transcript" | "export";

/**
 * Trajectory event — one record per JSONL line.
 *
 * - `traceSchema` + `schemaVersion`: parser fence (v1 is the only
 *   currently-shipped schema).
 * - `source`: who produced this event (`"runtime"` for live recorder emits).
 * - `traceId`: AsyncLocalStorage trace ID; falls back to `sessionId`
 *   when no trace is in flight (e.g., startup-time emit).
 * - `entryId` / `parentEntryId`: per-event UUIDs for graph correlation
 *   across artifacts. `parentEntryId` is set when an event derives
 *   from a parent (e.g., `tool.result.parentEntryId === tool.call.entryId`).
 * - `seq`: monotonic per-file counter (1-indexed) — per-session monotonic
 *   across all turns in the session (does NOT reset between turns).
 * - `provider` / `modelId` / `modelApi` / `workspaceDir`: optional envelope-level
 *   metadata copied from `TrajectoryRecorderInit` when defined.
 * - `data`: typed payload (after `sanitizeForPersistence`).
 *
 * Envelope-vs-data discipline: `traceId`, `agentId`, `sessionId`,
 * `sessionKey` are envelope-only — they MUST NOT be duplicated into `data`.
 */
export interface TrajectoryEvent {
  readonly traceSchema: "comis-trajectory";
  readonly schemaVersion: 1;
  readonly source: TrajectoryEventSource;
  readonly type: TrajectoryEventType;
  readonly ts: string;
  readonly seq: number;

  // Correlation IDs.
  readonly agentId: string;
  readonly tenantId?: string;
  readonly sessionId: string;
  readonly sessionKey?: string;
  readonly traceId: string;
  readonly runId?: string;
  readonly workspaceDir?: string;

  // Model metadata (lifted from TrajectoryRecorderInit when defined).
  readonly provider?: string;
  readonly modelId?: string;
  readonly modelApi?: string | null;

  readonly entryId: string;
  /** Parent event ID for DAG reconstruction.
   *  Populated by the session-DAG writer.
   *  `null` distinguishes "explicit root" from "missing". */
  readonly parentEntryId?: string | null;

  /** Source-relative monotonic position. Used by the bundle
   *  exporter as a tiebreak when merging runtime + transcript events with
   *  identical `ts`. */
  readonly sourceSeq?: number;

  // Payload — passed through `sanitizeForPersistence` before write.
  // Shape is intentionally `Record<string, unknown>` (envelope-vs-data contract);
  // `sanitizeForPersistence` always returns an object-shaped value.
  readonly data?: Record<string, unknown>;
}

/**
 * Recorder construction inputs.
 *
 * `sessionFile` is the per-session JSONL pointer (when available); the
 * trajectory file lives alongside it (`<sessionFile>.trajectory.jsonl`).
 * When `sessionFile` is missing the recorder falls back to
 * `${COMIS_TRAJECTORY_DIR ?? cwd}/<safeSessionId>.trajectory.jsonl`.
 *
 * The optional budgets default to:
 *   - `maxRuntimeEventBytes = 256 * 1024`
 *   - `maxRuntimeFileBytes = 50 * 1024 * 1024`
 *   - `maxQueuedBytes = 4 * 1024 * 1024`
 *   - `sentinelReserveBytes = 2 * 1024` (head-room reserved inside the
 *     file budget for the `trace.truncated` sentinel emit).
 *
 * `enabled = false` causes `createTrajectoryRecorder` to return `null`
 * (no-op contract; consumers null-check). The env override
 * `COMIS_TRAJECTORY=0` short-circuits the same way.
 */
/**
 * Optional byte-budget overrides clustered into a single `budgets` field.
 * Cluster (rule of three) keeps `TrajectoryRecorderInit`'s optional
 * field count ≤12 (architecture invariant — see
 * test/architecture/optional-field-bloat.test.ts). Operators usually
 * only override `maxFileBytes` via `diagnostics.trajectory.maxFileBytes`;
 * the remaining fields are tuning knobs for tests and edge cases.
 */
export interface TrajectoryRecorderBudgets {
  /** Per-event byte cap. Default 256 KB. */
  readonly maxRuntimeEventBytes?: number;
  /** Per-file byte cap. Default 50 MB. */
  readonly maxRuntimeFileBytes?: number;
  /** Per-writer queued byte cap. Default 4 MB. */
  readonly maxQueuedBytes?: number;
  /** Head-room reserved inside file cap for trace.truncated emit. Default 2 KB. */
  readonly sentinelReserveBytes?: number;
  /**
   * Soft capture cap: recording stops inline (trace.truncated emitted) when
   * writtenBytes would cross this threshold. Default TRAJECTORY_RUNTIME_CAPTURE_MAX_BYTES
   * (10 MB). Overridable per-recorder for tests. Must be ≤ maxRuntimeFileBytes.
   */
  readonly captureMaxBytes?: number;
}

export interface TrajectoryRecorderInit {
  /** Multi-tenant agent identifier. Required. */
  readonly agentId: string;
  /** Tenant ID for multi-tenant deployments. Optional (defaults to "default" in payload). */
  readonly tenantId?: string;
  /** Session identifier — used as the sessionId field on every event. */
  readonly sessionId: string;
  /** Formatted session key (joins tenant/user/channel). Optional surface for trajectory consumers. */
  readonly sessionKey?: string;
  /** Per-run identifier (one per execute() invocation). Optional. */
  readonly runId?: string;
  /** Path to the session JSONL file. Trajectory lives alongside as <sessionFile>.trajectory.jsonl. */
  readonly sessionFile?: string;
  /** Agent workspace directory — used as last-resort base for path resolution. */
  readonly workspaceDir?: string;
  /**
   * Model-metadata cluster (provider id + model id + model API). Adding
   * `modelApi` at the top level would push
   * TrajectoryRecorderInit past the ≤12-optional-fields architecture
   * invariant — clustering the three model identifiers into one
   * optional field collapses three slots into one. Resolver in
   * `runtime.ts` reads `init.model?.provider`, `init.model?.modelId`,
   * `init.model?.modelApi` and lifts each onto the trajectory envelope
   * when defined.
   */
  readonly model?: {
    /** Provider id (e.g., "anthropic"). */
    readonly provider?: string;
    /** Model id (e.g., "claude-sonnet-4-20250514"). */
    readonly modelId?: string;
    /** Model API (e.g., "messages", "responses"). `null` permitted. */
    readonly modelApi?: string | null;
  };

  /** Override for the trajectory base directory (precedes COMIS_TRAJECTORY_DIR). */
  readonly trajectoryDir?: string;

  // Convenience top-level overrides (forwarded to budgets when set):
  /** Per-file byte cap shortcut. Forwarded to budgets.maxRuntimeFileBytes. */
  readonly maxRuntimeFileBytes?: number;

  /** Cluster of optional byte budgets — see TrajectoryRecorderBudgets. */
  readonly budgets?: TrajectoryRecorderBudgets;

  /**
   * Optional logger for emitting operator-facing diagnostics from within
   * the recorder. When provided, the hard-cap branch (step 4b in
   * `recordEvent`) emits a single WARN with `errorKind:"resource"` and
   * a hint pointing to `observability.logRotation`. The WARN fires at
   * most once per recorder lifetime (guarded by an internal flag).
   *
   * Omit in tests that do not need log-level assertions; the recorder
   * degrades gracefully to the existing `droppedEvents()` counter.
   *
   * Uses `ComisLogger` from `@comis/core` (structural contract, no
   * coupling to `@comis/infra`) — consistent with the pattern in
   * `packages/observability/src/system-prompt-report/persist.ts`.
   */
  readonly logger?: ComisLogger;

  /**
   * Enable/disable. Default true. When false `createTrajectoryRecorder`
   * returns null (no-op contract). Env `COMIS_TRAJECTORY=0` also
   * short-circuits to null.
   */
  readonly enabled?: boolean;

  /**
   * Opt-in real-path confinement base forwarded to the underlying
   * queued writer (and from there to `appendRegularFile`). Production
   * callers (daemon trajectory wiring) pass
   * `path.join(os.homedir(), ".comis")` so an ancestor-symlink escape
   * is rejected before the open() call. Tests omit it (default
   * `undefined`) to keep tmp-dir paths legal.
   */
  readonly confinedBaseDir?: string;
}

/**
 * Parameters for the public `trace.truncated` emit hook.
 *
 * Used by:
 *   - Internal close-time sentinel emit in `flushAndClose` (passes
 *     `reason: "file-or-queue-cap-exceeded"`).
 *   - Bounded-payload writer (passes reasons like
 *     `"trajectory-runtime-file-size-limit"`).
 */
export interface TraceTruncatedParams {
  /** Human-readable reason code. E.g. "file-or-queue-cap-exceeded",
   *  "trajectory-runtime-file-size-limit", "trajectory-event-byte-limit". */
  readonly reason: string;
  /** Running total of dropped events at the time of the call. */
  readonly droppedEvents: number;
  /** Total dropped bytes (cumulative). Omitted when not yet tracked. */
  readonly droppedEventBytes?: number;
  /** The file or event limit that was hit, in bytes. Omitted when not applicable. */
  readonly limitBytes?: number;
}

/**
 * Writer interface returned by `createTrajectoryRecorder`. A no-op
 * disabled state is conveyed via a `null` return — consumers null-check
 * once at the construction site.
 *
 * `recordEvent` is fire-and-forget: it returns a Result with `"queued"`
 * or `"dropped"` (the latter when the per-writer queued-bytes cap would
 * be exceeded). The writer does not throw on disk-write failures.
 *
 * `flush` awaits the underlying queue tail. `flushAndClose` additionally
 * emits the `trace.truncated` sentinel if any events were dropped, then
 * closes the writer.
 */
export interface TrajectoryRecorder {
  /** Resolved on-disk path of the trajectory file. */
  readonly filePath: string;

  /**
   * Enqueue one event. `type` must be a closed-union TrajectoryEventType.
   * `data` is passed through `sanitizeForPersistence` before write.
   * When `data` exceeds `maxRuntimeEventBytes` after sanitization the
   * entire event is replaced with a single-key sentinel record.
   *
   * `data` is typed `Record<string, unknown> | undefined` to match the
   * envelope-vs-data contract. Pass `undefined` (or omit) when there is no
   * payload — bridge translators that intentionally produce no
   * correlation data still hand back an object so consumers can grep
   * by key.
   *
   * Returns "queued" on accept, "dropped" when the per-writer queue cap
   * would be exceeded (operator-tunable backpressure).
   */
  recordEvent(
    type: TrajectoryEventType,
    data?: Record<string, unknown>,
    parentEntryId?: string,
  ): "queued" | "dropped";

  /** Await the queue tail. */
  flush(): Promise<void>;

  /**
   * Await the queue tail, emit the `trace.truncated` sentinel if any
   * events were dropped during this recorder's lifetime, and remove
   * the writer from the registry.
   */
  flushAndClose(): Promise<void>;

  /**
   * Emit a `trace.truncated` event with operator-supplied reason and
   * bound metadata. Used to signal bound-exhaustion at any write-time
   * location, NOT only at close.
   *
   * The internal close-time sentinel emit in flushAndClose calls the
   * SAME codepath with reason `"file-or-queue-cap-exceeded"`.
   *
   * Returns "queued" on accept, "dropped" when the per-writer queue
   * cap is exceeded.
   */
  emitTraceTruncated(params: TraceTruncatedParams): "queued" | "dropped";

  /**
   * Returns the running count of events dropped by this recorder (both
   * soft-cap and hard-cap drops). Observable counter — callers at
   * lifecycle-envelope emit sites can read this to detect silent drops.
   *
   * Incremented on each call to `recordEvent` that returns `"dropped"`.
   */
  droppedEvents(): number;
}
