// SPDX-License-Identifier: Apache-2.0
/**
 * The internal mutable accumulator for `toIncidentSignals` (obs-explain-signals.ts):
 * every record handler folds into this, and it is collapsed into the public
 * `IncidentSignals` at the end. Extracted to keep obs-explain-signals.ts under the
 * obs-handlers per-subdirectory file-size cap (the nodeBudgetBreaches field
 * pushed it over). Type-only; no behavior change.
 *
 * @module
 */
import type {
  IncidentContextBudget,
  IncidentContextBudgetHistoryEntry,
  IncidentFailure,
  IncidentPromptTimeout,
  IncidentSignals,
} from "@comis/core";
import type {
  IncidentImageSignal,
  IncidentVisionSignal,
  IncidentVideoSignal,
  IncidentVoiceSignal,
} from "./obs-explain-signals-fields.js";
import type {
  LearningFoldState,
  OrchestrateRunFold,
  OrchestrateToolCallFold,
} from "./obs-explain-signal-folds.js";

/** The per-node working shape the `capability.audited` fold
 *  accumulates into (one per leaseId). Materialized into
 *  `IncidentSignals["spawnTree"]` at the end of `toIncidentSignals`. */
export type SpawnNode = NonNullable<IncidentSignals["spawnTree"]>[number];

