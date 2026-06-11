// SPDX-License-Identifier: Apache-2.0
/**
 * Operation model resolver: deterministic 5-level priority chain for
 * selecting the correct model per operation type.
 *
 * Pure function, no side effects, no async, no DI. All context passed
 * as parameters. This follows the normalizeModelId() pattern.
 *
 * Priority chain:
 *   Level 1: invocationOverride (e.g., CronPayload.model)
 *   Level 2: operationModels[operationType] from agent config
 *   Level 3: parentModel (sub-agent only)
 *   Level 4: catalog-derived tier (resolveOperationDefaults + OPERATION_TIER_MAP)
 *   Level 5: Agent primary model (ultimate fallback)
 *
 * @module
 */

import type { ModelOperationType, OperationModelEntry, OperationModels } from "@comis/core";
import { normalizeModelId } from "../provider/model-id-normalize.js";
import { normalizeProviderId } from "../provider/capabilities.js";
import {
  resolveOperationDefaults,
  OPERATION_TIER_MAP,
  OPERATION_TIMEOUT_DEFAULTS,
  OPERATION_CACHE_DEFAULTS,
} from "./operation-model-defaults.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Which level of the timeout resolution bound the effective timeout (LAT-01).
 * Born HERE — producers thread it; decodeExecutionOverrides merges it; hints
 * render knobs from it via executor/timeout-knob.ts. Deriving the label
 * anywhere downstream cannot work: the cron producer materializes
 * ExecutionOverrides.promptTimeout unconditionally, so by decode time
 * "the 150s cron default applied" is indistinguishable from an explicit
 * operator override. "graph_constant" is produced ONLY by the daemon graph
 * spawn (setup-cross-session-graph.ts hardcodes 600_000ms) — the resolver
 * never emits it.
 */
export type TimeoutSource =
  | "operation_explicit"   // agents.<id>.operationModels.<op>.timeout
  | "operation_default"    // OPERATION_TIMEOUT_DEFAULTS[op]
  | "agent_config"         // agents.<id>.promptTimeout.promptTimeoutMs
  | "builtin_default"      // DEFAULT_PROMPT_TIMEOUT_MS (180_000)
  | "graph_constant";      // GRAPH_PROMPT_TIMEOUT_MS (600_000) — not operator-tunable

