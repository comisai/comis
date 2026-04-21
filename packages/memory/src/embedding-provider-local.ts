// SPDX-License-Identifier: Apache-2.0
/**
 * Local embedding provider using node-llama-cpp for GGUF model inference.
 *
 * Uses dynamic import() so the module gracefully degrades if node-llama-cpp
 * native binaries are not available on the current platform.
 */

import type { EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * Options for creating a local embedding provider.
 */
export interface LocalEmbeddingProviderOptions {
  /** HuggingFace model URI or path to local GGUF file */
  modelUri: string;
  /** Directory to store/resolve downloaded models */
  modelsDir: string;
  /** GPU acceleration mode */
  gpu?: string;
  /** Context size for embedding model (tokens). When undefined, uses model default. */
  contextSize?: number;
}

/**
 * Create a local embedding provider backed by node-llama-cpp.
 *
 * Loads a GGUF embedding model and creates an embedding context. If the
 * model URI is an `hf:` URI, `resolveModelFile()` auto-downloads from
 * HuggingFace. All operations are wrapped in Result (no thrown exceptions).
 *
 * @param options - Local model configuration
 * @returns An EmbeddingPort backed by node-llama-cpp, or an error
 */
export async function createLocalEmbeddingProvider(
  options: LocalEmbeddingProviderOptions,
): Promise<Result<EmbeddingPort, Error>> {
  try {
    // Dynamic import for graceful degradation when native binaries unavailable
    const llamaCpp = await import("node-llama-cpp");

    const llama = await llamaCpp.getLlama();

    // Resolve model path (auto-download from HuggingFace if hf: URI)
    let modelPath: string;
    if (options.modelUri.startsWith("hf:")) {
      modelPath = await llamaCpp.resolveModelFile(
        options.modelUri,
        options.modelsDir,
      );
    } else {
      modelPath = options.modelUri;
    }

    const model = await llama.loadModel({ modelPath });
    const context = await model.createEmbeddingContext({
      contextSize: options.contextSize,
    });

    // Detect dimensions from a probe embedding
    const probe = await context.getEmbeddingFor("probe");
    const dimensions = probe.vector.length;

    // Guard against double-dispose
    let disposed = false;

    const port: EmbeddingPort = {
      provider: "local",
      dimensions,
      modelId: options.modelUri,

      async embed(text: string): Promise<Result<number[], Error>> {
        try {
          const embedding = await context.getEmbeddingFor(text);
          return ok(Array.from(embedding.vector));
        } catch (e: unknown) {
          return err(e instanceof Error ? e : new Error(String(e)));
        }
      },

      async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
        const results = await Promise.all(
          texts.map(async (text) => {
            try {
              const embedding = await context.getEmbeddingFor(text);
              return Array.from(embedding.vector);
            } catch {
              return null;
            }
          }),
        );
        return ok(results as number[][]);
      },

      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        // Free innermost resource first: context -> model -> llama
        await context.dispose();
        await model.dispose();
        await llama.dispose();
      },
    };

    return ok(port);
  } catch (e: unknown) {
    return err(
      e instanceof Error
        ? e
        : new Error(`Failed to create local embedding provider: ${String(e)}`),
    );
  }
}
