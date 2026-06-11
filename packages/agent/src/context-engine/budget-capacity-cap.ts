// SPDX-License-Identifier: Apache-2.0
/**
 * computeTokenBudgetForProfile — ModelProfile-aware token budget wrapper.
 *
 * C1: handles both:
 *   1. 8K-starvation (effectiveO = min(OUTPUT_RESERVE_TOKENS, profile.maxOutputTokens))
 *   2. 256K-overfill (effectiveWindow = min(contextWindow, EFFECTIVE_CAP_BY_CLASS[class]))
 *
 * Frontier/mid: byte-identical to computeTokenBudget (behavior-neutral guarantee).
 * Small/nano: effective window capped by capability class to prevent 256K-overfill degradation.
 *
 * IMPORTANT: the B-1 3.5-ratio over-reservation (the ÷CHARS_PER_TOKEN_RATIO
 * estimates in assembleTools step 5, "System token estimate", in
 * executor-tool-assembly.ts) is PRESERVED — it is applied at the call site
 * before passing systemTokensEstimate and freshTailPreambleTokensEstimate to
 * this function. Do NOT re-apply it here.
 *
 * @module
 */
import { computeTokenBudget } from "./token-budget.js";
import type { TokenBudget, WindowCapSource, WindowProvenance } from "./types.js";
import { OUTPUT_RESERVE_TOKENS } from "./constants.js";
import type { ModelProfile } from "../executor/model-profile.js";

/**
 * Fallback effective context caps by capability class.
 * Used ONLY when effectiveContextCapSmall / effectiveContextCapNano are not provided
 * (i.e., call sites that bypass the Zod schema). In schema-parsed configs (the two
 * production call sites in lcd-assembler.ts and executor-tool-assembly.ts), Zod
 * always supplies these values via `.default(32_000)` / `.default(16_000)`, so
 * the small/nano entries here are never reached in production — they serve as
 * documentation and as a safety net for non-schema callers.
 * The `?? 32_000` final fallback in resolveEffectiveCap handles unknown classes.
 *
 * frontier/mid: Infinity (use raw contextWindow — behavior-neutral).
 * small: 32K (matches Zod schema default; validated against Phase 149 comprehension data).
 * nano: 16K (matches Zod schema default; validated against Phase 149 comprehension data).
 * Operators can tune small/nano via contextEngine.budget.effectiveContextCapSmall/Nano.
 */
export const DEFAULT_EFFECTIVE_CAP_BY_CLASS: Readonly<Record<string, number>> = {
  frontier: Infinity,
  mid: Infinity, // mid (Google Gemini) genuinely uses long context; no cap in Phase 152
  small: 32_000,
  nano: 16_000,
} as const;

/**
 * Compute a ModelProfile-aware token budget.
 *
 * @param profile       - The resolved ModelProfile (from resolveModelProfile()).
 * @param systemTokensEstimate - S: system tokens (÷3.5 of system prompt chars — B-1 applied by caller).
 * @param freshTailPreambleTokensEstimate - P: preamble tokens (÷3.5 of preamble chars — B-1 applied by caller).
 * @param cacheFenceIndex - Optional; passed through to computeTokenBudget. Default: -1.
 * @param effectiveContextCapSmall - Optional override for the small class cap (from contextEngine.budget.effectiveContextCapSmall).
 * @param effectiveContextCapNano  - Optional override for the nano class cap (from contextEngine.budget.effectiveContextCapNano).
 * @param windowProvenance - Optional KNOB-02 provenance from the executor's
 *   resolveEffectiveContextWindow reconcile. When present, rawContextWindowTokens
 *   reports the TRUE configuredWindow (profile.contextWindow arrives ALREADY
 *   overwritten with the reconciled value) and windowCapSource gains "served" /
 *   the class knob for upstream binds. Absent ⇒ byte-identical pre-provenance
 *   behavior (I3 frontier/mid pin).
 */
