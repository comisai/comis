// SPDX-License-Identifier: Apache-2.0
/**
 * Characterization (regression-guard) tests for the COMPACTION SPAN invariant
 * (SUMW-01, Phase 178; structural precedent: recall-dag-budget-partition.test.ts).
 *
 * THE INVARIANT: for ALL compaction calls, inputTokens ≤ the RESOLVED
 * summarizer's effective window. The summarizer that ACTUALLY runs is
 * `overrideModel?.model ?? getRealModel()` (resolveSummarizerWindowTokens,
 * lcd-leaf-summarizer.ts — the one resolved-summarizer window read), which with
 * an `operationModels.compaction` override can be a MUCH smaller model than the
 * session primary (e.g. an 8K local summarizer under a 131K primary).
 *
 * THREE coupled clamp sites encode the invariant and must stay in agreement —
 * all three subtract the SHARED `SUMMARIZER_PROMPT_OVERHEAD_TOKENS` reserve
 * (constants.ts) from the resolved window before sizing their input span:
 *   1. llm-compaction.ts (pipeline): summarizes only the oldest-first prefix of
 *      `evictableMiddle` fitting `summarizerWindow − budget.outputReserveTokens −
 *      OVERHEAD`; the un-summarized remainder is re-inserted (never dropped).
 *   2. lcd-compaction-trigger.ts (LCD leaf): the chunk cap is clamped to
 *      `min(leafChunkTokens, summarizerWindow − leafTargetTokens − OVERHEAD)`,
 *      floored at MIN_SHRINKABLE_LEAF_CHUNK_TOKENS (the degenerate-window
 *      terminator); the bounded drain + next-turn re-arming split the backlog.
 *   3. lcd-condense-trigger.ts (LCD condense): the selected run is prefix-trimmed
 *      to the longest child prefix whose Σ tokenCount fits `summarizerWindow −
 *      condensedTargetTokens − OVERHEAD` (keep < 2 → honest skip); trimmed
 *      children survive in the store for a later pass.
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

  it("LEAF: clampedLeafChunk + leafTargetTokens + SUMMARIZER_PROMPT_OVERHEAD_TOKENS ≤ W for every grid window", () => {
    for (const W of GRID_WINDOWS) {
      // Premise guard: every grid window is above the degenerate floor (where
      // the MAX floor would bind and the pass terminates via "too-small" instead
      // of summarizing — the inequality deliberately does not cover that branch).
      expect(W - cfg.leafTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS).toBeGreaterThanOrEqual(
        MIN_SHRINKABLE_LEAF_CHUNK_TOKENS,
      );
      // The exact clamp formula from maybeRunLeafPass (lcd-compaction-trigger.ts).
      const clampedLeafChunk = Math.max(
        MIN_SHRINKABLE_LEAF_CHUNK_TOKENS,
        Math.min(cfg.leafChunkTokens, W - cfg.leafTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS),
      );
      // The invariant: chunk + summary target + prompt overhead fits the window.
      expect(clampedLeafChunk + cfg.leafTargetTokens + SUMMARIZER_PROMPT_OVERHEAD_TOKENS).toBeLessThanOrEqual(W);
      // And the clamp never exceeds the configured knob (the no-op pin direction).
      expect(clampedLeafChunk).toBeLessThanOrEqual(cfg.leafChunkTokens);
    }
  });

  it("CONDENSE: any kept child prefix (Σ ≤ childTokenBudget) + condensedTargetTokens + OVERHEAD ≤ W for every grid window", () => {
    for (const W of GRID_WINDOWS) {
      // The exact budget formula from maybeRunCondensePass (lcd-condense-trigger.ts).
      const childTokenBudget = W - cfg.condensedTargetTokens - SUMMARIZER_PROMPT_OVERHEAD_TOKENS;
      // Feasibility: every grid window leaves a positive child budget (the
      // infeasible-window skip is the C2 behavioral fixture).
      expect(childTokenBudget).toBeGreaterThan(0);
      // The trim keeps Σ child tokenCount ≤ childTokenBudget by construction, so
      // the summarizer input + target + overhead always fits the window.
      expect(childTokenBudget + cfg.condensedTargetTokens + SUMMARIZER_PROMPT_OVERHEAD_TOKENS).toBeLessThanOrEqual(W);
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
