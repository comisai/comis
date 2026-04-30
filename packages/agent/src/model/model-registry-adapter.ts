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

const _builtInProviders = new Set<string>(getProviders());

/**
 * Infer pi-ai wire API from the live catalog.
 *
 * For any provider name that pi-ai exposes via `getProviders()`, read the
 * `api` field from the first registered model. This is the single source of
 * truth: when pi-ai adds a provider with a new wire format (e.g. a future
 * `xyz-streaming` API), this helper picks it up automatically without any
 * comis code change.
 *
 * Returns `undefined` when the type is not in the native catalog -- callers
 * should chain to `FALLBACK_API_FOR_CUSTOM_TYPES` and finally to the
 * `openai-completions` default for arbitrary OpenAI-compatible proxies.
 */
function inferApiFromCatalog(type: string): Api | undefined {
  if (!_builtInProviders.has(type)) return undefined;
  const models = getModels(type as KnownProvider);
  return models[0]?.api as Api | undefined;
}

/**
 * Tiny fallback table for custom provider types pi-ai does NOT ship in its
 * native catalog. These are local inference servers and legacy aliases that
 * speak OpenAI-compatible wire format but have no provider entry in
 * `models.generated.ts`. Everything else falls through to
 * `"openai-completions"` -- the safe default for arbitrary OpenAI-compatible
 * proxies (NVIDIA NIM, Fireworks, Perplexity, vLLM, llama.cpp, etc.).
 */
const FALLBACK_API_FOR_CUSTOM_TYPES: Record<string, Api> = {
  ollama: "openai-completions",
  "lm-studio": "openai-completions",
  together: "openai-completions",
};

/**
 * API resolution model for `entry.type`:
 *   1. catalog-first   -- `inferApiFromCatalog(type)` reads the live pi-ai catalog
 *   2. fallback-second -- `FALLBACK_API_FOR_CUSTOM_TYPES[type]` for legacy custom types
 *   3. default-final   -- `"openai-completions"` for arbitrary OpenAI-compatible proxies
 */

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

    // Layer 1B (260430-vwt): catalog-aware model enrichment.
    //
    // Before computing customModels, decide whether to inherit the full
    // pi-ai catalog or to enrich the user's sparse list with catalog
    // metadata.
    //
    // Inherit branch (empty list + built-in type + no baseUrl override):
    //   user wants the full native catalog under this provider name --
    //   bypass the dedup filter below; the inherited list is intentional.
    // Enrich branch (sparse list + built-in type):
    //   for each user model, fill missing fields from the catalog when an
    //   ID match is found. The dedup filter still applies after enrichment
    //   so that user-supplied IDs already in pi-ai's built-in catalog are
    //   served via the built-in path (not redundantly registered).
    const hasBaseUrlOverride = !!entry.baseUrl;
    const shouldInheritCatalog =
      entry.models.length === 0 && isBuiltInType && !hasBaseUrlOverride;

    let workingModels: Array<{
      id: string;
      name?: string;
      contextWindow?: number;
      maxTokens?: number;
      reasoning?: boolean;
      input?: ReadonlyArray<"text" | "image">;
      cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    }>;

    if (shouldInheritCatalog) {
      // Inherit the full native catalog -- no dedup, no fallback values.
      const catalogModels = getModels(entry.type as KnownProvider);
      workingModels = catalogModels.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
      }));
      logger.debug(
        { providerName, type: entry.type, inherited: workingModels.length },
        "Inherited full pi-ai native catalog (empty user list)",
      );
    } else if (isBuiltInType) {
      // Sparse list: enrich each user model with catalog data, then dedup.
      const catalog = getModels(entry.type as KnownProvider);
      const enriched = entry.models.map((m) => {
        const cat = catalog.find((c) => c.id === m.id);
        if (!cat) {
          return {
            id: m.id,
            name: m.name,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            reasoning: m.reasoning,
            input: m.input,
            cost: m.cost,
          };
        }
        return {
          id: m.id,
          name: m.name ?? cat.name,
          contextWindow: m.contextWindow ?? cat.contextWindow,
          maxTokens: m.maxTokens ?? cat.maxTokens,
          reasoning: m.reasoning ?? cat.reasoning,
          input: m.input ?? cat.input,
          cost: {
            input: m.cost?.input ?? cat.cost?.input,
            output: m.cost?.output ?? cat.cost?.output,
            cacheRead: m.cost?.cacheRead ?? cat.cost?.cacheRead,
            cacheWrite: m.cost?.cacheWrite ?? cat.cost?.cacheWrite,
          },
        };
      });
      // Dedup: filter out built-in IDs (already served via pi-ai's built-in path).
      workingModels = enriched.filter((m) => !builtInIds.has(m.id));
      if (workingModels.length < entry.models.length) {
        const skipped = entry.models.length - workingModels.length;
        logger.debug(
          { providerName, type: entry.type, skipped, remaining: workingModels.length },
          "Skipped built-in models already in pi SDK catalog",
        );
      }
    } else {
      // Custom (non-catalog) type: user-supplied list as-is.
      workingModels = [...entry.models];
    }

    const customModels = workingModels;

    const hasModels = customModels.length > 0;
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

    const api =
      inferApiFromCatalog(entry.type)
      ?? FALLBACK_API_FOR_CUSTOM_TYPES[entry.type]
      ?? "openai-completions";
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