// @optional-field-count: internal mutable fold accumulator — each optional field
// is a DISTINCT terminal-record signal (breaker tool, contextBudget, promptTimeout,
// toolSchemaUnsupported, lastRecall, spend, perRootBudget, the four media turns,
// agentId, channel) that is absent until its trajectory record class is seen. They
// are not a configuration surface; collapsing or splitting them would only obscure
// the one-fold-per-record-class structure.
export interface Acc {
  toolStats: Map<string, { ok: number; failed: number; errorKinds: Map<string, number> }>;
  failures: IncidentFailure[];
  breakerEvents: IncidentSignals["breakerEvents"];
  offloads: IncidentSignals["offloads"];
  nodeBudgetBreaches: IncidentSignals["nodeBudgetBreaches"];
  /** The `capability.audited` fold groups nodes by leaseId
   *  (in-process records key on the synthetic rootRunId). Materialized into
   *  `spawnTree` at the end; absent → the section is omitted. */
  spawnNodesByLease: Map<string, SpawnNode>;
  /** The `orchestrate.run_summary` fold groups runs by runId (first-seen kept).
   *  Materialized (with joined toolCalls) into `orchestrate` at the end of
   *  toIncidentSignals; absent → the section is omitted. */
  orchestrateRunsByRunId: Map<string, OrchestrateRunFold>;
  /** The per-run tool-call tally from `capability.audited`, keyed by the PER-RUN
   *  child leaseId → the `${tool} ${capability} ${decision}` tuple → count. Joined
   *  onto each run's `toolCalls` at materialization (EXPLAIN-04: the per-run leaseId
   *  attributes a deny to THE RUN). */
  orchestrateToolCallsByLease: Map<string, Map<string, OrchestrateToolCallFold>>;
  breakerOpenedTool?: string;
  hasDoNotRetrySignal: boolean;
  /** Tools for which a log-shape breaker "opened" event was already synthesized
   * (dedup — the breaker opens once per tool even across repeated DO-NOT-retry
   * lines). Structured tool.breaker_opened events are NOT deduped here (they are
   * explicit telemetry, one push each). */
  synthesizedBreakerTools: Set<string>;
  /** Per-tool: did any failure body carry a status/200/403 token? */
  misclassTokenByTool: Map<string, string>;
  /** The LAST context.budget trajectory record (the terminal fit check). */
  contextBudget?: IncidentContextBudget;
  /** The per-turn context-budget CASCADE (the progression toward `contextBudget`). Deduped on
   *  transition + most-recent-40 capped (see the context.budget fold). Surfaced only when ≥2 states. */
  contextBudgetHistory: IncidentContextBudgetHistoryEntry[];
  /** The LAST `scheduler.wake_gate` record (a woke fire's content-free wake-gate
   *  fact). Present ONLY for a fire the gate woke — a skip opens no session. */
  cronWakeGate?: IncidentSignals["cronWakeGate"];
  /** The LAST execution.prompt_timeout record (the terminal kill
   *  explains the end state — a retry-path kill earlier in the session is
   *  superseded by the kill that actually ended it). */
  promptTimeout?: IncidentPromptTimeout;
  /** The LAST `execution.tool_schema_unsupported` record — the
   *  strip-retry self-heal outcome (one strip-retry per session means at most
   *  a handful; the terminal repair state explains the end). */
  toolSchemaUnsupported?: IncidentSignals["toolSchemaUnsupported"];
  /** Aggregated over `memory.recalled` records — how many recalls ran,
   *  how many returned zero injected memories, and the TERMINAL recall's shape. */
  recallCount: number;
  recallZeroHits: number;
  lastRecall?: { lanes: number; finalCount: number; rerankerAvailable: boolean };
  /** Cache breaks folded per-reason from `cache.break` records
   *  — `{count, estCostUsd}` summed per closed reason. Counts + a number
   *  ONLY (never the changed tool names — the trajectory carries only the digest). */
  cacheBreaksByReason: Map<string, { count: number; estCostUsd: number }>;
  /** The LAST `spend.exceeded` trajectory record's breach
   *  (the terminal kill explains the end state — a warn earlier in the session is
   *  superseded by the breach that actually killed it). `totalUsd` is the record's
   *  `spentUsd`; `capUsd` its ceiling. Content-free (a scope enum + two numbers). */
  spend?: { scope: string; totalUsd: number; capUsd: number };
  /** The per-ROOT autonomy.budget limb that tripped (from the terminal
   *  `execution.aborted` record's `perRootBudget`). DISTINCT from `spend` (the
   *  priced observability.spend $-ceiling): the token / wall-clock limbs carry
   *  tokens / ms in `spent`/`cap` (NOT dollars), and the right knob is
   *  `autonomy.budget.<limb>`, not `observability.spend.*`. Content-free. */
  perRootBudget?: { limb: string; spent: number; cap: number; unit: string };
  /** The LAST `activity.turn_finalized` record — the terminal user-surface
   *  state (strategy + effective outcome + reclassified flag). Content-free. */
  turnFinalized?: { strategy: string; outcome: string; errorKind?: string; reason?: string; reclassified: boolean };
  /** Session-wide finalize tally: how many turns painted a kept failure pill
   *  and how many finalized as recovered successes — the last-wins snapshot
   *  above cannot answer "which turn wore the pill" mid-session. */
  turnFinalizeCounts?: { failure: number; recovered: number };
  /** Σ over `memory.recall_degraded` records: how many recalls this session
   *  degraded (a lane or the whole split failed) + the last closed scope /
   *  ErrorKind labels. Content-free. */
  recallDegraded?: { count: number; lastScope: string; lastErrorKind: string };
  /** Σ over `delivery.aborted` records: events + blocks never sent. */
  deliveryAborts?: { events: number; chunksNotSent: number };
  /** Recovery-attempt fold from `execution.recovery_attempted` records:
   *  total + succeeded tally + per-reason counts. */
  recoveries?: { total: number; succeeded: number; byReason: Record<string, number> };
  /** Σ of the session's `session.summary` records' costUsd (one record per
   *  execution) — the trajectory-derived session cost the assembler prefers
   *  over the last-write-wins sessionEnd rollup. Absent ⇒ no summary records. */
  summaryCostUsd?: number;
  /** Σ of the session's `session.summary` records' turnCount — the
   *  trajectory-derived turn total the assembler prefers over the
   *  last-write-wins rollup turnCount. Absent ⇒ no summary records. */
  summaryTurnCount?: number;
  /** Σ of the session's `model.completed` token fields — the trajectory-derived
   *  token ledger (source of cost.totalTokens + cacheReadRatio). Absent ⇒ no
   *  model.completed records. */
  modelTokens?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /** The terminal
   *  `execution.aborted` record's `reason` (e.g. "spend_exceeded"). A HARD abort
   *  skips the clean `sessionEnd` rollup, so the assembler's metadata-derived
   *  `endReason` falls through to "unknown" and the spend-verdict (gated on
   *  endReason==="spend_exceeded") never fires; this lets the assembler use the
   *  abort reason as the endReason fallback. Content-free (a closed reason enum). */
  abortReason?: string;
  learning: LearningFoldState; // see obs-explain-signal-folds.ts
  /** The image / vision / video / voice turns reconstructed
   *  from the session's image.* / media.vision.* / video.* / media.stt / media.tts
   *  records (folded by `applyMediaRecord`). Each is undefined until its record class
   *  is seen. The paired *OutcomeSeq makes each fold seq-aware (a stale
   *  lower-seq terminal never overwrites a newer one). */
  image?: IncidentImageSignal;
  imageOutcomeSeq: number;
  vision?: IncidentVisionSignal;
  visionOutcomeSeq: number;
  video?: IncidentVideoSignal;
  videoOutcomeSeq: number;
  voice?: IncidentVoiceSignal;
  voiceOutcomeSeq: number;
  /** Event-shape tool.result toolCallIds already counted (dedup — the same
   *  call must not count twice if its result event is duplicated across sources). */
  seenToolResultCallIds: Set<string>;
  /** The distinct turn ids (envelope `traceId`,
   *  one per agent turn) seen in the trajectory. The session trajectory JSONL is
   *  APPEND-ONLY across `session.reset_conversation` severs, so a single file (and the
   *  whole-session `toolStats` derived from it) can span MANY turns — counting these
   *  lets the report flag the tool counts as cumulative-across-N-turns rather than
   *  this-turn (the near-miss that cost a cycle: a `toolStats` count read as one turn
   *  was actually the sum across several). */
  turnTraceIds: Set<string>;
  /** agentId from the first record envelope that carries one. */
  agentId?: string;
  /** Channel identity from the session.started record's data. */
  channel?: { type: string; id: string };
  sessionKey: string;
  seq: number;
  /** The LAST `terminal.drive_promoted` reason seen (mode_detached |
   *  producing), and how many promotions fired. Folded into `terminalDrivePromoted`. */
  terminalDrivePromotedReason?: string;
  terminalDrivePromotedCount: number;
  /** The LAST `terminal.session_evicted` reason (idle | max_sessions |
   *  wall_clock | max_interactions) + the session lifetime at that eviction. Folded into
   *  `terminalDriveEvicted`; `wasProducing` is derived from `terminalDrivePromotedReason`. */
  terminalDriveEvictedReason?: string;
  terminalDriveEvictedMs?: number;
  /** The LAST `subagent.killed` record's closed attribution + kill telemetry
   *  (runtime always; idle/threshold on health-monitor kills). Folded into
   *  `subagentKilled` for the subagent_stuck_killed verdict. */
  subagentKilledBy?: string;
  subagentKilledRuntimeMs?: number;
  subagentKilledIdleMs?: number;
  subagentKilledThresholdMs?: number;
}
