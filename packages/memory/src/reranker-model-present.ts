// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";

/**
 * Probe whether the reranker GGUF is ALREADY present locally WITHOUT downloading
 * (Phase 92, RERANK-01/RERANK-02). Resolves an hf: URI to its canonical on-disk
 * path with downloads disabled, then existsSync. The model path is internal,
 * config-derived, and root-confined by safePath at the caller — not attacker input;
 * any resolution failure (incl. a partial/corrupt file that resolveModelFile rejects)
 * degrades to `false` (stay OFF) rather than throwing into daemon startup.
 */
export async function rerankerModelPresent(opts: { modelUri: string; modelsDir: string }): Promise<boolean> {
  try {
    if (!opts.modelUri.startsWith("hf:")) return existsSync(opts.modelUri);
    const llamaCpp = await import("node-llama-cpp");
    const path = await llamaCpp.resolveModelFile(opts.modelUri, { directory: opts.modelsDir, download: false });
    return existsSync(path);
  } catch {
    return false;
  }
}
