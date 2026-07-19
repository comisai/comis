// SPDX-License-Identifier: Apache-2.0
/**
 * Causal-lane recall-eval fixtures — the `"causal"` group.
 *
 * Split out of recall-eval-fixtures.ts (the parent crossed the 800-line cap when the 5th-lane
 * fixtures landed) and re-exported from it, so the recall-eval.test.ts import path is unchanged.
 *
 * THE KEYSTONE PROOF (the invariant — the causal edge table is NEVER write-only dead
 * data; it is CONSUMED by the read lane): each fixture is a lexical DISTRACTOR with a HIGHER
 * fusion score vs a causally-LINKED relevant memory with a LOWER fusion score. Fusion-only
 * ranks the distractor @1 and MISSES the linked id (`baseline.recallAt1 < 1` — the headroom
 * guard makes the lift NON-VACUOUS). The causal lane (relevant-first, modeled by
 * {@link causalLane}) sums the linked id's two RRF terms and lifts it to recall@1 — the
 * measurable causal-lane figure. The cause is stated in the distractor's sibling content; the
 * `effect` (the linked memory) is what the lane surfaces.
 *
 * Determinism (AGENTS.md §2.5): neutral placeholders + stable ids `cz1`, `cz2`, … No real
 * identities, no network, no `Date.now`/`Math.random`.
 *
 * @module
 */

import type { MemorySearchResult } from "@comis/core";
import type { EvalQuery } from "./recall-eval-fixtures.js";

/** Local candidate builder (self-contained to avoid a circular re-export ↔ import cycle with
 *  the parent fixtures module — the parent re-exports this file, so importing its `candidate`
 *  here would TDZ on the parent's module-level consts). The causal fixtures need no event time,
 *  so `createdAt` is a fixed literal (no EVAL_NOW dependency). */
function candidate(id: string, content: string, score: number): MemorySearchResult {
  return {
    entry: {
      id,
      tenantId: "default",
      agentId: "default",
      userId: "user_a",
      visibility: { kind: "agent-shared" },
      content,
      trustLevel: "learned",
      source: { who: "user_a" },
      tags: [],
      createdAt: 1_700_000_000_000,
    },
    score,
  };
}

export const CAUSAL_EVAL_FIXTURES: EvalQuery[] = [
  {
    group: "causal",
    query: "what did the migration lead to",
    candidates: [
      // Lexical distractor: high fusion score, causally UNLINKED — fusion rank 1.
      candidate("cz1", "user_a wrote a long migration status update", 0.9),
      // Relevant: causally LINKED to the seed (the effect), lower fusion score — fusion rank 2
      // (missed @1).
      candidate("cz2", "the schema rollback corrupted three tables", 0.5),
      candidate("cz3", "user_a prefers dark mode", 0.25),
    ],
    relevantIds: ["cz2"],
  },
  {
    group: "causal",
    query: "what was the consequence of the outage",
    candidates: [
      // Lexical distractor: high fusion score, causally UNLINKED — fusion rank 1.
      candidate("cz4", "user_a mentioned the outage in passing", 0.88),
      // Relevant: causally LINKED to the seed (the effect), lower fusion score — fusion rank 2
      // (missed @1).
      candidate("cz5", "the cache stampede tripped the rate limiter", 0.5),
      candidate("cz6", "user_a scheduled a sync", 0.2),
    ],
    relevantIds: ["cz5"],
  },
];

/**
 * The MODELED causal one-hop lane for a fixture — the causally-linked memory/memories surfaced
 * FIRST, ready to fuse as a 2nd {@link import("../../rag/fuse.js").FusionLane}. The fixture
 * stand-in for the live `causalLane`'s output (the one-hop edge lookup over
 * memory_causal_edges): the memories causally linked (cause↔effect) to the seeds. Here those
 * are exactly the fixture's `relevantIds`, placed at lane rank 1 so RRF lifts them over the
 * lexical distractor. PURE — no DB, no I/O.
 */
export function causalLane(q: EvalQuery): MemorySearchResult[] {
  const relevant = new Set(q.relevantIds);
  return q.candidates.filter((c) => relevant.has(c.entry.id));
}
