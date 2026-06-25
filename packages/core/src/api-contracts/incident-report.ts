// SPDX-License-Identifier: Apache-2.0
/**
 * The `obs.explain` contract: the §6.3 `IncidentReport` wire schema + shape
 * types + the `ObsExplainContract` itself (Phase 153 centerpiece). Extracted
 * from `observability.ts` to keep that module under the file-size cap.
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
  IncidentPromptTimeoutSchema,
  SpawnTreeNodeSchema,
} from "./incident-report-sections.js";
import type {
  IncidentContextBudget,
  IncidentPromptTimeout,
  SpawnTreeNode,
} from "./incident-report-sections.js";

/**
 * The §6.3 `IncidentReport` wire shape (the `obs.explain` response).
 *
 * A self-contained, redaction-safe post-mortem for a single agent session:
 * outcome, cost, timing, per-tool stats, normalized failures (newest-first),
 * the circuit-breaker timeline, large-result offloads, a one-paragraph
 * summary, a deterministic `likelyRootCause` (heuristic registry, Plan 05),
 * report-level next steps, and an honest `truncations[]` ledger (Plan 04
 * bounding pass records what it dropped).
 *
 * Field bounding (≤200-char `errorPreview`, digest-only `resultDigest`, the
 * 6 KB summary budget) is ENFORCED by the Plan-04 bounding pass — this schema
 * only declares the shape. `suggestedNextSteps` appears BOTH inside
 * `likelyRootCause` (matching the heuristic `RootCause` 1:1) and at the report
 * root (report-level guidance); both are required-or-default.
 */
