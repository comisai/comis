// SPDX-License-Identifier: Apache-2.0
/**
 * The `obs.explain` contract: the `IncidentReport` wire schema + shape
 * types + the `ObsExplainContract` itself. Extracted from `observability.ts`
 * to keep that module under the file-size cap.
 *
 * Barrel-only: external consumers import these from `"@comis/core"`. The
 * `observability.ts` barrel re-exports them (and the `OBSERVABILITY_CONTRACTS`
 * array pulls `ObsExplainContract` in from here) so the public surface and the
 * registered RPC contract set are unchanged.
 *
 * Handler: packages/daemon/src/api/obs-handlers/obs-explain.ts
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";
// The section sub-schemas live in a sibling module (file-size cap). Imported
// locally for use in IncidentReportSchema/IncidentSignals AND re-exported below
// so the public barrel surface is unchanged.
import {
  IncidentContextBudgetSchema,
  IncidentContextBudgetHistoryEntrySchema,
  IncidentCronWakeGateSchema,
  IncidentPromptTimeoutSchema,
  SpawnTreeNodeSchema,
  OrchestrateRunSchema,
} from "./incident-report-sections.js";
import type {
  IncidentContextBudget,
  IncidentContextBudgetHistoryEntry,
  IncidentCronWakeGate,
  IncidentPromptTimeout,
  SpawnTreeNode,
  OrchestrateRun,
} from "./incident-report-sections.js";

/**
 * The `IncidentReport` wire shape (the `obs.explain` response).
 *
 * A self-contained, redaction-safe post-mortem for a single agent session:
 * outcome, cost, timing, per-tool stats, normalized failures (newest-first),
 * the circuit-breaker timeline, large-result offloads, a one-paragraph
 * summary, a deterministic `likelyRootCause` (heuristic registry),
 * report-level next steps, and an honest `truncations[]` ledger (the
 * bounding pass records what it dropped).
 *
 * Field bounding (≤200-char `errorPreview`, digest-only `resultDigest`, the
 * 6 KB summary budget) is ENFORCED by the bounding pass — this schema
 * only declares the shape. `suggestedNextSteps` appears BOTH inside
 * `likelyRootCause` (matching the heuristic `RootCause` 1:1) and at the report
 * root (report-level guidance); both are required-or-default.
 */
// Re-export the section sub-schemas + types (imported above) so the public
// barrel (observability.ts → @comis/core) and all consumers are unchanged after
// the file-size split.
export {
  IncidentContextBudgetSchema,
  IncidentCronWakeGateSchema,
  IncidentPromptTimeoutSchema,
  SpawnTreeNodeSchema,
  OrchestrateRunSchema,
};
export type { IncidentContextBudget, IncidentContextBudgetHistoryEntry, IncidentCronWakeGate, IncidentPromptTimeout, SpawnTreeNode, OrchestrateRun };

