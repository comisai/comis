// SPDX-License-Identifier: Apache-2.0
/**
 * Model Scanner: HTTP-based provider scanner for API key validation
 * and dynamic model discovery.
 *
 * Calls each configured provider's /models endpoint to validate that
 * API keys are active and to discover available models. Supports
 * OpenAI-compatible, Anthropic, and Google Gemini API formats.
 *
 * Results are used by the ModelCatalog to set validation state and
 * discover models not in the pi-ai static registry.
 *
 * @module
 */

import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of scanning a single provider. */
export interface ScanResult {
  /** Provider name that was scanned */
  provider: string;
  /** Whether the API key was confirmed valid (200 response) */
  keyValid: boolean;
  /** Model IDs discovered from the provider's response */
  modelsDiscovered: string[];
  /** Error message if the scan failed */
  error?: string;
  /** Duration of the scan in milliseconds */
  durationMs: number;
}

/** Dependencies for the model scanner (injectable for testing). */
export interface ModelScannerDeps {
  /** HTTP fetch function (injectable for testing) */
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  /** Timeout per provider in ms */
  timeoutMs: number;
}

/** Provider configuration for scanning. */
interface ProviderScanConfig {
  type: string;
  baseUrl: string;
}

/** Provider entry for scanAll(). */
interface ProviderScanAllEntry {
  type: string;
  baseUrl: string;
  apiKeyName: string;
  enabled: boolean;
}

/** Model scanner interface. */
export interface ModelScanner {
  /** Scan a single provider to validate its API key and discover models. */
  scanProvider(
    providerName: string,
    config: ProviderScanConfig,
    apiKey: string,
  ): Promise<ScanResult>;

  /** Scan all configured providers in parallel. */
  scanAll(
    providers: Record<string, ProviderScanAllEntry>,
    resolveKey: (keyName: string) => string | undefined,
  ): Promise<ScanResult[]>;
}

// ---------------------------------------------------------------------------
// Catalog-driven endpoint resolution (Layer 1E -- 260430-vwt)
// ---------------------------------------------------------------------------

/**
 * Native pi-ai providers from the live catalog. Used to source baseUrls
 * for scanner endpoints when the user has not supplied an explicit
 * baseUrl override.
 */
const _nativeProviders = new Set<string>(getProviders());

/**
 * Hardcoded fallback base URLs for the three "first-party" provider
 * families. These remain only as last-resort defaults when pi-ai's catalog
 * returns nothing for a given type (e.g., a custom proxy named "openai"
 * with type:"openai" but no baseUrl). The catalog is the source of truth;
 * these constants are explicit, discoverable backstops.
 */
const OPENAI_FALLBACK_BASE_URL = "https://api.openai.com";
const ANTHROPIC_FALLBACK_BASE_URL = "https://api.anthropic.com";
const GOOGLE_FALLBACK_BASE_URL = "https://generativelanguage.googleapis.com";

/**
 * Read the baseUrl for a provider type from the live pi-ai catalog.
 * Returns undefined when the type is not in the native catalog.
 *
 * Exported for testing -- in production, callers should use `buildEndpoint`
 * which chains catalog-first → user-supplied baseUrl → hardcoded fallback.
 */
export function getCatalogBaseUrl(type: string): string | undefined {
  if (!_nativeProviders.has(type)) return undefined;
  return getModels(type as KnownProvider)[0]?.baseUrl;
}

/**
 * Whether a provider type should be scanned with the OpenAI-compatible
 * /v1/models endpoint shape.
 *
 * Anthropic and Google have their own dedicated scan paths. Every other
 * type -- whether it's a native pi-ai provider with an `openai-completions`
 * primary api (groq, openrouter, cerebras, xai, ...), a native provider
 * whose primary api is something like `openai-responses` or
 * `mistral-conversations` (these still typically expose /v1/models for
 * compat), or a custom non-catalog type (NVIDIA NIM, Together, Fireworks,
 * Ollama, vLLM, ...) -- is scanned via the OpenAI-compatible shape.
 *
 * This is intentionally permissive: the scanner's job is API-key
 * validation, and most providers expose /v1/models regardless of their
 * primary wire format.
 *
 * Exported for testing.
 */
export function isOpenAICompatibleType(type: string): boolean {
  if (type === "anthropic" || type === "google") return false;
  return true;
}

interface EndpointInfo {
  url: string;
  headers: Record<string, string>;
}

