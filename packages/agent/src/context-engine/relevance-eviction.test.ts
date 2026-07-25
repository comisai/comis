// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the cache-stable relevance eviction of the evictable middle band.
 *
 * `rankMiddleBandByRelevance` is the relevance-ranked replacement for the pure-recency
 * `evictHistoryUnderBudget(middleBand, pool)` at the `margin-arbiter.ts:296` seam. It
 * scores ONLY the unpinned evictable middle band (FTS-the-band via the injected
 * `deps.contextStore.searchLcd` + the injected `deps.relevanceScorer`), keeps the top set
 * under the pool, and RESTORES chronological order before assembly. It re-ranks freely when
 * `supportsPromptCache === false`; on a caching profile it stays recency-ordered (the cached
 * prefix is byte-stable — no reorder above the cache fence).
 *
 * Invariants pinned here:
 *  - cache stable: a CACHING profile reaching the pass does NOT reorder (== recency).
 *  - non-caching re-rank (LOAD-BEARING): a more-relevant OLDER message is
 *    KEPT while a less-relevant NEWER one is DROPPED — the SELECTION differs from recency
 *    (assert membership, NOT a numeric score).
 *  - chronological order restored: relevance drives SELECTION only; output order is input order.
 *  - pinned survival: a security-marked item in the band is never dropped by the pass.
 *  - step atomic: a tool_use/tool_result pair is kept-or-dropped together.
 *  - degrade floor: no scorer / no store / empty band / degraded query → identical to
 *    evictHistoryUnderBudget; never throws.
 *  - id-based match: the pass associates a band message
 *    with its FTS hit by the STABLE `refId` (= lcd_messages.id) the hit carries, NOT by a
 *    snippet substring. The id-match fixtures use a stored snippet that DIFFERS from the live
 *    block-text render (a pure tool_use/tool_result message + a non-FTS5 LIKE metadata-JSON
 *    snippet) — the exact cases a `snippet.includes(renderMessageText(msg))` match silently
 *    drops to the recency tail. They assert MEMBERSHIP (tool messages participate).
 *    The `fakeStoreRanking` snippet==render fixtures are retained ONLY for the
 *    cache-stable/chronological/pinned/degrade invariants, which are render-agnostic.
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

/** A pure tool_use message: an assistant turn whose content is a single tool_use block (NO
 *  text block), so {@link renderMessageText} (block .text join) renders to "" — the
 *  divergence under test: its stored FTS snippet (renderMessageFtsText = toolName + JSON(args)) can never
 *  contain that empty render, so the snippet-substring match silently drops it. `marker` is a
 *  test-only identifier carried on the block so keptTexts can name the kept message. */
function toolUseMsg(marker: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: marker, name: marker, input: { marker } }],
  } as unknown as AgentMessage;
}

/** A pure tool_result message (NO text block) — same divergence as {@link toolUseMsg}. */
function toolResultMsg(marker: string): AgentMessage {
  return {
    role: "toolResult",
    content: [{ type: "tool_result", tool_use_id: marker, content: { marker } }],
  } as unknown as AgentMessage;
}

/** A history BudgetItem: a message + its supplied token count. Optional `lcdId` carries the
 *  store id the assembler threads so the relevance pass can match a hit by `refId`
 *  rather than snippet substring. */
function item(text: string, tokens: number, role: "user" | "assistant" = "user", lcdId?: string): BudgetItem {
  return { msg: msg(text, role), tokens, lcdId };
}

/** A `toolResult`-role BudgetItem: the inseparable result tail of an assistant `tool_use`.
 *  The step grouper binds a trailing toolResult to the preceding non-toolResult message. */
function toolResultItem(text: string, tokens: number, lcdId?: string): BudgetItem {
  return { msg: msg(text, "toolResult"), tokens, lcdId };
}