// Re-export the section sub-schemas + types (imported above) so the public
// barrel (observability.ts → @comis/core) and all consumers are unchanged after
// the file-size split.
export {
  IncidentContextBudgetSchema,
  IncidentPromptTimeoutSchema,
  SpawnTreeNodeSchema,
};
export type { IncidentContextBudget, IncidentPromptTimeout, SpawnTreeNode };

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
  /** ORCH-OBS (orchestration-observability): per-node token-budget breaches
   *  (BUDGET-03) reconstructed from the session's `subagent.budget_exceeded`
   *  trajectory records. `capSource` names WHICH knob bound each node (node /
   *  operator-default / inherit-share) so a breach is diagnosable from the report
   *  alone — not just "a node failed". Counts/ids/closed-enum ONLY (§2.7); never a
   *  task or output. Optional + additive (present only when the trajectory carries
   *  breach records; schemaVersion stays 1). */
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
  /** TREE-01/02 (215): the root→children SPAWN TREE reconstructed from the
   *  session's `capability.audited` records — the unattended-run authorization
   *  topology ("one call to root-cause an unattended run"). Node shape +
   *  rationale: {@link SpawnTreeNodeSchema}. Optional + additive (present only
   *  when the trajectory carried `capability.audited` records; schemaVersion stays
   *  1 — the `nodeBudgetBreaches` presence-conditional precedent). */
  spawnTree: SpawnTreeNodeSchema.array().optional(),
  /** W3: the terminal per-call budget equation (optional — present only when the
   *  session's trajectory carries `context.budget` records; additive, schemaVersion
   *  stays 1). */
  contextBudget: IncidentContextBudgetSchema.optional(),
  /** RECALL-01 (observability-excellence): memory-recall outcome aggregated over the
   *  session's `memory.recalled` trajectory records (the #1 blind spot — recall was
   *  invisible to obs.explain). Counts/booleans ONLY — never query text or memory bodies
   *  (§2.7). Optional + additive (present only when the trajectory carries recall records). */
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
  /** OBS-03/OBS-04 (Phase 186): the image-generation turn reconstructed from the
   *  session's `image.*` trajectory records (the terminal image record wins).
   *  The image cost (`costUsd`) rides HERE — `comis explain` shows it from the
   *  trajectory (Route a) — NOT `cost.costUsd`, which reads the executor-emitted
   *  `sessionEnd` rollup (a different code path; the image RPC runs in the daemon
   *  context — Pitfall 2). Content-free: ids/labels/costUsd/outcome ONLY (never
   *  the prompt, image bytes, or a raw provider message). Optional + additive
   *  (present only when the trajectory carries image records; schemaVersion stays
   *  1) — pre-existing constructors omit it (the `recall` precedent). */
  image: z
    .object({
      /** The executing image provider id (e.g. "openai"). */
      provider: z.string(),
      /** The image model the provider used (e.g. "gpt-image-1"). Absent on a failed/early turn. */
      model: z.string().optional(),
      /** The generation cost in USD — the OBS-03 reconstruction (Route a). Absent on a failed turn. */
      costUsd: z.number().optional(),
      /** The terminal outcome of the image turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"`. Absent on success. */
      errorKind: z.string().optional(),
      /** Whether the image was delivered to a channel (image.delivered fired). */
      delivered: z.boolean(),
      /** WR-02 (186): false when the generation SUCCEEDED + was delivered (base64)
       *  but the durable persist FAILED — a degraded delivery, still outcome:"ok"
       *  and still charged. Absent ⇒ persisted (or pre-WR-02 record). */
      persisted: z.boolean().optional(),
    })
    .optional(),
  /** VIS-04 (Phase 187): the VISION turn reconstructed from the session's
   *  `media.vision.*` trajectory records (the terminal record wins). The vision
   *  cost (`costUsd`) rides HERE — `comis explain` shows it from the trajectory
   *  (Route a) — NOT `cost.costUsd`, which reads the executor-emitted `sessionEnd`
   *  rollup (a different code path; the vision RPC runs in the daemon context —
   *  Pitfall 2). The `path` is VIS-03's "which tier served" signal. Content-free:
   *  ids/labels/path/costUsd/outcome ONLY (never the image bytes, the analysis
   *  prompt, or the model's answer). Optional + additive (present only when the
   *  trajectory carries media.vision.* records; schemaVersion stays 1) —
   *  pre-existing constructors omit it (the `image`/`recall` precedent). */
  vision: z
    .object({
      /** The executing vision provider id (e.g. "anthropic" on main-vision, "gemini" on the registry tier). */
      provider: z.string(),
      /** The caller agent's resolved main provider id (the lockstep label). Absent on a pre-VIS-04 / partial record. */
      mainProvider: z.string().optional(),
      /** The vision model used (e.g. "claude-sonnet-4-5"). Absent on a failed/early turn or an adapter that omits it. */
      model: z.string().optional(),
      /** The analysis cost in USD — the VIS-04 reconstruction (Route a). Absent on a failed turn OR the registry/gemini-video tiers (Pitfall 4). */
      costUsd: z.number().optional(),
      /** Which ladder tier served (VIS-03's "which path" signal). Absent on a partial record. */
      path: z.enum(["main-vision", "registry", "gemini-video", "unavailable"]).optional(),
      /** The terminal outcome of the vision turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"`. Absent on success. */
      errorKind: z.string().optional(),
    })
    .optional(),
  /** OBS-03/OBS-04 (Phase 192): the VIDEO-generation turn reconstructed from the
   *  session's `video.*` trajectory records (the terminal `video.generated` /
   *  `video.failed` record wins; `delivered` set when `video.delivered` fired).
   *  Unlike image/vision (wholly in-turn), a video job completes in the off-turn
   *  background poller — the `video.requested`/`video.submitted` records reach the
   *  persisted trajectory in-turn (recorder alive) and the offline assembler
   *  stitches the later completion via `traceId`/`jobId` on one `sessionKey`. The
   *  reconciled cost (`costUsd ?? estimatedCostUsd`) rides HERE (Route a — NOT
   *  `cost.costUsd`, the executor `sessionEnd`; Pitfall 2). Per-backend cost
   *  provenance: FAL/Veo=estimate, Grok=actual. Content-free: ids/labels/cost/
   *  outcome ONLY (never the prompt, the video bytes, the Veo keyed-download-URL,
   *  or a raw provider message). Optional + additive (present only when the
   *  trajectory carries `video.*` records; schemaVersion stays 1) — pre-existing
   *  constructors omit it (the `image`/`vision`/`recall` precedent).
   *
   *  WR-04 (Phase 192) — SINGLE-TURN by design: this is ONE signal per session
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
      /** The async job handle — ties the off-turn completion back to its originating turn (OBS-04). */
      jobId: z.string().optional(),
      /** The reconciled actual cost in USD (Grok actual; absent for FAL/Veo, which estimate). */
      costUsd: z.number().optional(),
      /** The pre-submit worst-case estimate (the SEC-02 ceiling input; the FAL/Veo cost provenance). */
      estimatedCostUsd: z.number().optional(),
      /** The rendered clip duration in seconds (DEL/OBS field). */
      durationSecs: z.number().optional(),
      /** The terminal outcome of the video turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"` (the closed VideoErrorKind union). Absent on success. */
      errorKind: z.string().optional(),
      /** Whether the clip was delivered to a channel (video.delivered fired with delivered:true). */
      delivered: z.boolean(),
    })
    .optional(),
  /** OBS-02/OBS-05 (Phase 196): the VOICE turn reconstructed from the session's
   *  `media.stt.*` / `media.tts.*` trajectory records (the terminal
   *  `media.*.completed` / `media.*.failed` record wins). Voice is wholly IN-TURN
   *  (unlike video's off-turn poller) — the daemon `media.transcribe` /
   *  `tts.synthesize` RPC handlers direct-emit the lifecycle records in one turn.
   *  The cost rides HERE (Route a — NOT `cost.costUsd`, the executor `sessionEnd`,
   *  a different path: the voice RPC runs in the daemon context, Pitfall 2). OBS-05
   *  honest limit (FLAG 4): a keyless turn records `costUsd:0` EXPLICITLY (so "free"
   *  is VISIBLE, not absent); a keyed turn OMITS cost (no port carries a per-call
   *  source today — NOT a fabricated number). The `source` is the OBS-03 resolved
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
      /** The turn cost in USD (Route a). `0` (explicit) on a keyless turn; ABSENT on a keyed turn (no per-call source today — FLAG 4). */
      costUsd: z.number().optional(),
      /** The OBS-03 resolved selection rung — WHY `auto` chose this provider. Absent on a partial record. */
      source: z.enum(["explicit", "keyless-local", "follow-main-key", "fallback"]).optional(),
      /** The terminal outcome of the voice turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"` (the domain SttErrorKind string, verbatim). Absent on success. */
      errorKind: z.string().optional(),
    })
    .optional(),
  /** OBS-02 (Phase 198): the Verified-Learning outcome signal reconstructed from
   *  the session's `learning.outcome_observed` trajectory records (the fused
   *  terminal verdict wins). Counts/ids/closed-enums ONLY — no body/alpha/recalled
   *  ids (SEC-01). `outcomeResolved` is false ⇒ a finished trajectory with no
   *  resolvable outcome (the `outcome_unresolved` verdict's trigger; distinct from
   *  an explicit `unknown` resolution). `skillsUsed`/`skillFailures` empty +
   *  `synthesisAbstained` false in P0 (attribution/synthesis → Phase 201).
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
      // REVISE-01 / GENERAL-01 (Phase 203): optional/additive revision + generalization
      // counts (counts only, never bodies). Absent in P0..P3 — existing fixtures unaffected.
      userModelRevised: z.number().optional(),
      memoriesGeneralized: z.number().optional(),
    })
    .optional(),
  /** PERSIST-01 (observability-excellence, Phase 176): the prompt-cache breaks the
   *  session incurred, aggregated per-reason from its `cache.break` trajectory
   *  records (Plan 04). `estCostUsd` is the directly-lost cache-read saving summed
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
  /** AUDIT-05 (observability-excellence, Phase 176): the security-decision audit
   *  events the session produced, aggregated counts-by-kind from the durable
   *  `obs_audit_events` (Plan 03) scoped to the session's (tenant, agent, traceId).
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
  /** SPEND (observability-excellence, WEBUI-04 / 179-04 — locked A2): the spend
   *  kill-switch breach reconstructed from the session's terminal `spend.exceeded`
   *  trajectory record (177-obs-loop WR-4). Content-free: the breached `scope` enum
   *  + the two dollar NUMBERS (`totalUsd` = the breaching scope's spent total;
   *  `capUsd` = its ceiling) — NO message/query/body. The verdict stays amount-free
   *  (177 decision); this section carries the numbers the Incident view renders.
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
  /** OBS-3 (openclaw-usecases 2026-06-25): the per-ROOT `autonomy.budget` limb that
   *  tripped (token / wall-clock / aggregateUsd), with its numbers in their own unit.
   *  DISTINCT from `spend` (the priced `observability.spend` $-ceiling): a token or
   *  wall-clock breach carries tokens / ms in `spent`/`cap` (NOT dollars), and the
   *  knob to raise is `autonomy.budget.<limb>` — surfacing it lets `explain` name the
   *  exact limb + numbers in ONE call instead of an operator grepping the
   *  "Per-root … budget exceeded" daemon-log line (the limb used to be log-only).
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
  /** OBS-4 (openclaw-usecases 2026-06-25): distinct turns (envelope traceId) the
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
   * from `truncations[]` (which records SIZE-drops from the Plan-04 bounding
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
       * QT1 — toolStats reconciliation between THIS report (the whole-session
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

/** The §6.3 IncidentReport (the `obs.explain` response). Inferred from the Zod schema. */
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
  resultDigest: string;
  resultBytes: number;
  errorPreview: string;
}

