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
import {
  resolveOperationDefaults,
  OPERATION_TIER_MAP,
  OPERATION_TIMEOUT_DEFAULTS,
  OPERATION_CACHE_DEFAULTS,
} from "./operation-model-defaults.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  cacheRetention?: "none" | "short",
): OperationModelResolution {
  return {
    model: `${provider}:${modelId}`,
    provider,
    modelId,
    source,
    operationType,
    timeoutMs,
    cacheRetention,
  };
}

// ---------------------------------------------------------------------------
// Provider family resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a provider name to its base family by stripping known platform
 * suffixes (-bedrock, -vertex).
 *
 * @param provider - Provider name (e.g., "anthropic-bedrock", "google-vertex", "openai")
 * @returns Base provider family name (e.g., "anthropic", "google", "openai")
 */
export function resolveProviderFamily(provider: string): string {
  if (provider.endsWith("-bedrock")) return provider.slice(0, -"-bedrock".length);
  if (provider.endsWith("-vertex")) return provider.slice(0, -"-vertex".length);
  return provider;
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
  const entry = (operationModels as Partial<Record<ModelOperationType, OperationModelEntry>>)[operationType];
  const explicitTimeout = entry?.timeout;
  const timeoutMs =
    typeof explicitTimeout === "number" && explicitTimeout > 0
      ? explicitTimeout
      : OPERATION_TIMEOUT_DEFAULTS[operationType] ?? agentPromptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

  // -- Resolve cache retention --
  const cacheRetention = OPERATION_CACHE_DEFAULTS[operationType];

  // -- Level 1: invocationOverride --
  if (invocationOverride != null && invocationOverride.length > 0) {
    if (invocationOverride === "primary") {
      return buildResult(agentProvider, agentModel, "cron_job_override", operationType, timeoutMs, cacheRetention);
    }
    const parsed = parseModelString(invocationOverride, agentProvider);
    return buildResult(parsed.provider, parsed.modelId, "cron_job_override", operationType, timeoutMs, cacheRetention);
  }

  // -- Level 2: explicit config (operationModels[operationType]) --
  const configValue = entry?.model;
  if (typeof configValue === "string" && configValue.length > 0) {
    if (configValue === "primary") {
      return buildResult(agentProvider, agentModel, "explicit_config", operationType, timeoutMs, cacheRetention);
    }
    const parsed = parseModelString(configValue, agentProvider);
    // Run normalizeModelId for shortcut resolution on operator-provided values
    const normalized = normalizeModelId(parsed.provider, parsed.modelId);
    return buildResult(normalized.provider, normalized.modelId, "explicit_config", operationType, timeoutMs, cacheRetention);
  }

  // -- Level 3: parentModel (subagent only) --
  if (operationType === "subagent" && parentModel != null && parentModel.length > 0) {
    const parsed = parseModelString(parentModel, agentProvider);
    return buildResult(parsed.provider, parsed.modelId, "parent_inherited", operationType, timeoutMs, cacheRetention);
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
      return buildResult(agentProvider, modelId, "family_default", operationType, timeoutMs, cacheRetention);
    }
  }

  // -- Level 5: agent primary (ultimate fallback) --
  return buildResult(agentProvider, agentModel, "agent_primary", operationType, timeoutMs, cacheRetention);
}
