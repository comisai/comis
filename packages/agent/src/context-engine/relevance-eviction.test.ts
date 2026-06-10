// SPDX-License-Identifier: Apache-2.0
/**
 * DEPTH-01 — cache-stable relevance eviction of the evictable middle band.
 *
 * RED-first (CLAUDE.md Tests-First): relevance-eviction.ts does not exist yet — every
 * test fails with "Cannot find module './relevance-eviction.js'" until the GREEN patch
 * creates it. This failing state is committed intentionally.
 *
 * `rankMiddleBandByRelevance` is the relevance-ranked replacement for the pure-recency
 * `evictHistoryUnderBudget(middleBand, pool)` at the `margin-arbiter.ts:296` seam. It
 * scores ONLY the unpinned evictable middle band (FTS-the-band via the injected
 * `deps.contextStore.searchLcd` + the injected `deps.relevanceScorer`), keeps the top set
 * under the pool, and RESTORES chronological order before assembly. It re-ranks freely when
 * `supportsPromptCache === false`; on a caching profile it stays recency-ordered (the cached
 * prefix is byte-stable — no reorder above the cache fence).
 *
 * Invariants pinned here (the DEPTH-01 success-criteria contract):
 *  - cache stable: a CACHING profile reaching the pass does NOT reorder (== recency).
 *  - non-caching re-rank (LOAD-BEARING, guards CR-01): a more-relevant OLDER message is
 *    KEPT while a less-relevant NEWER one is DROPPED — the SELECTION differs from recency
 *    (assert membership, NOT a numeric score). FAILS on pre-patch recency behavior.
 *  - chronological order restored: relevance drives SELECTION only; output order is input order.
 *  - pinned survival: a security-marked item in the band is never dropped by the pass.
 *  - step atomic: a tool_use/tool_result pair is kept-or-dropped together.
 *  - degrade floor: no scorer / no store / empty band / degraded query → identical to
 *    evictHistoryUnderBudget; never throws.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextStorePort, LcdSearchResult } from "@comis/core";
import { rankMiddleBandByRelevance } from "./relevance-eviction.js";
import { evictHistoryUnderBudget, type BudgetItem } from "./lcd-budget-eviction.js";
import type { ArbiterRelevanceQuery } from "./margin-arbiter.js";
import { scoreRelevance } from "../rag/relevance-scorer.js";
import type { ContextEngineDeps } from "./types.js";
import type { ModelProfile } from "../executor/model-profile.js";
import { FAIL_CLOSED_PROFILE } from "../executor/model-profile.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal AgentMessage/BudgetItem + a fake ContextStorePort.searchLcd
// ---------------------------------------------------------------------------

/** A minimal message carrying an identifying text (used for ordering + match assertions). */
function msg(text: string, role: "user" | "assistant" | "toolResult" = "user"): AgentMessage {
  return { role, content: text } as unknown as AgentMessage;
}

/** A history BudgetItem: a message + its supplied token count. */
function item(text: string, tokens: number, role: "user" | "assistant" = "user"): BudgetItem {
  return { msg: msg(text, role), tokens };
}

/** A `toolResult`-role BudgetItem: the inseparable result tail of an assistant `tool_use`.
 *  The step grouper binds a trailing toolResult to the preceding non-toolResult message. */
function toolResultItem(text: string, tokens: number): BudgetItem {
  return { msg: msg(text, "toolResult"), tokens };
}

/** Read a message's identifying text back (the builder stores it on `content`). */
function textOf(m: AgentMessage): string {
  return (m as unknown as { content: string }).content;
}

/** The texts of the kept messages, in returned order. */
function keptTexts(kept: AgentMessage[]): string[] {
  return kept.map(textOf);
}

/**
 * A fake ContextStorePort exposing ONLY searchLcd (the methods the SUT calls). The hits are
 * returned in a controlled RELEVANCE order: each hit's `snippet` carries the band item's
 * text so the SUT can associate a band message with its rank position (best-first). All
 * other port methods throw if touched (the pass must read nothing else).
 *
 * @param rankedTexts - the band item texts in DESCENDING relevance (most relevant first).
 *                      The fake assigns BM25-style negative ranks (lower = better).
 */
function fakeStoreRanking(rankedTexts: string[]): ContextStorePort {
  const searchLcd = (): LcdSearchResult => ({
    hits: rankedTexts.map((t, i) => ({
      kind: "message" as const,
      refId: `id-${i}`,
      snippet: t, // FTS path: snippet === the message's rendered text (lcd-fts.ts content AS snippet)
      rank: -1 - i, // BM25 ranks are negative; best (most relevant) is the largest (closest to 0)
    })),
    cjkZeroHit: false,
  });
  return new Proxy(
    { searchLcd } as unknown as ContextStorePort,
    {
      get(target, prop) {
        if (prop === "searchLcd") return (target as { searchLcd: typeof searchLcd }).searchLcd;
        throw new Error(`relevance-eviction must not call ContextStorePort.${String(prop)}`);
      },
    },
  );
}

