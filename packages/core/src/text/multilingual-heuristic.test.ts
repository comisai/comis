// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  EMBED_MULTILINGUAL,
  RERANK_MULTILINGUAL,
  resolveMultilingual,
} from "./multilingual-heuristic.js";

// ---------------------------------------------------------------------------
// resolveMultilingual: the pure advisory name heuristic.
//
// Classifies an embedder/reranker model id as `true | false | "unknown"` for the
// `comis fleet` model-health line. Pure (no I/O/clock/env). Advisory ONLY —
// NO search/recall behavior gates on the result (the FTS trigram floor
// carries recall regardless).
//
// Truth-table semantics:
//   - explicit declared boolean WINS over the regex (both directions)
//   - regex hit on the id        -> true
//   - no declaration, no hit     -> "unknown" (honest; `false` reserved for an
//                                    explicit `multilingual: false` declaration)
//
// The embedder-regex trap: a literal like
// `/multilingual|bge-m3|m3e|labse|e5/i` FALSE-NEGATIVES the shipped default
// reranker `bge-reranker-v2-m3` (it contains `bge-reranker-v2-m3`, NOT `bge-m3`).
// RERANK_MULTILINGUAL must match that shipped default -> true.
// ---------------------------------------------------------------------------

const DEFAULT_RERANKER = "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf";
const DEFAULT_EMBEDDER = "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.Q8_0.gguf";

describe("resolveMultilingual (multilingual name heuristic)", () => {
  it("classifies the SHIPPED default reranker bge-reranker-v2-m3 as multilingual=true (a bare /bge-m3/ literal would miss it)", () => {
    expect(resolveMultilingual(undefined, DEFAULT_RERANKER, RERANK_MULTILINGUAL)).toBe(true);
  });

  it("classifies the default embedder nomic-embed-text-v1.5 as \"unknown\" when undeclared (English-leaning, no heuristic hit)", () => {
    expect(resolveMultilingual(undefined, DEFAULT_EMBEDDER, EMBED_MULTILINGUAL)).toBe("unknown");
  });

  it("classifies a bge-m3 embedder id as multilingual=true", () => {
    expect(resolveMultilingual(undefined, "bge-m3", EMBED_MULTILINGUAL)).toBe(true);
  });

  it("classifies a multilingual-e5-large embedder id as multilingual=true", () => {
    expect(resolveMultilingual(undefined, "multilingual-e5-large", EMBED_MULTILINGUAL)).toBe(true);
  });

  it("classifies the English-only intfloat/e5-large-v2 as \"unknown\" — the bare-`e5` substring must NOT fire (a false positive SUPPRESSES the embedder_not_multilingual advisory, the harmful direction)", () => {
    expect(resolveMultilingual(undefined, "intfloat/e5-large-v2", EMBED_MULTILINGUAL)).toBe("unknown");
  });

  it("classifies the multilingual-E5 family intfloat/multilingual-e5-large as multilingual=true (the genuine multilingual family must STAY true via the `multilingual` token)", () => {
    expect(resolveMultilingual(undefined, "intfloat/multilingual-e5-large", EMBED_MULTILINGUAL)).toBe(true);
  });

  it("does not let an incidental `e5` substring (type5 / base5) false-positive an English embedder", () => {
    expect(resolveMultilingual(undefined, "some-model-type5-v2", EMBED_MULTILINGUAL)).toBe("unknown");
    expect(resolveMultilingual(undefined, "model-base5-embed", EMBED_MULTILINGUAL)).toBe("unknown");
  });

  it("classifies a LaBSE embedder id as multilingual=true (case-insensitive)", () => {
    expect(resolveMultilingual(undefined, "LaBSE", EMBED_MULTILINGUAL)).toBe(true);
  });

  it("classifies the OpenAI text-embedding-3-small id as \"unknown\" when undeclared", () => {
    expect(resolveMultilingual(undefined, "text-embedding-3-small", EMBED_MULTILINGUAL)).toBe("unknown");
  });

  it("lets an explicit declared=true WIN over an English-leaning id (override up)", () => {
    expect(resolveMultilingual(true, "nomic-embed-text", EMBED_MULTILINGUAL)).toBe(true);
  });

  it("lets an explicit declared=false WIN over a heuristic-positive id (override down)", () => {
    expect(resolveMultilingual(false, "bge-m3", EMBED_MULTILINGUAL)).toBe(false);
  });
});

describe("RERANK_MULTILINGUAL / EMBED_MULTILINGUAL regexes", () => {
  it("RERANK_MULTILINGUAL matches the bge-reranker-v2-m3 slug the EMBED regex misses", () => {
    expect(RERANK_MULTILINGUAL.test(DEFAULT_RERANKER)).toBe(true);
    // The embedder regex FALSE-NEGATIVES this slug — that gap is exactly why the
    // reranker-specific pattern exists.
    expect(EMBED_MULTILINGUAL.test(DEFAULT_RERANKER)).toBe(false);
  });

  it("EMBED_MULTILINGUAL does not match the English-leaning nomic default", () => {
    expect(EMBED_MULTILINGUAL.test(DEFAULT_EMBEDDER)).toBe(false);
  });
});
