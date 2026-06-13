// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { AppConfigSchema } from "@comis/core";
import { resolveModelHealthMultilingual } from "./main-helpers.js";
import type { BootContext } from "../daemon-types.js";

// ---------------------------------------------------------------------------
// EMB-01 — resolveModelHealthMultilingual: the provider-aware boot-snapshot
// helper extracted from daemon.ts (keeps the composition root under its line cap).
//
// Resolves the two advisory multilingual booleans for the model_health row. The
// embedder id is PROVIDER-AWARE (Pitfall 3 — never the legacy memory field); the
// reranker default bge-reranker-v2-m3 must classify multilingual (Pitfall 2).
// Advisory only — nothing here gates recall (I4).
// ---------------------------------------------------------------------------

type Config = BootContext["container"]["config"];

/** A fully-defaulted config, then the embedding/memory blocks overridden. */
function configWith(overrides: {
  embedding?: Record<string, unknown>;
  memory?: Record<string, unknown>;
}): Config {
  const base = AppConfigSchema.parse({}) as unknown as Config;
  return {
    ...base,
    embedding: { ...base.embedding, ...overrides.embedding } as Config["embedding"],
    memory: { ...base.memory, ...overrides.memory } as Config["memory"],
  };
}

describe("resolveModelHealthMultilingual (EMB-01 provider-aware boot helper)", () => {
  it("classifies the DEFAULT install: nomic embedder -> \"unknown\", bge-reranker-v2-m3 reranker -> true (Pitfall 2)", () => {
    const result = resolveModelHealthMultilingual(AppConfigSchema.parse({}) as unknown as Config);
    expect(result.embeddingMultilingual).toBe("unknown"); // nomic-embed-text-v1.5, no hit
    expect(result.rerankerMultilingual).toBe(true); // the shipped multilingual reranker default
  });

  it("resolves the LOCAL embedder id from embedding.local.modelUri (provider auto/local — Pitfall 3)", () => {
    const result = resolveModelHealthMultilingual(
      configWith({ embedding: { provider: "local", local: { modelUri: "hf:org/bge-m3-GGUF:bge-m3.Q8_0.gguf" } } }),
    );
    expect(result.embeddingMultilingual).toBe(true); // bge-m3 hits the embedder regex
  });

  it("resolves the OPENAI embedder id from embedding.openai.model when provider === openai (Pitfall 3)", () => {
    const result = resolveModelHealthMultilingual(
      configWith({ embedding: { provider: "openai", openai: { model: "multilingual-e5-large" } } }),
    );
    expect(result.embeddingMultilingual).toBe(true); // reads openai.model, not local.modelUri
  });

  it("honors an explicit embedding.multilingual override (declared wins over the English-leaning default id)", () => {
    const result = resolveModelHealthMultilingual(configWith({ embedding: { multilingual: true } }));
    expect(result.embeddingMultilingual).toBe(true); // declared true over the nomic default
  });

  it("returns rerankerMultilingual \"unknown\" for a non-multilingual reranker id (no per-reranker config flag)", () => {
    const result = resolveModelHealthMultilingual(
      configWith({ memory: { rerankerModel: "hf:org/some-english-reranker.gguf" } }),
    );
    expect(result.rerankerMultilingual).toBe("unknown");
  });
});