/** A store whose searchLcd returns ZERO hits (degrade-to-recency floor). */
function fakeStoreEmpty(): ContextStorePort {
  return { searchLcd: () => ({ hits: [], cjkZeroHit: false }) } as unknown as ContextStorePort;
}

const cachingProfile: ModelProfile = { ...FAIL_CLOSED_PROFILE, supportsPromptCache: true };
const nonCachingProfile: ModelProfile = { ...FAIL_CLOSED_PROFILE, supportsPromptCache: false };

/** A non-degraded relevance query (≥2 terms so the scorer runs the RRF/fusion path). */
const HEALTHY_QUERY: ArbiterRelevanceQuery = { terms: ["deploy", "trading", "bot"], degraded: false };
const DEGRADED_QUERY: ArbiterRelevanceQuery = { terms: [], degraded: true };

/** Build the deps the pass reads (scorer + store + R4 scope fields + the cache gate). */
function makeDeps(overrides: Partial<ContextEngineDeps> = {}): ContextEngineDeps {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ContextEngineDeps["logger"],
    getModel: () => ({ reasoning: false, contextWindow: 8192, maxTokens: 2048 }),
    relevanceScorer: scoreRelevance,
    contextStore: fakeStoreRanking([]),
    modelProfile: nonCachingProfile,
    conversationId: "conv-a",
    agentId: "agent-a",
    tenantId: "tenant-a",
    sessionKey: "conv-a",
    ...overrides,
  };
}

const LIVE: AgentMessage[] = [msg("deploy the trading bot now")];