export const IncidentReportSchema = z.object({
  schemaVersion: z.literal(1),
  sessionKey: z.string(),
  traceId: z.string(),
  agentId: z.string(),
  channel: z.object({ type: z.string(), id: z.string() }),
  outcome: z.object({
    endReason: z.string(),
    degraded: z.boolean(),
    severity: z.enum(["ok", "degraded", "failed"]),
  }),
  cost: z.object({
    costUsd: z.number(),
    totalTokens: z.number(),
    cacheReadRatio: z.number(),
  }),
  timing: z.object({
    durationMs: z.number(),
    turnCount: z.number(),
  }),
  toolStats: z.record(
    z.string(),
    z.object({
      ok: z.number(),
      failed: z.number(),
      topErrorKind: z.string().optional(),
    }),
  ),
  failures: z.array(
    z.object({
      seq: z.number(),
      toolName: z.string(),
      classifiedFailureBy: z.string(),
      transportOk: z.boolean(),
      httpStatus: z.number().optional(),
      errorKind: z.string(),
      matchedToken: z.string().optional(),
      /** The failure-detector sub-rule that flipped the call — "self_grade" (a
       *  clean DOMAIN task-failure via the {graded:true,outcome} self-grade envelope)
       *  vs an error-token rule. Distinguishes an honest task-failure from a transport error. */
      matchedRule: z.string().optional(),
      resultDigest: z.string(),
      // The size of the ORIGINAL, pre-bound tool body (a "how big was the thing
      // we digested" breadcrumb) — NOT the size of the emitted `errorPreview`
      // (which is ≤200 chars / digested). Do not correlate this against the
      // visible preview length.
      resultBytes: z.number(),
      errorPreview: z.string(),
    }),
  ),
  breakerTimeline: z.array(
    z.object({
      seq: z.number(),
      event: z.enum(["opened", "reset"]),
      toolName: z.string(),
      consecutiveFailures: z.number().optional(),
    }),
  ),
  offloads: z.array(
    z.object({
      seq: z.number(),
      toolName: z.string(),
      originalChars: z.number(),
      pointer: z.string(),
    }),
  ),
  /** Per-node token-budget breaches reconstructed from the session's
   *  `subagent.budget_exceeded` trajectory records. `capSource` names WHICH knob
   *  bound each node (node / operator-default / inherit-share) so a breach is
   *  diagnosable from the report alone — not just "a node failed".
   *  Counts/ids/closed-enum ONLY; never a task or output. Optional + additive
   *  (present only when the trajectory carries breach records; schemaVersion
   *  stays 1). */
  nodeBudgetBreaches: z
    .array(
      z.object({
        seq: z.number(),
        nodeId: z.string(),
        capSource: z.enum(["node", "operator-default", "inherit-share", "unknown"]),
        tokenBudget: z.number(),
        tokensUsed: z.number(),
      }),
    )
    .optional(),
  /** The root→children SPAWN TREE reconstructed from the
   *  session's `capability.audited` records — the unattended-run authorization
   *  topology ("one call to root-cause an unattended run"). Node shape +
   *  rationale: {@link SpawnTreeNodeSchema}. Optional + additive (present only
   *  when the trajectory carried `capability.audited` records; schemaVersion stays
   *  1 — the `nodeBudgetBreaches` presence-conditional precedent). */
  spawnTree: SpawnTreeNodeSchema.array().optional(),
  /** The per-run `orchestrate` PTC section reconstructed from the
   *  session's `orchestrate.run_summary` records — one entry per run (a session may
   *  hold several). Each carries its `failureClass`, the per-run `toolCalls`/denials
   *  attributed by the child leaseId (a `decision:"deny"` groups under THAT run), and
   *  the labeled `savings` estimate. Run shape + rationale: {@link OrchestrateRunSchema}.
   *  Optional + additive (present only when the trajectory carried run_summary records;
   *  schemaVersion stays 1 — the `spawnTree` presence-conditional precedent). */
  orchestrate: OrchestrateRunSchema.array().optional(),
  /** The terminal per-call budget equation (optional — present only when the
   *  session's trajectory carries `context.budget` records; additive, schemaVersion
   *  stays 1). */
  contextBudget: IncidentContextBudgetSchema.optional(),
  /** The woke-fire wake-gate fact (optional — present ONLY when the session's
   *  trajectory carries a `scheduler.wake_gate` record, i.e. a gate that woke the
   *  model). A skipped fire opens no session, so it never reaches here. Content-free;
   *  additive, schemaVersion stays 1. MUST stay declared — the non-strict `.parse()`
   *  strips any undeclared key. {@link IncidentCronWakeGateSchema}. */
  cronWakeGate: IncidentCronWakeGateSchema.optional(),
  /** The per-turn context-budget CASCADE — the progression of budget checks toward
   *  the terminal `contextBudget`. Present only when ≥2 distinct budget states occurred (a single
   *  check adds nothing over `contextBudget`). Dedup'd on transition + capped to the most recent 40,
   *  so a `context_exhausted` abort shows the tightening (assembled-input growth + eviction) in one
   *  `explain` field instead of the terminal fit-check alone. Optional + additive (schemaVersion 1). */
  contextBudgetHistory: z.array(IncidentContextBudgetHistoryEntrySchema).optional(),
  /** Memory-recall outcome aggregated over the session's `memory.recalled`
   *  trajectory records, so recall behavior is diagnosable from the report alone.
   *  Counts/booleans ONLY — never query text or memory bodies.
   *  Optional + additive (present only when the trajectory carries recall records). */
  recall: z
    .object({
      /** Number of recall queries the session issued. */
      recalls: z.number(),
      /** How many returned ZERO injected memories (a recall miss). */
      zeroHits: z.number(),
      /** The terminal recall's lane count / final injected count / reranker availability. */
      lastLanes: z.number(),
      lastFinalCount: z.number(),
      rerankerAvailable: z.boolean(),
    })
    .optional(),
  /** The image-generation turn reconstructed from the
   *  session's `image.*` trajectory records (the terminal image record wins).
   *  The image cost (`costUsd`) rides HERE — `comis explain` shows it from the
   *  trajectory — NOT `cost.costUsd`, which reads the executor-emitted
   *  `sessionEnd` rollup (a different code path; the image RPC runs in the daemon
   *  context, not the executor). Content-free: ids/labels/costUsd/outcome ONLY (never
   *  the prompt, image bytes, or a raw provider message). Optional + additive
   *  (present only when the trajectory carries image records; schemaVersion stays
   *  1) — pre-existing constructors omit it (the `recall` precedent). */
  image: z
    .object({
      /** The executing image provider id (e.g. "openai"). */
      provider: z.string(),
      /** The image model the provider used (e.g. "gpt-image-1"). Absent on a failed/early turn. */
      model: z.string().optional(),
      /** The generation cost in USD, reconstructed from the trajectory. Absent on a failed turn. */
      costUsd: z.number().optional(),
      /** The terminal outcome of the image turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"`. Absent on success. */
      errorKind: z.string().optional(),
      /** Whether the image was delivered to a channel (image.delivered fired). */
      delivered: z.boolean(),
      /** False when the generation SUCCEEDED + was delivered (base64)
       *  but the durable persist FAILED — a degraded delivery, still outcome:"ok"
       *  and still charged. Absent ⇒ persisted (or the record omits the field). */
      persisted: z.boolean().optional(),
    })
    .optional(),
  /** The VISION turn reconstructed from the session's
   *  `media.vision.*` trajectory records (the terminal record wins). The vision
   *  cost (`costUsd`) rides HERE — `comis explain` shows it from the trajectory
   *  — NOT `cost.costUsd`, which reads the executor-emitted `sessionEnd`
   *  rollup (a different code path; the vision RPC runs in the daemon context,
   *  not the executor). The `path` is the "which tier served" signal. Content-free:
   *  ids/labels/path/costUsd/outcome ONLY (never the image bytes, the analysis
   *  prompt, or the model's answer). Optional + additive (present only when the
   *  trajectory carries media.vision.* records; schemaVersion stays 1) —
   *  pre-existing constructors omit it (the `image`/`recall` precedent). */
  vision: z
    .object({
      /** The executing vision provider id (e.g. "anthropic" on main-vision, "gemini" on the registry tier). */
      provider: z.string(),
      /** The caller agent's resolved main provider id (the lockstep label). Absent on a partial record. */
      mainProvider: z.string().optional(),
      /** The vision model used (e.g. "claude-sonnet-4-5"). Absent on a failed/early turn or an adapter that omits it. */
      model: z.string().optional(),
      /** The analysis cost in USD, reconstructed from the trajectory. Absent on a failed turn OR the registry/gemini-video tiers (which carry no per-call cost). */
      costUsd: z.number().optional(),
      /** Which ladder tier served (the "which path" signal). Absent on a partial record. */
      path: z.enum(["main-vision", "registry", "gemini-video", "unavailable"]).optional(),
      /** The terminal outcome of the vision turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"`. Absent on success. */
      errorKind: z.string().optional(),
    })
    .optional(),
  /** The VIDEO-generation turn reconstructed from the
   *  session's `video.*` trajectory records (the terminal `video.generated` /
   *  `video.failed` record wins; `delivered` set when `video.delivered` fired).
   *  Unlike image/vision (wholly in-turn), a video job completes in the off-turn
   *  background poller — the `video.requested`/`video.submitted` records reach the
   *  persisted trajectory in-turn (recorder alive) and the offline assembler
   *  stitches the later completion via `traceId`/`jobId` on one `sessionKey`. The
   *  reconciled cost (`costUsd ?? estimatedCostUsd`) rides HERE (from the trajectory
   *  — NOT `cost.costUsd`, the executor `sessionEnd` rollup, a different code
   *  path). Per-backend cost
   *  provenance: FAL/Veo=estimate, Grok=actual. Content-free: ids/labels/cost/
   *  outcome ONLY (never the prompt, the video bytes, the Veo keyed-download-URL,
   *  or a raw provider message). Optional + additive (present only when the
   *  trajectory carries `video.*` records; schemaVersion stays 1) — pre-existing
   *  constructors omit it (the `image`/`vision`/`recall` precedent).
   *
   *  SINGLE-TURN by design: this is ONE signal per session
   *  (the LAST/terminal video turn — the highest-seq `video.generated`/`video.failed`
   *  wins, not keyed by `jobId`), exactly matching the `image`/`vision` single-signal
   *  convention. A session that renders MULTIPLE videos reconstructs only the terminal
   *  one here, and `costUsd`/`estimatedCostUsd` reflect that single turn — NOT the
   *  session total. The per-hour cost ceiling (`costLimiter`) and the synthetic
   *  `observability:token_usage` rollup ARE per-render-correct; only this trajectory
   *  reconstruction collapses to the last turn. (Consumers needing every video turn
   *  read the raw `video.*` trajectory records, not this rollup.) Diverging to a
   *  multi-signal array is deferred to keep parity with image/vision. */
  videoGenerated: z
    .object({
      /** The executing video provider id (e.g. "veo", "fal", "grok"). */
      provider: z.string(),
      /** The video model the provider used. Absent on a failed/early turn or a backend that omits it. */
      model: z.string().optional(),
      /** The async job handle — ties the off-turn completion back to its originating turn. */
      jobId: z.string().optional(),
      /** The reconciled actual cost in USD (Grok actual; absent for FAL/Veo, which estimate). */
      costUsd: z.number().optional(),
      /** The pre-submit worst-case estimate (the per-hour cost-ceiling input; the FAL/Veo cost provenance). */
      estimatedCostUsd: z.number().optional(),
      /** The rendered clip duration in seconds. */
      durationSecs: z.number().optional(),
      /** The terminal outcome of the video turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"` (the closed VideoErrorKind union). Absent on success. */
      errorKind: z.string().optional(),
      /** Whether the clip was delivered to a channel (video.delivered fired with delivered:true). */
      delivered: z.boolean(),
    })
    .optional(),
  /** The VOICE turn reconstructed from the session's
   *  `media.stt.*` / `media.tts.*` trajectory records (the terminal
   *  `media.*.completed` / `media.*.failed` record wins). Voice is wholly IN-TURN
   *  (unlike video's off-turn poller) — the daemon `media.transcribe` /
   *  `tts.synthesize` RPC handlers direct-emit the lifecycle records in one turn.
   *  The cost rides HERE, from the trajectory — NOT `cost.costUsd`, the executor
   *  `sessionEnd`, a different path: the voice RPC runs in the daemon context.
   *  Honest limit: a keyless turn records `costUsd:0` EXPLICITLY (so "free"
   *  is VISIBLE, not absent); a keyed turn OMITS cost (no port carries a per-call
   *  source today — NOT a fabricated number). The `source` is the resolved
   *  selection rung (WHY `auto` picked it). Content-free: provider/keyless/model/
   *  durationMs/costUsd/source/outcome/errorKind ONLY — never a transcript, audio
   *  bytes, or a credential (the `videoGenerated` content-free discipline). Optional
   *  + additive (present only when the trajectory carries `media.stt.*`/`media.tts.*`
   *  records; schemaVersion stays 1) — pre-existing constructors omit it (the
   *  `image`/`vision`/`videoGenerated` precedent). SINGLE-TURN by design: the
   *  terminal record wins (the image/vision single-signal convention). */
  voice: z
    .object({
      /** The executing voice provider id (e.g. "local", "edge", "openai", "groq", "deepgram", "elevenlabs"). */
      provider: z.string(),
      /** Whether the turn ran keyless (a local whisper engine for STT, Edge for TTS — no credential). */
      keyless: z.boolean(),
      /** The STT/TTS model used (e.g. "base", "whisper-large-v3-turbo", "tts-1"). Absent on a failed/early turn or an adapter that omits it. */
      model: z.string().optional(),
      /** The wall-clock transcription/synthesis duration in ms. Absent on a failed/early turn. */
      durationMs: z.number().optional(),
      /** The turn cost in USD, from the trajectory. `0` (explicit) on a keyless turn; ABSENT on a keyed turn (no per-call source today). */
      costUsd: z.number().optional(),
      /** The resolved selection rung — WHY `auto` chose this provider. Absent on a partial record. */
      source: z.enum(["explicit", "keyless-local", "follow-main-key", "fallback"]).optional(),
      /** The terminal outcome of the voice turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"` (the domain SttErrorKind string, verbatim). Absent on success. */
      errorKind: z.string().optional(),
    })
    .optional(),
  /** The Verified-Learning outcome signal reconstructed from
   *  the session's `learning.outcome_observed` trajectory records (the fused
   *  terminal verdict wins). Counts/ids/closed-enums ONLY — no body/alpha/recalled
   *  ids. `outcomeResolved` is false ⇒ a finished trajectory with no
   *  resolvable outcome (the `outcome_unresolved` verdict's trigger; distinct from
   *  an explicit `unknown` resolution). `skillsUsed`/`skillFailures` are currently
   *  always empty and `synthesisAbstained` always false (skill-use attribution and
   *  synthesis are not implemented).
   *  Optional + additive (present only when the trajectory carries learning
   *  records; schemaVersion stays 1) — the `recall`/`voice` precedent. */
  learning: z
    .object({
      outcomeResolved: z.boolean(),
      outcome: z.enum(["success", "failure", "corrected", "unknown"]).optional(),
      sources: z.array(
        z.enum(["tool", "pipeline", "correction", "judge", "reaction", "explicit"]),
      ),
      skillsUsed: z.array(z.string()),
      skillFailures: z.array(z.string()),
      synthesisAbstained: z.boolean(),
      // The reuse→promote chain on this session, COUNTS only.
      // `skillsPromoted`/`skillsDemoted` fold the `learning.skill_promoted`/`learning.skill_demoted`
      // trajectory records so `comis explain <session>` shows "used skill X → promoted N" in ONE call
      // instead of a trajectory + outcome_events + mental_models hand-join. Optional + additive
      // (present only when a promote/demote fired this session; schemaVersion stays 1).
      skillsPromoted: z.number().optional(),
      skillsDemoted: z.number().optional(),
      // The NAMES of skills demoted this session,
      // folded from `learning.skill_demoted.demotedSkillNames`. Answers "WHICH skill
      // demoted" without a daemon.log + mental_models hand-join. With the session's
      // outcome (failure/corrected) this gives "this session's failure demoted skill X" in one call.
      // Optional + additive (present only when ≥1 named demote; schemaVersion stays 1). Ids only.
      skillsDemotedNames: z.array(z.string()).optional(),
      // Memories that accrued a CORROBORATED failure this session
      // (count only) — the eviction-causation precursor (`learning.memory_failure_attributed`), so
      // "is this session pushing a memory toward eviction" is one `explain` field. Optional + additive
      // (present only when >0; schemaVersion stays 1).
      failuresAttributed: z.number().optional(),
      // Learned skills that SURFACED for
      // topic-match reuse and overlapped the turn but missed the credit bar — the reuse NEAR-MISSES,
      // folded from the `memory.skill_surfaced` census. Answers "why wasn't my skill reused?" (it
      // surfaced at coverage 0.45, just under 0.5) in ONE `explain` call instead of a debugger.
      // Each entry: skill NAME (id) + the best `coverage` seen this session. Optional + additive
      // (present only when ≥1 near-miss; schemaVersion stays 1). Names/numbers only — no body.
      skillsSurfacedButUncredited: z
        .array(z.object({ name: z.string(), coverage: z.number() }))
        .optional(),
      // The block stays counts/ids-only — no user-model or generalization fields belong here.
    })
    .optional(),
  /** The prompt-cache breaks the
   *  session incurred, aggregated per-reason from its `cache.break` trajectory
   *  records. `estCostUsd` is the directly-lost cache-read saving summed
   *  per reason (`tokenDrop × resolveModelPricing.cacheRead`; 0 for an unknown
   *  model — honest). Counts + a closed reason label + a number ONLY — never the
   *  changed tool NAMES (the trajectory carries only the changed-dims digest). The
   *  `cacheBreaks?` section answers "did caching break this session, why, and what
   *  did it cost". Optional + additive (present only when the trajectory carries
   *  cache.break records — undefined, never [], when none; schemaVersion stays 1).
   *  The `recall?`/`image?` content-free presence-conditional mold. */
  cacheBreaks: z
    .array(
      z.object({
        /** The closed CacheBreakReason discriminator (e.g. "system_changed", "tools_changed"). */
        reason: z.string(),
        /** How many cache breaks of this reason the session incurred. */
        count: z.number(),
        /** The summed directly-lost cache-read saving in USD (0 for an unknown-priced model). */
        estCostUsd: z.number(),
      }),
    )
    .optional(),
  /** The security-decision audit
   *  events the session produced, aggregated counts-by-kind from the durable
   *  `obs_audit_events` table scoped to the session's (tenant, agent, traceId).
   *  Content-free: a total + a `{kind → count}` record ONLY — NO actor names beyond
   *  ids, NO secret value, NO `refs` blob (the rows are already scrubbed at write).
   *  The `audit?` section answers "what security-relevant actions ran in this
   *  session, and how many of each". Optional + additive (present only when the
   *  session produced audit events — undefined when none; schemaVersion stays 1).
   *  The `recall?`/`cacheBreaks?` content-free presence-conditional mold. */
  audit: z
    .object({
      /** Total audit events the session produced. */
      total: z.number(),
      /** Per-kind counts (the closed AuditKind discriminator → count). Content-free. */
      byKind: z.record(z.string(), z.number()),
    })
    .optional(),
  /** The spend
   *  kill-switch breach reconstructed from the session's terminal `spend.exceeded`
   *  trajectory record. Content-free: the breached `scope` enum
   *  + the two dollar NUMBERS (`totalUsd` = the breaching scope's spent total;
   *  `capUsd` = its ceiling) — NO message/query/body. The verdict stays amount-free;
   *  this section carries the numbers the Incident view renders.
   *  Optional + additive (present only when the session was spend-killed — undefined,
   *  never {}, when none; schemaVersion stays 1). The `cacheBreaks?`/`audit?` mold. */
  spend: z
    .object({
      /** The breached spend scope (`agent` | `tenant` | `global`). */
      scope: z.string(),
      /** The breaching scope's total spent in USD (the record's `spentUsd`). */
      totalUsd: z.number(),
      /** The breaching scope's configured ceiling in USD. */
      capUsd: z.number(),
    })
    .optional(),
  /** The per-ROOT `autonomy.budget` limb that
   *  tripped (token / wall-clock / aggregateUsd), with its numbers in their own unit.
   *  DISTINCT from `spend` (the priced `observability.spend` $-ceiling): a token or
   *  wall-clock breach carries tokens / ms in `spent`/`cap` (NOT dollars), and the
   *  knob to raise is `autonomy.budget.<limb>` — surfacing it lets `explain` name the
   *  exact limb + numbers in ONE call instead of an operator grepping the
   *  "Per-root … budget exceeded" daemon-log line.
   *  Optional + additive (present only on a per-root spend-abort; schemaVersion 1). */
  perRootBudget: z
    .object({
      /** The tripped limb: `tokens` | `wallClockMs` | `aggregateUsd`. */
      limb: z.string(),
      /** The limb's spent amount, in `unit` (tokens / ms / USD). */
      spent: z.number(),
      /** The limb's configured cap, in `unit`. */
      cap: z.number(),
      /** The unit of `spent`/`cap`: `tokens` | `ms` | `usd`. */
      unit: z.string(),
    })
    .optional(),
  /** The terminal user-surface state: which outcome the activity renderer's
   *  finalize painted (the kept "❌ {errorKind}" pill / deleted scaffold /
   *  no-op — deterministic per strategy), and whether an observed failed
   *  event RECLASSIFIED a success outcome to failure. Answers "what did the
   *  user's chat show this turn" from the trajectory alone. From the LAST
   *  `activity.turn_finalized` record; absent when none. */
  activityFinalize: z
    .object({
      /** The renderer strategy that painted the surface (EditPlace / AppendOnly / …). */
      strategy: z.string(),
      /** The EFFECTIVE outcome kind dispatched to the renderer. */
      outcome: z.string(),
      /** The failure errorKind, when the outcome is a failure. */
      errorKind: z.string().optional(),
      /** The fixed one-line resource-abort reason, when present. */
      reason: z.string().optional(),
      /** True when a failed event flipped a non-failure outcome to failure. */
      reclassified: z.boolean(),
    })
    .optional(),
  /** Silent-failure recovery attempts folded from the session's
   *  `execution.recovery_attempted` records — the model re-entries
   *  (silent_retry / lkw_fallback / continuation_nudge) that were previously
   *  log-only. `total` attempts, `succeeded` count, and per-reason counts.
   *  Absent ⇒ no recovery attempts this session. */
  recoveries: z
    .object({
      total: z.number(),
      succeeded: z.number(),
      byReason: z.record(z.string(), z.number()),
    })
    .optional(),
  /** Reply blocks an aborted execution left UNSENT — the pacer's hard stop
   *  never reaches the delivery service, so no `delivery.dispatched` fires
   *  and the user silently receives nothing. Σ over the session's
   *  `delivery.aborted` records; absent when none. */
  deliverySkipped: z
    .object({
      /** How many aborted-delivery events the session recorded. */
      events: z.number(),
      /** Total blocks that were never sent across those events. */
      chunksNotSent: z.number(),
    })
    .optional(),
  /** Distinct turns (envelope traceId) the
   *  trajectory spans. Present only when >1 — it flags the whole-session toolStats as
   *  cumulative-across-N-turns (the trajectory JSONL is append-only across severs), so
   *  a reader does not misread a multi-turn count as this-turn. Additive (schemaVersion 1). */
  turnCount: z.number().optional(),
  summary: z.string(),
  likelyRootCause: z
    .object({
      code: z.string(),
      detail: z.string(),
      suggestedNextSteps: z.array(z.string()),
    })
    .nullable(),
  suggestedNextSteps: z.array(z.string()),
  truncations: z.array(
    z.object({
      field: z.string(),
      reason: z.string(),
      pointer: z.string().optional(),
    }),
  ),
  /**
   * READ-coverage breadcrumb (meta-observability): did the assembler actually
   * locate + read each source, and did every offload pointer resolve? DISTINCT
   * from `truncations[]` (which records SIZE-drops from the bounding
   * pass): `coverage` records whether the INPUTS were read, so a silently-empty
   * report ("0 trajectory records / 0 of N pointers resolved") is self-evident
   * instead of masquerading as a clean zero-activity session. Optional
   * (schemaVersion stays 1) — additive; pre-existing constructors omit it.
   */
  coverage: z
    .object({
      trajectory: z.object({ found: z.boolean(), records: z.number() }),
      rollup: z.object({ present: z.boolean() }),
      offloads: z.object({ pointersResolved: z.number(), pointersTotal: z.number() }),
      /**
       * The toolStats reconciliation between THIS report (the whole-session
       * trajectory union, the headline `toolStats`) and the persisted per-session
       * rollup that `obs.fleet.health` reads (latest-execution-wins). The two
       * lenses read structurally-different sources, so they CAN legitimately
       * differ — but only in one direction: the rollup is built per-execution and
       * the `sessionEnd` is overwritten each execution, so it is a SUBSET of the
       * trajectory (`rollup.{ok,failed} ≤ trajectory.{ok,failed}` per tool). This
       * block makes that divergence TRANSPARENT instead of letting the two
       * commands silently contradict: `reconciled` is the directional invariant
       * (rollup ⊆ trajectory) holding; `rollupSource` names WHY the rollup can be
       * smaller; `divergentTools[]` lists each tool whose persisted rollup differs
       * from the trajectory with BOTH count pairs, so an operator cross-
       * referencing `comis explain` vs `comis fleet` sees exactly the gap. A
       * rollup OVERcount (the forbidden direction — incl. a tool present in the
       * rollup but absent from the trajectory) flips `reconciled` to `false` and
       * surfaces the offending tool. Bounded: counts + tool names only, capped by
       * the distinct tool set (same bound as `toolStats`).
       */
      toolStats: z
        .object({
          reconciled: z.boolean(),
          rollupSource: z.literal("last-execution"),
          divergentTools: z.array(
            z.object({
              tool: z.string(),
              rollup: z.object({ ok: z.number(), failed: z.number() }),
              trajectory: z.object({ ok: z.number(), failed: z.number() }),
            }),
          ),
        })
        .optional(),
    })
    .optional(),
});

