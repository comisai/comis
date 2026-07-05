// SPDX-License-Identifier: Apache-2.0
/**
 * The optional `IncidentReport` SECTION sub-schemas + their inferred types.
 *
 * Extracted from `incident-report.ts` to keep that module under the 800-line
 * file-size cap (the obs-handlers fold-extraction discipline). These are the
 * self-contained, content-free sections the `obs.explain` normalizer folds from
 * the trajectory and the report/`IncidentSignals` both reference:
 *   - `IncidentContextBudgetSchema` — the per-LLM-call budget equation.
 *   - `IncidentPromptTimeoutSchema` — the terminal prompt-timeout attribution.
 *   - `SpawnTreeNodeSchema` — one node of the per-cap spawn tree.
 *
 * Barrel-only: external consumers import these from `"@comis/core"` (re-exported
 * by `incident-report.ts` → `observability.ts`), so the public surface is unchanged.
 *
 * @module
 */
import { z } from "zod";

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
 * The woke-fire wake-gate fact (content-free — counts/ids/boolean ONLY, no free
 * text). A wake gate that WOKE the model runs the job in its main session, so
 * that fire (and only that fire) has a session/trajectory to post-mortem; the
 * `obs.explain` normalizer folds its `scheduler.wake_gate` trajectory record here
 * (LAST wins). A SKIPPED fire opens no session and produces no IncidentReport at
 * all — its lens is the enriched `cron.runs` row, not `comis explain`. The gate's
 * gathered finding / script source never rides this fact (bounded z.object; any
 * off-vocabulary key is stripped on parse).
 */
export const IncidentCronWakeGateSchema = z.object({
  /** The cron job whose gated fire woke the model. */
  jobId: z.string(),
  /** Always true on the report path — only a woke fire has a session (a skip records nothing here). */
  wake: z.boolean(),
  /** Wall-clock ms the gate's pre-flight took. */
  durationMs: z.number(),
  /** Tool calls the gate's pre-flight made (reconstructed in detail via the content-free cap-audit stream). */
  toolCalls: z.number(),
  /** Model turns the gate estimated it saved (0 on a wake — the model ran). */
  estTurnsSaved: z.number(),
});

/** The woke-fire wake-gate fact (see {@link IncidentCronWakeGateSchema}). */
export type IncidentCronWakeGate = z.infer<typeof IncidentCronWakeGateSchema>;

/**
 * One COMPACT per-turn budget-check entry — the cascade
 * shape. `IncidentReport.contextBudget` keeps only the TERMINAL fit-check; a `context_exhausted`
 * abort needs the PROGRESSION (each turn's assembled-input growth + eviction + verdict) to see the
 * tightening toward exhaustion. The history folds these (dedup'd on transition, most-recent capped) so
 * the cascade is one `explain` field away. The four fields that move turn-to-turn — the window is
 * fixed per session, S is ~fixed, so assembledInputTokens + keptCount + verdict carry the signal.
 */
export const IncidentContextBudgetHistoryEntrySchema = z.object({
  windowTokens: z.number(),
  assembledInputTokens: z.number(),
  keptCount: z.number(),
  verdict: z.enum(["fits", "downshifted", "exhausted"]),
});

/** One per-turn context-budget cascade entry (see {@link IncidentContextBudgetHistoryEntrySchema}). */
export type IncidentContextBudgetHistoryEntry = z.infer<typeof IncidentContextBudgetHistoryEntrySchema>;

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
  /** Which limit fired: stall budget vs makespan ceiling. Absent = whole-turn (retry-path rows, or a row that omits it). */
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

/**
 * One node of the root→children SPAWN TREE folded from a
 * session's `capability.audited` records (one per `leaseId`) — the attenuated
 * `caps` held, the tool NAMES invoked, and any `CapabilityDeniedError` cap in
 * `denials`. `parentLeaseId` is the child→root edge (absent on the root
 * and on the lease-less in-process path, which groups under its synthetic
 * `rootRunId`); `budgetTokensUsed` is honest-optional (the live `whoami`
 * owns remaining budget; this is post-mortem topology). Content-free (ids / caps
 * / tool-NAMES / denials ONLY). Single source of truth for BOTH
 * `IncidentReportSchema.spawnTree` and `IncidentSignals.spawnTree`.
 */
export const SpawnTreeNodeSchema = z.object({
  leaseId: z.string(),
  parentLeaseId: z.string().optional(),
  rootRunId: z.string(),
  agentId: z.string(),
  caps: z.array(z.string()),
  toolsInvoked: z.array(z.string()),
  denials: z.array(z.string()),
  budgetTokensUsed: z.number().optional(),
});

/** One spawn-tree node (see {@link SpawnTreeNodeSchema}). */
export type SpawnTreeNode = z.infer<typeof SpawnTreeNodeSchema>;
