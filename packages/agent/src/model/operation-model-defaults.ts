/**
 * Operation model defaults: static maps for provider-family model tiering.
 *
 * These maps define the zero-config smart defaults for non-interactive
 * operations. When no explicit operationModels config is set, the resolver
 * uses these to select cost-appropriate models per provider family.
 *
 * Default model IDs are verified against pi-ai SDK registry v0.65.0.
 * Do NOT call normalizeModelId() on these -- they are already valid
 * registry IDs that bypass normalization.
 *
 * @module
 */

import type { ModelOperationType } from "@comis/core";

/**
 * Per-provider-family default models for mid-tier and fast-tier operations.
 *
 * - anthropic: Sonnet 4.6 (mid) for tool-using ops, Haiku 4.5 (fast) for classification
 * - google: Gemini 3 Flash (mid) for tool-using ops, Gemini 2.5 Flash Lite (fast) for classification
 * - openai: GPT-5.4-mini (mid) for tool-using ops, GPT-5.4-nano (fast) for classification
 */
export const OPERATION_MODEL_DEFAULTS: Record<string, { mid: string; fast: string }> = {
  anthropic: {
    mid: "claude-sonnet-4-6",
    fast: "claude-haiku-4-5",
  },
  google: {
    mid: "gemini-3-flash",
    fast: "gemini-2.5-flash-lite",
  },
  openai: {
    mid: "gpt-5.4-mini",
    fast: "gpt-5.4-nano",
  },
};

/**
 * Maps each operation type to its cost tier.
 *
 * - "primary": always uses the agent's primary model (interactive, subagent)
 * - "mid": moderate complexity, tool-using operations (cron)
 * - "fast": simple classification/summarization (heartbeat, taskExtraction, condensation, compaction)
 */
export const OPERATION_TIER_MAP: Record<ModelOperationType, "primary" | "mid" | "fast"> = {
  interactive: "primary",
  cron: "mid",
  heartbeat: "fast",
  subagent: "primary",
  compaction: "fast",
  taskExtraction: "fast",
  condensation: "fast",
};

/**
 * Default timeout per operation type in milliseconds.
 *
 * These are used when no explicit per-operation timeout is configured.
 * The agent's promptTimeout.promptTimeoutMs is the ultimate fallback
 * (handled by the resolver, not stored here).
 */
export const OPERATION_TIMEOUT_DEFAULTS: Partial<Record<ModelOperationType, number>> = {
  heartbeat: 60_000,
  cron: 150_000,
  subagent: 120_000,
  compaction: 60_000,
  taskExtraction: 30_000,
  condensation: 30_000,
};

/**
 * Default cache retention hint per operation type.
 *
 * Most non-interactive operations use "short" (5-min TTL) or "none"
 * because their prompts change frequently and caching wastes storage.
 */
export const OPERATION_CACHE_DEFAULTS: Partial<Record<ModelOperationType, "none" | "short">> = {
  heartbeat: "none",
  compaction: "none",
  taskExtraction: "none",
  condensation: "short",
};
