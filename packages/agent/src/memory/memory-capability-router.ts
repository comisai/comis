// SPDX-License-Identifier: Apache-2.0
/**
 * Capability-routed memory operations strategy resolver.
 *
 * For low-capabilityClass models (small/nano), routes to "abstain" rather
 * than allowing potentially-fabricated LLM memory operations (dialectic
 * synthesis, extraction, consolidation). frontier/mid: returns "capable".
 *
 * Fail-closed: small/nano without an explicit capableModelOverride → "abstain"
 * (the safe floor). The override exists so operators can inject a stronger cheap
 * model for the memory pipeline independently of the main agent model.
 *
 * Fabrication mitigation: a weak model passed a synthesis/extraction task
 * will fabricate citations. Routing to "abstain" prevents fabricated triples/
 * citations from entering trusted storage.
 *
 * Mirrors {@link resolveCompactionStrategy} structure exactly (pure function,
 * CapabilityClass input, strategy output, no I/O).
 *
 * @module
 */
import type { CapabilityClass } from "../executor/model-profile.js";

/** Memory operations routing strategy. */
export type MemoryOpsStrategy = "capable" | "abstain";

/**
 * Resolve the memory operations strategy for a given capability class.
 *
 * Returns "capable" for frontier/mid (behavior-neutral — these models can
 * produce grounded, citation-accurate synthesis/extraction output).
 *
 * Returns "abstain" for small/nano without a capable-model override
 * (fabrication mitigation: prevent fabricated citations/triples from
 * entering trusted storage). An operator can configure a stronger cheap model
 * for the memory pipeline via the `hasCapableModelOverride` flag.
 *
 * @param capabilityClass - From ModelProfile.capabilityClass.
 * @param hasCapableModelOverride - True when a stronger cheap model is configured
 *   for the memory pipeline (e.g. providers.memory.capableModelEnabled). Default: false.
 */
export function resolveMemoryOpsStrategy(
  capabilityClass: CapabilityClass,
  hasCapableModelOverride: boolean = false,
): MemoryOpsStrategy {
  // frontier and mid: always capable (behavior-neutral)
  if (capabilityClass === "frontier" || capabilityClass === "mid") {
    return "capable";
  }
  // Operator override: a stronger cheap model for the memory pipeline.
  if (hasCapableModelOverride) {
    return "capable";
  }
  // small or nano without a capable-model override: abstain hard.
  // Prevents fabrication: a weak model fabricates citations/triples.
  return "abstain";
}
