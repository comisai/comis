// SPDX-License-Identifier: Apache-2.0
/**
 * Served-Window Comparator: boot-time comparison of the Ollama-served context
 * window (discovered by ollama-capacity-probe.ts) against the registry-resolved
 * configured contextWindow for the same provider.
 *
 * The probe discovers the served window; without this comparison an operator
 * whose Ollama serves 8K against a configured 131072 gets a silently shrunken
 * agent. This module is the boot-time comparison:
 *
 * - served < configured → exactly ONE WARN per provider per boot, naming both
 *   numbers, both Ollama knobs (`OLLAMA_CONTEXT_LENGTH` / `PARAMETER num_ctx`),
 *   the probed model, and the `probeServedWindow` opt-out path.
 * - served >= configured, equal windows, or provider absent from the probe map
 *   → silent (healthy boot stays quiet).
 * - EVERY call returns the structured {@link ServedWindowComparison} — latched
 *   repeat calls return data WITHOUT re-warning, so the daemon can collect one
 *   result per agent for the config-posture count (one comparison, two
 *   surfaces).
 *
 * Multi-model limitation: Ollama serves num_ctx PER MODEL but the probe yields
 * one window per provider (probed on models[0] via resolveProbedModelId); the
 * WARN names the probed model; per-model probing is a possible future
 * refinement.
 *
 * @module
 */

import { resolveProbedModelId } from "./ollama-capacity-probe.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structured comparison result — collected by the daemon for the config-posture count. */
export interface ServedWindowComparison {
  providerId: string;
  /** The probe-discovered served num_ctx. */
  served: number;
  /** Registry-resolved contextWindow (executor parity, incl. the ?? 8_192 fallback). */
  configured: number;
  /** Which model the probe used (resolveProbedModelId — shared with the probe). */
  probedModelId: string;
  /** true ⇒ the agent runs with the smaller served window. */
  belowConfigured: boolean;
}

/** Inputs for one provider's served-vs-configured comparison. */
export interface ServedWindowComparisonInput {
  providerId: string;
  /** servedWindowByProvider.get(providerId) — undefined ⇒ probe absent ⇒ NO comparison. */
  served: number | undefined;
  /** The raw config provider entry (for the probed-model expression + opt-out naming). */
  providerEntry: { defaultModel?: string; models?: Array<{ id?: string }> } | undefined;
  /** Registry resolution composed by the caller: piModelRegistry.find + providerAliases
   *  fallback — the SAME chain pi-executor.ts uses to resolve `configured`, so the two
   *  paths cannot disagree about what "configured" is. */
  findModel: (provider: string, modelId: string) => { contextWindow?: number } | undefined;
  /** Structural logger (dependency-light, trivially testable — probe precedent). */
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

// ---------------------------------------------------------------------------
// Once-per-boot-per-provider WARN latch
// ---------------------------------------------------------------------------

/** Once-per-boot-per-provider WARN latch. Module-level Set — the daemon
 *  process IS the boot (normalize.ts gbnf precedent). */
const servedWarnLoggedForProvider = new Set<string>();

/** Test-only reset for the module-level latch — without it test order breaks
 *  (normalize.ts resetGbnfBootSummaryForTest precedent). */
export function resetServedWindowWarnForTest(): void {
  servedWarnLoggedForProvider.clear();
}

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

/**
 * Compare one provider's served window against its configured contextWindow.
 *
 * Returns undefined when the probe yielded no served value (absent = no
 * comparison, NOT a zero-served comparison). Otherwise always returns the
 * comparison result; the under-served WARN fires at most once per provider
 * per boot (the latch), so repeat calls from agents sharing the provider
 * still feed the config-posture collector without log spam.
 */
export function compareServedWindowForProvider(
  input: ServedWindowComparisonInput,
): ServedWindowComparison | undefined {
  const { providerId, served } = input;
  if (served === undefined) return undefined;

  const probedModelId = resolveProbedModelId(input.providerEntry);
  const configured = input.findModel(providerId, probedModelId)?.contextWindow ?? 8_192;
  const belowConfigured = served < configured;

  if (belowConfigured && !servedWarnLoggedForProvider.has(providerId)) {
    servedWarnLoggedForProvider.add(providerId);
    input.logger.warn(
      {
        providerId,
        served,
        configured,
        probedModel: probedModelId,
        errorKind: "config" as const,
        submodule: "served-window-comparator",
        // Knob NAMES + config PATHS + numbers only — never env VALUES.
        hint:
          `Ollama serves num_ctx ${served} but model '${probedModelId}' is configured for ${configured} — the agent runs with the smaller window. ` +
          `Fix: OLLAMA_CONTEXT_LENGTH=${configured} ollama serve, or Modelfile 'PARAMETER num_ctx ${configured}' (VRAM caveat: see the config-yaml.mdx served-window section). ` +
          `Opt out: providers.entries.${providerId}.capabilities.probeServedWindow: false`,
      },
      "Ollama served context window below configured",
    );
  }

  return { providerId, served, configured, probedModelId, belowConfigured };
}
