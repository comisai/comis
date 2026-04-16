/**
 * Model hygiene security check.
 *
 * Assesses model configuration risks: missing allowlists with open
 * failover, and use of small/weak models that are more susceptible
 * to prompt injection attacks.
 *
 * @module
 */

import type { SecurityCheck, SecurityFinding } from "../types.js";

/** Patterns in model names indicating small/weak models. */
const WEAK_MODEL_PATTERNS = [/\bnano\b/i, /\bmini\b/i, /\btiny\b/i, /\bsmall\b/i];

/**
 * Model hygiene check.
 *
 * Inspects agent model configurations for:
 * - Missing model allowlists with failover configured
 * - Small parameter models susceptible to prompt injection
 */
export const modelHygieneCheck: SecurityCheck = {
  id: "model-hygiene",
  name: "Model Hygiene",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.config?.agents) {
      return findings;
    }

    for (const [agentId, agent] of Object.entries(context.config.agents)) {
      // Check for missing model allowlist with failover configured
      const failover = agent.modelFailover;
      if (failover) {
        const hasAllowlist = failover.allowedModels && failover.allowedModels.length > 0;
        const hasFallbacks = failover.fallbackModels && failover.fallbackModels.length > 0;

        if (!hasAllowlist && hasFallbacks) {
          findings.push({
            category: "model-hygiene",
            severity: "warning",
            message: `Agent "${agentId}": No model allowlist with open failover increases injection risk`,
            remediation:
              "Add modelFailover.allowedModels to restrict which models can be used during failover",
            code: "SEC-MODEL-001",
          });
        }
      }

      // Check for weak/small model identifiers
      const modelName = agent.model ?? "";
      for (const pattern of WEAK_MODEL_PATTERNS) {
        if (pattern.test(modelName)) {
          findings.push({
            category: "model-hygiene",
            severity: "warning",
            message: `Agent "${agentId}": Small parameter models are more susceptible to prompt injection (model: ${modelName})`,
            remediation: "Consider using a larger model or adding additional input validation",
            code: "SEC-MODEL-002",
          });
          break; // One finding per agent is sufficient
        }
      }
    }

    return findings;
  },
};
