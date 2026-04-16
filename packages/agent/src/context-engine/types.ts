/**
 * Shared types for the context engine pipeline.
 *
 * Split into domain-focused modules:
 * - types-core.ts: Token budget, layers, metrics, guards
 * - types-eviction.ts: Dead content evictor stats
 * - types-compaction.ts: LLM compaction and rehydration
 * - types-dag.ts: DAG compaction, assembly, reconciliation
 * - types-integrity.ts: DAG integrity checking
 *
 * This barrel re-exports all types so existing `from "./types.js"` imports
 * continue to resolve without changes.
 *
 * @module
 */

export * from "./types-core.js";
export * from "./types-eviction.js";
export * from "./types-compaction.js";
export * from "./types-dag.js";
export * from "./types-integrity.js";