/** The IncidentReport (the `obs.explain` response). Inferred from the Zod schema. */
export type IncidentReport = z.infer<typeof IncidentReportSchema>;

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
   * Memory-recall outcome aggregated over the session's
   * `memory.recalled` trajectory records. Lets the `recall_miss` heuristic name a
   * zero-hit recall on a degraded session. Counts/booleans
   * only. Absent ⇒ no recall records in the trajectory (omitted from the report).
   */
  recall?: {
    recalls: number;
    zeroHits: number;
    lastLanes: number;
    lastFinalCount: number;
    rerankerAvailable: boolean;
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
   * The number of DISTINCT turns (envelope
   * `traceId`, one per agent turn) the trajectory spans. The session trajectory JSONL
   * is append-only across `session.reset_conversation` severs, so the whole-session
   * `toolStats` can be the SUM across many turns — surfacing this (only when >1) flags
   * the counts as cumulative so a reader does not misread a multi-turn count as
   * this-turn. Absent for a single-turn session.
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

/**
 * Assemble a redaction-safe post-mortem for a single agent session.
 *
 * Accepts ONE of `sessionKey`, `traceId`, or `rootRunId` (the
 * `.refine` rejects none-of-three). A `traceId` is canonicalized to its
 * sessionKey, and a `rootRunId` (an autonomy run) is canonicalized to the
 * run's sessionKey, so there is one assembler path. `depth` selects the
 * summary (≤6 KB) vs. full projection. Admin-only; the handler is
 * non-mutating (read-only post-mortem).
 */
export const ObsExplainContract = defineContract({
  method: "obs.explain",
  request: z
    .object({
      sessionKey: z.string().min(1).optional(),
      traceId: z.string().min(1).optional(),
      // The 3rd ref shape — an autonomy run's rootRunId (the synthetic
      // `root-session-<key>` or a real spawned/socket root). The daemon
      // canonicalizes it to its sessionKey FIRST (resolveRootRunToSession), so the
      // fleet→explain drill-down can paste the worst run's rootRunId straight in.
      rootRunId: z.string().min(1).optional(),
      depth: z.enum(["summary", "full"]).optional(),
      // Admin opt-in to include synthetic/test sessions (excluded by default).
      includeSynthetic: z.boolean().optional(),
    })
    .refine((r) => r.sessionKey != null || r.traceId != null || r.rootRunId != null, {
      message: "sessionKey, traceId, or rootRunId required",
    }),
  response: IncidentReportSchema,
  // rpc, NOT admin. The obs_query agent tool's
  // explain/session_report action calls obs.explain for SELF-observability ("why did my
  // session degrade?") — a documented agent capability. As scopes:["admin"] it
  // would sit in ADMIN_METHODS → assertNotAgentOrigin would deny the agent-origin call
  // before the handler ran ("Control-plane method obs.explain is not reachable from an
  // agent origin"). The report is READ-ONLY + scrubbed/digest-only (no secrets — the
  // trajectory it reads carries no secret residency), and the daemon is
  // single-tenant (reads its own data dir). `memory.store` is rpc-scoped for the same reason.
  scopes: ["rpc"] as const,
});
