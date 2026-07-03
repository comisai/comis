// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the bounded in-process multi-hop `ctx_expand` walk
 * (`ctxExpandWalk` + `depthForTier`).
 *
 * Pure-JS / macOS-green: a hand-built stub `ContextStorePort` exposing only the
 * methods the walk touches (`getSummaryChildren` / `getSummaryMessages` /
 * `getMessages`, multi-level returns keyed by summaryId), plus an OPTIONAL
 * `spreadLane` (T4). No real DB / FTS / filesystem. The walk is read-only, so
 * the stub records reads only — there is NO append/upsert surface to assert.
 *
 * Load-bearing behaviors covered:
 *   - T2 multi-hop descent recovers deep messages (more than a single-hop expansion)
 *   - depth cap bounds the walk (depthReached + capped)
 *   - node-visit cap bounds the walk (nodesVisited ≤ maxNodes)
 *   - token cap bounds the bundle (estimate ≤ maxTokens)
 *   - T2-only floor: NO spreadLane (or empty/err lane) ⇒ the walk SUCCEEDS T2-only
 *   - cycle / drift safe (visited-set; a missing id is counted, never thrown)
 *   - depthForTier(nano1/small2/mid3/frontier4)
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type {
  ContextStorePort,
  ContextStoreScope,
  LcdSummary,
  LcdMessage,
  LcdMessagePart,
  MemorySearchResult,
} from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";

import { ctxExpandWalk, depthForTier } from "./ctx-expand-walk.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const SCOPE: ContextStoreScope = {
  conversationId: "default:user_a:chan_a",
  agentId: "agent_a",
  tenantId: "default",
  sessionKey: "default:user_a:chan_a",
};

/** Build a text-only message part (the verbatim block carries the text). */
function textPart(text: string): LcdMessagePart {
  return { kind: "text", metadata: { raw: { type: "text", text }, rawType: "text" } };
}

/** Build a stub LcdMessage with one text part. */
function makeMessage(id: string, seq: number, text: string): LcdMessage {
  return {
    id,
    conversationId: SCOPE.conversationId,
    seq,
    role: "user",
    tokenCount: 4,
    createdAt: 1_000_000 + seq,
    parts: [textPart(text)],
  };
}

/** Build a stub LcdSummary with a given kind. */
function makeSummary(summaryId: string, kind: "leaf" | "condensed", depth: number): LcdSummary {
  return {
    summaryId,
    conversationId: SCOPE.conversationId,
    kind,
    depth,
    earliestAt: 1_000_001,
    latestAt: 1_000_009,
    descendantCount: 3,
    tokenCount: 42,
    content: `summary ${summaryId}`,
    fileIds: [],
    taint: false,
    fallback: false,
    createdAt: 1_000_010,
  };
}

interface StoreStub {
  /** parentSummaryId → child summaries (the lcd_summary_parents condensed→child edge). */
  children: Map<string, LcdSummary[]>;
  /** leaf summaryId → covered message ids (the lcd_summary_messages leaf→message edge). */
  summaryMessages: Map<string, string[]>;
  /** id → message row (the id-keyed re-join). */
  messages: Map<string, LcdMessage>;
  /** Records the FULL scope of every read for the R4 per-call-scope assertion. */
  readScopes: ContextStoreScope[];
  /** Records every conversationId passed to runOnConversation (single-flight proof). */
  serialized: string[];
  /** Records every (parentSummaryId | summaryId) the walk read, in order (traversal proof). */
  visitedIds: string[];
}

