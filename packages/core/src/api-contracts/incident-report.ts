// SPDX-License-Identifier: Apache-2.0
/**
 * The `obs.explain` contract: the §6.3 `IncidentReport` wire schema + shape
 * types + the `ObsExplainContract` itself. Extracted
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

/**
 * The §6.3 `IncidentReport` wire shape (the `obs.explain` response).
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
/**
 * The per-LLM-call context budget equation,
 * extracted from the trajectory's `context.budget` records (last record wins —
 * the terminal fit check explains the end state). Carried on the report so a
 * `context_exhausted` abort is explainable with numbers (assembled vs window,
 * cap knob, tool-schema share, kept history) instead of speculation. Bounded
 * by construction: ten numbers/enums, no free text.
 */
export const IncidentContextBudgetSchema = z.object({
  /** The EFFECTIVE window the fit check ran against (post capability-class cap). */
  windowTokens: z.number(),
  /** The model's declared contextWindow before any cap (== windowTokens when uncapped). */
  rawContextWindowTokens: z.number(),
  /** What clamped the window. The cap members are contextEngine.budget.* knob
   *  names; "served" means the Ollama-served num_ctx bound the window
   *  (knobs: OLLAMA_CONTEXT_LENGTH env / Modelfile PARAMETER num_ctx);
   *  "capabilityClass" means the executor-side class cap from the
   *  operator's providers.entries.<id>.capabilities.capabilityClass pin bound
   *  — the pin is the lever (the budget knobs are inert on that branch). */
  windowCapSource: z.enum(["effectiveContextCapSmall", "effectiveContextCapNano", "served", "capabilityClass", "none"]),
  /** S: system prompt + tool schemas estimate. */
  systemTokens: z.number(),
  /** Estimated fresh-tail tokens (latest user message + preamble + pending tool results). */
  freshTailTokens: z.number(),
  /** Token sum of the history items kept by budget eviction. */
  budgetedHistoryTokens: z.number(),
  /** Count of history items kept by budget eviction (0 = model saw no history). */
  keptCount: z.number(),
  /** S + kept history + fresh tail — what was actually dispatched. */
  assembledInputTokens: z.number(),
  /** Output headroom reserved at the final effective thinking level. */
  outputHeadroom: z.number(),
  /** Fit-check outcome. */
  verdict: z.enum(["fits", "downshifted", "exhausted"]),
});

/** The per-call context budget equation (see {@link IncidentContextBudgetSchema}). */
export type IncidentContextBudget = z.infer<typeof IncidentContextBudgetSchema>;

/**
 * The terminal prompt-timeout attribution record — the LAST
 * `execution.prompt_timeout` trajectory row. Content-free: numbers + closed
 * enums + the pre-rendered config-KEY string (`bindingKnob` — knob NAME + ids
 * only, never values/bodies). Wholesale-validated by the signals normalizer
 * (the contextBudget discipline); a malformed/partial record is ignored
 * (forward-compatible). Signals-only — NOT on `IncidentReportSchema`
 * (mirroring the `toolSchemaUnsupported` precedent: the heuristic
 * verdict carries what the operator needs).
 */
export const IncidentPromptTimeoutSchema = z.object({
  /** The configured ms value of the limit that FIRED. */
  timeoutMs: z.number(),
  /** Elapsed wall-clock ms at kill. */
  durationMs: z.number().optional(),
  /** Which limit fired: stall budget vs makespan ceiling. Absent = whole-turn (retry-path / older rows). */
  limit: z.enum(["stall", "makespan"]).optional(),
  /** Binding resolution level (the agent-side TimeoutSource union). */
  source: z.string().optional(),
  /** Pre-rendered config-key string from the agent-side source→knob table. */
  bindingKnob: z.string().optional(),
  operationType: z.string().optional(),
  stallBudgetMs: z.number().optional(),
  makespanMs: z.number().optional(),
});

