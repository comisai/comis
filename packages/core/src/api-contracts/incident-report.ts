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
// locally for use in IncidentReportSchema AND re-exported below so the public
// barrel surface is unchanged.
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
  /** Durable scheduler task-check lifecycle evidence. The task body and origin
   *  content are deliberately absent: this section exposes only bounded
   *  identifiers, the terminal disposition, and delivery counts needed to
   *  diagnose a governed background attempt. */
  taskCheck: z
    .object({
      rootRunId: z.string().min(1).max(512),
      attemptId: z.string().min(1).max(512),
      correlationId: z.string().min(1).max(512),
      lifecycle: z.enum(["started", "terminal"]),
      outcome: z
        .enum([
          "dismissed",
          "retry_scheduled",
          "expired",
          "delivered",
          "delivery_partial",
          "delivery_unknown",
          "configuration_disabled",
          "delivery_window_closed",
          "failed",
        ])
        .optional(),
      recovery: z.enum(["live", "ownership_recovery"]).optional(),
      deliveredChunks: z.number().int().nonnegative().nullable().optional(),
      failedChunks: z.number().int().nonnegative().nullable().optional(),
      ambiguousChunks: z.number().int().nonnegative().nullable().optional(),
    })
    .optional(),
  /** The per-turn context-budget CASCADE — the progression of budget checks toward
   *  the terminal `contextBudget`. Present only when ≥2 distinct budget states occurred (a single
   *  check adds nothing over `contextBudget`). Dedup'd on transition + capped to the most recent 40,
   *  so a `context_exhausted` abort shows the tightening (assembled-input growth + eviction) in one
   *  `explain` field instead of the terminal fit-check alone. Optional + additive (schemaVersion 1). */
  contextBudgetHistory: z.array(IncidentContextBudgetHistoryEntrySchema).optional(),
  /** Memory-recall outcome aggregated over the session's `memory.recalled` +
   *  `memory.recall_degraded` trajectory records, so recall behavior — and a
   *  DEAD/DEGRADED recall — is diagnosable from the report alone.
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
      /** How many recalls injected ≥1 memory scoped to a DIFFERENT user than the
       *  conversation (agent-scoped recall crossing a sender boundary) — the cross-sender
       *  privacy signal, answerable from the report alone. Optional/additive: absent on
       *  pre-fix trajectories that predate the crossUserCount event field. */
      crossUserRecalls: z.number().optional(),
      /** The terminal recall's cross-user injected count (`> 0` ⇒ another sender's
       *  memory reached this turn's context). Counts only — never the ids/bodies. */
      lastCrossUserCount: z.number().optional(),
      /** Count of degraded recalls (a retrieval lane — or the whole lane
       *  split — failed; previously a daemon.log-grep-only discovery). */
      degraded: z.number().optional(),
      /** The last degradation's scope: "vector_lane" (FTS still served) or "lanes" (no recall ran). */
      lastDegradedScope: z.string().optional(),
      /** The last degradation's closed ErrorKind string. */
      lastDegradedErrorKind: z.string().optional(),
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
      /** True when a failed event flipped a delivered success to
       *  success_with_recovered_failures. */
      reclassified: z.boolean(),
      /** Session-wide count of turns that finalized as kept failure pills —
       *  the last-wins snapshot above cannot show a mid-session failure paint. */
      failedTurnCount: z.number().optional(),
      /** Session-wide count of turns that finalized as recovered successes. */
      recoveredTurnCount: z.number().optional(),
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
  /** Protected background-continuation recovery failures associated with this
   *  session. Content-free counts and stable identifiers only. */
  backgroundRecovery: z
    .object({
      retryRequiredCount: z.number(),
      lastTaskId: z.string().optional(),
      lastToolName: z.string().optional(),
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
  /** Distinct agent turns derived from prompt anchors, with tool-lifecycle
   *  trace ids as the sparse-history fallback. Present only when greater than one so
   *  whole-session toolStats cannot be mistaken for one turn's counts. */
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
       * rollup that `obs.system.health` reads (latest-execution-wins). The two
       * lenses read structurally-different sources, so they CAN legitimately
       * differ — but only in one direction: the rollup is built per-execution and
       * the `sessionEnd` is overwritten each execution, so it is a SUBSET of the
       * trajectory (`rollup.{ok,failed} ≤ trajectory.{ok,failed}` per tool). This
       * block makes that divergence TRANSPARENT instead of letting the two
       * commands silently contradict: `reconciled` is the directional invariant
       * (rollup ⊆ trajectory) holding; `rollupSource` names WHY the rollup can be
       * smaller; `divergentTools[]` lists each tool whose persisted rollup differs
       * from the trajectory with BOTH count pairs, so an operator cross-
       * referencing `comis explain` vs `comis system-health` sees exactly the gap. A
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
      /**
       * The closest REAL session keys when the requested key resolved ZERO records
       * (a lossy/partial key — e.g. `telegram:<chatId>` instead of the formatted
       * `<agent>:<chatId>:<chatId>:peer:<chatId>`). Populated only on a 0-record miss,
       * from the on-disk trajectory pointers whose formatted `sessionId` shares a
       * segment with the request, ranked most-relevant-first + capped. Turns a silent
       * empty report into a "did you mean …?" so the operator copies the right key
       * instead of hand-joining the session index. Content-free (keys are ids, already
       * in the trajectory path layout). Absent when the key resolved records OR no
       * candidate matched.
       */
      candidateSessionKeys: z.array(z.string()).optional(),
      /**
       * On-disk source PATHS the report was built from — a POINTER, never the content.
       * The distinction is load-bearing for numeric/value reconciliation: the
       * `.trajectory.jsonl` carries tool-call PROVENANCE only (toolName/success/
       * durationMs — the result body is kept OUT of the event stream for secret-egress
       * safety, §2.7), while the co-located raw session `.jsonl` carries the tool-result
       * VALUES the model actually saw (wrapExternalContent-wrapped). So to RECONCILE a
       * reported figure to the tool result that produced it, read `session` (values),
       * NOT `trajectory` (provenance). Large results additionally offload to disk (see
       * `offloads[].diskPathRel`). Paths only — never bodies; ids in the path mirror
       * `candidateSessionKeys` (already in the trajectory layout). Present only when the
       * session resolved to real on-disk artifacts.
       */
      sources: z
        .object({
          session: z.string(),
          trajectory: z.string(),
        })
        .optional(),
    })
    .optional(),
});

/** The IncidentReport (the `obs.explain` response). Inferred from the Zod schema. */
export type IncidentReport = z.infer<typeof IncidentReportSchema>;

// The normalizer-contract interfaces (`IncidentFailure`, `IncidentSignals`)
// live in a sibling module (file-size cap). Re-exported here so the public
// barrel (observability.ts → @comis/core) and every consumer are unchanged.
export type { IncidentFailure, IncidentSignals } from "./incident-report-signals.js";

/**
 * Assemble a redaction-safe post-mortem for a single agent session.
 *
 * Accepts ONE of `sessionKey`, `traceId`, or `rootRunId` (the
 * `.refine` rejects none-of-three). A `traceId` is canonicalized to its
 * sessionKey, and a `rootRunId` (a governed run) is canonicalized to the
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
      // The 3rd ref shape — a governed run's rootRunId (a session, cron,
      // task-check, or spawned/socket root). The daemon
      // canonicalizes it to its sessionKey FIRST (resolveRootRunToSession), so the
      // system→explain drill-down can paste the worst run's rootRunId straight in.
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