/** A BudgetItem wrapping an arbitrary message + its store id (id-based match). */
function itemWithId(message: AgentMessage, tokens: number, lcdId: string): BudgetItem {
  return { msg: message, tokens, lcdId };
}

/** Read a tool message's test marker (the `name` of the tool_use block / the toolResult id). */
function markerOf(m: AgentMessage): string | undefined {
  const content = (m as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content[0] as { name?: string; tool_use_id?: string } | undefined;
  return block?.name ?? block?.tool_use_id;
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
    lane: "word",
    matchErrored: false,
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
  return { searchLcd: () => ({ hits: [], cjkZeroHit: false, lane: "word", matchErrored: false }) } as unknown as ContextStorePort;
}

/**
 * A fake ContextStorePort whose hits are matched by the STABLE `refId`
 * (= lcd_messages.id), with a `snippet` that DELIBERATELY DIFFERS from the live block-text
 * render. This reproduces production: the FTS path stores `renderMessageFtsText` (text +
 * toolName + JSON(toolInput/toolOutput), lcd-fts.ts:61) which is NOT a substring of the live
 * `renderMessageText` for a pure tool_use/tool_result message (no text block → live render is
 * ""). A snippet-substring match therefore returns the unmatched sentinel for these and
 * sorts them to the recency tail; the correct id-based match associates the hit by `refId`.
 *
 * @param rankedIds - the band item lcd ids in DESCENDING relevance (most relevant first).
 */
function fakeStoreRankingByIdFts(rankedIds: string[]): ContextStorePort {
  const searchLcd = (): LcdSearchResult => ({
    hits: rankedIds.map((id, i) => ({
      kind: "message" as const,
      refId: id,
      // The stored FTS snippet is NOT the live block-text render — for a tool message it is
      // the renderMessageFtsText JSON envelope, which the live `""` render can never match.
      snippet: `FTS_RENDER(${id}) name=tool args={"k":"v"} <<< diverges from live block text`,
      rank: -1 - i, // BM25 ranks negative; best (most relevant) closest to 0
    })),
    cjkZeroHit: false,
    lane: "word",
    matchErrored: false,
  });
  return new Proxy({ searchLcd } as unknown as ContextStorePort, {
    get(target, prop) {
      if (prop === "searchLcd") return (target as { searchLcd: typeof searchLcd }).searchLcd;
      throw new Error(`relevance-eviction must not call ContextStorePort.${String(prop)}`);
    },
  });
}

/**
 * The NON-FTS5-host LIKE fallback: `searchLcd` returns each message hit with a
 * `snippet` of the matched part's `metadata` JSON envelope (lcd-fts.ts:356), NOT rendered text,
 * AND `rank: undefined` (the LIKE path has no BM25 ranking). Under a snippet-substring
 * match this metadata JSON contains the live render of essentially nothing, so the ENTIRE pass
 * degrades to recency. The id-based match keys on `refId`, so the LIKE fallback still ranks.
 *
 * @param rankedIds - the band item lcd ids in scan order (LIKE returns no ranking; the order is
 *                    the SELECT order, which the id-based match uses as the relevance ordinal).
 */
function fakeStoreRankingByIdLike(rankedIds: string[]): ContextStorePort {
  const searchLcd = (): LcdSearchResult => ({
    hits: rankedIds.map((id, i) => ({
      kind: "message" as const,
      refId: id,
      // Metadata-JSON envelope that does NOT contain the message's live render — keyed only by
      // an OPAQUE ordinal so the snippet-substring fallback can never accidentally hit it.
      snippet: `{"raw":{"kind":"text"},"part":"opaque-metadata-blob-#${i}"}`,
      rank: undefined, // LIKE fallback: no BM25 rank
    })),
    cjkZeroHit: false,
    lane: "scan",
    matchErrored: false,
  });
  return new Proxy({ searchLcd } as unknown as ContextStorePort, {
    get(target, prop) {
      if (prop === "searchLcd") return (target as { searchLcd: typeof searchLcd }).searchLcd;
      throw new Error(`relevance-eviction must not call ContextStorePort.${String(prop)}`);
    },
  });
}

const cachingProfile: ModelProfile = { ...FAIL_CLOSED_PROFILE, supportsPromptCache: true };
const nonCachingProfile: ModelProfile = { ...FAIL_CLOSED_PROFILE, supportsPromptCache: false };

/** A non-degraded relevance query (≥2 terms so the scorer runs the RRF/fusion path). */
const HEALTHY_QUERY: ArbiterRelevanceQuery = { terms: ["deploy", "trading", "bot"], degraded: false };
const DEGRADED_QUERY: ArbiterRelevanceQuery = { terms: [], degraded: true };

/** Build the deps the pass reads (scorer + store + read-scope fields + the cache gate). */
function makeDeps(overrides: Partial<ContextEngineDeps> = {}): ContextEngineDeps {
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ContextEngineDeps["logger"],
    getModel: () => ({ reasoning: false, contextWindow: 8192, maxTokens: 2048 }),
    relevanceScorer: scoreRelevance,
    contextStore: fakeStoreRanking([]),
    modelProfile: nonCachingProfile,
    conversationRef: `cv_${"a".repeat(43)}`,
    agentId: "agent-a",
    tenantId: "tenant-a",
    sessionKey: "conv-a",
    ...overrides,
  };
}

