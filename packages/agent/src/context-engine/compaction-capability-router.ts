// SPDX-License-Identifier: Apache-2.0
/**
 * Capability-routed compaction strategy resolver.
 *
 * C4/C5/S4: for low-capabilityClass models (small/nano), routes to eviction
 * or a configured stronger summarizer rather than same-model LLM summarization.
 * frontier/mid: returns "llm" (unchanged behavior).
 *
 * @module
 */
import type { CapabilityClass } from "../executor/model-profile.js";

export type CompactionStrategy = "llm" | "eviction" | "strong-summarizer" | "deterministic";

export function resolveCompactionStrategy(
  capabilityClass: CapabilityClass,
  preferEvictionByCapability: boolean,
  strongerSummarizerModel: string,
): CompactionStrategy {
  throw new Error("resolveCompactionStrategy: not yet implemented (Plan 05)");
}
