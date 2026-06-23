// SPDX-License-Identifier: Apache-2.0
/**
 * The optional `IncidentReport` SECTION sub-schemas + their inferred types.
 *
 * Extracted from `incident-report.ts` to keep that module under the 800-line
 * file-size cap (the obs-handlers fold-extraction discipline). These are the
 * self-contained, content-free sections the `obs.explain` normalizer folds from
 * the trajectory and the report/`IncidentSignals` both reference:
 *   - `IncidentContextBudgetSchema` (W3) — the per-LLM-call budget equation.
 *   - `IncidentPromptTimeoutSchema` (LAT-04) — the terminal prompt-timeout attribution.
 *   - `SpawnTreeNodeSchema` (TREE-01/02) — one node of the per-cap spawn tree.
 *
 * Barrel-only: external consumers import these from `"@comis/core"` (re-exported
 * by `incident-report.ts` → `observability.ts`), so the public surface is unchanged.
 *
 * @module
 */
import { z } from "zod";

/**
 * W3 (obs-llm-troubleshooting): the per-LLM-call context budget equation,
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
   *  names; "served" (KNOB-02) means the Ollama-served num_ctx bound the window
   *  (knobs: OLLAMA_CONTEXT_LENGTH env / Modelfile PARAMETER num_ctx);
   *  "capabilityClass" (WR-01) means the executor-side class cap from the
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
 * LAT-04 (177): the terminal prompt-timeout attribution record — the LAST
 * `execution.prompt_timeout` trajectory row. Content-free: numbers + closed
 * enums + the pre-rendered config-KEY string (`bindingKnob` — knob NAME + ids
 * only, never values/bodies). Wholesale-validated by the signals normalizer
 * (the contextBudget discipline); a malformed/partial record is ignored
 * (forward-compatible). Signals-only — NOT on `IncidentReportSchema`
 * (mirroring the GBNF-02 `toolSchemaUnsupported` precedent: the heuristic
 * verdict carries what the operator needs).
 */
export const IncidentPromptTimeoutSchema = z.object({
  /** The configured ms value of the limit that FIRED. */
  timeoutMs: z.number(),
  /** Elapsed wall-clock ms at kill. */
  durationMs: z.number().optional(),
  /** Which limit fired: stall budget vs makespan ceiling. Absent = whole-turn (retry-path/pre-LAT-02 rows). */
  limit: z.enum(["stall", "makespan"]).optional(),
  /** Binding resolution level (LAT-01 — the agent-side TimeoutSource union). */
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
 * TREE-01/02 (215): one node of the root→children SPAWN TREE folded from a
 * session's `capability.audited` records (one per `leaseId`) — the attenuated
 * `caps` held, the tool NAMES invoked, and any `CapabilityDeniedError` cap in
 * `denials` (TREE-02). `parentLeaseId` is the child→root edge (absent on the root
 * and on the lease-less in-process path, which groups under its synthetic
 * `rootRunId`, G1); `budgetTokensUsed` is honest-optional (G3 — the live `whoami`
 * owns remaining budget; this is post-mortem topology). Content-free (ids / caps
 * / tool-NAMES / denials ONLY, §2.7). Single source of truth for BOTH
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