/**
 * The normalizer output (`toIncidentSignals`) that Plans 02/03/05 consume.
 *
 * One shared contract for the heuristic registry's predicates: raw per-tool
 * stats + normalized failures/breaker/offload arrays, plus the derived
 * booleans/strings the deterministic `RootCause` rules key on (breaker-opened
 * tool, "DO NOT retry" signal, most-failed tool, the content-heuristic
 * misclassification signal + offending tool/token). Derived from the heuristic
 * predicates in 153-PATTERNS.md ("678 / 503 heuristic derivation").
 */
// @optional-field-count: 18 — this is the obs.explain signal accumulator, the
// single shared contract every Glass-Box heuristic (Phase 153/175/177/179/180/186/187/192/198/215)
// reads. Each optional field is a presence-conditional signal aggregated from a
// distinct trajectory record class (contextBudget / promptTimeout /
// toolSchemaUnsupported / recall / cacheBreaks / spend / image / vision /
// videoGenerated / voice / learning / channel / agentId / spawnTree / …) — absent
// when that record class did not occur. Clustering them would couple unrelated
// heuristics; the read sites already key on each independently. Grows by one per
// Glass-Box signal class (image added in 186 — OBS-03/OBS-04; vision added in 187 — VIS-04;
// videoGenerated added in 192 — OBS-03/OBS-04 video; learning added in 198 —
// OBS-02, the Verified-Learning outcome-signal shadow; spend added in 179 —
// WEBUI-04, the spend-kill breach numbers for the Incident view; spawnTree added
// in 215 — TREE-01/02, the per-cap spawn-tree topology for an autonomous run).
export interface IncidentSignals {
  sessionKey: string;
  /** W8: agentId from the trajectory record envelopes (first seen). Fallback for
   *  reports whose metadata rollup carries no agentId. */
  agentId?: string;
  /** W8: channel identity from the session.started trajectory record. Fallback for
   *  reports whose metadata rollup carries no channel. */
  channel?: { type: string; id: string };
  toolStats: Record<
    string,
    { ok: number; failed: number; topErrorKind?: string }
  >;
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
  /** ORCH-OBS: per-node token-budget breaches (BUDGET-03) folded from
   *  `subagent.budget_exceeded` trajectory records — the per-incident view (capSource
   *  + the two token numbers) the IncidentReport surfaces. */
  nodeBudgetBreaches: Array<{
    seq: number;
    nodeId: string;
    capSource: "node" | "operator-default" | "inherit-share" | "unknown";
    tokenBudget: number;
    tokensUsed: number;
  }>;
  /** TREE-01/02 (215): the spawn-tree nodes folded from `capability.audited`
   *  records — one node per `leaseId` (in-process records group under their
   *  synthetic `rootRunId`). Optional (the `recall`/`spend` presence-conditional
   *  mold): absent when the trajectory carried no `capability.audited` records, so
   *  the assembler omits the report section. Node shape: {@link SpawnTreeNode}. */
  spawnTree?: SpawnTreeNode[];
  // derived booleans/strings for the heuristic registry:
  breakerOpenedTool?: string; // from a tool.breaker_opened event OR a "DO NOT retry" log line's toolName
  hasDoNotRetrySignal: boolean; // any errorText contains "DO NOT retry"
  mostFailedTool?: string;
  repeatedFailureCount: Record<string, number>;
  hasMisclassificationSignal: boolean; // ≥N success:true co-existing with ≥N "Tool execution failed" + "status"/"403"/"200" substring in an errorText
  misclassifiedTool?: string;
  misclassifiedToken?: string; // e.g. "403"|"status"|"200"
  /** GBNF-02: derived from `execution.tool_schema_unsupported` trajectory records
   *  (last record wins — one strip-retry per session means at most a handful).
   *  Content-free by construction: tool + keyword NAMES only. `reason`
   *  (175-REVIEW WR-05) discriminates the handler branch so gate-closed and
   *  nothing-to-strip terminals stay distinguishable in the verdict; optional
   *  because pre-WR-05 trajectory records on disk lack it. */
  toolSchemaUnsupported?: {
    toolNames: string[];
    strippedKeywords: string[];
    retried: boolean;
    succeeded: boolean;
    reason?: "stripped" | "nothing_to_strip" | "gate_closed";
  };
  /**
   * The mapped terminal `endReason` (the NAMED degradation cause — QT2/QT3 Glass
   * Box degradation detectors). Metadata-derived (NOT from the trajectory record
   * stream — `toIncidentSignals` omits it), so the handler threads
   * `report.outcome.endReason` onto the signals before running the registry. The
   * two lowest-priority heuristics (`context_exhausted` / `output_starved`) key
   * on it — they explain the TERMINAL state, so a tool-failure cause out-ranks
   * them. Absent ⇒ those rules do not fire (a clean session names no cause).
   */
  endReason?: string;
  /**
   * RECALL-01: the report's authoritative `outcome.degraded` flag (derived by the
   * assembler from the closed HARD_FAILURE/DEGRADED end-reason sets), threaded by
   * the handler alongside `endReason`. Lets the `recall_miss` heuristic gate on
   * genuine degradation instead of re-deriving it from endReason strings (a
   * zero-hit recall on a healthy turn is benign and must never name a cause).
   * Absent ⇒ the rule does not fire.
   */
  degraded?: boolean;
  /**
   * W3: the terminal per-call budget equation from the trajectory's
   * `context.budget` records (last wins). Lets the `context_exhausted`
   * heuristic produce a numbers-backed verdict naming the cap knob and the
   * tool-schema share instead of the generic speculation.
   */
  contextBudget?: IncidentContextBudget;
  /**
   * LAT-04 (177): the LAST `execution.prompt_timeout` trajectory record (the
   * terminal kill explains the end state). Lets the `prompt_timeout` heuristic
   * produce a numbers-backed verdict naming the binding knob (stall) or
   * `stallCeilingMultiplier` (makespan) instead of falling through to NO
   * verdict. Absent ⇒ pre-extension session (the rule degrades to a generic
   * knob suggestion when `endReason` is "timeout").
   */
  promptTimeout?: IncidentPromptTimeout;
  /**
   * RECALL-01: memory-recall outcome aggregated over the session's
   * `memory.recalled` trajectory records. Lets the `recall_miss` heuristic name a
   * zero-hit recall on a degraded session (the #1 blind spot). Counts/booleans
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
   * PERSIST-01 (176-05): cache breaks folded per-reason from the session's
   * `cache.break` trajectory records (Plan 04). Bounded + deterministically
   * ordered (count desc, reason asc). Counts + a closed reason label + a summed
   * est-$ ONLY (never the changed tool names). Absent ⇒ no cache breaks in the
   * trajectory (omitted from the report — the `recall?` presence-conditional mold).
   */
  cacheBreaks?: Array<{ reason: string; count: number; estCostUsd: number }>;
  /**
   * SPEND (WEBUI-04 / 179-04): the spend kill-switch breach folded from the
   * session's terminal `spend.exceeded` trajectory record (last wins). `totalUsd`
   * is the breaching scope's spent total (the record's `spentUsd`); `capUsd` is its
   * ceiling. Content-free (a scope enum + two numbers). Absent ⇒ the session was
   * not spend-killed (omitted from the report — the `cacheBreaks?` presence mold).
   */
  spend?: { scope: string; totalUsd: number; capUsd: number };
  /**
   * OBS-3 (openclaw-usecases 2026-06-25): the per-ROOT `autonomy.budget` limb that
   * tripped, folded from the terminal `execution.aborted` record's `perRootBudget`
   * (last wins). DISTINCT from `spend` (the priced `observability.spend` ceiling):
   * `spent`/`cap` are tokens / ms / USD per `unit`, and the knob is
   * `autonomy.budget.<limb>`. Lets the spend verdict name the exact limb. Absent ⇒
   * not a per-root spend-abort.
   */
  perRootBudget?: { limb: string; spent: number; cap: number; unit: string };
  /**
   * OBS-4 (openclaw-usecases 2026-06-25): the number of DISTINCT turns (envelope
   * `traceId`, one per agent turn) the trajectory spans. The session trajectory JSONL
   * is append-only across `session.reset_conversation` severs, so the whole-session
   * `toolStats` can be the SUM across many turns — surfacing this (only when >1) flags
   * the counts as cumulative so a reader does not misread a multi-turn count as
   * this-turn. Absent for a single-turn session.
   */
  turnCount?: number;
  /**
   * OBS-03/OBS-04 (Phase 186): the image-generation turn reconstructed from the
   * session's `image.*` trajectory records (the terminal image.generated /
   * image.failed record wins; `delivered` set when image.delivered fired). The
   * cost (`costUsd`) rides HERE so `comis explain` shows it from the trajectory
   * (Route a) — NOT `cost.costUsd` (the executor `sessionEnd`, a different path —
   * Pitfall 2). Content-free. Absent ⇒ no image records in the trajectory.
   */
  image?: {
    provider: string;
    model?: string;
    costUsd?: number;
    outcome: "ok" | "failed";
    errorKind?: string;
    delivered: boolean;
    /** WR-02 (186): false on a persist-failed-but-delivered generation (degraded
     *  delivery, still outcome:"ok", still charged). Absent ⇒ persisted. */
    persisted?: boolean;
  };
  /**
   * VIS-04 (Phase 187): the VISION turn reconstructed from the session's
   * `media.vision.*` trajectory records (the terminal media.vision.completed /
   * media.vision.failed record wins). The cost (`costUsd`) rides HERE so `comis
   * explain` shows it from the trajectory (Route a) — NOT `cost.costUsd`
   * (Pitfall 2). The `path` is VIS-03's "which tier served". Content-free.
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
   * OBS-03/OBS-04 (Phase 192): the VIDEO-generation turn reconstructed from the
   * session's `video.*` trajectory records (the terminal `video.generated` /
   * `video.failed` record wins; `delivered` set when `video.delivered` fired,
   * `jobId` carried from `video.submitted`). The cost rides HERE so `comis
   * explain` shows it from the trajectory (Route a — NOT `cost.costUsd`,
   * Pitfall 2). A background-completed job's later completion stitches to its
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
   * OBS-02/OBS-05 (Phase 196): the VOICE turn reconstructed from the session's
   * `media.stt.*` / `media.tts.*` trajectory records (the terminal completed/
   * failed record wins). Wholly in-turn (the daemon voice RPC handlers
   * direct-emit). The cost rides HERE (Route a — NOT `cost.costUsd`, Pitfall 2):
   * `0` explicit on keyless (OBS-05 "free" visible), absent on keyed (no per-call
   * source — FLAG 4). `source` is the OBS-03 selection rung. Content-free. Absent
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
   * OBS-02 (Phase 198): the outcome-signal telemetry reconstructed from the
   * session's `learning.outcome_observed` trajectory records (counts/ids/closed
   * enums ONLY — the bridged record carries no body/alpha/recalled-ids; SEC-01).
   * `outcomeResolved` is false ⇒ the learning shadow observed this finished
   * trajectory but no signal tier produced a resolvable outcome (the
   * `outcome_unresolved` verdict keys on exactly this — distinct from an explicit
   * `unknown` outcome, which IS a resolution). `skillsUsed`/`skillFailures` are
   * EMPTY in P0 (skill-use attribution lands Phase 201); `synthesisAbstained` is
   * false in P0 (synthesis is Phase 201). Absent ⇒ no learning records in the
   * trajectory (omitted from the report — the signal is per-agent default-OFF).
   * `userModelRevised`/`memoriesGeneralized` (Phase 203) are optional counts of
   * the session's profile-revision / higher-order-generalization activity (counts
   * only, never bodies); absent in P0..P3.
   */
  learning?: {
    outcomeResolved: boolean;
    outcome?: "success" | "failure" | "corrected" | "unknown";
    sources: Array<"tool" | "pipeline" | "correction" | "judge" | "reaction" | "explicit">;
    skillsUsed: string[];
    skillFailures: string[];
    synthesisAbstained: boolean;
    /** REVISE-01 (Phase 203): incumbent profile entries soft-closed by revision this session (count only). Optional/additive. */
    userModelRevised?: number;
    /** GENERAL-01 (Phase 203): higher-order semantic memories synthesized this session (count only). Optional/additive. */
    memoriesGeneralized?: number;
  };
}

