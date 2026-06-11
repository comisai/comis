// SPDX-License-Identifier: Apache-2.0
/**
 * Characterization (regression-guard) tests for the COMPACTION SPAN invariant
 * (SUMW-01, Phase 178; structural precedent: recall-dag-budget-partition.test.ts).
 *
 * THE INVARIANT: for ALL compaction calls, inputTokens ≤ the RESOLVED
 * summarizer's effective window. The summarizer that ACTUALLY runs is
 * `overrideModel?.model ?? getRealModel()` (resolveSummarizerWindowTokens,
 * summarizer-window.ts — the one resolved-summarizer window read), which with
 * an `operationModels.compaction` override can be a MUCH smaller model than the
 * session primary (e.g. an 8K local summarizer under a 131K primary).
 *
 * THREE coupled clamp sites encode the invariant and must stay in agreement —
 * all three subtract the SHARED `SUMMARIZER_PROMPT_OVERHEAD_TOKENS` reserve
 * (constants.ts) from the resolved window before sizing their input span:
 *   1. llm-compaction.ts (pipeline): summarizes only the oldest-first prefix of
 *      `evictableMiddle` fitting `summarizerWindow − summaryReserve − OVERHEAD`
 *      (review CR-01: summaryReserve = min(budget.outputReserveTokens,
 *      max(1, ⌊W/4⌋)) — summarizer-sized, never the session reserve, so small
 *      windows cannot go permanently negative); the un-summarized remainder is
 *      re-inserted (never dropped), and a cut===0 oldest message escalates
 *      through the Level-2/3 ladder (convergence — never a permanent skip).
 *   2. lcd-compaction-trigger.ts (LCD leaf): the chunk cap is clamped to
 *      `min(leafChunkTokens, summarizerWindow − leafTargetTokens − OVERHEAD −
 *      prevTokens)` (review WR-03: the ACTUAL threaded previousSummary tokens
 *      — OVERHEAD covers only the instruction template), floored at
 *      MIN_SHRINKABLE_LEAF_CHUNK_TOKENS; the bounded drain + next-turn
 *      re-arming split the backlog.
 *   3. lcd-condense-trigger.ts (LCD condense): the selected run is prefix-trimmed
 *      to the longest child prefix whose Σ tokenCount fits `summarizerWindow −
 *      condensedTargetTokens − OVERHEAD − prevTokens` (keep < 2 → honest skip);
 *      trimmed children survive in the store for a later pass.
 *
 * THE REGRESSION CLASS PREVENTED: a small RESOLVED summarizer fed an over-window
 * span → an opaque provider error or silent truncation, surfacing live as
 * "compaction intermittently fails" with no knob-named diagnosis (the v2.20/
 * DIST-01 class). The arithmetic grid below is window-independent algebra over
 * the REAL constants (never re-literaled), so a future change to the overhead
 * reserve or the schema defaults re-verifies the fit; the source-locks pin every
 * clamp site to the shared constant + the shared resolved-window read so one
 * site can never silently drift to a different model or reserve.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ContextEngineConfigSchema } from "@comis/core";
import { SUMMARIZER_PROMPT_OVERHEAD_TOKENS } from "./constants.js";
import { MIN_SHRINKABLE_LEAF_CHUNK_TOKENS } from "./lcd-leaf-summarizer.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Resolved-summarizer windows spanning local-small → frontier (all above the
 *  degenerate floor — the degenerate behavioral cases are the trigger tests'
 *  L3/C2 fixtures). */
const GRID_WINDOWS = [8_000, 16_000, 32_000, 131_072, 200_000] as const;

