// SPDX-License-Identifier: Apache-2.0
/**
 * Startup dry-run: log all operation model resolutions for each configured
 * agent when the daemon boots. Pure diagnostic logging -- never blocks
 * startup, never throws.
 * Operators verify operation model tiering at a glance, catching
 * misconfigurations (missing API keys, unintended primary-only fallback)
 * before they cause silent cost waste or auth failures during actual LLM calls.
 * @module
 */

import type { ModelOperationType, OperationModels } from "@comis/core";
import {
  resolveOperationModel,
  resolveProviderFamily,
  OPERATION_TIER_MAP,
  DEFAULT_PROVIDER_KEYS,
} from "@comis/agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal agent config shape needed for dry-run resolution. */
interface AgentConfig {
  provider: string;
  model: string;
  operationModels?: Record<string, unknown>;
}

/** Minimal logger interface (subset of Pino). */
interface DryRunLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Minimal secret manager interface (subset of SecretManager). */
interface DryRunSecretManager {
  has(key: string): boolean;
}

/** Summary object for a single operation resolution. */
interface OperationSummary {
  op: string;
  model: string;
  source: string;
  tieringActive: boolean;
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// All 7 operation types from the tier map
// ---------------------------------------------------------------------------

const ALL_OPERATION_TYPES = Object.keys(OPERATION_TIER_MAP) as ModelOperationType[];

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Log all operation model resolutions for every configured agent.
 * Called once at daemon startup after setupAgents(). Logs one structured
 * INFO line per agent with all 7 operation type resolutions and emits
 * WARN for cross-provider API key misses.
 * Never throws -- each agent is wrapped in a try/catch that logs WARN
 * on resolution failure.
 * @param params.agents - Record of agent configs keyed by agent ID
 * @param params.secretManager - SecretManager for API key availability checks
 * @param params.logger - Logger for structured output (info/warn)
 */
export function logOperationModelDryRun(params: {
  agents: Record<string, AgentConfig>;
  secretManager: DryRunSecretManager;
  logger: DryRunLogger;
}): void {
  const { agents, secretManager, logger } = params;

  for (const agentId of Object.keys(agents)) {
    try {
      const agentConfig = agents[agentId];
      const providerFamily = resolveProviderFamily(agentConfig.provider);
      const summaries: OperationSummary[] = [];

      for (const operationType of ALL_OPERATION_TYPES) {
        const resolution = resolveOperationModel({
          operationType,
          agentProvider: agentConfig.provider,
          agentModel: agentConfig.model,
          operationModels: (agentConfig.operationModels ?? {}) as OperationModels,
          providerFamily,
        });

        summaries.push({
          op: resolution.operationType,
          model: resolution.model,
          source: resolution.source,
          tieringActive: resolution.source === "family_default" || resolution.source === "explicit_config",
          timeoutMs: resolution.timeoutMs,
        });

        // Check for cross-provider API key availability:
        // If the resolved provider's family differs from the agent's family,
        // verify the cross-provider key exists in SecretManager.
        const resolvedFamily = resolveProviderFamily(resolution.provider);
        if (resolvedFamily !== providerFamily) {
          const keyName = DEFAULT_PROVIDER_KEYS[resolvedFamily];
          if (keyName && !secretManager.has(keyName)) {
            logger.warn({
              agentId,
              operationType: resolution.operationType,
              resolvedModel: resolution.model,
              resolvedProvider: resolution.provider,
              expectedKey: keyName,
              hint: `Cross-provider resolution requires ${keyName} but it is not configured in SecretManager`,
              errorKind: "config" as const,
            }, "Operation model cross-provider API key missing");
          }
        }
      }

      logger.info({
        agentId,
        providerFamily,
        primaryModel: `${agentConfig.provider}:${agentConfig.model}`,
        operationModels: summaries,
        tieringActive: summaries.some((s) => s.tieringActive),
      }, "Operation model dry-run complete");
    } catch (error: unknown) {
      logger.warn({
        agentId,
        err: error,
        hint: "Dry-run resolution failed for this agent; check agent config",
        errorKind: "config" as const,
      }, "Operation model dry-run failed for agent");
    }
  }
}
