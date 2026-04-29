// SPDX-License-Identifier: Apache-2.0
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
import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { Api, Model, KnownProvider } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { SecretManager } from "@comis/core";
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
 * YAML provider type → pi-ai API identifier. Mirrors the
 * `OPENAI_COMPATIBLE_TYPES` set in `model-scanner.ts`. Unknown types
 * default to `openai-completions` so arbitrary OpenAI-compatible
 * proxies (NVIDIA NIM, Together, ollama, lm-studio, etc.) work without
 * code changes.
 */
/**
 * Provider types that can register without an API key.
 *
 * Ollama (and similar local inference servers) do not require authentication
 * by default. When a provider entry has a type in this set and no apiKeyName
 * is configured (or the named secret is missing), registration proceeds with
 * the "ollama-no-auth" sentinel instead of being skipped.
 *
 * The sentinel reaches the wire as `Authorization: Bearer ollama-no-auth`.
 * Ollama ignores Authorization unless `OLLAMA_API_KEY` is set server-side.
 */
const KEYLESS_PROVIDER_TYPES = new Set(["ollama"]);

const PROVIDER_TYPE_TO_API: Record<string, Api> = {
  openai: "openai-completions",
  groq: "openai-completions",
  mistral: "openai-completions",
  together: "openai-completions",
  deepseek: "openai-completions",
  cerebras: "openai-completions",
  xai: "openai-completions",
  openrouter: "openai-completions",
  anthropic: "anthropic-messages",
  google: "google-generative-ai",
};

const _builtInProviders = new Set<string>(getProviders());

function getBuiltInBaseUrl(type: string): string | undefined {
  if (!_builtInProviders.has(type)) return undefined;
  const models = getModels(type as KnownProvider);
  return models[0]?.baseUrl;
}

function getBuiltInModelIds(type: string): Set<string> {
  if (!_builtInProviders.has(type)) return new Set();
  return new Set(getModels(type as KnownProvider).map((m) => m.id));
}

/** Subset of `ProviderEntry` (from `@comis/core`) we read for pi registration. */
export interface CustomProviderRegistration {
  type: string;
  baseUrl: string;
  apiKeyName: string;
  enabled: boolean;
  headers: Record<string, string>;
  models: ReadonlyArray<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    input?: ReadonlyArray<"text" | "image">;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  }>;
}

/** Logger surface accepted by `registerCustomProviders`. Subset of Pino. */
export interface CustomProviderLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Result of custom provider registration. */
export interface RegisterCustomProvidersResult {
  /** Number of provider entries successfully registered. */
  registered: number;
  /**
   * Comis provider name → built-in pi SDK provider name.
   * Populated when a YAML entry's `type` matches a built-in provider but the
   * entry's key (comis name) differs. Lets model resolution fall back to the
   * built-in catalog: `registry.find("gemini", id)` fails → try `registry.find("google", id)`.
   */
  providerAliases: Map<string, string>;
}

/**
 * Register YAML `providers.entries.*` with pi-coding-agent's ModelRegistry.
 *
 * Without this, custom OpenAI-compatible providers (NVIDIA NIM, Together,
 * ollama, etc.) are not findable via `registry.find(provider, modelId)`,
 * which causes pi's `findInitialModel` to silently fall back to whatever
 * built-in provider has env-var auth (e.g., GEMINI_API_KEY → google).
 *
 * Per-entry behavior:
 *   - Skipped if `enabled === false`.
 *   - Skipped if no models declared and no `baseUrl` override.
 *   - Models that already exist in the built-in pi SDK catalog for the
 *     entry's `type` are filtered out (no redundant registration).
 *   - On `registerProvider` error (missing baseUrl, missing apiKey, etc.),
 *     a WARN is logged and the loop continues -- one bad entry must not
 *     prevent the daemon from starting.
 */