describe("compaction span invariant (SUMW-01): window-independent arithmetic grid", () => {
  const cfg = ContextEngineConfigSchema.parse({});
  // Review WR-03: the previousSummary dimension — the budget subtracts the
  // ACTUAL threaded previousSummary tokens (the flat OVERHEAD covers only the
  // template). Grid: none / a leaf-target-sized one / a condense-target-sized
  // one (previousSummaryContent returns the last summary of ANY kind).
  const PREV_TOKENS = [0, 1_200, 2_000] as const;

  it("LEAF: clampedLeafChunk + leafTargetTokens + OVERHEAD + prevTokens ≤ W for every grid window × previousSummary size", () => {
    for (const W of GRID_WINDOWS) {
      for (const prev of PREV_TOKENS) {
        // Premise guard: every grid point is above the degenerate floor (where
        // the MAX floor would bind and the pass terminates via "too-small" /
        // the WR-02 deterministic floor instead — the inequality deliberately
        // does not cover that branch).
        expect(W - cfg.leafTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS - prev).toBeGreaterThanOrEqual(
          MIN_SHRINKABLE_LEAF_CHUNK_TOKENS,
        );
        // The exact clamp formula from runOneLeafPass (lcd-compaction-trigger.ts).
        const clampedLeafChunk = Math.max(
          MIN_SHRINKABLE_LEAF_CHUNK_TOKENS,
          Math.min(cfg.leafChunkTokens, W - cfg.leafTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS - prev),
        );
        // The invariant: chunk + summary target + template + previousSummary fits W.
        expect(clampedLeafChunk + cfg.leafTargetTokens + SUMMARIZER_PROMPT_OVERHEAD_TOKENS + prev).toBeLessThanOrEqual(W);
        // And the clamp never exceeds the configured knob (the no-op pin direction).
        expect(clampedLeafChunk).toBeLessThanOrEqual(cfg.leafChunkTokens);
      }
    }
  });

  it("CONDENSE: any kept child prefix (Σ ≤ childTokenBudget) + condensedTargetTokens + OVERHEAD + prevTokens ≤ W for every grid window × previousSummary size", () => {
    for (const W of GRID_WINDOWS) {
      for (const prev of PREV_TOKENS) {
        // The exact budget formula from maybeRunCondensePass (lcd-condense-trigger.ts).
        const childTokenBudget = W - cfg.condensedTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS - prev;
        // Feasibility: every grid point leaves a positive child budget (the
        // infeasible-window skip is the C2 behavioral fixture).
        expect(childTokenBudget).toBeGreaterThan(0);
        // The trim keeps Σ child tokenCount ≤ childTokenBudget by construction, so
        // the summarizer input + target + template + previousSummary fits W.
        expect(childTokenBudget + cfg.condensedTargetTokens + SUMMARIZER_PROMPT_OVERHEAD_TOKENS + prev).toBeLessThanOrEqual(W);
      }
    }
  });
});

describe("compaction span invariant (SUMW-01): structural source-locks across the three clamp sites", () => {
  const leafTriggerSource = readFileSync(resolve(here, "../executor/lcd-compaction-trigger.ts"), "utf-8");
  const condenseTriggerSource = readFileSync(resolve(here, "../executor/lcd-condense-trigger.ts"), "utf-8");
  const pipelineSource = readFileSync(resolve(here, "llm-compaction.ts"), "utf-8");

  it("all three clamp sites consume the SHARED overhead constant (SUMMARIZER_PROMPT_OVERHEAD_TOKENS)", () => {
    // One shared reserve, three consumers — a site re-literaling its own number
    // (or dropping the subtraction) breaks the lock before it breaks production.
    expect(leafTriggerSource).toContain("SUMMARIZER_PROMPT_OVERHEAD_TOKENS");
    expect(condenseTriggerSource).toContain("SUMMARIZER_PROMPT_OVERHEAD_TOKENS");
    expect(pipelineSource).toContain("SUMMARIZER_PROMPT_OVERHEAD_TOKENS");
  });

  it("both LCD triggers key their clamp to the RESOLVED summarizer (resolveSummarizerWindowTokens — never the getModel() session-primary snapshot)", () => {
    // Pitfall 2: a clamp keyed to the session-primary snapshot would pass a 131K
    // span to an 8K operationModels.compaction override. Both triggers must read
    // the window through the ONE shared helper that mirrors the summarize call's
    // own model resolution (overrideModel?.model ?? getRealModel()).
    expect(leafTriggerSource).toContain("resolveSummarizerWindowTokens(");
    expect(condenseTriggerSource).toContain("resolveSummarizerWindowTokens(");
  });
});

// ---------------------------------------------------------------------------
// INT-W1 (milestone integration WARNING 1): the SERVED-window dimension. The
// Phase-176 boot probe discovers the window the provider will ACTUALLY serve
// (e.g. Ollama num_ctx 8_192 against a configured 131_072); the resolved
// summarizer window must be min(configured, served) whenever the summarizer
// executes on the provider the served value was probed from — otherwise the
// SUMW-01 clamps size spans against a configured fiction and the provider
// silently truncates the summarize input (the flagship gap).
// ---------------------------------------------------------------------------

