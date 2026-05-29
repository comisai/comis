// SPDX-License-Identifier: Apache-2.0
/**
 * Local cross-encoder reranker provider using node-llama-cpp for GGUF model
 * inference.
 *
 * This is the SOLE RerankerPort implementation and the ONLY site in the
 * codebase that touches node-llama-cpp's ranking API. It mirrors
 * embedding-provider-local.ts exactly, swapping createEmbeddingContext for
 * createRankingContext and exposing rankAll as RerankerPort.rank.
 *
 * Uses dynamic import() so the module gracefully degrades if node-llama-cpp
 * native binaries are unavailable. A failed load (absent binary or invalid
 * model path) returns err() rather than throwing, so the recall orchestrator
 * (Plan 04) can fall back to fusion-ranked order (RANK-03). Reranking is
 * opt-in / default-OFF per the Phase-79 latency decision.
 *
 * Zero new runtime dependencies (RANK-02): node-llama-cpp@3.18.1 is already
 * pinned in packages/memory/package.json (the embedding runtime).
 */

import type { RerankerPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

/**
 * Options for creating a local reranker provider.
 */
export interface LocalRerankerProviderOptions {
  /** HuggingFace model URI (hf:...) or path to a local GGUF file. */
  modelUri: string;
  /** Directory to store/resolve downloaded models. */
  modelsDir: string;
  /**
   * GPU acceleration mode (threaded through by the composition root). Mirrors
   * the MemoryConfig.rerankerGpu enum; "false" forces CPU, the rest are
   * node-llama-cpp backend selectors passed through to getLlama.
   */
  gpu?: "auto" | "metal" | "cuda" | "vulkan" | "false";
  /** Thread count for the ranking context. Bounds CPU contention (Phase-79: 4-8). */
  threads?: number;
}

/**
 * Create a local reranker provider backed by node-llama-cpp.
 *
 * Loads a GGUF cross-encoder model and creates a single ranking context that
 * is reused across all rank() calls (the cold load is a one-time daemon-startup
 * cost, NOT per-turn). If the model URI is an `hf:` URI, `resolveModelFile()`
 * auto-downloads from HuggingFace. All operations are wrapped in Result (no
 * thrown exceptions).
 *
 * @param options - Local model configuration
 * @returns A RerankerPort backed by node-llama-cpp, or an error
 */
export async function createLocalRerankerProvider(
  options: LocalRerankerProviderOptions,
): Promise<Result<RerankerPort, Error>> {
  try {
    // Dynamic import for graceful degradation when native binaries unavailable
    const llamaCpp = await import("node-llama-cpp");

    // Map the MemoryConfig.rerankerGpu enum onto the node-llama-cpp getLlama
    // GPU option. "false" forces CPU (boolean false); any other backend string
    // ("auto"/"metal"/"cuda"/"vulkan") is passed through verbatim. When gpu is
    // unset, pass no option so node-llama-cpp keeps its own auto-detect default.
    const llama = await llamaCpp.getLlama(
      options.gpu ? { gpu: options.gpu === "false" ? false : options.gpu } : {},
    );

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
    // SINGLETON ranking context — created once and reused across every rank()
    // call. Per-call context creation would dominate latency (Phase-79
    // cold-load ~433 ms is one-time).
    const context = await model.createRankingContext({
      threads: options.threads,
    });

    // Guard against double-dispose
    let disposed = false;

    const port: RerankerPort = {
      isAvailable: () => true,

      async rank(
        query: string,
        documents: string[],
      ): Promise<Result<number[], Error>> {
        try {
          // rankAll returns calibrated [0,1] probabilities in INPUT ORDER
          // (documents[i] -> scores[i]). No sigmoid post-processing needed.
          const scores = await context.rankAll(query, documents);
          return ok(scores);
        } catch (e: unknown) {
          return err(e instanceof Error ? e : new Error(String(e)));
        }
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
        : new Error(`Failed to create local reranker provider: ${String(e)}`),
    );
  }
}
