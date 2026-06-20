// SPDX-License-Identifier: Apache-2.0
/**
 * The internal mutable accumulator for `toIncidentSignals` (obs-explain-signals.ts):
 * every record handler folds into this, and it is collapsed into the public
 * `IncidentSignals` at the end. Extracted to keep obs-explain-signals.ts under the
 * obs-handlers per-subdirectory file-size cap (the ORCH-OBS nodeBudgetBreaches field
 * pushed it over). Type-only; no behavior change.
 *
 * @module
 */
import type {
  IncidentContextBudget,
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
import type { LearningFoldState } from "./obs-explain-signal-folds.js";

export interface Acc {
  toolStats: Map<string, { ok: number; failed: number; errorKinds: Map<string, number> }>;
  failures: IncidentFailure[];
  breakerEvents: IncidentSignals["breakerEvents"];
  offloads: IncidentSignals["offloads"];
  nodeBudgetBreaches: IncidentSignals["nodeBudgetBreaches"];
  breakerOpenedTool?: string;
  hasDoNotRetrySignal: boolean;
  /** Tools for which a log-shape breaker "opened" event was already synthesized
   * (dedup — the breaker opens once per tool even across repeated DO-NOT-retry
   * lines). Structured tool.breaker_opened events are NOT deduped here (they are
   * explicit telemetry, one push each). */
  synthesizedBreakerTools: Set<string>;
  /** Per-tool: did any failure body carry a status/200/403 token? */
  misclassTokenByTool: Map<string, string>;
  /** W3: the LAST context.budget trajectory record (the terminal fit check). */
  contextBudget?: IncidentContextBudget;
  /** LAT-04: the LAST execution.prompt_timeout record (the terminal kill
   *  explains the end state — a retry-path kill earlier in the session is
   *  superseded by the kill that actually ended it). */
  promptTimeout?: IncidentPromptTimeout;
  /** GBNF-02: the LAST `execution.tool_schema_unsupported` record — the
   *  strip-retry self-heal outcome (one strip-retry per session means at most
   *  a handful; the terminal repair state explains the end). */
  toolSchemaUnsupported?: IncidentSignals["toolSchemaUnsupported"];
  /** RECALL-01: aggregated over `memory.recalled` records — how many recalls ran,
   *  how many returned zero injected memories, and the TERMINAL recall's shape. */
  recallCount: number;
  recallZeroHits: number;
  lastRecall?: { lanes: number; finalCount: number; rerankerAvailable: boolean };
  /** PERSIST-01 (176-05): cache breaks folded per-reason from `cache.break` records
   *  (Plan 04) — `{count, estCostUsd}` summed per closed reason. Counts + a number
   *  ONLY (never the changed tool names — the trajectory carries only the digest). */
  cacheBreaksByReason: Map<string, { count: number; estCostUsd: number }>;
  learning: LearningFoldState; // OBS-02 (198): see obs-explain-learning-fold.ts
  /** The image (186) / vision (187) / video (192) / voice (196) turns reconstructed
   *  from the session's image.* / media.vision.* / video.* / media.stt / media.tts
   *  records (folded by `applyMediaRecord`). Each is undefined until its record class
   *  is seen. The paired *OutcomeSeq makes each fold seq-aware (IN-04 — a stale
   *  lower-seq terminal never overwrites a newer one). */
  image?: IncidentImageSignal;
  imageOutcomeSeq: number;
  vision?: IncidentVisionSignal;
  visionOutcomeSeq: number;
  video?: IncidentVideoSignal;
  videoOutcomeSeq: number;
  voice?: IncidentVoiceSignal;
  voiceOutcomeSeq: number;
  /** W8: event-shape tool.result toolCallIds already counted (dedup — the same
   *  call must not count twice if its result event is duplicated across sources). */
  seenToolResultCallIds: Set<string>;
  /** W8: agentId from the first record envelope that carries one. */
  agentId?: string;
  /** W8: channel identity from the session.started record's data. */
  channel?: { type: string; id: string };
  sessionKey: string;
  seq: number;
}
