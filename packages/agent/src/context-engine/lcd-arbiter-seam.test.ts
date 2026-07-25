// SPDX-License-Identifier: Apache-2.0
/**
 * The assembly-path relevance query the arbiter seam builds
 * (`buildAssemblyRelevanceQuery`, via `ASSEMBLY_STOPWORDS`) must never let an FTS5 OPERATOR
 * keyword (`near` / `and` / `or` / `not`) survive as a bare term. The OR-join
 * (`relevance-eviction.ts:132`) splices the terms into a `lcd_messages_fts MATCH` query, so a
 * surviving operator keyword could subtly alter FTS5 parsing. This drives the PUBLIC
 * `evictUnderArbiter` seam (the only live caller of the private query builder) and asserts the
 * exact FTS query string the store receives carries no bare operator.
 *
 * Regression pinned: with `near` missing from the stoplist (`and`/`or`/`not` alone), a live
 * user turn "search near the deployment" yields a query whose terms include "near" → the
 * OR-join is "near OR deployment ..." — the assertion fails until `near` is stopped.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextStorePort, LcdSearchResult } from "@comis/core";
import { evictUnderArbiter } from "./lcd-arbiter-seam.js";
import { scoreRelevance } from "../rag/relevance-scorer.js";
import type { BudgetItem } from "./lcd-budget-eviction.js";
import type { ContextEngineDeps } from "./types.js";
import { FAIL_CLOSED_PROFILE } from "../executor/model-profile.js";

const FTS5_OPERATORS = ["near", "and", "or", "not"];

/** Capture the FTS query string passed to searchLcd (the OR-joined terms). */
function makeCapturingStore(captured: { ftsQuery?: string }): ContextStorePort {
  const searchLcd = (_scope: unknown, query: string): LcdSearchResult => {
    captured.ftsQuery = query;
    return { hits: [], cjkZeroHit: false, lane: "word", matchErrored: false }; // 0 hits → recency floor; we only need the query
  };
  return { searchLcd } as unknown as ContextStorePort;
}

function msg(text: string, role: "user" | "assistant" = "user"): AgentMessage {
  return { role, content: text } as unknown as AgentMessage;
}

function makeDeps(store: ContextStorePort): ContextEngineDeps {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ContextEngineDeps["logger"],
    getModel: () => ({ reasoning: false, contextWindow: 8192, maxTokens: 2048 }),
    relevanceScorer: scoreRelevance,
    contextStore: store,
    modelProfile: { ...FAIL_CLOSED_PROFILE, supportsPromptCache: false },
    relevanceFirst: true,
    conversationRef: `cv_${"a".repeat(43)}`,
    agentId: "agent-a",
    tenantId: "tenant-a",
    sessionKey: "conv-a",
  } as unknown as ContextEngineDeps;
}

describe("buildAssemblyRelevanceQuery — FTS5 operator stopwords", () => {
  it("never emits a bare FTS5 operator keyword (near/and/or/not) in the MATCH query", () => {
    const captured: { ftsQuery?: string } = {};
    const deps = makeDeps(makeCapturingStore(captured));
    // A live user turn deliberately seeded with every FTS5 operator keyword plus real terms.
    const live: AgentMessage[] = [msg("search near and or not the deployment config rollback")];
    const band: BudgetItem[] = [
      { msg: msg("history a"), tokens: 40 },
      { msg: msg("history b"), tokens: 40 },
    ];

    evictUnderArbiter(deps, band, 80, live, 1_700_000_000_000);

    // The query was built + the store was asked (≥2 content terms → not degraded).
    expect(captured.ftsQuery).toBeDefined();
    const terms = (captured.ftsQuery ?? "").split(" OR ").map((t) => t.trim().toLowerCase());
    for (const op of FTS5_OPERATORS) {
      expect(terms).not.toContain(op);
    }
    // Sanity: real content terms DID survive (the query is not empty/degraded).
    expect(terms).toContain("deployment");
    expect(terms.length).toBeGreaterThanOrEqual(2);
  });
});
