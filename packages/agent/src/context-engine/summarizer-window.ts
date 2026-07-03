// SPDX-License-Identifier: Apache-2.0
/**
 * THE one resolved-summarizer window read, kept in its own module so
 * `lcd-leaf-summarizer.ts` stays under the 800-line file-size cap.
 * The deps shape stays {@link LeafSummarizerDeps} — this module
 * only owns the window-resolution read; the summarizer seam, chunk selection,
 * and escalation ladder remain in `lcd-leaf-summarizer.ts`.
 *
 * Consumed by: llm-compaction (pipeline span clamp, via
 * {@link effectiveSummarizerWindow}) and the LCD leaf/condense clamps
 * (lcd-compaction-trigger / lcd-condense-trigger, via
 * {@link resolveSummarizerWindowTokens}).
 *
 * @module
 */

import type { LeafSummarizerDeps } from "./lcd-leaf-summarizer.js";

/**
 * Combine a candidate summarizer's CONFIGURED contextWindow with the
 * provider-SERVED window bound to that candidate into the one
 * effective window the span clamps size against. Finite-positive guards on
 * both inputs (an invalid number never disables or inflates a
 * clamp):
 *
 *  - both valid → `min(configured, served)` — the provider truncates anything
 *    above what it serves, and the model's declared window governs from above
 *    (serving MORE than configured never raises the window);
 *  - only one valid → that one (the served value is PROBED truth, never an
 *    invented window — it may stand alone when a registry model lacks a
 *    usable contextWindow);
 *  - neither valid → `undefined` (the caller's no-clamp / fallback path).
 *
 * The served value must already be PROVIDER-GATED and CANDIDATE-BOUND by the
 * wiring site (see the `servedWindow` / `primaryServedWindow` fields on
 * {@link LeafSummarizerDeps}) — this helper does pure arithmetic only.
 */
export function effectiveSummarizerWindow(
  configuredWindow: unknown,
  servedWindow: number | undefined,
): number | undefined {
  const cfg =
    typeof configuredWindow === "number" && Number.isFinite(configuredWindow) && configuredWindow > 0
      ? configuredWindow
      : undefined;
  const served =
    typeof servedWindow === "number" && Number.isFinite(servedWindow) && servedWindow > 0
      ? servedWindow
      : undefined;
  if (cfg !== undefined && served !== undefined) return Math.min(cfg, served);
  return cfg ?? served;
}

/**
 * THE one resolved-summarizer window read. Mirrors
 * `buildLeafSummarizeFn`'s PRIMARY model resolution EXACTLY
 * (`overrideModel?.model ?? getRealModel()`) so a span clamp and the primary
 * LLM call always agree about WHICH model summarizes. Pitfall: `getModel()`
 * is the session-PRIMARY snapshot — with an `operationModels.compaction`
 * override the summarizer is a DIFFERENT model; a clamp keyed to the primary
 * would pass a 131K span to an 8K summarizer. `getRealModel` is optional-called
 * (`?.()`): production always sets it (executor-context-engine-setup.ts), but
 * pre-existing trigger-test deps builders omit it at runtime — they route to
 * the documented snapshot fallback instead of a TypeError cascade. The
 * finite-positive guard falls back to `getModel().contextWindow` (the snapshot
 * — never silently huge).
 *
 * Served-window truth: the configured window is then min()'d with the
 * provider-SERVED window bound to the SAME candidate the `??` chain
 * resolved — `overrideModel.servedWindow` when the override summarizes,
 * `primaryServedWindow` when the primary does. Both values were provider-gated
 * at the wiring site against the probed `{providerKey, window}` pair, so a
 * served bound can never clamp a summarizer on another
 * provider; on the flagship gap (configured 131_072, Ollama serving 8_192,
 * summarizer = primary) this resolves 8_192 and the leaf/condense/pipeline
 * clamps bind against the window the provider will actually serve.
 *
 * KNOWN LIMIT: this resolves the PRIMARY summarizer only. The
 * production `summarize` seam may be failover-wrapped
 * (`wrapSummarizerWithFailover` via `summarizerFallbackProviders`): on
 * primary failure a fallback model with a possibly SMALLER window serves the
 * same already-sized span, and that fallback is neither window-checked nor
 * served-window-checked here — an over-window span on a small fallback fails
 * through the escalation ladder (degraded, never data loss). Clamping to
 * min(primary, ...fallback windows) is a deliberate non-goal until a live
 * incident motivates it.
 * Consumed by: llm-compaction (pipeline span clamp) and the LCD
 * leaf/condense clamps.
 */
export function resolveSummarizerWindowTokens(
  deps: Pick<LeafSummarizerDeps, "overrideModel" | "getRealModel" | "getModel" | "primaryServedWindow">,
): number {
  const overrideResolved = deps.overrideModel?.model;
  const resolved = overrideResolved ?? deps.getRealModel?.();
  const win = (resolved as { contextWindow?: number } | undefined)?.contextWindow;
  const configured =
    typeof win === "number" && Number.isFinite(win) && win > 0
      ? win
      : deps.getModel().contextWindow; // documented fallback: the snapshot — never silently huge
  // The served truth rides the SAME candidate the ?? above resolved
  // (`!= null` is the exact nullish test `??` applies to overrideModel.model),
  // so clamp and call can never disagree about which provider's bound applies.
  const served = overrideResolved != null ? deps.overrideModel?.servedWindow : deps.primaryServedWindow;
  return effectiveSummarizerWindow(configured, served) ?? configured;
}