/**
 * Assemble a redaction-safe post-mortem for a single agent session.
 *
 * Accepts ONE of `sessionKey`, `traceId`, or `rootRunId` (FLEET-05; the
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
      // FLEET-05: the 3rd ref shape — an autonomy run's rootRunId (the synthetic
      // `root-session-<key>` or a real spawned/socket root). The daemon
      // canonicalizes it to its sessionKey FIRST (resolveRootRunToSession), so the
      // fleet→explain drill-down can paste the worst run's rootRunId straight in.
      rootRunId: z.string().min(1).optional(),
      depth: z.enum(["summary", "full"]).optional(),
      // D9: admin opt-in to include synthetic/test sessions (excluded by default).
      includeSynthetic: z.boolean().optional(),
    })
    .refine((r) => r.sessionKey != null || r.traceId != null || r.rootRunId != null, {
      message: "sessionKey, traceId, or rootRunId required",
    }),
  response: IncidentReportSchema,
  // OBS-SELF-DEAD (30uc-20260624 UC-14): rpc, NOT admin. The obs_query agent tool's
  // explain/session_report action calls obs.explain for SELF-observability ("why did my
  // session degrade?") — a documented agent capability (CLAUDE.md). As scopes:["admin"] it
  // was in ADMIN_METHODS → assertNotAgentOrigin denied the agent-origin call before the
  // handler ran ("Control-plane method obs.explain is not reachable from an agent origin").
  // The report is READ-ONLY + scrubbed/digest-only (no secrets — 30uc UC-27 residency sweep
  // confirmed zero secret residency in the trajectory it reads), and the daemon is
  // single-tenant (reads its own data dir). Same MD-02 re-scope class as memory.store.
  scopes: ["rpc"] as const,
});