export function computeTokenBudgetForProfile(
  profile: ModelProfile,
  systemTokensEstimate: number,
  freshTailPreambleTokensEstimate: number = 0,
  cacheFenceIndex: number = -1,
  effectiveContextCapSmall?: number,
  effectiveContextCapNano?: number,
  windowProvenance?: WindowProvenance,
): TokenBudget {
  // Effective context window: cap for small/nano to prevent 256K-overfill degradation.
  // frontier/mid: Infinity → Math.min(contextWindow, Infinity) = contextWindow (byte-identical).
  const { cap: classCap, source: capKnob } = resolveEffectiveCap(
    profile.capabilityClass,
    effectiveContextCapSmall,
    effectiveContextCapNano,
  );
  const effectiveWindow = Math.min(profile.contextWindow, classCap);
  // W1 cap provenance: when this function's OWN class cap bit, it is the
  // binding (tightest) constraint — name the budget knob (raising it genuinely
  // works on this branch). Otherwise (KNOB-02) consult the executor-side
  // reconcile provenance: "served" when the Ollama-served window bound
  // upstream; "capabilityClass" when the executor's DEFAULT_EFFECTIVE_CAP_BY_CLASS
  // cap bound upstream (WR-01: that cap comes from the operator's
  // providers.entries.<id>.capabilities.capabilityClass pin — it never reads
  // the contextEngine.budget.* knobs, so naming the budget knob here would send
  // operators to a dead lever); "none" when nothing clamped or no provenance
  // was threaded (pre-KNOB-02 byte-identical behavior).
  const capBit = effectiveWindow < profile.contextWindow;
  const windowCapSource: WindowCapSource = capBit
    ? capKnob
    : windowProvenance === undefined || windowProvenance.reconcileSource === "configured"
      ? "none"
      : windowProvenance.reconcileSource === "served"
        ? "served"
        : "capabilityClass"; // "capability" reconcile: the executor-side class-pin cap bound upstream — name the PIN (no silent clamp, no dead budget knob)

  // 8K-starvation fix: cap O at maxOutputTokens so it cannot consume the whole window.
  // On an 8K window with OUTPUT_RESERVE_TOKENS=8192, uncapped O leaves H=0.
  // effectiveO = min(OUTPUT_RESERVE_TOKENS, maxOutputTokens) — respects model's declared limit.
  // For frontier models with large maxOutputTokens, effectiveO = OUTPUT_RESERVE_TOKENS (no change).
  const effectiveO = Math.min(OUTPUT_RESERVE_TOKENS, profile.maxOutputTokens);

  // If effectiveO < OUTPUT_RESERVE_TOKENS (8K-starvation case), computeTokenBudget would use
  // the hardcoded OUTPUT_RESERVE_TOKENS constant which is larger — we need to adjust for the
  // reduced output reserve so history tokens H > 0 on narrow windows.
  if (effectiveO < OUTPUT_RESERVE_TOKENS) {
    // 8K-starvation: re-derive H with the smaller O.
    // computeTokenBudget uses OUTPUT_RESERVE_TOKENS internally; it subtracts OUTPUT_RESERVE_TOKENS.
    // We compute with the effective window, then add back (OUTPUT_RESERVE_TOKENS - effectiveO)
    // to availableHistoryTokens to reflect the smaller output reserve actually needed.
    // The algebra is linear: H = W - S - O - M - R - P
    // With effectiveO < OUTPUT_RESERVE_TOKENS, H_actual = H_raw + (OUTPUT_RESERVE_TOKENS - effectiveO).
    const rawBudget = computeTokenBudget(effectiveWindow, systemTokensEstimate, cacheFenceIndex, freshTailPreambleTokensEstimate);
    const oReduction = OUTPUT_RESERVE_TOKENS - effectiveO;
    return {
      ...rawBudget,
      windowTokens: effectiveWindow,
      // KNOB-02: profile.contextWindow arrives executor-OVERWRITTEN with the
      // reconciled (possibly served) value — the TRUE configured window lives
      // on the provenance. Absent provenance ⇒ pre-KNOB-02 behavior.
      rawContextWindowTokens: windowProvenance?.configuredWindow ?? profile.contextWindow,
      windowCapSource,
      ...(windowProvenance?.served !== undefined && { servedWindowTokens: windowProvenance.served }),
      outputReserveTokens: effectiveO,
      availableHistoryTokens: Math.max(0, rawBudget.availableHistoryTokens + oReduction),
    };
  }

  // Standard path (frontier/mid/small with window ≥ OUTPUT_RESERVE_TOKENS): just cap the window.
  // For frontier: effectiveWindow == contextWindow (Infinity cap) → byte-identical.
  return {
    ...computeTokenBudget(effectiveWindow, systemTokensEstimate, cacheFenceIndex, freshTailPreambleTokensEstimate),
    // KNOB-02: see the starvation-path comment above — raw = the TRUE configured window.
    rawContextWindowTokens: windowProvenance?.configuredWindow ?? profile.contextWindow,
    windowCapSource,
    ...(windowProvenance?.served !== undefined && { servedWindowTokens: windowProvenance.served }),
  };
}

/**
 * Resolve the class cap AND the knob it came from. `source` names the
 * `contextEngine.budget.*` knob that produced the cap so the budget can report
 * WHICH setting to raise (W1 cap provenance). The unknown-class `?? 32_000`
 * safety net is attributed to the small knob — it mirrors that knob's default
 * and only non-schema callers can reach it.
 */
function resolveEffectiveCap(
  capabilityClass: string,
  effectiveContextCapSmall: number | undefined,
  effectiveContextCapNano: number | undefined,
): { cap: number; source: Extract<WindowCapSource, "effectiveContextCapSmall" | "effectiveContextCapNano"> } {
  if (capabilityClass === "small") {
    if (effectiveContextCapSmall !== undefined) {
      return {
        cap: effectiveContextCapSmall > 0 ? effectiveContextCapSmall : Infinity,
        source: "effectiveContextCapSmall",
      };
    }
  }
  if (capabilityClass === "nano") {
    if (effectiveContextCapNano !== undefined) {
      return {
        cap: effectiveContextCapNano > 0 ? effectiveContextCapNano : Infinity,
        source: "effectiveContextCapNano",
      };
    }
  }
  return {
    cap: DEFAULT_EFFECTIVE_CAP_BY_CLASS[capabilityClass] ?? 32_000,
    source: capabilityClass === "nano" ? "effectiveContextCapNano" : "effectiveContextCapSmall",
  };
}
