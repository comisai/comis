// SPDX-License-Identifier: Apache-2.0
/**
 * SUMW-01 (Phase 178): THE one resolved-summarizer window read, extracted into
 * its own module from `lcd-leaf-summarizer.ts` (which sits at the 800-line
 * file-size cap). The deps shape stays {@link LeafSummarizerDeps} — this module
 * only owns the window-resolution read; the summarizer seam, chunk selection,
 * and escalation ladder remain in `lcd-leaf-summarizer.ts`.
 *
 * Consumed by: llm-compaction (pipeline span clamp) and the 178-03 LCD
 * leaf/condense clamps (lcd-compaction-trigger / lcd-condense-trigger).
 *
 * @module
 */

import type { LeafSummarizerDeps } from "./lcd-leaf-summarizer.js";

/**
 * SUMW-01 (Phase 178): THE one resolved-summarizer window read. Mirrors
 * `buildLeafSummarizeFn`'s PRIMARY model resolution EXACTLY
 * (`overrideModel?.model ?? getRealModel()`) so a span clamp and the primary
 * LLM call always agree about WHICH model summarizes. Pitfall 2: `getModel()`
 * is the session-PRIMARY snapshot — with an `operationModels.compaction`
 * override the summarizer is a DIFFERENT model; a clamp keyed to the primary
 * would pass a 131K span to an 8K summarizer. `getRealModel` is optional-called
 * (`?.()`): production always sets it (executor-context-engine-setup.ts), but
 * pre-existing trigger-test deps builders omit it at runtime — they route to
 * the documented snapshot fallback instead of a TypeError cascade. The
 * finite-positive guard falls back to `getModel().contextWindow` (the snapshot
 * — never silently huge).
 *
 * KNOWN LIMIT (review IN-02): this resolves the PRIMARY summarizer only. The
 * production `summarize` seam may be failover-wrapped
 * (`wrapSummarizerWithFailover` via `summarizerFallbackProviders`): on
 * primary failure a fallback model with a possibly SMALLER window serves the
 * same already-sized span, and that fallback is not window-checked here — an
 * over-window span on a small fallback fails through the escalation ladder
 * (degraded, never data loss). Clamping to min(primary, ...fallback windows)
 * is a deliberate non-goal until a live incident motivates it.
 * Consumed by: llm-compaction (pipeline span clamp) and the 178-03 LCD
 * leaf/condense clamps.
 */
export function resolveSummarizerWindowTokens(
  deps: Pick<LeafSummarizerDeps, "overrideModel" | "getRealModel" | "getModel">,
): number {
  const resolved = deps.overrideModel?.model ?? deps.getRealModel?.();
  const win = (resolved as { contextWindow?: number } | undefined)?.contextWindow;
  return typeof win === "number" && Number.isFinite(win) && win > 0
    ? win
    : deps.getModel().contextWindow; // documented fallback: the snapshot — never silently huge
}
