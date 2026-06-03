// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * RerankerPort: the hexagonal architecture boundary for on-device
 * cross-encoder reranking.
 *
 * A reranker scores how RELEVANT each candidate document is to the query
 * (a cross-encoder judgement), as opposed to mere vector similarity. The
 * sole adapter is the local node-llama-cpp GGUF provider in @comis/memory;
 * the agent-side recall orchestrator consumes this port type from
 * @comis/core (it cannot import @comis/memory).
 *
 * Reranking is opt-in (default-OFF per the latency decision): when
 * disabled or unavailable, recall keeps fusion-ranked order. This port never
 * mints trust — relevance scoring is orthogonal to the trust model.
 */
export interface RerankerPort {
  /**
   * Score each document's relevance to the query. Scores are in [0,1],
   * returned in INPUT ORDER (documents[i] -> scores[i]).
   */
  rank(query: string, documents: string[]): Promise<Result<number[], Error>>;

  /**
   * Whether the model loaded. false -> the recall orchestrator keeps
   * fusion order (graceful degradation).
   */
  isAvailable(): boolean;

  /**
   * Release native resources (ranking context -> model -> llama).
   * Optional -- only the local GGUF provider holds native handles.
   * Called during daemon graceful shutdown before process exit.
   */
  dispose?(): Promise<void>;
}