function makeStore(over: Partial<StoreStub> = {}): { stub: StoreStub; store: ContextStorePort } {
  const stub: StoreStub = {
    children: new Map(),
    summaryMessages: new Map(),
    messages: new Map(),
    readScopes: [],
    serialized: [],
    visitedIds: [],
    ...over,
  };
  const store = {
    getSummaryChildren(scope: ContextStoreScope, parentSummaryId: string): LcdSummary[] {
      stub.readScopes.push(scope);
      stub.visitedIds.push(parentSummaryId);
      return stub.children.get(parentSummaryId) ?? [];
    },
    getSummaryMessages(scope: ContextStoreScope, summaryId: string): string[] {
      stub.readScopes.push(scope);
      return stub.summaryMessages.get(summaryId) ?? [];
    },
    getMessages(scope: ContextStoreScope): LcdMessage[] {
      stub.readScopes.push(scope);
      return [...stub.messages.values()];
    },
    async runOnConversation<T>(conversationId: string, fn: () => T | Promise<T>): Promise<T> {
      stub.serialized.push(conversationId);
      return fn();
    },
  } as unknown as ContextStorePort;
  return { stub, store };
}

/**
 * A 3-level DAG: a condensed root → two condensed children → leaf summaries →
 * messages. Mirrors the "zoom into a compressed region" descent: descend
 * parent→child via getSummaryChildren.
 *
 *   sum-root (condensed, d2)
 *     ├── sum-a (condensed, d1) ── sum-a-leaf (leaf) ── [m-a1, m-a2]
 *     └── sum-b (condensed, d1) ── sum-b-leaf (leaf) ── [m-b1, m-b2]
 */
function makeThreeLevelDag(): StoreStub {
  const children = new Map<string, LcdSummary[]>([
    ["sum-root", [makeSummary("sum-a", "condensed", 1), makeSummary("sum-b", "condensed", 1)]],
    ["sum-a", [makeSummary("sum-a-leaf", "leaf", 0)]],
    ["sum-b", [makeSummary("sum-b-leaf", "leaf", 0)]],
  ]);
  const summaryMessages = new Map<string, string[]>([
    ["sum-a-leaf", ["m-a1", "m-a2"]],
    ["sum-b-leaf", ["m-b1", "m-b2"]],
  ]);
  const messages = new Map<string, LcdMessage>([
    ["m-a1", makeMessage("m-a1", 1, "alpha one deep detail")],
    ["m-a2", makeMessage("m-a2", 2, "alpha two deep detail")],
    ["m-b1", makeMessage("m-b1", 3, "beta one deep detail")],
    ["m-b2", makeMessage("m-b2", 4, "beta two deep detail")],
  ]);
  return {
    children,
    summaryMessages,
    messages,
    readScopes: [],
    serialized: [],
    visitedIds: [],
  };
}

// ---------------------------------------------------------------------------
// depthForTier (tier-gate)
// ---------------------------------------------------------------------------

