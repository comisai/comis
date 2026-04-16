/**
 * Vision provider registry: Auto-discovers and registers vision providers
 * based on available API keys and configuration.
 *
 * Wraps existing multimodal analyzers (Anthropic, OpenAI) as VisionProvider
 * instances, and uses the native Gemini adapter for Google.
 *
 * @module
 */

import type {
  VisionProvider,
  VisionRequest,
  VisionResult,
  VisionConfig,
  SecretManager,
} from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { createMultimodalAnalyzer } from "../multimodal-analyzer.js";
import { createGeminiVisionProvider } from "./gemini-vision-adapter.js";

/**
 * Fallback image provider order when auto-selecting.
 * First available provider in this list is used.
 */
const AUTO_IMAGE_PROVIDERS: ReadonlyArray<string> = ["openai", "anthropic", "google"];

/**
 * Dependencies for creating a vision provider registry.
 */
export interface VisionRegistryDeps {
  /** Secret manager for API key lookup. */
  readonly secretManager: SecretManager;
  /** Vision configuration (providers, video limits, etc.). */
  readonly config: VisionConfig;
}

/**
 * Wrap an existing multimodal analyzer as a VisionProvider.
 *
 * The analyzer implements ImageAnalysisPort (returns string).
 * We adapt it to VisionProvider (returns VisionResult).
 */
function wrapAnalyzerAsProvider(
  id: string,
  apiKey: string,
  model?: string,
): VisionProvider {
  const analyzer = createMultimodalAnalyzer({
    apiKey,
    provider: id as "anthropic" | "openai",
    model,
  });

  return {
    id,
    capabilities: ["image"],

    async describeImage(req: VisionRequest): Promise<Result<VisionResult, Error>> {
      const result = await analyzer.analyze(req.image, req.prompt, {
        mimeType: req.mimeType,
        maxTokens: req.maxTokens,
      });

      if (!result.ok) {
        return err(result.error);
      }

      return ok({
        text: result.value,
        provider: id,
        model: model ?? (id === "anthropic" ? "claude-sonnet-4-5-20250929" : "gpt-4o"),
      });
    },
  };
}

/**
 * Create a vision provider registry populated with providers that have
 * available API keys.
 *
 * Auto-registers:
 * - Anthropic (if ANTHROPIC_API_KEY available and "anthropic" in config.providers)
 * - OpenAI (if OPENAI_API_KEY available and "openai" in config.providers)
 * - Google/Gemini (if GOOGLE_API_KEY available and "google" in config.providers)
 *
 * @param deps - Secret manager and vision configuration
 * @returns Map of provider ID to VisionProvider instance
 */
export function createVisionProviderRegistry(
  deps: VisionRegistryDeps,
): Map<string, VisionProvider> {
  const { secretManager, config } = deps;
  const registry = new Map<string, VisionProvider>();
  const providerSet = new Set(config.providers);

  // Anthropic
  if (providerSet.has("anthropic")) {
    const key = secretManager.get("ANTHROPIC_API_KEY");
    if (key) {
      registry.set("anthropic", wrapAnalyzerAsProvider("anthropic", key));
    }
  }

  // OpenAI
  if (providerSet.has("openai")) {
    const key = secretManager.get("OPENAI_API_KEY");
    if (key) {
      registry.set("openai", wrapAnalyzerAsProvider("openai", key));
    }
  }

  // Google / Gemini
  if (providerSet.has("google")) {
    const key = secretManager.get("GOOGLE_API_KEY");
    if (key) {
      registry.set(
        "google",
        createGeminiVisionProvider({
          apiKey: key,
          videoMaxRawBytes: config.videoMaxRawBytes,
          videoMaxBase64Bytes: config.videoMaxBase64Bytes,
          timeoutMs: config.videoTimeoutMs,
        }),
      );
    }
  }

  return registry;
}

/**
 * Select the best vision provider for a given media type.
 *
 * Selection logic:
 * 1. If preferredProvider is set and available with the required capability, use it.
 * 2. For "video": only providers with "video" capability (currently Google).
 * 3. For "image": fallback order ["openai", "anthropic", "google"].
 *
 * Returns undefined if no suitable provider is found (graceful degradation).
 *
 * @param registry - Map of registered vision providers
 * @param mediaType - Type of media to analyze ("image" or "video")
 * @param preferredProvider - Optional preferred provider ID
 * @returns The selected VisionProvider, or undefined
 */
export function selectVisionProvider(
  registry: Map<string, VisionProvider>,
  mediaType: "image" | "video",
  preferredProvider?: string,
): VisionProvider | undefined {
  // Try preferred provider first
  if (preferredProvider) {
    const preferred = registry.get(preferredProvider);
    if (preferred && preferred.capabilities.includes(mediaType)) {
      return preferred;
    }
  }

  // For video: find any provider with video capability
  if (mediaType === "video") {
    for (const provider of registry.values()) {
      if (provider.capabilities.includes("video")) {
        return provider;
      }
    }
    return undefined;
  }

  // For image: use defined fallback order
  for (const id of AUTO_IMAGE_PROVIDERS) {
    const provider = registry.get(id);
    if (provider && provider.capabilities.includes("image")) {
      return provider;
    }
  }

  return undefined;
}
