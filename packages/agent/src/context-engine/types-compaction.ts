// SPDX-License-Identifier: Apache-2.0
/**
 * LLM compaction and post-compaction rehydration layer types.
 *
 * @module
 */

import type { ComisLogger, TypedEventBus } from "@comis/core";
import type { TokenAnchor } from "./types-anchor.js";

// ---------------------------------------------------------------------------
// LLM Compaction
// ---------------------------------------------------------------------------

/**
 * Dependencies for the LLM compaction layer.
 * Injected by createContextEngine from pi-executor deps.
 */
export interface CompactionLayerDeps {
  /** Structured logger. */
  logger: ComisLogger;
  /** Getter for SessionManager (for persistent compaction write-back). */
  getSessionManager: () => unknown;
  /** Getter for the current model object (for generateSummary). Resolved via ModelRegistry. */
  getModel: () => { id?: string; provider: string; contextWindow: number; reasoning: boolean };
  /** Getter for API key for the current model's provider. */
  getApiKey: () => Promise<string>;
  /** Optional: resolved override model + apiKey for cheaper compaction.
   *  When provided, compaction uses this model instead of the session model.
   *  `servedWindow` is the provider-served window binding THIS override
   *  model, provider-gated at the wiring site (executor-context-engine-setup)
   *  against the probed `servedContextWindow` pair — see the identical
   *  fields on `LeafSummarizerDeps` (lcd-leaf-summarizer.ts). */
  overrideModel?: { model: unknown; getApiKey: () => Promise<string>; servedWindow?: number };
  /** The provider-served window binding the PRIMARY (session) model —
   *  `windowProvenance.served`, already provider-gated by the executor
   *  reconcile. Consumed by the Step-4 model read in llm-compaction:
   *  the served value is selected in the SAME branch that selects the
   *  summarizer model, so clamp and call always agree. Absent ⇒ configured
   *  window governs. */
  primaryServedWindow?: number;
  /** Optional callback for reporting compaction stats. */
  onCompacted?: (stats: { fallbackLevel: 1 | 2 | 3; attempts: number; originalMessages: number; keptMessages: number }) => void;
  /** Getter for current session's discovered deferred tool names.
   *  Returns serialized tool names for compaction metadata persistence. */
  getDiscoveredTools?: () => string[];
  /** Optional getter for the API-grounded token anchor.
   *  When provided, compaction threshold check uses anchor + delta instead of pure char estimation. */
  getTokenAnchor?: () => TokenAnchor | null;
  /** Optional event bus for emitting context:compaction_routed. */
  eventBus?: TypedEventBus;
  /** Optional agent id for context:compaction_routed event payload. */
  agentId?: string;
  /** Optional session key for context:compaction_routed event payload. */
  sessionKey?: string;
}

/**
 * Metrics from a single compaction layer run.
 */
export interface CompactionLayerMetrics {
  /** Whether compaction was triggered this turn. */
  triggered: boolean;
  /** Compaction fallback level used (1=full, 2=exclude-oversized, 3=count-only, 0=not triggered). */
  fallbackLevel: 0 | 1 | 2 | 3;
  /** Number of LLM summarization attempts (retries). */
  attempts: number;
  /** Whether the compaction was skipped due to cooldown. */
  skippedCooldown: boolean;
}

// ---------------------------------------------------------------------------
// Post-Compaction Rehydration
// ---------------------------------------------------------------------------

/**
 * Dependencies for the rehydration layer.
 */
export interface RehydrationLayerDeps {
  /** Structured logger. */
  logger: ComisLogger;
  /** Getter for AGENTS.md content. Returns empty string if not available. */
  getAgentsMdContent: () => string;
  /** Section names to extract from AGENTS.md (default: ["Session Startup", "Red Lines"]). */
  postCompactionSections: string[];
  /** Getter for recently-accessed file paths from last compaction details. Returns string[]. */
  getRecentFiles: () => string[];
  /** Read a file from disk. Returns content or empty string on failure. */
  readFile: (path: string) => Promise<string>;
  /** Getter for active state: channel context, pending items. */
  getActiveState: () => {
    channelType?: string;
    channelId?: string;
    agentId?: string;
  };
  /** Optional callback for reporting rehydration stats. */
  onRehydrated?: (stats: { sectionsInjected: number; filesInjected: number; skillsInjected: number; overflowStripped: boolean }) => void;
  /** Optional callback for reporting overflow events. */
  onOverflow?: (stats: { contextChars: number; budgetChars: number; recoveryAction: "strip_files" | "strip_skills" | "remove_position1" | "remove_rehydration" | "none" }) => void;
  /** Optional getter for prompt skills XML content (post-compact skill restoration).
   *  Returns the full <available_skills>...</available_skills> XML string.
   *  When absent, skill rehydration is skipped. */
  getPromptSkillsXml?: () => string;
}

/**
 * Metrics from a single rehydration layer run.
 */
export interface RehydrationLayerMetrics {
  /** Whether rehydration was triggered (compaction detected). */
  triggered: boolean;
  /** Number of AGENTS.md sections injected. */
  sectionsInjected: number;
  /** Number of files re-read and injected. */
  filesInjected: number;
  /** Whether overflow recovery stripped file content. */
  overflowStripped: boolean;
}
