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
import {
  asNumber,
  asString,
  previewAndDigest,
  relativizeDiskPath,
} from "./obs-explain-signals-fields.js";
type IncidentLearningSignal = NonNullable<IncidentSignals["learning"]>;
type LearningOutcome = NonNullable<IncidentLearningSignal["outcome"]>;
type LearningSource = IncidentLearningSignal["sources"][number];

/** Mutable state shared by the learning-record folds and the incident accumulator. */
export interface LearningFoldState {
  count: number;
  outcome?: LearningOutcome;
  everResolved: boolean;
  sources: Set<LearningSource>;
  skillsUsed: Set<string>;
  synthesisAbstained: boolean;
  skillsPromoted: number;
  skillsDemoted: number;
  failuresAttributed: number;
  skillsSurfacedButUncredited: Map<string, number>;
  skillsCreditedFromPriorTurn: Set<string>;
  skillsDemotedNames: Set<string>;
}

/** The content-free orchestrate run skeleton accumulated before tool-call joining. */
export type OrchestrateRunFold =
  Omit<NonNullable<IncidentSignals["orchestrate"]>[number], "toolCalls">;

/** One tallied, content-free tool authorization decision for an orchestrate run. */
export type OrchestrateToolCallFold =
  NonNullable<IncidentSignals["orchestrate"]>[number]["toolCalls"][number];

/** The per-node working shape the `capability.audited` fold
 *  accumulates into (one per leaseId). Materialized into
 *  `IncidentSignals["spawnTree"]` at the end of `toIncidentSignals`. */
export type SpawnNode = NonNullable<IncidentSignals["spawnTree"]>[number];

/** Collapse mutable per-tool counters into the public incident-report shape. */
export function summarizeToolStats(
  acc: Pick<Acc, "toolStats">,
): {
  toolStats: IncidentSignals["toolStats"];
  repeatedFailureCount: Record<string, number>;
  mostFailedTool?: string;
} {
  const toolStats: IncidentSignals["toolStats"] = {};
  const repeatedFailureCount: Record<string, number> = {};
  let mostFailedTool: string | undefined;
  let mostFailedCount = 0;
  for (const [tool, entry] of acc.toolStats) {
    let topErrorKind: string | undefined;
    let topCount = 0;
    for (const [kind, count] of entry.errorKinds) {
      if (count > topCount) {
        topCount = count;
        topErrorKind = kind;
      }
    }
    toolStats[tool] = {
      ok: entry.ok,
      failed: entry.failed,
      ...(entry.noOp > 0 ? { noOp: entry.noOp } : {}),
      ...(topErrorKind !== undefined ? { topErrorKind } : {}),
    };
    if (entry.failed > 0) repeatedFailureCount[tool] = entry.failed;
    if (entry.failed > mostFailedCount) {
      mostFailedCount = entry.failed;
      mostFailedTool = tool;
    }
  }
  return {
    toolStats,
    repeatedFailureCount,
    ...(mostFailedTool !== undefined ? { mostFailedTool } : {}),
  };
}

