// SPDX-License-Identifier: Apache-2.0
/**
 * Context-engine error types (Phase 166 CWF-02).
 *
 * These named error classes cross the transformContext boundary so the executor
 * can map them to the correct finishReason without inspecting string messages.
 */

import type { ContextWindowCapInfo } from "./types-core.js";

/**
 * Stable prefix of every ContextExhaustionError message.
 *
 * HR-01 (v2.19): when this error is thrown by the pre-flight during a MID-TURN
 * continuation, the pi-ai SDK converts the throw into a turn_end with
 * stopReason:"error" and a STRING errorMessage — the `instanceof` is lost, so
 * the top-level handleEnvelopeException mapping never runs. The bridge recovers
 * the signal at that boundary via `isContextExhaustionErrorMessage()`. Sharing
 * this prefix between the constructor and the predicate keeps the contract from
 * drifting (no magic literal in the bridge). See design/small-model-orchestration-fidelity.md §4.
 */
export const CONTEXT_EXHAUSTION_MESSAGE_PREFIX = "Context exhausted: assembled" as const;

/**
 * Maps a WindowCapSource onto the exact knob an operator must turn — the
 * message must name the KNOB, not just the number, so an operator (or an
 * LLM agent reading the log) can fix it without reading budget-capacity-cap.ts
 * (W1 obs-llm-troubleshooting; the live incident reported "effective window
 * 32000" against a configured contextWindow of 131072 with no link between them).
 * KNOB-02: the cap-class entries are `contextEngine.budget.*` config keys; the
 * `served` entry names the OLLAMA knobs (env / Modelfile); the
 * `capabilityClass` entry (WR-01) names the operator's
 * `providers.entries.<id>.capabilities.capabilityClass` PIN — the executor's
 * DEFAULT_EFFECTIVE_CAP_BY_CLASS cap never reads the budget knobs, so
 * "raise contextEngine.budget.effectiveContextCapSmall" is a DEAD lever on
 * that branch. NEVER template `contextEngine.budget.${source}` (for "served" /
 * "capabilityClass" that renders a nonsense config key that does not exist).
 */
const CAP_KNOB_BY_SOURCE: Record<
  "effectiveContextCapSmall" | "effectiveContextCapNano" | "served" | "capabilityClass",
  string
> = {
  effectiveContextCapSmall: "contextEngine.budget.effectiveContextCapSmall",
  effectiveContextCapNano: "contextEngine.budget.effectiveContextCapNano",
  served: "OLLAMA_CONTEXT_LENGTH (ollama serve env) / PARAMETER num_ctx (Modelfile)",
  capabilityClass: "providers.entries.<id>.capabilities.capabilityClass",
};

/** Returns the capped-window suffix for the exhaustion message, or "" when
 *  uncapped/unknown. Exported for reuse by the pre-flight WARN hint.
 *  KNOB-02: branched by source — the served bind gets the Ollama remedy and
 *  the capabilityClass bind gets the pin remedy ("raise it (0 = uncapped)" is
 *  the WRONG knob for both: served lives in Ollama, and the executor's class
 *  cap reads only the operator's capabilityClass pin — WR-01). A budget-knob
 *  bind with served provenance names the full chain (configured → served → cap). */
export function describeWindowCap(effectiveWindow: number, capInfo?: ContextWindowCapInfo): string {
  if (capInfo === undefined || capInfo.windowCapSource === "none") return "";
  if (capInfo.windowCapSource === "served") {
    return (
      ` (model contextWindow ${capInfo.rawContextWindowTokens} but Ollama serves only ${effectiveWindow}` +
      ` — fix: OLLAMA_CONTEXT_LENGTH=${capInfo.rawContextWindowTokens} ollama serve,` +
      ` or Modelfile 'PARAMETER num_ctx ${capInfo.rawContextWindowTokens}')`
    );
  }
  const knob = CAP_KNOB_BY_SOURCE[capInfo.windowCapSource];
  const servedClause =
    capInfo.servedWindowTokens !== undefined ? `, Ollama serves ${capInfo.servedWindowTokens},` : "";
  // WR-01: the remedy must match the lever that actually moves the window —
  // the budget knobs are numeric ("raise it, 0 = uncapped"); the capability
  // pin is a class name (raise/remove the pin; the budget knob is inert here).
  const remedy =
    capInfo.windowCapSource === "capabilityClass"
      ? "pin a higher class (or remove the pin)"
      : "raise it (0 = uncapped)";
  return (
    ` (model contextWindow ${capInfo.rawContextWindowTokens}${servedClause} capped to ${effectiveWindow}` +
    ` by ${knob} — ${remedy} or reduce active tool schemas)`
  );
}

/** Thrown by lcd-assembler.transformContext when assembled input cannot fit in the
 *  effective window even after eviction, preamble trimming, and thinking down-shift.
 *  Caught by the executor and mapped to finishReason: "context_exhausted".
 *  Design ref: design/small-model-context-fidelity.md §4 Fix 3 item 2d. */
export class ContextExhaustionError extends Error {
  override name = "ContextExhaustionError" as const;
  constructor(
    public readonly effectiveWindow: number,
    public readonly assembledTokens: number,
    capInfo?: ContextWindowCapInfo,
  ) {
    super(
      `${CONTEXT_EXHAUSTION_MESSAGE_PREFIX} ${assembledTokens} tokens leaves no room in effective window ${effectiveWindow}` +
        describeWindowCap(effectiveWindow, capInfo),
    );
  }
}

/**
 * True when an error MESSAGE string is a ContextExhaustionError surfaced across a
 * boundary that strips the type (the SDK's turn_end-error conversion). Used by the
 * bridge to map a mid-turn context-exhaustion throw to finishReason:"context_exhausted"
 * so the executor delivers the honest degraded reply instead of the empty-turn
 * recovery's "the work was done" synthesis. Pure; tolerant of undefined/empty.
 */
export function isContextExhaustionErrorMessage(message: string | undefined): boolean {
  return typeof message === "string" && message.startsWith(CONTEXT_EXHAUSTION_MESSAGE_PREFIX);
}