describe("depthForTier maps a capability class to a bounded multi-hop depth", () => {
  it("depthForTier(\"nano\") returns 1 (shallowest walk for the weakest tier)", () => {
    expect(depthForTier("nano")).toBe(1);
  });
  it("depthForTier(\"small\") returns 2", () => {
    expect(depthForTier("small")).toBe(2);
  });
  it("depthForTier(\"mid\") returns 3", () => {
    expect(depthForTier("mid")).toBe(3);
  });
  it("depthForTier(\"frontier\") returns 4 (deepest walk for the strongest tier)", () => {
    expect(depthForTier("frontier")).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// ctxExpandWalk — bounded multi-hop BFS over T2 edges
// ---------------------------------------------------------------------------

describe("ctxExpandWalk performs a bounded multi-hop BFS over summary-parent (T2) edges", () => {
  it("T2 descent recovers multi-hop deep detail across a three-level DAG", async () => {
    const stub = makeThreeLevelDag();
    const { store } = makeStore(stub);
    const bundle = await ctxExpandWalk(store, SCOPE, "sum-root", {
      maxDepth: 3,
      maxTokens: 100_000,
      maxNodes: 64,
    });
    const recoveredText = bundle.items.map((i) => i.text).join(" ");
    // All four deep messages (two hops below the seed) are recovered — strictly
    // more than the single-hop tool (which would see ZERO, the seed being condensed).
    expect(recoveredText).toContain("alpha one deep detail");
    expect(recoveredText).toContain("alpha two deep detail");
    expect(recoveredText).toContain("beta one deep detail");
    expect(recoveredText).toContain("beta two deep detail");
    expect(bundle.depthReached).toBeGreaterThanOrEqual(2);
    // Every recovered item is CITED (refId + kind) — the "ranked cited bundle".
    for (const item of bundle.items) {
      expect(item.refId.length).toBeGreaterThan(0);
      expect(["summary", "message"]).toContain(item.kind);
    }
  });

  it("depth cap bounds the walk: maxDepth=1 stops at the seed's immediate children", async () => {
    const stub = makeThreeLevelDag();
    const { store } = makeStore(stub);
    const bundle = await ctxExpandWalk(store, SCOPE, "sum-root", {
      maxDepth: 1,
      maxTokens: 100_000,
      maxNodes: 64,
    });
    expect(bundle.depthReached).toBe(1);
    expect(bundle.capped).toBe(true);
    // The deep leaf messages (two hops down) are NOT reached at depth 1.
    const recoveredText = bundle.items.map((i) => i.text).join(" ");
    expect(recoveredText).not.toContain("alpha one deep detail");
    expect(recoveredText).not.toContain("beta two deep detail");
  });

  it("node-visit cap bounds the walk: a wide DAG visits at most maxNodes summary nodes", async () => {
    // A wide DAG: one root with many condensed children, each with a leaf + messages.
    const children = new Map<string, LcdSummary[]>();
    const summaryMessages = new Map<string, string[]>();
    const messages = new Map<string, LcdMessage>();
    const rootChildren: LcdSummary[] = [];
    for (let i = 0; i < 20; i++) {
      const cid = `c-${i}`;
      const leaf = `c-${i}-leaf`;
      rootChildren.push(makeSummary(cid, "condensed", 1));
      children.set(cid, [makeSummary(leaf, "leaf", 0)]);
      summaryMessages.set(leaf, [`mm-${i}`]);
      messages.set(`mm-${i}`, makeMessage(`mm-${i}`, i, `wide message ${i}`));
    }
    children.set("wide-root", rootChildren);
    const { store } = makeStore({ children, summaryMessages, messages });
    const bundle = await ctxExpandWalk(store, SCOPE, "wide-root", {
      maxDepth: 5,
      maxTokens: 1_000_000,
      maxNodes: 5,
    });
    expect(bundle.nodesVisited).toBeLessThanOrEqual(5);
    expect(bundle.capped).toBe(true);
  });

  it("token cap bounds the bundle: a large region stops accumulating at maxTokens", async () => {
    // Each leaf message is ~10_000 chars (~2500 tokens via chars/4). With a small
    // token cap the bundle stops accumulating well before all four are added.
    const stub = makeThreeLevelDag();
    for (const id of ["m-a1", "m-a2", "m-b1", "m-b2"]) {
      stub.messages.set(id, makeMessage(id, 1, "Z".repeat(10_000)));
    }
    const { store } = makeStore(stub);
    const bundle = await ctxExpandWalk(store, SCOPE, "sum-root", {
      maxDepth: 3,
      maxTokens: 1_000, // ~4000 chars — far below the ~40_000-char full region
      maxNodes: 64,
    });
    const totalChars = bundle.items.reduce((n, i) => n + i.text.length, 0);
    // The accumulated text estimate (chars/4) stays at/under the cap (+ one final item slack).
    expect(Math.ceil(totalChars / 4)).toBeLessThanOrEqual(1_000 + 2_500);
    expect(bundle.capped).toBe(true);
  });

  it("T2-only floor: with NO spreadLane the walk succeeds using summary edges only", async () => {
    const stub = makeThreeLevelDag();
    const { store } = makeStore(stub);
    // No `opts` at all → no KG lane. The walk MUST NOT throw and MUST recover T2 detail.
    const bundle = await ctxExpandWalk(store, SCOPE, "sum-root", {
      maxDepth: 3,
      maxTokens: 100_000,
      maxNodes: 64,
    });
    expect(bundle.items.length).toBeGreaterThan(0);
    expect(bundle.items.some((i) => i.text.includes("alpha one deep detail"))).toBe(true);
  });

  it("T2-only floor: an EMPTY spreadLane (ok:[]) leaves the T2 bundle intact (KG absent default)", async () => {
    const stub = makeThreeLevelDag();
    const { store } = makeStore(stub);
    const spreadLane = async (): Promise<Result<MemorySearchResult[], Error>> => ok([]);
    const bundle = await ctxExpandWalk(store, SCOPE, "sum-root", { maxDepth: 3, maxTokens: 100_000, maxNodes: 64 }, { spreadLane });
    // Empty KG lane is a no-op — the T2 bundle is unchanged.
    expect(bundle.items.some((i) => i.text.includes("beta two deep detail"))).toBe(true);
  });

  it("a failing spreadLane (ok:false) is non-fatal: the walk continues T2-only", async () => {
    const stub = makeThreeLevelDag();
    const { store } = makeStore(stub);
    const spreadLane = async (): Promise<Result<MemorySearchResult[], Error>> =>
      err(new Error("kg unavailable"));
    const bundle = await ctxExpandWalk(store, SCOPE, "sum-root", { maxDepth: 3, maxTokens: 100_000, maxNodes: 64 }, { spreadLane });
    // The KG error never fails the walk — T2 detail is still recovered.
    expect(bundle.items.some((i) => i.text.includes("alpha one deep detail"))).toBe(true);
  });

  it("cycle safe: a back-edge in the summary DAG does not loop (visited-set bounds it)", async () => {
    // sum-x → sum-y → sum-x (a cycle). The visited-set must stop the walk.
    const children = new Map<string, LcdSummary[]>([
      ["sum-x", [makeSummary("sum-y", "condensed", 1)]],
      ["sum-y", [makeSummary("sum-x", "condensed", 1)]],
    ]);
    const { store } = makeStore({ children });
    const bundle = await ctxExpandWalk(store, SCOPE, "sum-x", {
      maxDepth: 10,
      maxTokens: 100_000,
      maxNodes: 64,
    });
    // No infinite loop: each node visited at most once.
    expect(bundle.nodesVisited).toBeLessThanOrEqual(2);
  });

  it("drift safe: a missing summaryId / message id is skipped, never thrown", async () => {
    // Seed references a leaf whose message ids are missing from getMessages.
    const children = new Map<string, LcdSummary[]>([
      ["sum-seed", [makeSummary("sum-leaf", "leaf", 0)]],
    ]);
    const summaryMessages = new Map<string, string[]>([["sum-leaf", ["m-gone-1", "m-gone-2"]]]);
    const { store } = makeStore({ children, summaryMessages, messages: new Map() });
    const bundle = await ctxExpandWalk(store, SCOPE, "sum-seed", {
      maxDepth: 3,
      maxTokens: 100_000,
      maxNodes: 64,
    });
    // The drifted ids are counted as unrecoverable, not thrown.
    expect(bundle.unrecoverable).toBeGreaterThanOrEqual(2);
  });

  it("performs every edge read under the exact per-call scope, never a widened one", async () => {
    const stub = makeThreeLevelDag();
    const { store } = makeStore(stub);
    await ctxExpandWalk(store, SCOPE, "sum-root", { maxDepth: 3, maxTokens: 100_000, maxNodes: 64 });
    expect(stub.readScopes.length).toBeGreaterThan(0);
    // EVERY read carried the exact scope the caller passed — never a widened scope.
    for (const s of stub.readScopes) {
      expect(s.agentId).toBe("agent_a");
      expect(s.tenantId).toBe("default");
      expect(s.conversationId).toBe("default:user_a:chan_a");
    }
  });
});