// @optional-field-count: internal mutable fold accumulator — each optional field
// is a DISTINCT terminal-record signal (breaker tool, contextBudget, rehydration, promptTimeout,
// toolSchemaUnsupported, providerErrorCode, oauthRefreshFailure, inboundEdit, responseLocale, lastRecall, spend, perRootBudget, the four media turns,
// agentId, channel) that is absent until its trajectory record class is seen. They
// are not a configuration surface; collapsing or splitting them would only obscure
// the one-fold-per-record-class structure.
export interface Acc {
  toolStats: Map<string, { ok: number; failed: number; noOp: number; errorKinds: Map<string, number> }>;
  failures: IncidentFailure[];
  breakerEvents: IncidentSignals["breakerEvents"];
  queueTimeline: NonNullable<IncidentSignals["queueTimeline"]>;
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
  /** Whether the LAST valid normalized inbound update was an edit. */
  inboundEdit?: boolean;
  /** The LAST positive counts-only earlier-group-context receipt. */
  groupHistory?: NonNullable<IncidentSignals["groupHistory"]>;
  /** The LAST valid `prompt.submitted` locale decision. */
  responseLocale?: NonNullable<IncidentSignals["responseLocale"]>;
  /** The LAST prompt's installed-but-unavailable skill facts. */
  skillAvailability?: NonNullable<IncidentSignals["skillAvailability"]>;
  /** The LAST prompt's bounded request-relevant tool names. */
  requestRelevantToolNames?: NonNullable<
    IncidentSignals["requestRelevantToolNames"]
  >;
  /** The LAST prompt's bounded relevance-history evidence. */
  requestRelevanceHistory?: NonNullable<
    IncidentSignals["requestRelevanceHistory"]
  >;
  /** The LAST pre-model clarification stop in the selected records. */
  requestClarification?: NonNullable<IncidentSignals["requestClarification"]>;
  /** The LAST prompt's content-free operator-policy tool projections. */
  operatorPolicyToolProjections?: NonNullable<
    IncidentSignals["operatorPolicyToolProjections"]
  >;
  /** The LAST valid locale-repair skip from a session summary. */
  responseLocaleRepairSkipped?: NonNullable<
    IncidentSignals["responseLocaleRepairSkipped"]
  >;
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
  /** The LAST valid `context.rehydrated` receipt. */
  rehydration?: IncidentSignals["rehydration"];
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
  /** Recalls that injected ≥1 memory scoped to a DIFFERENT user than the conversation
   *  (`crossUserCount > 0`) — the cross-sender privacy signal aggregated for the report. */
  crossUserRecalls: number;
  lastRecall?: { lanes: number; finalCount: number; rerankerAvailable: boolean; crossUserCount: number };
  /** Cache breaks folded per-reason from `cache.break` records
   *  — `{count, estCostUsd}` summed per closed reason. Counts + a number
   *  ONLY (never the changed tool names — the trajectory carries only the digest). */
  cacheBreaksByReason: Map<string, { count: number; estCostUsd: number; tokenDrop: number }>;
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
  perRootBudget?: { limb: string; spent: number; attempted?: number; cap: number; unit: string };
  /** Exact configured step ceiling from the terminal max-steps abort. */
  stepLimit?: { bindingKnob: string; stepsExecuted: number; cap: number };
  /** Bounded content-free evidence from the loop detector's terminal abort. */
  loopEvidence?: IncidentSignals["loopEvidence"];
  /** The LAST `activity.turn_finalized` record — the terminal user-surface
   *  state (strategy + effective outcome + reclassified flag). Content-free. */
  turnFinalized?: {
    strategy: string;
    outcome: string;
    errorKind?: string;
    reason?: string;
    renderErrorKind?: string;
    reclassified: boolean;
  };
  /** Session-wide finalize tally for surface states that a later finalize can
   *  hide: kept failure pills, recovered successes, and background-pending
   *  scaffold cleanup. */
  turnFinalizeCounts?: {
    failure: number;
    recovered: number;
    backgroundPending: number;
  };
  /** Σ over `memory.recall_degraded` records: how many recalls this session
   *  degraded (a lane or the whole split failed) + the last closed scope /
   *  ErrorKind labels. Content-free. */
  recallDegraded?: { count: number; lastScope: string; lastErrorKind: string };
  /** Σ over `delivery.aborted` records: events + blocks never sent. */
  deliveryAborts?: { events: number; chunksNotSent: number };
  /** The LAST valid `delivery.dispatched` terminal outcome. */
  deliveryDispatch?: IncidentSignals["deliveryDispatch"];
  /** Bounded platform response IDs from `delivery.reply_bound` records. */
  deliveryMessageIds: string[];
  /** Runtime-recovery fold from `execution.recovery_attempted` and
   *  `execution.replay_recovered` records: model re-entries and deterministic
   *  response corrections, summarized as total + succeeded tally + per-reason
   *  counts. Optional handoff counters are present only for records carrying
   *  the newer content-free request-tool evidence. */
  recoveries?: {
    total: number;
    succeeded: number;
    byReason: Record<string, number>;
    groundedResponseBeforeRecoveryCount?: number;
    groundedResponsePreservedCount?: number;
    successfulReceiptsOutsideRoute?: number;
  };
  /** Σ of the session's `session.summary` records' costUsd (one record per
   *  execution) — the trajectory-derived session cost the assembler prefers
   *  over the last-write-wins sessionEnd rollup. Absent ⇒ no summary records. */
  summaryCostUsd?: number;
  /** Σ of the session's `session.summary` records' turnCount — the
   *  trajectory-derived turn total the assembler prefers over the
   *  last-write-wins rollup turnCount. Absent ⇒ no summary records. */
  summaryTurnCount?: number;
  summaryTopErrorKinds?: IncidentSignals["summaryTopErrorKinds"];
  /** Σ of the session's `model.completed` token fields — the trajectory-derived
   *  token ledger (source of cost.totalTokens + cacheReadRatio). Absent ⇒ no
   *  model.completed records. */
  modelTokens?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  /** The LAST recognized content-free provider protocol error classification. */
  providerErrorCode?: "invalid_tool_identity";
  oauthRefreshFailure?: IncidentSignals["oauthRefreshFailure"];
  /** Per-category tally of the LLM calls the provider rejected, keyed by the
   *  closed `ErrorCategory` enum carried on `model.completed`. Absent ⇒ no
   *  errored model call in the trajectory. */
  modelErrorCounts?: Record<string, number>;
  /** The terminal
   *  `execution.aborted` record's `reason` (e.g. "spend_exceeded"). A HARD abort
   *  skips the clean `sessionEnd` rollup, so the assembler's metadata-derived
   *  `endReason` falls through to "unknown" and the spend-verdict (gated on
   *  endReason==="spend_exceeded") never fires; this lets the assembler use the
   *  abort reason as the endReason fallback. Content-free (a closed reason enum). */
  abortReason?: string;
  learning: LearningFoldState;
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
  /** Distinct turn ids from `prompt.submitted`, the authoritative one-per-agent-turn
   *  anchor. Daemon-global events may be written into an open session recorder outside
   *  request context with the session id as their fallback trace id, so arbitrary
   *  trajectory envelopes are not valid turn evidence. */
  promptTraceIds: Set<string>;
  /** Distinct turn ids from tool lifecycle records. This is the fallback for sparse
   *  historical trajectories and fixtures that predate `prompt.submitted`. */
  toolTraceIds: Set<string>;
  /** agentId from the first record envelope that carries one. */
  agentId?: string;
  /** Channel identity from the session.started record's data. */
  channel?: { type: string; id: string };
  /** Channel-health lifecycle after the first degraded transition. */
  channelHealth?: NonNullable<IncidentSignals["channelHealth"]>;
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
  subagentWait?: NonNullable<IncidentSignals["subagentWait"]>;
  routedChildPreserved?: NonNullable<IncidentSignals["routedChildPreserved"]>;
  subagentBackgroundProcessesAbandonedCount: number;
  subagentBackgroundProcessesAbandonedLastRunId?: string;
  subagentDeliverySkippedCount: number;
  subagentDeliverySkippedLastRunId?: string;
  subagentDeliverySkippedLastReason?: "no_origin" | "no_channel_params" | "route_validation_failed";
  /** Child run ids already folded across lifecycle and synchronous-wait observations. */
  subagentCompletedRunIds: Set<string>;
  subagentCompletedCount: number;
  subagentFailedCount: number;
  subagentLastFailedRunId?: string;
  backgroundRecoveryRetryCount: number;
  backgroundRecoveryByTask: Map<string, { unresolved: boolean; toolName?: string }>;
  backgroundRecoveryLastTaskId?: string;
  backgroundRecoveryLastToolName?: string;
  /** Promoted task id → originating tool, used to replace the synthetic
   * handoff success with the later authoritative terminal failure. */
  backgroundPromotionsByTask: Map<string, string>;
  /** Terminal task ids already folded; recovery redelivery must not duplicate outcomes. */
  backgroundTerminalTaskIds: Set<string>;
  backgroundCompletedTaskIds: Set<string>;
  backgroundFailedTaskIds: Set<string>;
  backgroundCancelledTaskIds: Set<string>;
  backgroundReenteredTaskIds: Set<string>;
  backgroundAcceptedTaskIds: Set<string>;
  /** Session aggregate of direct `link.prefetch` counts-only receipts. */
  linkPrefetch?: NonNullable<IncidentSignals["linkPrefetch"]>;
  /** Rejections belonging to the latest prompt-anchored turn. */
  mediaAttachmentRejections: NonNullable<
    IncidentSignals["mediaAttachmentRejections"]
  >;
}

