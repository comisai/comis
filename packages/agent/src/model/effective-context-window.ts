// SPDX-License-Identifier: Apache-2.0
/**
 * Effective context window resolver: deterministic min() reconciliation across
 * the three sources that can constrain an agent's usable context window.
 *
 * Pure function — no side effects, no async, no DI. All context passed
 * as parameters. Mirrors the operation-model-resolver.ts pattern.
 *
 * Sources (in priority order for tie-breaking — earlier wins on equal value):
 *   1. configured  — operator config (contextWindow in providers/agents config)
 *   2. served      — Ollama /api/ps num_ctx (present only when probe ran)
 *   3. capability  — ModelProfile capabilityCap (Infinity for frontier/mid)
 *
 * Infinity capabilityCap is excluded from the min race: frontier/mid models
 * carry Infinity to signal "no capability upper bound", so it must not shrink
 * the configured window.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Inputs to the effective-context-window resolver. */
export interface EffectiveContextWindowInput {
  /** Operator-configured context window (from providers/agents config). */
  configured: number;
  /**
   * Served context window discovered via Ollama capacity probe (/api/ps).
   * Omit or pass undefined when no probe result is available.
   */
  served?: number;
  /**
   * ModelProfile capability cap for this capability class.
   * Pass Infinity for frontier/mid models (excluded from the min race).
   */
  capabilityCap: number;
}

/** Result of resolving the effective context window. */
export interface EffectiveContextWindowResult {
  /** The resolved effective context window (minimum of the active constraints). */
  effectiveWindow: number;
  /** Which source provided the binding constraint. */
  source: "served" | "capability" | "configured";
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the effective context window as min(configured, served?, capabilityCap).
 *
 * Rules:
 * - `Infinity` capabilityCap is excluded from the race (not a constraint).
 * - `undefined` served is excluded from the race (probe not available).
 * - Ties resolve to the earlier candidate: configured > served > capability.
 *   (The reduce uses strict `<`, so equal values keep the first/earlier entry.)
 *
 * @param input - The three possible window constraints
 * @returns The minimum active constraint and the source that provided it
 */
export function resolveEffectiveContextWindow(
  input: EffectiveContextWindowInput,
): EffectiveContextWindowResult {
  const { configured, served, capabilityCap } = input;

  // Build the candidate list in tie-break priority order (earlier wins on equal).
  const candidates: Array<{ value: number; source: EffectiveContextWindowResult["source"] }> = [
    { value: configured, source: "configured" },
  ];

  // served=undefined means the probe didn't run — exclude from the race.
  if (served !== undefined) {
    candidates.push({ value: served, source: "served" });
  }

  // Infinity capabilityCap means "no class-level upper bound" (frontier/mid).
  // Exclude it so it does not constrain the configured window.
  if (isFinite(capabilityCap)) {
    candidates.push({ value: capabilityCap, source: "capability" });
  }

  // Stable min: strict `<` means ties keep the first (earlier) candidate.
  const winner = candidates.reduce((a, b) => (b.value < a.value ? b : a));

  return { effectiveWindow: winner.value, source: winner.source };
}
