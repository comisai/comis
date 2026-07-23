// SPDX-License-Identifier: Apache-2.0
/**
 * The `IncidentReport` normalizer-contract interfaces — `IncidentFailure`
 * (one normalized failure entry) and `IncidentSignals` (the `toIncidentSignals`
 * output the assembler + deterministic root-cause heuristics consume).
 *
 * Split from `incident-report.ts` to keep that module under the file-size cap.
 * Barrel-only: consumers import these from `"@comis/core"` (re-exported via
 * `incident-report.ts` → `observability.ts`), so the public surface is unchanged.
 *
 * @module
 */
import type {
  IncidentContextBudget,
  IncidentContextBudgetHistoryEntry,
  IncidentCronWakeGate,
  IncidentPromptTimeout,
  SpawnTreeNode,
  OrchestrateRun,
} from "./incident-report-sections.js";

/**
 * A single normalized failure entry the assembler emits (and the bounding
 * pass trims). Mirrors `IncidentReport.failures[]` so the normalizer output
 * maps 1:1 onto the wire shape.
 */
export interface IncidentFailure {
  seq: number;
  toolName: string;
  classifiedFailureBy: string;
  transportOk: boolean;
  httpStatus?: number;
  errorKind: string;
  matchedToken?: string;
  /** The failure-detector sub-rule ("self_grade" = a clean domain task-failure
   *  via the {graded:true,outcome} self-grade envelope, vs an error-token rule) — surfaced on
   *  `explain.failures` so an honest task-failure is distinguishable from a transport error. */
  matchedRule?: string;
  resultDigest: string;
  resultBytes: number;
  errorPreview: string;
  /** The bounded+redacted argument shape the FAILED call was invoked with
   *  (from the tool.result record's `argsPreview`): secrets/PII/paths masked,
   *  each value capped (large values → "[N chars]"). Answers "what did the
   *  failed call attempt?" without a raw conversation-store dive. Absent for a
   *  failure record that carried no argsPreview (older trajectories). */
  argsPreview?: Record<string, unknown>;
}

/**
 * The normalizer output (`toIncidentSignals`) the assembler and heuristic
 * registry consume.
 *
 * One shared contract for the heuristic registry's predicates: raw per-tool
 * stats + normalized failures/breaker/offload arrays, plus the derived
 * booleans/strings the deterministic `RootCause` rules key on (breaker-opened
 * tool, "DO NOT retry" signal, most-failed tool, the content-heuristic
 * misclassification signal + offending tool/token).
 */