/** Result of resolving which model to use for a given operation. */
export interface OperationModelResolution {
  /** Full model string in "provider:modelId" format. */
  model: string;
  /** Extracted provider name. */
  provider: string;
  /** Extracted model ID (without provider prefix). */
  modelId: string;
  /** Which priority level resolved the model. */
  source: "explicit_config" | "cron_job_override" | "parent_inherited" | "family_default" | "agent_primary";
  /** The operation type that was resolved. */
  operationType: ModelOperationType;
  /** Resolved timeout in milliseconds. */
  timeoutMs: number;
  /** Which resolution level bound timeoutMs (LAT-01) — mirrors `source` for
   *  the MODEL pick. Carried through ExecutionOverrides so hints can name the
   *  binding knob without re-deriving it. */
  timeoutSource: TimeoutSource;
  /** Cache retention hint override (undefined means use agent default). */
  cacheRetention?: "none" | "short";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default prompt timeout matching PromptTimeoutConfigSchema default. */
const DEFAULT_PROMPT_TIMEOUT_MS = 180_000;

/**
 * Parse a "provider:modelId" string into separate parts.
 * If no ":" is present, uses fallbackProvider as the provider.
 *
 * @param modelStr - Model string, possibly in "provider:modelId" format
 * @param fallbackProvider - Provider to use when modelStr has no ":" prefix
 */
function parseModelString(modelStr: string, fallbackProvider: string): { provider: string; modelId: string } {
  const colonIdx = modelStr.indexOf(":");
  if (colonIdx > 0) {
    return {
      provider: modelStr.slice(0, colonIdx),
      modelId: modelStr.slice(colonIdx + 1),
    };
  }
  return { provider: fallbackProvider, modelId: modelStr };
}

/**
 * Build an OperationModelResolution from resolved parts.
 */
function buildResult(
  provider: string,
  modelId: string,
  source: OperationModelResolution["source"],
  operationType: ModelOperationType,
  timeoutMs: number,
  timeoutSource: TimeoutSource,
  cacheRetention?: "none" | "short",
): OperationModelResolution {
  return {
    model: `${provider}:${modelId}`,
    provider,
    modelId,
    source,
    operationType,
    timeoutMs,
    timeoutSource,
    cacheRetention,
  };
}

// ---------------------------------------------------------------------------
// Provider family resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a provider name to its canonical ID for operation-tier catalog lookup.
 *
 * SA8: routes through normalizeProviderId (resolves user-facing aliases like
 * "bedrock" → "amazon-bedrock", "aws-bedrock" → "amazon-bedrock") and returns
 * the normalized ID as-is. Both "amazon-bedrock" and "google-vertex" are native
 * pi-ai KnownProvider entries in getProviders() — stripping the suffix to
 * "amazon" or "google" was never correct and caused resolveOperationDefaults
 * to return {} (Level 5 silent fallback) for Bedrock/Vertex agents.
 *
 * Side-effect on executor-context-engine-setup.ts:284 (currentApi drift):
 * Existing Bedrock and Vertex sessions will emit ONE api_change drift event
 * on first execution post-deploy (old value: "amazon"/"google", new value:
 * "amazon-bedrock"/"google-vertex"). This drops signed thinking state once,
 * then stabilizes. See T-162-05b.
 *
 * @param provider - Provider name (e.g., "amazon-bedrock", "google-vertex",
 *                   "bedrock", "openai")
 * @returns Canonical provider ID usable as input to resolveOperationDefaults()
 */
export function resolveProviderFamily(provider: string): string {
  // Resolve user-facing aliases ("bedrock" → "amazon-bedrock", etc.),
  // then return the full normalized ID. Both "amazon-bedrock" and
  // "google-vertex" are native pi-ai KnownProvider entries — no suffix
  // stripping needed or correct for either one.
  return normalizeProviderId(provider);
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve which model to use for a given operation type.
 *
 * Implements a deterministic 5-level priority chain:
 *   1. invocationOverride -- per-call override (e.g., CronPayload.model)
 *   2. operationModels[op] -- explicit agent config
 *   3. parentModel -- inherited from parent agent (subagent only)
 *   4. resolveOperationDefaults -- pi-ai catalog-derived per-provider tier
 *   5. agent primary -- ultimate fallback
 *
 * @param params - Resolution context (all inputs needed for the decision)
 * @returns Full resolution result including model, source, timeout, cache hint
 */
export function resolveOperationModel(params: {
  operationType: ModelOperationType;
  agentProvider: string;
  agentModel: string;
  operationModels: OperationModels;
  providerFamily: string;
  invocationOverride?: string;
  parentModel?: string;
  agentPromptTimeoutMs?: number;
}): OperationModelResolution {
  const {
    operationType,
    agentProvider,
    agentModel,
    operationModels,
    providerFamily,
    invocationOverride,
    parentModel,
    agentPromptTimeoutMs,
  } = params;

  // -- Resolve timeout (independent of which level picks the model) --
  // LAT-01: the binding provenance is born at these branch points — never
  // re-derived downstream (value-equality inference is ambiguous when an
  // operator sets a value equal to a default; T-177-06).
  const entry = (operationModels as Partial<Record<ModelOperationType, OperationModelEntry>>)[operationType];
  const explicitTimeout = entry?.timeout;
  const operationDefaultTimeout = OPERATION_TIMEOUT_DEFAULTS[operationType];
  let timeoutMs: number;
  let timeoutSource: TimeoutSource;
  if (typeof explicitTimeout === "number" && explicitTimeout > 0) {
    timeoutMs = explicitTimeout;
    timeoutSource = "operation_explicit";
  } else if (operationDefaultTimeout !== undefined) {
    timeoutMs = operationDefaultTimeout;
    timeoutSource = "operation_default";
  } else if (agentPromptTimeoutMs !== undefined) {
    timeoutMs = agentPromptTimeoutMs;
    timeoutSource = "agent_config";
  } else {
    timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS;
    timeoutSource = "builtin_default";
  }

  // -- Resolve cache retention --
  const cacheRetention = OPERATION_CACHE_DEFAULTS[operationType];

  // -- Level 1: invocationOverride --
  if (invocationOverride != null && invocationOverride.length > 0) {
    if (invocationOverride === "primary") {
      return buildResult(agentProvider, agentModel, "cron_job_override", operationType, timeoutMs, timeoutSource, cacheRetention);
    }
    const parsed = parseModelString(invocationOverride, agentProvider);
    return buildResult(parsed.provider, parsed.modelId, "cron_job_override", operationType, timeoutMs, timeoutSource, cacheRetention);
  }

  // -- Level 2: explicit config (operationModels[operationType]) --
  const configValue = entry?.model;
  if (typeof configValue === "string" && configValue.length > 0) {
    if (configValue === "primary") {
      return buildResult(agentProvider, agentModel, "explicit_config", operationType, timeoutMs, timeoutSource, cacheRetention);
    }
    const parsed = parseModelString(configValue, agentProvider);
    // Run normalizeModelId for shortcut resolution on operator-provided values
    const normalized = normalizeModelId(parsed.provider, parsed.modelId);
    return buildResult(normalized.provider, normalized.modelId, "explicit_config", operationType, timeoutMs, timeoutSource, cacheRetention);
  }

  // -- Level 3: parentModel (subagent only) --
  if (operationType === "subagent" && parentModel != null && parentModel.length > 0) {
    const parsed = parseModelString(parentModel, agentProvider);
    return buildResult(parsed.provider, parsed.modelId, "parent_inherited", operationType, timeoutMs, timeoutSource, cacheRetention);
  }

  // -- Level 4: catalog-derived tier --
  // Reads pi-ai catalog at call time (no hardcoded family map). Picks the
  // 10th-percentile cost text-capable model for `fast`, 50th for `mid`.
  // Returns {} for unknown providers (custom YAML providers like Ollama).
  const tier = OPERATION_TIER_MAP[operationType];
  if (tier !== "primary") {
    const defaults = resolveOperationDefaults(providerFamily);
    const modelId = defaults[tier];
    if (modelId) {
      // Do NOT call normalizeModelId on catalog ids — they are already
      // canonical pi-ai registry entries.
      return buildResult(agentProvider, modelId, "family_default", operationType, timeoutMs, timeoutSource, cacheRetention);
    }
  }

  // -- Level 5: agent primary (ultimate fallback) --
  return buildResult(agentProvider, agentModel, "agent_primary", operationType, timeoutMs, timeoutSource, cacheRetention);
}
