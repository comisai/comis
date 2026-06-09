// SPDX-License-Identifier: Apache-2.0
/**
 * R6 capability resolution for the memory-job daemon wiring (CR-01).
 *
 * The LLM-backed memory jobs (`runMemoryReview`, `runMemoryConsolidation`, the
 * `createDialecticSeam` synthesis) gate their LLM call on
 * `resolveMemoryOpsStrategy(capabilityClass, hasCapableModelOverride)` so a
 * small/nano model never fabricates citations/triples into trusted storage
 * (T-153-fabricate). Those two fields were declared OPTIONAL on each job's deps
 * and DEFAULTED to "frontier"/false — but NO daemon call site ever passed them,
 * so every consumer hit the default and the abstain branch was unreachable in
 * production (R6 dead). This helper single-sources the derivation so all three
 * sites thread the SAME, correct values.
 *
 * R6 KEYS ON THE MEMORY MODEL, NOT THE AGENT'S PRIMARY. Each job already resolves
 * the cheap "cron"/cheap operation model via `resolveOperationModel` and makes its
 * LLM call with THAT model — so the capability that matters is that model's, not
 * the agent's interactive model. (A frontier agent with a nano cron model must
 * still abstain; a nano agent with a frontier cron override must be capable.)
 *
 * capabilityClass derivation mirrors pi-executor's per-execution
 * `resolveModelProfile(...)` EXACTLY: the capability axis reads only the provider
 * family (via the canonical provider-capabilities registry) plus an explicit
 * operator `capabilityClass` override — it NEVER reads contextWindow — so a
 * minimal `{ id, provider }` model object yields the same class a fully-resolved
 * model would. A bare ollama/local cron model therefore resolves to "small" and
 * (absent an override) abstains; an unknown provider fails closed to the
 * most-locked profile ("nano"), which also abstains.
 *
 * hasCapableModelOverride is the operator's explicit "I configured a stronger
 * model for the memory pipeline" signal: it is true ONLY when the operator
 * pinned a CAPABLE (frontier/mid) `capabilityClass` on the cron model's provider
 * capabilities. Fail-closed: no override → false → small/nano abstain.
 *
 * @module
 */

import { resolveModelProfile, type CapabilityClass } from "@comis/agent";
import type { ProviderCapabilities } from "@comis/core";

/** The R6 routing inputs threaded into each memory-job deps object. */
export interface MemoryOpsCapability {
  /** The capability class of the cron/memory model (drives the abstain gate). */
  capabilityClass: CapabilityClass;
  /** True when the operator pinned a capable (frontier/mid) class on the memory provider. */
  hasCapableModelOverride: boolean;
}

/**
 * Derive the R6 `{ capabilityClass, hasCapableModelOverride }` for a memory job
 * from the resolved cron/memory model + that provider's capabilities.
 *
 * @param model - The resolved cron/memory model parts (`resolveOperationModel`
 *   output: `{ provider, modelId }`). The model that ACTUALLY makes the memory
 *   LLM call.
 * @param providerCapabilities - The cron model provider's capabilities
 *   (`container.config.providers?.entries?.[provider]?.capabilities`), or
 *   undefined when the provider has no entry. Supplies the optional operator
 *   `capabilityClass` override.
 */
export function resolveMemoryOpsCapability(
  model: { provider: string; modelId: string },
  providerCapabilities: ProviderCapabilities | undefined,
): MemoryOpsCapability {
  const override = providerCapabilities?.capabilityClass;
  // Mirror pi-executor: resolveModelProfile derives the class from the provider
  // family + the explicit override. The capacity fields (contextWindow/maxTokens)
  // are irrelevant to the capability axis, so a minimal model object is correct.
  const profile = resolveModelProfile({ id: model.modelId, provider: model.provider }, override);

  // The operator override flag is true ONLY when a CAPABLE class was explicitly
  // pinned on this provider. A small/nano pin (or no pin) does NOT light it up —
  // fail-closed so an unconfigured small/nano memory model abstains.
  const hasCapableModelOverride = override === "frontier" || override === "mid";

  return { capabilityClass: profile.capabilityClass, hasCapableModelOverride };
}
