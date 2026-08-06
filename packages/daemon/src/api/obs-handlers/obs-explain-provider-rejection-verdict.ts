// SPDX-License-Identifier: Apache-2.0
/**
 * The `provider_rejected_request` root-cause verdict predicate spliced into the
 * `obs-explain-heuristics` registry.
 *
 * Extracted into this sibling (the `obs-explain-recall-verdict.ts` /
 * `obs-explain-spend-verdict.ts` discipline) to keep `obs-explain-heuristics.ts`
 * under the 500-line `obs-handlers/*` subdir cap. PURE: no LLM, no I/O, no
 * globals — same signals ⇒ same verdict forever.
 *
 * Fires when the PROVIDER rejected the request itself rather than failing to
 * answer it: the model call never produced a turn, so no tool ran and no
 * `failures[]` entry exists (that array is tool-boundary-shaped — toolName,
 * resultDigest, argsPreview). Grounded in a live incident where every LLM call
 * of a session was rejected with the same deterministic category and
 * `likelyRootCause` reported `recall_miss` instead — the zero-hit recall was
 * real but incidental (a fresh install's memory store is empty, so EVERY recall
 * misses), while the acute cause left no signal the registry could see.
 *
 * The return type is structurally identical to the registry's `RootCause` (no
 * cross-module type import ⇒ no cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type ProviderRejectionVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/**
 * Categories where the PROVIDER refused the request deterministically, so
 * neither a retry nor a self-heal can clear it — an operator has to change
 * something. Transient classes (overloaded, rate_limited, provider_unreachable)
 * are deliberately excluded: those resolve on their own and would turn routine
 * blips into a root-cause verdict.
 */
const DETERMINISTIC_REJECTIONS = new Set([
  "model_capability_unsupported",
  "client_request",
  "client_request_signed_replay",
  "tool_schema_unsupported",
  "model_not_available",
  "aws_region_or_model",
  "aws_model_access",
  "auth_invalid",
  "aws_auth_invalid",
  "aws_auth_expired",
  "credit_exhausted",
  "context_too_long",
]);

/** Per-category operator guidance. Falls back to a generic step when unlisted. */
const NEXT_STEPS: Record<string, string[]> = {
  client_request_signed_replay: [
    "check `recoveries.byReason.signed_replay` and `recoveries.succeeded` in this report to confirm whether Comis removed persisted signed reasoning state and recovered",
    "if automatic replay recovery failed, start a new conversation so the provider receives no rejected signed reasoning history",
  ],
  model_capability_unsupported: [
    "check the resolved model id under `agents.<id>.model` against the provider's supported request parameters",
    "a `providers.entries.*` entry that re-declares built-in catalog models can drop the capability metadata that selects the request shape — remove the redundant entry or list the model explicitly",
  ],
  model_not_available: [
    "verify the configured model id is enabled for this API plan/region",
  ],
  auth_invalid: ["verify the provider credential named by `providers.entries.<name>.apiKeyName`"],
  credit_exhausted: ["check the provider account's billing/usage caps"],
  context_too_long: ["lower `contextEngine.budget.*` or start a new conversation"],
};

/**
 * `provider_rejected_request` — fires when a deterministic provider rejection
 * killed at least one LLM call on a degraded session.
 *
 * Ordered ABOVE `recall_miss` and the tool-failure catch-all: a request the
 * provider refused outright is the acute cause, and any recall/tool evidence
 * on the same session is downstream of it.
 */
export const providerRejectedRequestVerdict = (
  s: IncidentSignals,
): ProviderRejectionVerdict | null => {
  if (s.modelErrors === undefined || s.modelErrors.total === 0) return null;
  if (s.degraded !== true) return null;

  // byCategory is emitted dominant-first with a deterministic tie-break.
  const dominant = Object.entries(s.modelErrors.byCategory).find(([category]) =>
    DETERMINISTIC_REJECTIONS.has(category),
  );
  if (dominant === undefined) return null;
  const [category, count] = dominant;

  return {
    code: "provider_rejected_request",
    detail:
      `provider rejected the request — ${count} of ${s.modelErrors.total} LLM call(s) failed with `
      + `\`${category}\`; the model never ran, so any tool/recall evidence on this session is downstream. `
      + "Deterministic: an identical retry reproduces it",
    suggestedNextSteps: [
      ...(NEXT_STEPS[category] ?? [
        "inspect the provider error for this category in the daemon log (the raw body is never persisted to the trajectory)",
      ]),
      "comis system-health --since 24 to see whether this rejection spans other sessions",
    ],
  };
};
