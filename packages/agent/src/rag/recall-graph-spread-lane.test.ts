// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for appendGraphSpreadLane — the 6th fused recall lane, the
 * file-for-file analog of appendCausalLane. PURE helper: it appends the
 * graph-spread lane to `lanes` IN PLACE and returns the lane's candidate count
 * (0 when no seeds / store err / empty lane — the empty-lane no-op).
 *
 * Mirrors recall-causal-lane.test.ts tier-for-tier:
 * - empty seedSubjects → 0, the store is NEVER queried (the defensive early-return).
 * - a store err → 0 + a non-fatal WARN (recall never fails because the spread failed).
 * - an empty lane (ok([])) → 0, nothing pushed (RRF unchanged).
 * - a non-empty lane → pushes `{ results, weight }` + returns the count; the call
 *   carries the seed subjects, the (tenant, agent) scope, and the depth/fan-out caps.
 *
 * The store is the injected TripleStorePort (TYPE only from @comis/core — the
 * agent↛memory build cut). This file imports core TYPES + the in-package helper ONLY.
 */

import type { TripleStorePort, SessionKey, MemorySearchResult, ComisLogger } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, it, expect } from "vitest";
import { appendGraphSpreadLane } from "./recall-graph-spread-lane.js";
import type { FusionLane } from "./fuse.js";

/** A neutral-placeholder MemorySearchResult with a controllable id. */
function makeResult(id: string): MemorySearchResult {
  const entry: Record<string, unknown> = {
    id,
    tenantId: "default",
    agentId: "default",
    userId: "user_a",
    content: `content for ${id}`,
    trustLevel: "learned",
    source: { who: "agent" },
    tags: [],
    createdAt: 1_700_000_000_000,
  };
  return { entry: entry as unknown as MemorySearchResult["entry"], score: 0.5 };
}

const SESSION_KEY_OBJ = {
  tenantId: "tenant_x",
  userId: "user_a",
  channelId: "chat_1",
} as unknown as SessionKey;

const noopLogger: ComisLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
} as unknown as ComisLogger;

/**
 * A controllable TripleStorePort stub. `spreadLane` returns a canned Result and
 * records every call (seedSubjects + scope + maxDepth + fanOut + cap) so the
 * gate / scope / not-called invariants are assertable. The write/asOf/currentTruth
 * methods are the unused halves (the lane helper only calls spreadLane).
 */
function fakeTripleStore(laneResult: Result<MemorySearchResult[], Error>): {
  store: TripleStorePort;
  calls: {
    seedSubjects: string[];
    scope: { tenantId: string; agentId: string };
    maxDepth: number;
    fanOut: number;
    cap: number;
  }[];
} {
  const calls: {
    seedSubjects: string[];
    scope: { tenantId: string; agentId: string };
    maxDepth: number;
    fanOut: number;
    cap: number;
  }[] = [];
  const store: TripleStorePort = {
    async upsertTriple() {
      return ok(undefined);
    },
    async asOf() {
      return ok([]);
    },
    async currentTruth() {
      return ok([]);
    },
    async spreadLane(seedSubjects, scope, maxDepth, fanOut, cap) {
      calls.push({ seedSubjects, scope, maxDepth, fanOut, cap });
      return laneResult;
    },
  };
  return { store, calls };
}

describe("appendGraphSpreadLane (the 6th-lane helper)", () => {
  it("returns 0 and NEVER queries the store when seedSubjects is empty (the defensive early-return)", async () => {
    const lanes: FusionLane[] = [{ results: [makeResult("base")], weight: 1.0 }];
    const { store, calls } = fakeTripleStore(ok([makeResult("spread")]));
    const count = await appendGraphSpreadLane(
      lanes,
      store,
      1.0,
      5,
      2,
      8,
      [],
      SESSION_KEY_OBJ,
      "agent_y",
      noopLogger,
    );
    expect(count).toBe(0);
    expect(calls.length).toBe(0); // never queried with no seeds
    expect(lanes.length).toBe(1); // unchanged
  });

  it("pushes the lane + returns the count on a non-empty result, carrying the scope + depth/fan-out caps", async () => {
    const lanes: FusionLane[] = [{ results: [makeResult("base")], weight: 1.0 }];
    const { store, calls } = fakeTripleStore(ok([makeResult("n1"), makeResult("n2")]));
    const count = await appendGraphSpreadLane(
      lanes,
      store,
      2.0,
      5,
      2,
      8,
      ["alice"],
      SESSION_KEY_OBJ,
      "agent_y",
      noopLogger,
    );
    expect(count).toBe(2);
    expect(lanes.length).toBe(2);
    expect(lanes[1]?.weight).toBe(2.0);
    // The call carried the seeds, the recall (tenant, agent) scope, and the caps.
    expect(calls.length).toBe(1);
    expect(calls[0]?.seedSubjects).toEqual(["alice"]);
    expect(calls[0]?.scope).toEqual({ tenantId: "tenant_x", agentId: "agent_y" });
    expect(calls[0]?.maxDepth).toBe(2);
    expect(calls[0]?.fanOut).toBe(8);
    expect(calls[0]?.cap).toBe(5);
  });

  it("returns 0 and pushes nothing on an EMPTY lane (ok([])) — the empty-lane no-op", async () => {
    const lanes: FusionLane[] = [{ results: [makeResult("base")], weight: 1.0 }];
    const { store, calls } = fakeTripleStore(ok([]));
    const count = await appendGraphSpreadLane(
      lanes,
      store,
      1.0,
      5,
      2,
      8,
      ["alice"],
      SESSION_KEY_OBJ,
      "agent_y",
      noopLogger,
    );
    expect(count).toBe(0);
    expect(calls.length).toBe(1); // queried (had seeds) but empty
    expect(lanes.length).toBe(1); // nothing pushed
  });

  it("returns 0 and WARNs (non-fatal) on a store err — recall ranks without the lane", async () => {
    const lanes: FusionLane[] = [{ results: [makeResult("base")], weight: 1.0 }];
    const warns: Record<string, unknown>[] = [];
    const capturingLogger = {
      ...noopLogger,
      warn: (obj: Record<string, unknown>) => {
        warns.push(obj);
      },
    } as unknown as ComisLogger;
    const { store } = fakeTripleStore(err(new Error("spread CTE exploded")));
    const count = await appendGraphSpreadLane(
      lanes,
      store,
      1.0,
      5,
      2,
      8,
      ["alice"],
      SESSION_KEY_OBJ,
      "agent_y",
      capturingLogger,
    );
    expect(count).toBe(0);
    expect(lanes.length).toBe(1); // nothing pushed
    const warn = warns.find((w) => typeof w.hint === "string" && /graph[- ]?spread/i.test(String(w.hint)));
    expect(warn).toBeDefined();
    expect(warn?.errorKind).toBe("internal");
  });

  it("uses the explicitly resolved agent instead of session display metadata", async () => {
    const lanes: FusionLane[] = [];
    const { store, calls } = fakeTripleStore(ok([makeResult("n1")]));
    await appendGraphSpreadLane(
      lanes,
      store,
      1.0,
      5,
      2,
      8,
      ["alice"],
      SESSION_KEY_OBJ,
      "agent-explicit",
      noopLogger,
    );
    expect(calls[0]?.scope).toEqual({ tenantId: "tenant_x", agentId: "agent-explicit" });
  });
});
