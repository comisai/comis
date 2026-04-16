/**
 * ModelRegistry adapter -- bridges Comis's model configuration to
 * pi-coding-agent's ModelRegistry with allowlist enforcement.
 *
 * Creates a ModelRegistry from AuthStorage and wraps model resolution
 * to enforce Comis's ModelAllowlist on top of pi-coding-agent's
 * built-in model catalog.
 *
 * @module
 */

import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ModelAllowlist } from "./model-allowlist.js";

/** Result of initial model resolution. */
export interface InitialModelResult {
  /** Resolved model, or undefined if no match / blocked by allowlist. */
  model: Model<Api> | undefined;
  /** Thinking level for the resolved model. */
  thinkingLevel: ThinkingLevel;
  /** Human-readable message if model was not resolved or was rejected. */
  fallbackMessage: string | undefined;
}

/**
 * Create a ModelRegistry from an AuthStorage instance.
 *
 * Uses built-in models only (no models.json loading).
 * The registry discovers available models based on which providers
 * have API keys configured in AuthStorage.
 */
export function createModelRegistryAdapter(authStorage: AuthStorage): ModelRegistry {
  return ModelRegistry.inMemory(authStorage);
}

/**
 * Resolve the initial model for an agent session.
 *
 * Finds a model matching the configured provider/modelId in the registry,
 * then enforces the optional allowlist. Returns undefined model with a
 * rejection message if the allowlist blocks the resolved model.
 *
 * @param registry - ModelRegistry to search
 * @param config - Agent model configuration (provider + model ID)
 * @param allowlist - Optional model allowlist for enforcement
 */
export async function resolveInitialModel(
  registry: ModelRegistry,
  config: { provider: string; model: string },
  allowlist?: ModelAllowlist,
): Promise<InitialModelResult> {
  // Try to find the exact model in the registry
  const model = registry.find(config.provider, config.model);

  if (!model) {
    // Try to find any available model from the requested provider
    const available = registry.getAvailable();
    const providerModel = available.find((m) => m.provider === config.provider);

    if (!providerModel) {
      return {
        model: undefined,
        thinkingLevel: "off",
        fallbackMessage: `No model found for provider '${config.provider}' with id '${config.model}'. ` +
          `Available models: ${available.map((m) => `${m.provider}/${m.id}`).join(", ") || "none"}`,
      };
    }

    // Found a provider model but not the exact ID -- return it with a note
    return {
      model: undefined,
      thinkingLevel: "off",
      fallbackMessage: `Model '${config.model}' not found for provider '${config.provider}'. ` +
        `Available: ${available.filter((m) => m.provider === config.provider).map((m) => m.id).join(", ")}`,
    };
  }

  // Enforce allowlist if active
  if (allowlist?.isActive()) {
    const provider = model.provider as string;
    const modelId = model.id;
    if (!allowlist.isAllowed(provider, modelId)) {
      return {
        model: undefined,
        thinkingLevel: "off",
        fallbackMessage: allowlist.getRejectionMessage(provider, modelId),
      };
    }
  }

  return {
    model,
    thinkingLevel: model.reasoning ? "medium" : "off",
    fallbackMessage: undefined,
  };
}