function buildEndpoint(
  providerType: string,
  baseUrl: string,
  apiKey: string,
): EndpointInfo | undefined {
  if (isOpenAICompatibleType(providerType)) {
    const base =
      baseUrl
      || getCatalogBaseUrl(providerType)
      || OPENAI_FALLBACK_BASE_URL;
    return {
      url: `${base}/v1/models`,
      headers: { Authorization: `Bearer ${apiKey}` },
    };
  }

  if (providerType === "anthropic") {
    const base =
      baseUrl
      || getCatalogBaseUrl(providerType)
      || ANTHROPIC_FALLBACK_BASE_URL;
    return {
      url: `${base}/v1/models`,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    };
  }

  if (providerType === "google") {
    const base =
      baseUrl
      || getCatalogBaseUrl(providerType)
      || GOOGLE_FALLBACK_BASE_URL;
    return {
      url: `${base}/v1beta/models?key=${apiKey}`,
      headers: {},
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

function parseModelIds(providerType: string, body: Record<string, unknown>): string[] {
  if (isOpenAICompatibleType(providerType) || providerType === "anthropic") {
    const data = (body as Record<string, unknown>)?.data;
    if (!Array.isArray(data)) return [];
    return data.map((m: Record<string, unknown>) => m.id).filter((id: unknown) => typeof id === "string");
  }

  if (providerType === "google") {
    const models = (body as Record<string, unknown>)?.models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m: Record<string, unknown>) => {
        const name = m.name;
        if (typeof name !== "string") return undefined;
        return name.replace("models/", "");
      })
      .filter((id: unknown): id is string => typeof id === "string");
  }

  return [];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a model scanner with injectable fetch and timeout.
 *
 * @param deps - fetchFn and timeoutMs for HTTP requests
 */
export function createModelScanner(deps: ModelScannerDeps): ModelScanner {
  const { fetchFn, timeoutMs } = deps;

  return {
    async scanProvider(
      providerName: string,
      config: ProviderScanConfig,
      apiKey: string,
    ): Promise<ScanResult> {
      const startMs = Date.now();

      const endpoint = buildEndpoint(config.type, config.baseUrl, apiKey);
      if (!endpoint) {
        return {
          provider: providerName,
          keyValid: false,
          modelsDiscovered: [],
          error: `Unsupported provider type: ${config.type}`,
          durationMs: Date.now() - startMs,
        };
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response: Response;
        try {
          response = await fetchFn(endpoint.url, {
            method: "GET",
            headers: endpoint.headers,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        const durationMs = Date.now() - startMs;

        if (response.ok) {
          const body = (await response.json()) as Record<string, unknown>;
          const modelIds = parseModelIds(config.type, body);

          return {
            provider: providerName,
            keyValid: true,
            modelsDiscovered: modelIds,
            durationMs,
          };
        }

        // Non-OK response (401, 403, etc.)
        let errorMessage: string;
        try {
          const body = await response.json();
          errorMessage =
            body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;
        } catch {
          errorMessage = `HTTP ${response.status}`;
        }

        return {
          provider: providerName,
          keyValid: false,
          modelsDiscovered: [],
          error: errorMessage,
          durationMs,
        };
      } catch (error: unknown) {
        const durationMs = Date.now() - startMs;
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          provider: providerName,
          keyValid: false,
          modelsDiscovered: [],
          error: message,
          durationMs,
        };
      }
    },

    async scanAll(
      providers: Record<string, ProviderScanAllEntry>,
      resolveKey: (keyName: string) => string | undefined,
    ): Promise<ScanResult[]> {
      const tasks: Array<Promise<ScanResult>> = [];

      for (const [name, entry] of Object.entries(providers)) {
        // Skip disabled providers
        if (!entry.enabled) continue;

        // Resolve API key -- skip if not available
        const apiKey = resolveKey(entry.apiKeyName);
        if (apiKey === undefined) continue;

        tasks.push(
          this.scanProvider(name, { type: entry.type, baseUrl: entry.baseUrl }, apiKey),
        );
      }

      // Run all scans in parallel
      const settled = await Promise.allSettled(tasks);

      return settled.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }

        // Rejected promise -- create error ScanResult
        // We need to figure out which provider this was for.
        // Since we iterated in order and filtered, reconstruct the provider name.
        const enabledProviders = Object.entries(providers)
          .filter(([, e]) => e.enabled && resolveKey(e.apiKeyName) !== undefined)
          .map(([name]) => name);

        return {
          provider: enabledProviders[index] ?? "unknown",
          keyValid: false,
          modelsDiscovered: [],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          durationMs: 0,
        };
      });
    },
  };
}