export function registerCustomProviders(
  registry: ModelRegistry,
  entries: Record<string, CustomProviderRegistration>,
  secretManager: SecretManager,
  logger: CustomProviderLogger,
): RegisterCustomProvidersResult {
  let registered = 0;
  const providerAliases = new Map<string, string>();

  for (const [providerName, entry] of Object.entries(entries)) {
    if (!entry.enabled) {
      logger.debug({ providerName }, "Custom provider skipped (disabled)");
      continue;
    }

    const builtInIds = getBuiltInModelIds(entry.type);
    const isBuiltInType = builtInIds.size > 0;

    if (isBuiltInType && providerName !== entry.type) {
      providerAliases.set(providerName, entry.type);
    }

    const customModels = isBuiltInType
      ? entry.models.filter((m) => !builtInIds.has(m.id))
      : [...entry.models];

    if (isBuiltInType && customModels.length < entry.models.length) {
      const skipped = entry.models.length - customModels.length;
      logger.debug(
        { providerName, type: entry.type, skipped, remaining: customModels.length },
        "Skipped built-in models already in pi SDK catalog",
      );
    }

    const hasModels = customModels.length > 0;
    const hasBaseUrlOverride = !!entry.baseUrl;
    if (!hasModels && !hasBaseUrlOverride) {
      logger.debug(
        { providerName },
        "Custom provider skipped (no custom models and no baseUrl override)",
      );
      continue;
    }

    const apiKey = entry.apiKeyName ? secretManager.get(entry.apiKeyName) : undefined;
    const isKeylessType = KEYLESS_PROVIDER_TYPES.has(entry.type);

    if (hasModels && !apiKey && !isKeylessType) {
      logger.warn(
        {
          providerName,
          apiKeyName: entry.apiKeyName,
          hint: "Set the named secret in ~/.comis/.env, omit apiKeyName for type='ollama', or remove the provider entry from config.yaml",
          errorKind: "config",
        },
        "Custom provider has models but no API key -- skipping registration",
      );
      continue;
    }

    const api = PROVIDER_TYPE_TO_API[entry.type] ?? "openai-completions";
    const headersResolved = Object.keys(entry.headers).length > 0 ? entry.headers : undefined;
    const resolvedApiKey = apiKey ?? (isKeylessType ? "ollama-no-auth" : undefined);

    if (resolvedApiKey === "ollama-no-auth") {
      logger.debug(
        {
          providerName,
          hint: "Using keyless sentinel for type='ollama'. If your Ollama server requires an OLLAMA_API_KEY, set the provider's apiKeyName explicitly via providers_manage update.",
        },
        "Custom provider registered with keyless sentinel",
      );
    }

    try {
      registry.registerProvider(providerName, {
        api,
        baseUrl: entry.baseUrl || getBuiltInBaseUrl(entry.type),
        apiKey: resolvedApiKey,
        headers: headersResolved,
        models: hasModels
          ? customModels.map((m) => ({
              id: m.id,
              name: m.name ?? m.id,
              contextWindow: m.contextWindow ?? 128_000,
              maxTokens: m.maxTokens ?? 4_096,
              reasoning: m.reasoning ?? false,
              input: m.input ? [...m.input] : ["text"],
              cost: {
                input: m.cost?.input ?? 0,
                output: m.cost?.output ?? 0,
                cacheRead: m.cost?.cacheRead ?? 0,
                cacheWrite: m.cost?.cacheWrite ?? 0,
              },
            }))
          : undefined,
      });
      registered += 1;
      logger.debug(
        {
          providerName,
          api,
          baseUrl: entry.baseUrl,
          modelCount: customModels.length,
        },
        "Custom provider registered with pi ModelRegistry",
      );
    } catch (error) {
      logger.warn(
        {
          providerName,
          err: error instanceof Error ? error.message : String(error),
          hint: "Check providers.entries config: baseUrl required when defining models; apiKey required unless oauth configured",
          errorKind: "config",
        },
        "Custom provider registration failed",
      );
    }
  }
  return { registered, providerAliases };
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
  providerAliases?: Map<string, string>,
): Promise<InitialModelResult> {
  let model = registry.find(config.provider, config.model);

  if (!model && providerAliases) {
    const builtInName = providerAliases.get(config.provider);
    if (builtInName) {
      model = registry.find(builtInName, config.model);
    }
  }

  if (!model) {
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
