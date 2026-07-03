// SPDX-License-Identifier: Apache-2.0
/**
 * Context-engine error types.
 *
 * These named error classes cross the transformContext boundary so the executor
 * can map them to the correct finishReason without inspecting string messages.
 */

import type { ContextWindowCapInfo } from "./types-core.js";

/**
 * Stable prefix of every ContextExhaustionError message.
 *
 * When this error is thrown by the pre-flight during a MID-TURN
 * continuation, the pi-ai SDK converts the throw into a turn_end with
 * stopReason:"error" and a STRING errorMessage — the `instanceof` is lost, so
 * the top-level handleEnvelopeException mapping never runs. The bridge recovers
 * the signal at that boundary via `isContextExhaustionErrorMessage()`. Sharing
 * this prefix between the constructor and the predicate keeps the contract from
 * drifting (no magic literal in the bridge).
 */
export const CONTEXT_EXHAUSTION_MESSAGE_PREFIX = "Context exhausted: assembled" as const;

/**
 * WHY the fit failed, so the degraded reply can point at the right knob.
 * The generic "narrow the ask" advice is actively misleading when the
 * offender is a persisted oversized message in HISTORY (the ask may be
 * tiny).
 *
 *  - `oversized_input`: the CURRENT user message alone cannot fit — "narrow
 *    the ask" / "shorten the message" is the correct remedy.
 *  - `oversized_history_message`: a SINGLE earlier message alone cannot fit —
 *    only clearing the session (or raising the window) helps; with the
 *    fresh-tail assembly bound in place this cause should no longer occur, but
 *    the classification stays for robustness (e.g. an operator-cranked cap).
 *  - `fixed_overhead_exceeds_window`: the
 *    NON-EVICTABLE fixed overhead — the system prompt + tool schemas (S =
 *    getSystemTokensEstimate) — ALONE exceeds the bound, so the turn is
 *    infeasible regardless of history, thinking level, OR message size. The
 *    remedy is the WINDOW or the agent's tool/prompt footprint, never "shorten
 *    your message". This is the failure a `nano`-class model (~16K effective
 *    window) hits when its ~10K prompt + tool schemas overflow before any user
 *    text. The window-aware tool-budget fit pass (executor-tool-assembly.ts
 *    enforceToolBudgetFit) defers tools to prevent this on adequate windows; the
 *    degenerate window<prompt case still throws, and this cause makes it HONEST
 *    (classifying it as `oversized_input` would wrongly blame the message).
 *  - `aggregate`: the conversation + tools collectively overflow — compaction /
 *    cap-raise / fewer tools advice applies (the default classification).
 */
export type ContextExhaustionCause =
  | "oversized_input"
  | "oversized_history_message"
  | "fixed_overhead_exceeds_window"
  | "aggregate";

/**
 * The `[cause: …]` tag appended to the exhaustion message. Like
 * {@link CONTEXT_EXHAUSTION_MESSAGE_PREFIX}, the tag is a SHARED CONTRACT
 * between the constructor and {@link parseContextExhaustionCause}: the error
 * crosses the SDK's turn_end-error boundary as a bare STRING, so the
 * cause must survive inside the message text. "aggregate" is the unmarked
 * default — untagged messages parse as aggregate.
 */
const CAUSE_TAG_PATTERN =
  /\[cause: (oversized_input|oversized_history_message|fixed_overhead_exceeds_window)\]/;

/**
 * Recover the {@link ContextExhaustionCause} from an exhaustion message string
 * that crossed a type-stripping boundary (`result.errorContext.originalError`
 * on the top-level path, `lastLlmErrorMessage` on the mid-turn path).
 * Pure; tolerant of undefined/untagged input (→ "aggregate").
 */
export function parseContextExhaustionCause(
  message: string | undefined,
): ContextExhaustionCause {
  const match = typeof message === "string" ? CAUSE_TAG_PATTERN.exec(message) : null;
  return match ? (match[1] as ContextExhaustionCause) : "aggregate";
}

/**
 * Maps a WindowCapSource onto the exact knob an operator must turn — the
 * message must name the KNOB, not just the number, so an operator (or an
 * LLM agent reading the log) can fix it without reading budget-capacity-cap.ts
 * (a log line reporting "effective window 32000" against a configured
 * contextWindow of 131072 with no link between them is undiagnosable).
 * The cap-class entries are `contextEngine.budget.*` config keys; the
 * `served` entry names the OLLAMA knobs (env / Modelfile); the
 * `capabilityClass` entry names the operator's
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
 *  Branched by source — the served bind gets the Ollama remedy and
 *  the capabilityClass bind gets the pin remedy ("raise it (0 = uncapped)" is
 *  the WRONG knob for both: served lives in Ollama, and the executor's class
 *  cap reads only the operator's capabilityClass pin). A budget-knob
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
  // The remedy must match the lever that actually moves the window —
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
 *  Caught by the executor and mapped to finishReason: "context_exhausted". */
export class ContextExhaustionError extends Error {
  override name = "ContextExhaustionError" as const;
  constructor(
    public readonly effectiveWindow: number,
    public readonly assembledTokens: number,
    capInfo?: ContextWindowCapInfo,
    /** Why the fit failed (default "aggregate" — the unmarked shape). */
    public readonly exhaustionCause: ContextExhaustionCause = "aggregate",
  ) {
    super(
      `${CONTEXT_EXHAUSTION_MESSAGE_PREFIX} ${assembledTokens} tokens leaves no room in effective window ${effectiveWindow}` +
        describeWindowCap(effectiveWindow, capInfo) +
        // The tag must survive the turn_end string boundary; "aggregate" stays
        // unmarked — the parser treats an untagged message as aggregate.
        (exhaustionCause === "aggregate" ? "" : ` [cause: ${exhaustionCause}]`),
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