// @optional-field-count: 19 — this is the obs.explain signal accumulator, the
// single shared contract every root-cause heuristic
// reads. Each optional field is a presence-conditional signal aggregated from a
// distinct trajectory record class (contextBudget / promptTimeout /
// toolSchemaUnsupported / recall / cacheBreaks / spend / image / vision /
// videoGenerated / voice / learning / channel / agentId / spawnTree / orchestrate / …) — absent
// when that record class did not occur. Clustering them would couple unrelated
// heuristics; the read sites already key on each independently. Grows by one per
// observability signal class.
export interface IncidentSignals {
  sessionKey: string;
  /** agentId from the trajectory record envelopes (first seen). Fallback for
   *  reports whose metadata rollup carries no agentId. */
  agentId?: string;
  /** Channel identity from the session.started trajectory record. Fallback for
   *  reports whose metadata rollup carries no channel. */
  channel?: { type: string; id: string };
  toolStats: Record<
    string,
    { ok: number; failed: number; topErrorKind?: string }
  >;
  /** Set when a terminal/coding-CLI drive was promoted to a backgrounded
   *  drive-owner during the session — folded from `terminal.drive_promoted` trajectory
   *  records (bridged from the `terminal:drive_promoted` event).
   *  `reason` is the promotion enum (`mode_detached` | `producing`), last-wins; `count` is
   *  how many fired. Lets the terminal-drive verdict cite the backgrounding. Absent (never
   *  `{}`) when no drive backgrounded. */
  terminalDrivePromoted?: { reason: string; count: number };
  /** Set when a durable terminal drive was evicted by a reaper cap during the
   *  session — folded from `terminal.session_evicted` trajectory records (bridged from the
   *  `terminal:session_evicted` event). `reason` is the cap
   *  enum (`idle` | `max_sessions` | `wall_clock` | `max_interactions`), last-wins; `idleMs`
   *  is the session's total lifetime at eviction; `wasProducing` is DERIVED (zero new events)
   *  from whether a `producing` drive_promoted preceded it — the acute canary
   *  (a producing drive that was idle-reaped). Lets the terminal_drive_evicted verdict name a
   *  reaper-killed autonomous drive. Absent (never `{}`) when no eviction fired. */
  terminalDriveEvicted?: { reason: string; idleMs: number; wasProducing: boolean };
  /** Set when a sub-agent run was force-killed during the session — folded from
   *  `subagent.killed` trajectory records (bridged from the `subagent:killed`
   *  event, emitted at the runner's kill chokepoint). `killedBy` is the closed
   *  attribution union (`parent` | `health_monitor` | `operator` | `system`),
   *  last-wins; the numbers are the kill telemetry (idle/threshold present on
   *  health-monitor kills only). Lets the subagent_stuck_killed verdict name an
   *  autonomous stuck-kill — the child's own rollup can still read success when
   *  the kill races completion. Absent (never `{}`) when no kill fired. */
  subagentKilled?: { killedBy: string; runtimeMs?: number; idleMs?: number; thresholdMs?: number };
  /** Protected background-continuation recovery incidents folded from
   *  `background_task.notified` records whose reason is
   *  `recovery_retry_required`. Counts and stable identifiers only. */
  backgroundRecovery?: {
    retryRequiredCount: number;
    lastTaskId?: string;
    lastToolName?: string;
  };
  failures: IncidentFailure[]; // normalized, newest-first
  breakerEvents: Array<{
    seq: number;
    event: "opened" | "reset";
    toolName: string;
    consecutiveFailures?: number;
  }>;
  offloads: Array<{
    seq: number;
    toolName: string;
    originalChars: number;
    pointer: string;
  }>;
  /** Per-node token-budget breaches folded from
   *  `subagent.budget_exceeded` trajectory records — the per-incident view (capSource
   *  + the two token numbers) the IncidentReport surfaces. */
  nodeBudgetBreaches: Array<{
    seq: number;
    nodeId: string;
    capSource: "node" | "operator-default" | "inherit-share" | "unknown";
    tokenBudget: number;
    tokensUsed: number;
  }>;
  /** The spawn-tree nodes folded from `capability.audited`
   *  records — one node per `leaseId` (in-process records group under their
   *  synthetic `rootRunId`). Optional (the `recall`/`spend` presence-conditional
   *  mold): absent when the trajectory carried no `capability.audited` records, so
   *  the assembler omits the report section. Node shape: {@link SpawnTreeNode}. */
  spawnTree?: SpawnTreeNode[];
  /** The per-run orchestrate PTC runs folded from
   *  `orchestrate.run_summary` records (one entry per runId, first-seen kept), each
   *  with its `toolCalls` joined from the per-run child-leaseId `capability.audited`
   *  tally (EXPLAIN-04). Optional (the `spawnTree` presence-conditional mold): absent
   *  when the trajectory carried no run_summary records, so the assembler omits the
   *  report section. Run shape: {@link OrchestrateRun}. */
  orchestrate?: OrchestrateRun[];
  // derived booleans/strings for the heuristic registry:
  breakerOpenedTool?: string; // from a tool.breaker_opened event OR a "DO NOT retry" log line's toolName
  hasDoNotRetrySignal: boolean; // any errorText contains "DO NOT retry"
  mostFailedTool?: string;
  repeatedFailureCount: Record<string, number>;
  hasMisclassificationSignal: boolean; // ≥N success:true co-existing with ≥N "Tool execution failed" + "status"/"403"/"200" substring in an errorText
  misclassifiedTool?: string;
  misclassifiedToken?: string; // e.g. "403"|"status"|"200"
  /** Derived from `execution.tool_schema_unsupported` trajectory records
   *  (last record wins — one strip-retry per session means at most a handful).
   *  Content-free by construction: tool + keyword NAMES only. `reason`
   *  discriminates the handler branch so gate-closed and
   *  nothing-to-strip terminals stay distinguishable in the verdict; optional
   *  because a trajectory record on disk may omit it. */
  toolSchemaUnsupported?: {
    toolNames: string[];
    strippedKeywords: string[];
    retried: boolean;
    succeeded: boolean;
    reason?: "stripped" | "nothing_to_strip" | "gate_closed";
  };
  /**
   * The mapped terminal `endReason` (the NAMED degradation cause the
   * degradation detectors key on). Metadata-derived (NOT from the trajectory record
   * stream — `toIncidentSignals` omits it), so the handler threads
   * `report.outcome.endReason` onto the signals before running the registry. The
   * two lowest-priority heuristics (`context_exhausted` / `output_starved`) key
   * on it — they explain the TERMINAL state, so a tool-failure cause out-ranks
   * them. Absent ⇒ those rules do not fire (a clean session names no cause).
   */
  endReason?: string;
  /**
   * The terminal `execution.aborted` record's `reason` (e.g.
   * "spend_exceeded"), captured by `toIncidentSignals` from the trajectory. UNLIKE
   * `endReason` (metadata-derived), this IS in the record stream — so when a HARD
   * abort skipped the clean `sessionEnd` rollup (leaving metadata's endReason
   * absent), the assembler uses it as the `endReason` fallback. Without it a
   * per-root budget abort would surface endReason:"unknown" + a null spend-verdict
   * despite the trajectory carrying the limb.
   */
  abortReason?: string;
  /**
   * The report's authoritative `outcome.degraded` flag (derived by the
   * assembler from the closed HARD_FAILURE/DEGRADED end-reason sets), threaded by
   * the handler alongside `endReason`. Lets the `recall_miss` heuristic gate on
   * genuine degradation instead of re-deriving it from endReason strings (a
   * zero-hit recall on a healthy turn is benign and must never name a cause).
   * Absent ⇒ the rule does not fire.
   */
  degraded?: boolean;
  /**
   * The terminal per-call budget equation from the trajectory's
   * `context.budget` records (last wins). Lets the `context_exhausted`
   * heuristic produce a numbers-backed verdict naming the cap knob and the
   * tool-schema share instead of the generic speculation.
   */
  contextBudget?: IncidentContextBudget;
  /** The per-turn context-budget cascade toward the terminal `contextBudget` (≥2 distinct states;
   *  deduped on transition, most-recent-40 capped). The assembler folds it onto IncidentReport. */
  contextBudgetHistory?: IncidentContextBudgetHistoryEntry[];
  /**
   * The woke-fire wake-gate fact from the session's `scheduler.wake_gate`
   * trajectory record (LAST wins). Present ONLY for a fire the gate woke (a skip
   * opens no session). Content-free counts/ids/boolean. Absent ⇒ no wake-gate
   * record in the trajectory (the assembler omits it from the report).
   */
  cronWakeGate?: IncidentCronWakeGate;
  /**
   * The LAST `execution.prompt_timeout` trajectory record (the
   * terminal kill explains the end state). Lets the `prompt_timeout` heuristic
   * produce a numbers-backed verdict naming the binding knob (stall) or
   * `stallCeilingMultiplier` (makespan) instead of falling through to NO
   * verdict. Absent ⇒ no prompt-timeout record in the trajectory (the rule
   * degrades to a generic knob suggestion when `endReason` is "timeout").
   */
  promptTimeout?: IncidentPromptTimeout;
  /**
   * Memory-recall outcome aggregated over the session's `memory.recalled` +
   * `memory.recall_degraded` trajectory records. Lets the `recall_miss`
   * heuristic name a zero-hit recall on a degraded session, and surfaces a
   * DEAD/DEGRADED recall (lane or whole-split failure) with the last closed
   * scope/ErrorKind labels. Counts/booleans only. Absent ⇒ no recall records
   * in the trajectory (omitted from the report).
   */
  recall?: {
    recalls: number;
    zeroHits: number;
    lastLanes: number;
    lastFinalCount: number;
    rerankerAvailable: boolean;
    /** Recalls that injected ≥1 memory scoped to a different user than the conversation
     *  (the cross-sender privacy signal). Optional/additive (absent on pre-fix trajectories). */
    crossUserRecalls?: number;
    /** The terminal recall's cross-user injected count. Counts only — never ids/bodies. */
    lastCrossUserCount?: number;
    degraded?: number;
    lastDegradedScope?: string;
    lastDegradedErrorKind?: string;
  };
  /**
   * Cache breaks folded per-reason from the session's
   * `cache.break` trajectory records. Bounded + deterministically
   * ordered (count desc, reason asc). Counts + a closed reason label + a summed
   * est-$ ONLY (never the changed tool names). Absent ⇒ no cache breaks in the
   * trajectory (omitted from the report — the `recall?` presence-conditional mold).
   */
  cacheBreaks?: Array<{ reason: string; count: number; estCostUsd: number }>;
  /**
   * The spend kill-switch breach folded from the
   * session's terminal `spend.exceeded` trajectory record (last wins). `totalUsd`
   * is the breaching scope's spent total (the record's `spentUsd`); `capUsd` is its
   * ceiling. Content-free (a scope enum + two numbers). Absent ⇒ the session was
   * not spend-killed (omitted from the report — the `cacheBreaks?` presence mold).
   */
  spend?: { scope: string; totalUsd: number; capUsd: number };
  /**
   * The per-ROOT `autonomy.budget` limb that
   * tripped, folded from the terminal `execution.aborted` record's `perRootBudget`
   * (last wins). DISTINCT from `spend` (the priced `observability.spend` ceiling):
   * `spent`/`cap` are tokens / ms / USD per `unit`, and the knob is
   * `autonomy.budget.<limb>`. Lets the spend verdict name the exact limb. Absent ⇒
   * not a per-root spend-abort.
   */
  perRootBudget?: { limb: string; spent: number; cap: number; unit: string };
  /**
   * The LAST `activity.turn_finalized` record — the terminal user-surface
   * state the renderer painted (closed outcome kind + closed ErrorKind + a
   * fixed named-constant reason + the strategy) and the reclassified flag.
   * Absent ⇒ no finalize record in the trajectory.
   */
  turnFinalized?: {
    strategy: string;
    outcome: string;
    errorKind?: string;
    reason?: string;
    reclassified: boolean;
  };
  /**
   * Session-wide finalize tally: turns that painted a kept failure pill and
   * turns that finalized as recovered successes. The last-wins `turnFinalized`
   * snapshot above cannot answer "which turn wore the pill" mid-session.
   * Absent ⇒ no finalize records.
   */
  turnFinalizeCounts?: { failure: number; recovered: number };
  /**
   * Σ over the session's `delivery.aborted` records — aborted-delivery events
   * and the blocks they left unsent (chunksNotSent = Σ(totalChunks −
   * chunksDelivered)). Absent ⇒ no aborted deliveries.
   */
  deliveryAborts?: { events: number; chunksNotSent: number };
  /**
   * Recovery-attempt fold from `execution.recovery_attempted` records: total +
   * succeeded tally + per-reason counts. Absent ⇒ no recovery attempts.
   */
  recoveries?: { total: number; succeeded: number; byReason: Record<string, number> };
  /**
   * Σ of the session's `session.summary` records' `turnCount` — the
   * trajectory-derived turn total, preferred for `timing.turnCount` over the
   * last-write-wins rollup turnCount. Absent ⇒ no summary records.
   */
  summaryTurnCount?: number;
  /**
   * Σ of the session's `session.summary` records' `costUsd` — the
   * trajectory-derived session cost. Each summary record carries ONE
   * execution's cost, while the sessionEnd rollup is overwritten per execution
   * (last write wins), so the rollup's costUsd is the FINAL execution's cost
   * only. The assembler prefers this sum; absent ⇒ no summary records in the
   * trajectory (log-only session → rollup fallback). A single number.
   */
  summaryCostUsd?: number;
  /**
   * Σ of the session's `model.completed` records' token fields — the
   * trajectory-derived token ledger. Source for `cost.totalTokens` and
   * `cost.cacheReadRatio` (the rollup never carries a cache ratio). Counts
   * only. Absent ⇒ no model.completed records in the trajectory.
   */
  modelTokens?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /**
   * The number of distinct agent turns the trajectory spans, derived from
   * `prompt.submitted` trace ids with tool-lifecycle trace ids as the sparse-history
   * fallback. The session trajectory JSONL is append-only across
   * `session.reset_conversation` severs, so whole-session `toolStats` can be the sum
   * across many turns. Present only when greater than one.
   */
  turnCount?: number;
  /**
   * The image-generation turn reconstructed from the
   * session's `image.*` trajectory records (the terminal image.generated /
   * image.failed record wins; `delivered` set when image.delivered fired). The
   * cost (`costUsd`) rides HERE so `comis explain` shows it from the trajectory
   * — NOT `cost.costUsd` (the executor `sessionEnd`, a different code
   * path). Content-free. Absent ⇒ no image records in the trajectory.
   */
  image?: {
    provider: string;
    model?: string;
    costUsd?: number;
    outcome: "ok" | "failed";
    errorKind?: string;
    delivered: boolean;
    /** False on a persist-failed-but-delivered generation (degraded
     *  delivery, still outcome:"ok", still charged). Absent ⇒ persisted. */
    persisted?: boolean;
  };
  /**
   * The VISION turn reconstructed from the session's
   * `media.vision.*` trajectory records (the terminal media.vision.completed /
   * media.vision.failed record wins). The cost (`costUsd`) rides HERE so `comis
   * explain` shows it from the trajectory — NOT `cost.costUsd`
   * (the executor `sessionEnd`, a different code path). The `path` is the
   * "which tier served" signal. Content-free.
   * Absent ⇒ no media.vision.* records in the trajectory.
   */
  vision?: {
    provider: string;
    mainProvider?: string;
    model?: string;
    costUsd?: number;
    path?: "main-vision" | "registry" | "gemini-video" | "unavailable";
    outcome: "ok" | "failed";
    errorKind?: string;
  };
  /**
   * The VIDEO-generation turn reconstructed from the
   * session's `video.*` trajectory records (the terminal `video.generated` /
   * `video.failed` record wins; `delivered` set when `video.delivered` fired,
   * `jobId` carried from `video.submitted`). The cost rides HERE so `comis
   * explain` shows it from the trajectory (NOT `cost.costUsd`, the executor
   * `sessionEnd`, a different code path). A background-completed job's later completion stitches to its
   * originating turn via `traceId`/`jobId` on one `sessionKey` (the offline
   * assembler is the binding oracle). Content-free. Absent ⇒ no `video.*`
   * records in the trajectory.
   */
  videoGenerated?: {
    provider: string;
    model?: string;
    jobId?: string;
    costUsd?: number;
    estimatedCostUsd?: number;
    durationSecs?: number;
    outcome: "ok" | "failed";
    errorKind?: string;
    delivered: boolean;
  };
  /**
   * The VOICE turn reconstructed from the session's
   * `media.stt.*` / `media.tts.*` trajectory records (the terminal completed/
   * failed record wins). Wholly in-turn (the daemon voice RPC handlers
   * direct-emit). The cost rides HERE, from the trajectory (NOT `cost.costUsd`,
   * the executor `sessionEnd`, a different code path):
   * `0` explicit on keyless ("free" stays visible), absent on keyed (no per-call
   * source). `source` is the resolved selection rung. Content-free. Absent
   * ⇒ no `media.stt.*`/`media.tts.*` records in the trajectory.
   */
  voice?: {
    provider: string;
    keyless: boolean;
    model?: string;
    durationMs?: number;
    costUsd?: number;
    source?: "explicit" | "keyless-local" | "follow-main-key" | "fallback";
    outcome: "ok" | "failed";
    errorKind?: string;
  };
  /**
   * The outcome-signal telemetry reconstructed from the
   * session's `learning.outcome_observed` trajectory records (counts/ids/closed
   * enums ONLY — the bridged record carries no body/alpha/recalled-ids).
   * `outcomeResolved` is false ⇒ the learning shadow observed this finished
   * trajectory but no signal tier produced a resolvable outcome (the
   * `outcome_unresolved` verdict keys on exactly this — distinct from an explicit
   * `unknown` outcome, which IS a resolution). `skillsUsed`/`skillFailures` are
   * currently always empty and `synthesisAbstained` always false (skill-use
   * attribution and synthesis are not implemented). Absent ⇒ no learning records
   * in the trajectory (omitted from the report — the signal is per-agent default-OFF).
   */
  learning?: {
    outcomeResolved: boolean;
    outcome?: "success" | "failure" | "corrected" | "unknown";
    sources: Array<"tool" | "pipeline" | "correction" | "judge" | "reaction" | "explicit">;
    skillsUsed: string[];
    skillFailures: string[];
    synthesisAbstained: boolean;
    /** Count of candidate skills promoted to active this session (`learning.skill_promoted`). */
    skillsPromoted?: number;
    /** Count of skills demoted this session (`learning.skill_demoted`). */
    skillsDemoted?: number;
    /** Memories that accrued a corroborated failure this session (`learning.memory_failure_attributed`) — eviction precursor. */
    failuresAttributed?: number;
  };
}