describe("rankMiddleBandByRelevance — DEPTH-01 cache-stable relevance eviction", () => {
  it("cache stable: a caching profile reaching the pass does NOT reorder (kept set == recency)", () => {
    // Band of 4 single-message steps, 40 tokens each; pool fits only 2 (80 tokens).
    const band: BudgetItem[] = [item("old0", 40), item("old1", 40), item("new2", 40), item("new3", 40)];
    const pool = 80;
    // searchLcd would rank the OLDEST as most relevant — but a caching profile must IGNORE it.
    const deps = makeDeps({
      modelProfile: cachingProfile,
      contextStore: fakeStoreRanking(["old0", "old1", "new2", "new3"]),
    });

    const kept = rankMiddleBandByRelevance(deps, band, pool, LIVE, HEALTHY_QUERY);

    // Cache-stability guarantee: identical to the pure-recency newest-whole-steps fill —
    // the cached prefix is byte-stable (NO relevance reorder above the fence).
    expect(keptTexts(kept)).toEqual(keptTexts(evictHistoryUnderBudget(band, pool)));
    expect(keptTexts(kept)).toEqual(["new2", "new3"]); // recency kept the two NEWEST
  });

  it("non-caching re-rank: a more-relevant OLDER message is KEPT and a less-relevant NEWER one DROPPED", () => {
    // LOAD-BEARING (guards CR-01): assert SELECTION differs from recency, not a score.
    // Band of 4 single-message steps, 40 tokens each; pool fits exactly 2 (80 tokens).
    const band: BudgetItem[] = [item("old0", 40), item("old1", 40), item("new2", 40), item("new3", 40)];
    const pool = 80;
    // searchLcd ranks the two OLDEST as MOST relevant; the two NEWEST as least relevant.
    const deps = makeDeps({
      modelProfile: nonCachingProfile,
      contextStore: fakeStoreRanking(["old0", "old1", "new2", "new3"]),
    });

    const kept = rankMiddleBandByRelevance(deps, band, pool, LIVE, HEALTHY_QUERY);
    const keptSet = new Set(keptTexts(kept));

    // SELECTION (membership) — the relevance-first selection, NOT recency:
    expect(keptSet.has("old0")).toBe(true); // older + more relevant → KEPT
    expect(keptSet.has("old1")).toBe(true); // older + more relevant → KEPT
    expect(keptSet.has("new3")).toBe(false); // newer + less relevant → DROPPED
    expect(keptSet.has("new2")).toBe(false); // newer + less relevant → DROPPED
    // And this DIFFERS from pure recency (which would have kept the two NEWEST):
    expect(keptTexts(kept)).not.toEqual(keptTexts(evictHistoryUnderBudget(band, pool)));
    expect(keptTexts(evictHistoryUnderBudget(band, pool))).toEqual(["new2", "new3"]);
  });

  it("chronological order restored: relevance drives SELECTION only; the output is in input order", () => {
    // Band of 4; pool fits 2. searchLcd ranks index 2 (newer) above index 0 (older), but BOTH
    // are selected — assert the returned array is in ASCENDING input order regardless of rank.
    const band: BudgetItem[] = [item("a0", 40), item("a1", 40), item("a2", 40), item("a3", 40)];
    const pool = 80;
    // Relevance order: a2 (idx 2) first, then a0 (idx 0) — selection picks {a2, a0} out of order.
    const deps = makeDeps({
      modelProfile: nonCachingProfile,
      contextStore: fakeStoreRanking(["a2", "a0", "a1", "a3"]),
    });

    const kept = rankMiddleBandByRelevance(deps, band, pool, LIVE, HEALTHY_QUERY);

    // Selection was {a0, a2}; output MUST be chronological (a0 before a2), not relevance order.
    expect(keptTexts(kept)).toEqual(["a0", "a2"]);
    // Indices monotonically increasing in the original band order:
    const idxOf = (t: string): number => band.findIndex((b) => textOf(b.msg) === t);
    const indices = keptTexts(kept).map(idxOf);
    expect(indices).toEqual([...indices].sort((x, y) => x - y));
  });

  it("pinned survival: a security-marked message in the band is never dropped by the pass", () => {
    // The middle band already excludes S4 pins by construction at margin-arbiter.ts:235.
    // Defense-in-depth: even if a security-marked message reaches the pass, it is kept.
    // Band of 3 single steps; pool fits 1 (40 tokens). The OLDEST is the security-marked one,
    // and searchLcd ranks it LEAST relevant — recency AND relevance would both drop it, but
    // the pass must protect it.
    const band: BudgetItem[] = [item("PINNED-secret", 40), item("mid1", 40), item("new2", 40)];
    const pool = 40;
    const deps = makeDeps({
      modelProfile: nonCachingProfile,
      contextStore: fakeStoreRanking(["new2", "mid1", "PINNED-secret"]),
      securityPinMarkers: {
        canaryToken: "PINNED-secret",
        contentDelimiter: "",
      } as unknown as ContextEngineDeps["securityPinMarkers"],
    });

    const kept = rankMiddleBandByRelevance(deps, band, pool, LIVE, HEALTHY_QUERY);

    // The pinned item survives — it is NEVER dropped by the relevance pass.
    expect(keptTexts(kept)).toContain("PINNED-secret");
  });

  it("step atomic: a tool_use/tool_result pair is kept-or-dropped together (never split)", () => {
    // Step 0: assistant tool_use "call0" (40) + toolResult "res0" (40) = one inseparable step (80).
    // Step 1: user "u1" (40). Pool = 80: fits the WHOLE pair OR u1 — never half the pair.
    const band: BudgetItem[] = [
      item("call0", 40, "assistant"),
      toolResultItem("res0", 40),
      item("u1", 40),
    ];
    const pool = 80;
    // searchLcd ranks res0 most relevant, then u1, then call0 — a naive per-item fill would
    // try to keep res0 alone (orphan toolResult). The pass must keep the pair atomic.
    const deps = makeDeps({
      modelProfile: nonCachingProfile,
      contextStore: fakeStoreRanking(["res0", "u1", "call0"]),
    });

    const kept = rankMiddleBandByRelevance(deps, band, pool, LIVE, HEALTHY_QUERY);
    const set = new Set(keptTexts(kept));

    // Either BOTH halves of the pair are kept, or NEITHER — never a lone toolResult.
    expect(set.has("call0")).toBe(set.has("res0"));
    // The output never STARTS with an orphan toolResult.
    if (kept.length > 0) {
      expect((kept[0] as unknown as { role: string }).role).not.toBe("toolResult");
    }
  });

  it("degrade floor: no scorer / no store / empty band / degraded query → identical to recency, never throws", () => {
    const band: BudgetItem[] = [item("h0", 40), item("h1", 40), item("h2", 40)];
    const pool = 80;
    const recency = keptTexts(evictHistoryUnderBudget(band, pool));

    // (a) no scorer dep → recency floor.
    expect(
      keptTexts(rankMiddleBandByRelevance(makeDeps({ relevanceScorer: undefined }), band, pool, LIVE, HEALTHY_QUERY)),
    ).toEqual(recency);
    // (b) no store dep → recency floor.
    expect(
      keptTexts(rankMiddleBandByRelevance(makeDeps({ contextStore: undefined }), band, pool, LIVE, HEALTHY_QUERY)),
    ).toEqual(recency);
    // (c) searchLcd returns 0 hits → recency floor.
    expect(
      keptTexts(
        rankMiddleBandByRelevance(makeDeps({ contextStore: fakeStoreEmpty() }), band, pool, LIVE, HEALTHY_QUERY),
      ),
    ).toEqual(recency);
    // (d) degraded query → recency floor.
    expect(
      keptTexts(rankMiddleBandByRelevance(makeDeps(), band, pool, LIVE, DEGRADED_QUERY)),
    ).toEqual(recency);
    // (e) empty band → [] (never throws).
    expect(rankMiddleBandByRelevance(makeDeps(), [], pool, LIVE, HEALTHY_QUERY)).toEqual([]);
  });
});