/** The terminal prompt-timeout attribution record (see {@link IncidentPromptTimeoutSchema}). */
export type IncidentPromptTimeout = z.infer<typeof IncidentPromptTimeoutSchema>;

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
  /** Per-node token-budget breaches reconstructed from the session's
   *  `subagent.budget_exceeded` trajectory records. `capSource` names WHICH knob
   *  bound each node (node / operator-default / inherit-share) so a breach is
   *  diagnosable from the report alone — not just "a node failed".
   *  Counts/ids/closed-enum ONLY (§2.7); never a task or output. Optional +
   *  additive (present only when the trajectory carries breach records;
   *  schemaVersion stays 1). */
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
  /** The terminal per-call budget equation (optional — present only when the
   *  session's trajectory carries `context.budget` records; additive, schemaVersion
   *  stays 1). */
  contextBudget: IncidentContextBudgetSchema.optional(),
  /** Memory-recall outcome aggregated over the session's `memory.recalled`
   *  trajectory records (the #1 blind spot — recall was invisible to obs.explain).
   *  Counts/booleans ONLY — never query text or memory bodies (§2.7). Optional +
   *  additive (present only when the trajectory carries recall records). */
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
  /** The image-generation turn reconstructed from the session's `image.*`
   *  trajectory records (the terminal image record wins). The image cost
   *  (`costUsd`) rides HERE — `comis explain` shows it from the trajectory
   *  (Route a) — NOT `cost.costUsd`, which reads the executor-emitted
   *  `sessionEnd` rollup (a different code path; the image RPC runs in the daemon
   *  context). Content-free: ids/labels/costUsd/outcome ONLY (never
   *  the prompt, image bytes, or a raw provider message). Optional + additive
   *  (present only when the trajectory carries image records; schemaVersion stays
   *  1) — pre-existing constructors omit it (the `recall` precedent). */
  image: z
    .object({
      /** The executing image provider id (e.g. "openai"). */
      provider: z.string(),
      /** The image model the provider used (e.g. "gpt-image-1"). Absent on a failed/early turn. */
      model: z.string().optional(),
      /** The generation cost in USD — the reconstruction (Route a). Absent on a failed turn. */
      costUsd: z.number().optional(),
      /** The terminal outcome of the image turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"`. Absent on success. */
      errorKind: z.string().optional(),
      /** Whether the image was delivered to a channel (image.delivered fired). */
      delivered: z.boolean(),
      /** false when the generation SUCCEEDED + was delivered (base64)
       *  but the durable persist FAILED — a degraded delivery, still outcome:"ok"
       *  and still charged. Absent ⇒ persisted (or an older record). */
      persisted: z.boolean().optional(),
    })
    .optional(),
  /** The VISION turn reconstructed from the session's `media.vision.*`
   *  trajectory records (the terminal record wins). The vision cost (`costUsd`)
   *  rides HERE — `comis explain` shows it from the trajectory (Route a) — NOT
   *  `cost.costUsd`, which reads the executor-emitted `sessionEnd` rollup (a
   *  different code path; the vision RPC runs in the daemon context). The `path`
   *  is the "which tier served" signal. Content-free: ids/labels/path/costUsd/
   *  outcome ONLY (never the image bytes, the analysis prompt, or the model's
   *  answer). Optional + additive (present only when the trajectory carries
   *  media.vision.* records; schemaVersion stays 1) — pre-existing constructors
   *  omit it (the `image`/`recall` precedent). */
  vision: z
    .object({
      /** The executing vision provider id (e.g. "anthropic" on main-vision, "gemini" on the registry tier). */
      provider: z.string(),
      /** The caller agent's resolved main provider id (the lockstep label). Absent on an older / partial record. */
      mainProvider: z.string().optional(),
      /** The vision model used (e.g. "claude-sonnet-4-5"). Absent on a failed/early turn or an adapter that omits it. */
      model: z.string().optional(),
      /** The analysis cost in USD — the reconstruction (Route a). Absent on a failed turn OR the registry/gemini-video tiers. */
      costUsd: z.number().optional(),
      /** Which ladder tier served (the "which path" signal). Absent on a partial record. */
      path: z.enum(["main-vision", "registry", "gemini-video", "unavailable"]).optional(),
      /** The terminal outcome of the vision turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"`. Absent on success. */
      errorKind: z.string().optional(),
    })
    .optional(),
  /** The VIDEO-generation turn reconstructed from the session's `video.*`
   *  trajectory records (the terminal `video.generated` / `video.failed` record
   *  wins; `delivered` set when `video.delivered` fired). Unlike image/vision
   *  (wholly in-turn), a video job completes in the off-turn background poller —
   *  the `video.requested`/`video.submitted` records reach the persisted
   *  trajectory in-turn (recorder alive) and the offline assembler stitches the
   *  later completion via `traceId`/`jobId` on one `sessionKey`. The reconciled
   *  cost (`costUsd ?? estimatedCostUsd`) rides HERE (Route a — NOT `cost.costUsd`,
   *  the executor `sessionEnd`). Per-backend cost provenance: FAL/Veo=estimate,
   *  Grok=actual. Content-free: ids/labels/cost/outcome ONLY (never the prompt,
   *  the video bytes, the Veo keyed-download-URL, or a raw provider message).
   *  Optional + additive (present only when the trajectory carries `video.*`
   *  records; schemaVersion stays 1) — pre-existing constructors omit it (the
   *  `image`/`vision`/`recall` precedent).
   *
   *  SINGLE-TURN by design: this is ONE signal per session (the LAST/terminal
   *  video turn — the highest-seq `video.generated`/`video.failed` wins, not keyed
   *  by `jobId`), exactly matching the `image`/`vision` single-signal convention. A
   *  session that renders MULTIPLE videos reconstructs only the terminal one here,
   *  and `costUsd`/`estimatedCostUsd` reflect that single turn — NOT the session
   *  total. The per-hour cost ceiling (`costLimiter`) and the synthetic
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
      /** The pre-submit worst-case estimate (the cost-ceiling input; the FAL/Veo cost provenance). */
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
  /** The VOICE turn reconstructed from the session's `media.stt.*` /
   *  `media.tts.*` trajectory records (the terminal `media.*.completed` /
   *  `media.*.failed` record wins). Voice is wholly IN-TURN (unlike video's
   *  off-turn poller) — the daemon `media.transcribe` / `tts.synthesize` RPC
   *  handlers direct-emit the lifecycle records in one turn. The cost rides HERE
   *  (Route a — NOT `cost.costUsd`, the executor `sessionEnd`, a different path:
   *  the voice RPC runs in the daemon context). Honest limit: a keyless turn
   *  records `costUsd:0` EXPLICITLY (so "free" is VISIBLE, not absent); a keyed
   *  turn OMITS cost (no port carries a per-call source today — NOT a fabricated
   *  number). The `source` is the resolved selection rung (WHY `auto` picked it).
   *  Content-free: provider/keyless/model/durationMs/costUsd/source/outcome/
   *  errorKind ONLY — never a transcript, audio bytes, or a credential (the
   *  `videoGenerated` content-free discipline). Optional + additive (present only
   *  when the trajectory carries `media.stt.*`/`media.tts.*` records; schemaVersion
   *  stays 1) — pre-existing constructors omit it (the `image`/`vision`/
   *  `videoGenerated` precedent). SINGLE-TURN by design: the terminal record wins
   *  (the image/vision single-signal convention). */
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
      /** The turn cost in USD (Route a). `0` (explicit) on a keyless turn; ABSENT on a keyed turn (no per-call source today). */
      costUsd: z.number().optional(),
      /** The resolved selection rung — WHY `auto` chose this provider. Absent on a partial record. */
      source: z.enum(["explicit", "keyless-local", "follow-main-key", "fallback"]).optional(),
      /** The terminal outcome of the voice turn. */
      outcome: z.enum(["ok", "failed"]),
      /** The classified failure kind when `outcome === "failed"` (the domain SttErrorKind string, verbatim). Absent on success. */
      errorKind: z.string().optional(),
    })
    .optional(),
  /** The Verified-Learning outcome signal reconstructed from the session's
   *  `learning.outcome_observed` trajectory records (the fused terminal verdict
   *  wins). Counts/ids/closed-enums ONLY — no body/alpha/recalled ids.
   *  `outcomeResolved` is false ⇒ a finished trajectory with no resolvable outcome
   *  (the `outcome_unresolved` verdict's trigger; distinct from an explicit
   *  `unknown` resolution). `skillsUsed`/`skillFailures` empty +
   *  `synthesisAbstained` false initially (attribution/synthesis land later).
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
      // Optional/additive revision + generalization counts (counts only, never
      // bodies). Absent initially — existing fixtures unaffected.
      userModelRevised: z.number().optional(),
      memoriesGeneralized: z.number().optional(),
    })
    .optional(),
  /** The prompt-cache breaks the session incurred, aggregated per-reason from its
   *  `cache.break` trajectory records. `estCostUsd` is the directly-lost cache-read saving summed
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
  /** The security-decision audit events the session produced, aggregated
   *  counts-by-kind from the durable `obs_audit_events` scoped to the session's
   *  (tenant, agent, traceId).
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
  /** The spend kill-switch breach reconstructed from the session's terminal
   *  `spend.exceeded` trajectory record. Content-free: the breached `scope` enum
   *  + the two dollar NUMBERS (`totalUsd` = the breaching scope's spent total;
   *  `capUsd` = its ceiling) — NO message/query/body. The verdict stays
   *  amount-free; this section carries the numbers the Incident view renders.
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
       * toolStats reconciliation between THIS report (the whole-session
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
  /** The daemon-boot proxy posture reconstructed from the `config_posture`
   *  obs_diagnostics row (the boot-time snapshot written at startup). Optional +
   *  additive — present ONLY when a proxy was configured at the last daemon boot;
   *  absent (key not present) when no proxy is configured (the zero-config gate).
   *  schemaVersion stays 1 (no schema bump). Carries only maskedUrl
   *  (sanitizeProxyUrl() output — never a raw URL), booleans, and closed enum
   *  strings — the content-free invariant. The `voice?` / `learning?`
   *  presence-conditional spread mold. */
  proxyPosture: z
    .object({
      /** true when a proxy was configured (env var or config.proxy.proxyUrl). */
      configured: z.boolean(),
      /** sanitizeProxyUrl() output — never the raw proxy URL. Absent when not configured. */
      maskedUrl: z.string().optional(),
      /** The effective loopback mode (from ProxyBootConfig.loopbackMode). */
      loopbackMode: z.string().optional(),
      /** Where the proxy URL was sourced (env var or config.yaml). */
      source: z.enum(["env", "config", "none"]).optional(),
      /** true when installGlobalProxyDispatcher() completed without error. */
      installerOk: z.boolean(),
      /** The configKey string from ProxyConfigError when installerOk is false. */
      installerError: z.string().optional(),
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
 * The normalizer output (`toIncidentSignals`) that the assembler + heuristics consume.
 *
 * One shared contract for the heuristic registry's predicates: raw per-tool
 * stats + normalized failures/breaker/offload arrays, plus the derived
 * booleans/strings the deterministic `RootCause` rules key on (breaker-opened
 * tool, "DO NOT retry" signal, most-failed tool, the content-heuristic
 * misclassification signal + offending tool/token).
 */
// @optional-field-count: 17 — this is the obs.explain signal accumulator, the
// single shared contract every Glass-Box heuristic reads. Each optional field is
// a presence-conditional signal aggregated from a distinct trajectory record
// class (contextBudget / promptTimeout / toolSchemaUnsupported / recall /
// cacheBreaks / spend / image / vision / videoGenerated / voice / learning /
// channel / agentId / …) — absent when that record class did not occur.
// Clustering them would couple unrelated heuristics; the read sites already key
// on each independently. Grows by one per Glass-Box signal class (image, vision,
// videoGenerated, learning — the Verified-Learning outcome-signal shadow, spend —
// the spend-kill breach numbers for the Incident view).
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
  /** Per-node token-budget breaches folded from `subagent.budget_exceeded`
   *  trajectory records — the per-incident view (capSource + the two token
   *  numbers) the IncidentReport surfaces. */
  nodeBudgetBreaches: Array<{
    seq: number;
    nodeId: string;
    capSource: "node" | "operator-default" | "inherit-share" | "unknown";
    tokenBudget: number;
    tokensUsed: number;
  }>;
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
   *  discriminates the handler branch so gate-closed and nothing-to-strip
   *  terminals stay distinguishable in the verdict; optional because older
   *  trajectory records on disk lack it. */
  toolSchemaUnsupported?: {
    toolNames: string[];
    strippedKeywords: string[];
    retried: boolean;
    succeeded: boolean;
    reason?: "stripped" | "nothing_to_strip" | "gate_closed";
  };
  /**
   * The mapped terminal `endReason` (the NAMED degradation cause — the Glass
   * Box degradation detectors). Metadata-derived (NOT from the trajectory record
   * stream — `toIncidentSignals` omits it), so the handler threads
   * `report.outcome.endReason` onto the signals before running the registry. The
   * two lowest-priority heuristics (`context_exhausted` / `output_starved`) key
   * on it — they explain the TERMINAL state, so a tool-failure cause out-ranks
   * them. Absent ⇒ those rules do not fire (a clean session names no cause).
   */
  endReason?: string;
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
  /**
   * The LAST `execution.prompt_timeout` trajectory record (the terminal kill
   * explains the end state). Lets the `prompt_timeout` heuristic produce a
   * numbers-backed verdict naming the binding knob (stall) or
   * `stallCeilingMultiplier` (makespan) instead of falling through to NO
   * verdict. Absent ⇒ older session (the rule degrades to a generic
   * knob suggestion when `endReason` is "timeout").
   */
  promptTimeout?: IncidentPromptTimeout;
  /**
   * Memory-recall outcome aggregated over the session's `memory.recalled`
   * trajectory records. Lets the `recall_miss` heuristic name a zero-hit recall
   * on a degraded session (the #1 blind spot). Counts/booleans
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
   * Cache breaks folded per-reason from the session's `cache.break` trajectory
   * records. Bounded + deterministically ordered (count desc, reason asc).
   * Counts + a closed reason label + a summed
   * est-$ ONLY (never the changed tool names). Absent ⇒ no cache breaks in the
   * trajectory (omitted from the report — the `recall?` presence-conditional mold).
   */
  cacheBreaks?: Array<{ reason: string; count: number; estCostUsd: number }>;
  /**
   * The spend kill-switch breach folded from the session's terminal
   * `spend.exceeded` trajectory record (last wins). `totalUsd`
   * is the breaching scope's spent total (the record's `spentUsd`); `capUsd` is its
   * ceiling. Content-free (a scope enum + two numbers). Absent ⇒ the session was
   * not spend-killed (omitted from the report — the `cacheBreaks?` presence mold).
   */
  spend?: { scope: string; totalUsd: number; capUsd: number };
  /**
   * The image-generation turn reconstructed from the session's `image.*`
   * trajectory records (the terminal image.generated / image.failed record wins;
   * `delivered` set when image.delivered fired). The cost (`costUsd`) rides HERE
   * so `comis explain` shows it from the trajectory (Route a) — NOT `cost.costUsd`
   * (the executor `sessionEnd`, a different path). Content-free. Absent ⇒ no
   * image records in the trajectory.
   */
  image?: {
    provider: string;
    model?: string;
    costUsd?: number;
    outcome: "ok" | "failed";
    errorKind?: string;
    delivered: boolean;
    /** false on a persist-failed-but-delivered generation (degraded delivery,
     *  still outcome:"ok", still charged). Absent ⇒ persisted. */
    persisted?: boolean;
  };
  /**
   * The VISION turn reconstructed from the session's `media.vision.*` trajectory
   * records (the terminal media.vision.completed / media.vision.failed record
   * wins). The cost (`costUsd`) rides HERE so `comis explain` shows it from the
   * trajectory (Route a) — NOT `cost.costUsd`. The `path` is the "which tier
   * served" signal. Content-free. Absent ⇒ no media.vision.* records in the
   * trajectory.
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
   * The VIDEO-generation turn reconstructed from the session's `video.*`
   * trajectory records (the terminal `video.generated` / `video.failed` record
   * wins; `delivered` set when `video.delivered` fired, `jobId` carried from
   * `video.submitted`). The cost rides HERE so `comis explain` shows it from the
   * trajectory (Route a — NOT `cost.costUsd`). A background-completed job's later
   * completion stitches to its
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
   * The VOICE turn reconstructed from the session's `media.stt.*` /
   * `media.tts.*` trajectory records (the terminal completed/failed record wins).
   * Wholly in-turn (the daemon voice RPC handlers direct-emit). The cost rides
   * HERE (Route a — NOT `cost.costUsd`): `0` explicit on keyless ("free"
   * visible), absent on keyed (no per-call source). `source` is the selection
   * rung. Content-free. Absent ⇒ no `media.stt.*`/`media.tts.*` records in the
   * trajectory.
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
   * The outcome-signal telemetry reconstructed from the session's
   * `learning.outcome_observed` trajectory records (counts/ids/closed enums ONLY
   * — the bridged record carries no body/alpha/recalled-ids). `outcomeResolved`
   * is false ⇒ the learning shadow observed this finished trajectory but no signal
   * tier produced a resolvable outcome (the `outcome_unresolved` verdict keys on
   * exactly this — distinct from an explicit `unknown` outcome, which IS a
   * resolution). `skillsUsed`/`skillFailures` are EMPTY initially (skill-use
   * attribution lands later); `synthesisAbstained` is false initially (synthesis
   * lands later). Absent ⇒ no learning records in the trajectory (omitted from the
   * report — the signal is per-agent default-OFF). `userModelRevised`/
   * `memoriesGeneralized` are optional counts of the session's profile-revision /
   * higher-order-generalization activity (counts only, never bodies); absent
   * initially.
   */
  learning?: {
    outcomeResolved: boolean;
    outcome?: "success" | "failure" | "corrected" | "unknown";
    sources: Array<"tool" | "pipeline" | "correction" | "judge" | "reaction" | "explicit">;
    skillsUsed: string[];
    skillFailures: string[];
    synthesisAbstained: boolean;
    /** Incumbent profile entries soft-closed by revision this session (count only). Optional/additive. */
    userModelRevised?: number;
    /** Higher-order semantic memories synthesized this session (count only). Optional/additive. */
    memoriesGeneralized?: number;
  };
  /**
   * The daemon-boot proxy posture read from the latest `config_posture`
   * obs_diagnostics row. Populated by the obs-explain handler before calling
   * assembleIncidentReport. Absent ⇒ no proxy configured (zero-config).
   * maskedUrl + booleans/closed-enum strings ONLY — never a raw proxy URL.
   */
  proxyPosture?: {
    configured: boolean;
    maskedUrl?: string;
    loopbackMode?: string;
    source?: "env" | "config" | "none";
    installerOk: boolean;
    installerError?: string;
  };
}

/**
 * Assemble a redaction-safe post-mortem for a single agent session.
 *
 * Accepts EITHER `sessionKey` OR `traceId` (the `.refine` rejects neither;
 * a traceId is canonicalized to its sessionKey so there is one assembler
 * path). `depth` selects the summary (≤6 KB) vs. full projection. Admin-only;
 * the handler is non-mutating (read-only post-mortem). This contract is the
 * shared response shape; the full assembler pipeline lives in the handler.
 */
export const ObsExplainContract = defineContract({
  method: "obs.explain",
  request: z
    .object({
      sessionKey: z.string().min(1).optional(),
      traceId: z.string().min(1).optional(),
      depth: z.enum(["summary", "full"]).optional(),
      // Admin opt-in to include synthetic/test sessions (excluded by default).
      includeSynthetic: z.boolean().optional(),
    })
    .refine((r) => r.sessionKey != null || r.traceId != null, {
      message: "sessionKey or traceId required",
    }),
  response: IncidentReportSchema,
  scopes: ["admin"] as const,
});