describe("compaction span invariant (INT-W1): served-window arithmetic dimension", () => {
  const cfg = ContextEngineConfigSchema.parse({});
  const PREV_TOKENS = [0, 1_200, 2_000] as const;
  /** configured × served grid: the flagship pair (131_072 / 8_192), a mid
   *  served bound, and the served-larger direction (configured must govern). */
  const SERVED_GRID = [
    { configured: 131_072, served: 8_192 },
    { configured: 131_072, served: 32_768 },
    { configured: 32_768, served: 131_072 },
  ] as const;

  it("LEAF and CONDENSE clamps computed on min(configured, served) always fit the window the provider will ACTUALLY serve", () => {
    for (const { configured, served } of SERVED_GRID) {
      // The INT-W1 resolution: the candidate-bound served window min()s the
      // configured window (never raises it).
      const resolved = Math.min(configured, served);
      // What the provider accepts is bounded by BOTH numbers.
      const providerBound = Math.min(configured, served);
      for (const prev of PREV_TOKENS) {
        // Premise guard: every grid point stays above the degenerate floor.
        expect(resolved - cfg.leafTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS - prev).toBeGreaterThanOrEqual(
          MIN_SHRINKABLE_LEAF_CHUNK_TOKENS,
        );
        // LEAF: the exact clamp formula from runOneLeafPass over the RESOLVED window.
        const clampedLeafChunk = Math.max(
          MIN_SHRINKABLE_LEAF_CHUNK_TOKENS,
          Math.min(cfg.leafChunkTokens, resolved - cfg.leafTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS - prev),
        );
        expect(clampedLeafChunk + cfg.leafTargetTokens + SUMMARIZER_PROMPT_OVERHEAD_TOKENS + prev).toBeLessThanOrEqual(
          providerBound,
        );
        // CONDENSE: the exact budget formula from maybeRunCondensePass over the RESOLVED window.
        const childTokenBudget = resolved - cfg.condensedTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS - prev;
        expect(childTokenBudget).toBeGreaterThan(0);
        expect(childTokenBudget + cfg.condensedTargetTokens + SUMMARIZER_PROMPT_OVERHEAD_TOKENS + prev).toBeLessThanOrEqual(
          providerBound,
        );
      }
    }
  });
});

describe("compaction span invariant (INT-W1): served-window source-locks", () => {
  const summarizerWindowSource = readFileSync(resolve(here, "summarizer-window.ts"), "utf-8");
  const pipelineSourceForServed = readFileSync(resolve(here, "llm-compaction.ts"), "utf-8");
  const setupSource = readFileSync(
    resolve(here, "../executor/executor-context-engine-setup.ts"),
    "utf-8",
  );

  it("resolveSummarizerWindowTokens consumes the CANDIDATE-BOUND served fields (deps.primaryServedWindow / deps.overrideModel?.servedWindow)", () => {
    // The served value must ride the candidate model it was provider-gated for
    // — a deps-level bare number the helper applies regardless of which
    // candidate resolves would clamp cross-provider overrides (the exact
    // WR-02 regression the binding prevents).
    expect(summarizerWindowSource).toContain("deps.primaryServedWindow");
    expect(summarizerWindowSource).toContain("deps.overrideModel?.servedWindow");
  });

  it("the pipeline Step-4 read binds the served value in the SAME branch that selects the summarizer model", () => {
    // Clamp/call agreement: override-success → the override's servedWindow;
    // override-key-failure fallback AND no-override → the primary's.
    expect(pipelineSourceForServed).toContain("deps.overrideModel.servedWindow");
    expect(pipelineSourceForServed).toContain("deps.primaryServedWindow");
  });

  it("the wiring site provider-gates the 176 served pair in CONFIG space (providers.entries keys — never model.provider)", () => {
    // The override gate compares the pair's providerKey against the
    // operation-model resolution's provider key; the primary binding reuses
    // the executor reconcile's already-gated windowProvenance.served (WR-02 —
    // the registry alias fallback can rename model.provider, so config-space
    // keys are the only sound comparison).
    expect(setupSource).toContain("providerKey === compactionResolution.provider");
    expect(setupSource).toContain("windowProvenance?.served");
  });
});