/**
 * Get-or-create the per-tool tally. Lives with `Acc` so every fold that
 * touches `toolStats` shares one initializer.
 */
export function ensureTool(acc: Acc, tool: string): { ok: number; failed: number; noOp: number; errorKinds: Map<string, number> } {
  let entry = acc.toolStats.get(tool);
  if (entry === undefined) {
    entry = { ok: 0, failed: 0, noOp: 0, errorKinds: new Map() };
    acc.toolStats.set(tool, entry);
  }
  return entry;
}

const MISCLASS_TOKEN_RE = /"?status"?\s*:?\s*(200|403)|\b(200|403)\b|status/i;
const DO_NOT_RETRY_RE = /DO NOT retry/i;

/** Fold one legacy structured-log record into the incident accumulator. */
export function handleLogRecord(acc: Acc, rec: Record<string, unknown>): void {
  const msg = asString(rec.msg) ?? "";
  const tool = asString(rec.toolName);
  const sessionKey = asString(rec.sessionKey);
  if (sessionKey && !acc.sessionKey) acc.sessionKey = sessionKey;
  if (msg === "Tool result offloaded to disk" && tool) {
    acc.offloads.push({
      seq: acc.seq++,
      toolName: tool,
      originalChars: asNumber(rec.originalChars) ?? 0,
      pointer: relativizeDiskPath(asString(rec.diskPath)),
    });
    return;
  }
  if (msg === "Tool execution failed" && tool) {
    const entry = ensureTool(acc, tool);
    entry.failed += 1;
    const errorKind = asString(rec.errorKind) ?? "internal";
    entry.errorKinds.set(errorKind, (entry.errorKinds.get(errorKind) ?? 0) + 1);
    const errorText = asString(rec.errorText);
    const { errorPreview, resultDigest, resultBytes } = previewAndDigest(errorText);
    const httpStatus = asNumber(rec.httpStatus);
    if (errorText && DO_NOT_RETRY_RE.test(errorText)) {
      acc.hasDoNotRetrySignal = true;
      acc.breakerOpenedTool ??= tool;
      if (!acc.synthesizedBreakerTools.has(tool)) {
        acc.synthesizedBreakerTools.add(tool);
        acc.breakerEvents.push({ seq: acc.seq++, event: "opened", toolName: tool });
      }
    }
    if (errorText) {
      const match = errorText.match(MISCLASS_TOKEN_RE);
      if (match) acc.misclassTokenByTool.set(tool, match[1] ?? match[2] ?? "status");
    }
    acc.failures.push({
      seq: acc.seq++,
      toolName: tool,
      classifiedFailureBy: "",
      transportOk: false,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      errorKind,
      ...(asString(rec.failureCode) !== undefined ? { failureCode: asString(rec.failureCode) } : {}),
      resultDigest,
      resultBytes,
      errorPreview,
    });
    return;
  }
  if (tool && (rec.success === true || /succeeded/.test(msg))) {
    ensureTool(acc, tool).ok += 1;
  }
}

/** Fold a content-free OAuth refresh failure; malformed records do not erase the last valid one. */
export function accumulateOauthRefreshFailure(acc: Acc, data: Record<string, unknown>): void {
  const provider = typeof data.provider === "string" ? data.provider : undefined;
  const errorKind = typeof data.errorKind === "string" ? data.errorKind : undefined;
  const hint = typeof data.hint === "string" ? data.hint : undefined;
  if (provider === undefined || errorKind === undefined || hint === undefined) return;
  const status = typeof data.status === "number" ? data.status : undefined;
  acc.oauthRefreshFailure = { provider, errorKind, hint, ...(status !== undefined ? { status } : {}) };
}
