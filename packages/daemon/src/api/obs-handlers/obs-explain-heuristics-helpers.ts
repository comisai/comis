// SPDX-License-Identifier: Apache-2.0
/**
 * Tunable thresholds + rule helpers for the deterministic root-cause heuristic
 * registry (`obs-explain-heuristics.ts`). Kept beside the registry so the
 * ordered rules stay readable; PURE (no LLM, no I/O, no globals).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/**
 * Minimum same-tool failures for the repeated-failure breaker path to fire when
 * no explicit breaker event / "DO NOT retry" line is present. Re-exported from
 * the signals module's `BREAKER_N` intent (kept literal here so the registry has
 * no runtime import cycle with the normalizer).
 */
export const BREAKER_N = 5;

/** Minimum disk offloads for the context-bloat insurance signal. */
export const CONTEXT_BLOAT_MIN_OFFLOADS = 3;

/**
 * A single large-result offload (chars) that, on its own, marks a token spike
 * for the context-bloat heuristic — one ~50 KB body offloaded is already a
 * working-set spike.
 */
export const TOKEN_SPIKE_CHARS = 32_000;

/** Substrings that mark a missing-dependency exec failure (insurance code). */
export const MODULE_NOT_FOUND_MARKERS: readonly string[] = [
  "ModuleNotFoundError",
  "Cannot find module",
];

/**
 * The tool the breaker most plausibly opened on: the explicit breaker-opened
 * tool, else the most-failed tool, else the first tool with a repeated-failure
 * count. Returns `undefined` when no tool can be named.
 */
export function breakerTool(s: IncidentSignals): string | undefined {
  if (s.breakerOpenedTool !== undefined) return s.breakerOpenedTool;
  if (s.mostFailedTool !== undefined) return s.mostFailedTool;
  for (const tool of Object.keys(s.repeatedFailureCount)) return tool;
  return undefined;
}

/** Does any failure body carry a known module-not-found marker? */
export function hasModuleNotFound(s: IncidentSignals): boolean {
  return s.failures.some(
    (f) =>
      f.errorKind === "dependency" &&
      MODULE_NOT_FOUND_MARKERS.some((marker) => f.errorPreview.includes(marker)),
  );
}
