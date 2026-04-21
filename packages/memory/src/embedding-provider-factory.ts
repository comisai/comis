// SPDX-License-Identifier: Apache-2.0
/**
 * Embedding provider factory with auto-selection and fallback chain.
 *
 * When provider is "auto", tries local first (node-llama-cpp) then falls
 * back to remote (OpenAI). Returns Result<EmbeddingPort, Error> with
 * descriptive error messages listing all attempted providers.
 */

import type { EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { err } from "@comis/shared";
import { createLocalEmbeddingProvider } from "./embedding-provider-local.js";
import {
  createOpenAIEmbeddingProvider,
  type OpenAIEmbeddingProviderOptions,
} from "./embedding-provider-openai.js";

/**
 * Options for the auto-selection embedding provider factory.
 */
export interface EmbeddingProviderOptions {
  /** Provider selection strategy */
  provider: "auto" | "local" | "openai";
  /** Local model configuration (used when provider is "auto" or "local") */
  local?: { modelUri: string; modelsDir: string; gpu?: string; contextSize?: number };
  /** Remote OpenAI configuration (used when provider is "auto" or "openai") */
  remote?: { apiKey: string; model: string; dimensions: number };
}

/**
 * Create an embedding provider based on the configured strategy.
 *
 * - `"local"`: Try local only, return error if fails
 * - `"openai"`: Try remote only, return error if no apiKey
 * - `"auto"`: Try local first. If local fails, try remote. If both fail, return combined error
 *
 * @param options - Provider selection and configuration
 * @returns An EmbeddingPort instance, or an error describing what failed
 */
export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<Result<EmbeddingPort, Error>> {
  if (options.provider === "local") {
    if (!options.local) {
      return err(new Error("Local embedding provider requested but no local config provided"));
    }
    return createLocalEmbeddingProvider(options.local);
  }

  if (options.provider === "openai") {
    return tryRemote(options.remote);
  }

  // Auto mode: try local first, then fall back to remote
  const errors: string[] = [];

  if (options.local) {
    const localResult = await createLocalEmbeddingProvider(options.local);
    if (localResult.ok) {
      return localResult;
    }
    errors.push(`Local: ${localResult.error.message}`);
  } else {
    errors.push("Local: no local config provided");
  }

  const remoteResult = tryRemote(options.remote);
  if (remoteResult.ok) {
    return remoteResult;
  }
  errors.push(`Remote: ${remoteResult.error.message}`);

  return err(
    new Error(`No embedding provider available. Tried: ${errors.join("; ")}`),
  );
}

/**
 * Attempt to create the remote (OpenAI) provider.
 */
function tryRemote(
  remote: OpenAIEmbeddingProviderOptions | undefined,
): Result<EmbeddingPort, Error> {
  if (!remote || !remote.apiKey) {
    return err(new Error("OpenAI embedding provider requires an apiKey"));
  }
  return createOpenAIEmbeddingProvider(remote);
}
