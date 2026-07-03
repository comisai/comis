// SPDX-License-Identifier: Apache-2.0
/**
 * buildSyntheticCriticDeps — construct the verification critic's CriticDeps from
 * the PostExecutionParams fields available at the post-execution hook.
 *
 * Extracted from verification-gate.ts so BOTH that file and
 * executor-post-execution.ts stay within their line-count budgets. The synthetic
 * ModelProfile derives capacity/security from capabilityClass (the hook has no
 * resolved ModelProfile in scope).
 *
 * apiKey:"" is SAFE here because shouldRunCritic (verification-gate.ts)
 * gates the critic to keyless providers (ollama/lm-studio) — a key-requiring
 * cloud provider is skipped-with-WARN upstream and never reaches this builder,
 * so no cloud apiKey threading exists here.
 *
 * Forbidden: Date.now(), raw setTimeout/clearTimeout, new Date().
 * Invariant: no compatibility shims, no deprecated annotations.
 *
 * @module
 */
import type { CapabilityClass } from "./model-profile.js";
import type { CriticDeps } from "./verification-gate.js";

export function buildSyntheticCriticDeps(params: {
  capabilityClass: CapabilityClass | undefined;
  provider: string;
  modelId: string;
  agentId: string;
  canaryToken: string;
  minResponseChars: number;
  maxRetries: number;
  clock: CriticDeps["clock"];
  logger: CriticDeps["logger"];
  eventBus: CriticDeps["eventBus"];
}): { deps: CriticDeps; maxRetries: number } {
  const cc = params.capabilityClass ?? "nano";
  const isSmall = cc === "small" || cc === "nano";
  return {
    deps: {
      provider: params.provider,
      modelId: params.modelId,
      apiKey: "", // keyless-only (gated by shouldRunCritic); cloud providers never reach here
      clock: params.clock,
      logger: params.logger,
      agentId: params.agentId,
      canaryToken: params.canaryToken,
      minResponseChars: params.minResponseChars,
      modelProfile: {
        capabilityClass: cc,
        scaffoldLevel: isSmall ? "max" : "light",
        securityLevel: isSmall ? "locked" : "standard",
        reasoningStyle: "none",
        maxOutputTokens: 4_096,
        contextWindow: 8_192,
        supportsVision: false,
        supportsTools: true,
        supportsPromptCache: false,
        supportsServerToolSearch: false,
        supportsStructuredOutput: false,
      },
      eventBus: params.eventBus,
    },
    maxRetries: params.maxRetries,
  };
}
