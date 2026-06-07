// SPDX-License-Identifier: Apache-2.0
/**
 * Capability-routed compaction strategy resolver.
 *
 * C4/C5/S4: for low-capabilityClass models (small/nano), routes to eviction
 * or a configured stronger summarizer rather than same-model LLM summarization.
 * frontier/mid: returns "llm" (unchanged behavior, byte-identical to today).
 *
 * Fail-closed: unknown capabilityClass → "eviction" (the safe floor, not "llm").
 *
 * @module
 */
import type { CapabilityClass } from "../executor/model-profile.js";

export type CompactionStrategy = "llm" | "eviction" | "strong-summarizer" | "deterministic";

/**
 * Resolve the compaction strategy for a given capability class and config.
 *
 * @param capabilityClass - From ModelProfile.capabilityClass.
 * @param preferEvictionByCapability - From contextEngine.compaction.preferEvictionByCapability (default: true).
 * @param strongerSummarizerModel - From contextEngine.compaction.strongerSummarizerModel (default: "").
 */
export function resolveCompactionStrategy(
  capabilityClass: CapabilityClass,
  preferEvictionByCapability: boolean,
  strongerSummarizerModel: string,
): CompactionStrategy {
  // frontier and mid: always use the LLM compaction path (behavior-neutral)
  if (capabilityClass === "frontier" || capabilityClass === "mid") {
    return "llm";
  }
  // Operator opt-out: preferEvictionByCapability=false routes small/nano to same-model LLM summarization
  if (!preferEvictionByCapability) {
    return "llm";
  }
  // small or nano with eviction preference:
  // If a stronger summarizer model is configured, use it instead of eviction
  if (strongerSummarizerModel.length > 0) {
    return "strong-summarizer";
  }
  // Default: eviction (safe floor — no self-summarization for small/nano)
  return "eviction";
}