const LIVE: AgentMessage[] = [msg("deploy the trading bot now")];

describe("rankMiddleBandByRelevance — cache-stable relevance eviction", () => {
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
    // LOAD-BEARING: assert SELECTION differs from recency, not a score.
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
    // The middle band already excludes security pins by construction at margin-arbiter.ts:235.
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

  // -------------------------------------------------------------------------
  // Id-based match: the relevance pass associates a band
  // message with its FTS hit by the STABLE refId (= lcd_messages.id) the hit carries,
  // NOT by snippet substring. The fixtures below use a stored snippet that DIFFERS from
  // the live block-text render (a pure tool_use/tool_result message + a LIKE-fallback
  // metadata-JSON snippet) — the EXACT cases a snippet-substring match silently
  // drops to the recency tail (a tool message's live render is "" / a JSON shape that is
  // not a substring of the snippet → unmatched sentinel → recency). The assertion is
  // MEMBERSHIP (the tool message participates), not a numeric score.
  // -------------------------------------------------------------------------

  it("a pure tool_use message participates in relevance selection via refId (snippet ≠ live render)", () => {
    // Band: [tool_use("call0"), text "new1", text "new2"], 40 tokens each; pool fits 1 (40).
    // The OLDEST is a PURE tool_use message (renderMessageText → "") that the FTS hit ranks
    // MOST relevant by its lcd id. A snippet-substring match would drop it (empty render is
    // never a substring of the FTS snippet) and keep the newest text message by recency.
    const band: BudgetItem[] = [
      itemWithId(toolUseMsg("call0"), 40, "id-call0"),
      item("new1", 40, "user", "id-new1"),
      item("new2", 40, "user", "id-new2"),
    ];
    const pool = 40;
    const deps = makeDeps({
      modelProfile: nonCachingProfile,
      // Rank the tool_use's lcd id MOST relevant; the two text messages least relevant.
      contextStore: fakeStoreRankingByIdFts(["id-call0", "id-new1", "id-new2"]),
    });

    const kept = rankMiddleBandByRelevance(deps, band, pool, LIVE, HEALTHY_QUERY);
    const keptMarkers = kept.map((m) => markerOf(m) ?? textOf(m));

    // The PURE tool_use message is the most-relevant by FTS rank → it MUST be kept even
    // though its live render is "". The id-based match guarantee: tool messages participate.
    expect(keptMarkers).toContain("call0");
    // And this DIFFERS from pure recency (which would have kept the NEWEST text message):
    expect(keptTexts(evictHistoryUnderBudget(band, pool))).toEqual(["new2"]);
    expect(keptMarkers).not.toContain("new2");
  });

  it("a tool_use/tool_result PAIR both participate via refId and stay step-atomic", () => {
    // Step 0: assistant tool_use("call0") + toolResult("res0") = one inseparable step (80).
    // Step 1: text "u1" (40). Pool = 80 fits the WHOLE pair OR u1. The FTS hit ranks the
    // tool_use's lcd id MOST relevant — a snippet-substring match would drop BOTH tool
    // messages (empty live render) and keep u1; the id-based match keeps the pair.
    const band: BudgetItem[] = [
      itemWithId(toolUseMsg("call0"), 40, "id-call0"),
      itemWithId(toolResultMsg("res0"), 40, "id-res0"),
      item("u1", 40, "user", "id-u1"),
    ];
    const pool = 80;
    const deps = makeDeps({
      modelProfile: nonCachingProfile,
      contextStore: fakeStoreRankingByIdFts(["id-call0", "id-res0", "id-u1"]),
    });

    const kept = rankMiddleBandByRelevance(deps, band, pool, LIVE, HEALTHY_QUERY);
    const markers = new Set(kept.map((m) => markerOf(m) ?? textOf(m)));

    // The most-relevant tool_use is kept AND its toolResult rides with it (step atomic) —
    // both tool messages participated in selection (under a snippet-substring match
    // neither would → u1 kept).
    expect(markers.has("call0")).toBe(true);
    expect(markers.has("res0")).toBe(true);
    expect(markers.has("u1")).toBe(false);
    // Never a lone toolResult at the head.
    if (kept.length > 0) {
      expect((kept[0] as unknown as { role: string }).role).not.toBe("toolResult");
    }
  });

  it("the non-FTS5 LIKE fallback (metadata-JSON snippet, no rank) still ranks by refId", () => {
    // On a SQLite build without FTS5, searchLcd returns p.metadata AS snippet (NOT rendered
    // text) and rank=undefined. Under a snippet-substring match the ENTIRE pass would degrade
    // to recency. The LIKE ranking is INTERLEAVED (oldest + newest most relevant, the two
    // middle items least relevant) so a correct id-based match yields a NON-CONTIGUOUS,
    // NON-CHRONOLOGICAL selection that NEITHER recency NOR the unmatched-everything
    // chronological fallback can reproduce — the spurious-pass guard.
    const band: BudgetItem[] = [
      item("old0", 40, "user", "id-old0"),
      item("mid1", 40, "user", "id-mid1"),
      item("mid2", 40, "user", "id-mid2"),
      item("new3", 40, "user", "id-new3"),
    ];
    const pool = 80;
    const deps = makeDeps({
      modelProfile: nonCachingProfile,
      // LIKE scan order ranks the OLDEST and the NEWEST most relevant; the two middle least.
      contextStore: fakeStoreRankingByIdLike(["id-old0", "id-new3", "id-mid1", "id-mid2"]),
    });

    const kept = rankMiddleBandByRelevance(deps, band, pool, LIVE, HEALTHY_QUERY);
    const keptSet = new Set(keptTexts(kept));

    // SELECTION by id-rank despite the metadata-JSON snippet: the OLDEST + the NEWEST are
    // kept, the two middle dropped. This is impossible under recency (newest-contiguous →
    // [mid2,new3]) AND under an unmatched-everything chronological fallback
    // (oldest-contiguous → [old0,mid1]).
    expect(keptSet.has("old0")).toBe(true);
    expect(keptSet.has("new3")).toBe(true);
    expect(keptSet.has("mid1")).toBe(false);
    expect(keptSet.has("mid2")).toBe(false);
    expect(keptTexts(evictHistoryUnderBudget(band, pool))).toEqual(["mid2", "new3"]);
  });
});
