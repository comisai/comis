// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the OFFLINE outcome-learning reader behind
 * `comis memory learning`. Drives the PRODUCTION write path
 * (`createSqliteOutcomeStore.observe`) into a temp `memory.db`, then asserts the
 * counts-only coverage/volume/ratio roll-up — including the content-free
 * guarantee (no body/confidence/recalled-id ever surfaces) and the honest-empty
 * soft-fail when the store or table is absent.
 *
 * `path.join` is test-only here (the no-path.join rule scopes to non-test src).
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSqliteOutcomeStore, openSqliteDatabase, initSchema } from "@comis/memory";
import type { OutcomeObservation } from "@comis/core";
import { readLearningStatsOffline } from "./offline-learning.js";

const tmpDirs: string[] = [];
function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-learning-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function obs(over: Partial<OutcomeObservation>): OutcomeObservation {
  return {
    tenantId: "default",
    agentId: "alice",
    sessionId: "s1",
    trajectoryId: "t1",
    outcome: "success",
    source: "tool",
    confidence: 0.9,
    observedAt: 1_000,
    ...over,
  };
}

async function seed(dataDir: string, rows: Array<Partial<OutcomeObservation>>): Promise<void> {
  const db = openSqliteDatabase({
    dbPath: path.join(dataDir, "memory.db"),
    initSchema: (d) => void initSchema(d, 384), // 384 = an arbitrary positive embed dim (outcome_events needs none, but initSchema validates it)
  });
  try {
    const store = createSqliteOutcomeStore({ db });
    for (const r of rows) {
      const result = await store.observe(obs(r));
      expect(result.ok).toBe(true);
    }
  } finally {
    db.close();
  }
}

describe("readLearningStatsOffline", () => {
  it("returns undefined when memory.db is absent (honest empty — shadow default-off)", () => {
    expect(readLearningStatsOffline(tmpDataDir())).toBeUndefined();
  });

  it("returns undefined when memory.db exists but has no outcome_events table", () => {
    const dir = tmpDataDir();
    fs.writeFileSync(path.join(dir, "memory.db"), "", "utf-8");
    expect(readLearningStatsOffline(dir)).toBeUndefined();
  });

  it("computes coverage, per-source volume, and per-outcome counts (resolved excludes unknown)", async () => {
    const dir = tmpDataDir();
    await seed(dir, [
      // t1 resolved (a tool success)
      { trajectoryId: "t1", outcome: "success", source: "tool", observedAt: 1 },
      // t2 has ONLY an unknown row → counted as a trajectory but NOT resolved
      { trajectoryId: "t2", outcome: "unknown", source: "pipeline", observedAt: 2 },
      // t3 resolved (a pipeline failure)
      { trajectoryId: "t3", outcome: "failure", source: "pipeline", observedAt: 3 },
    ]);
    const stats = readLearningStatsOffline(dir);
    expect(stats).toBeDefined();
    expect(stats!.totalTrajectories).toBe(3);
    expect(stats!.totalResolved).toBe(2); // t1 + t3 (t2 is unknown-only)
    expect(stats!.coverage).toBeCloseTo(2 / 3);
    expect(stats!.totalRows).toBe(3);
    const alice = stats!.perAgent.find((a) => a.agentId === "alice")!;
    expect(alice.outcomes).toEqual({ success: 1, unknown: 1, failure: 1 });
    expect(alice.sources).toEqual({ tool: 1, pipeline: 2 });
    expect(alice.coverage).toBeCloseTo(2 / 3);
  });

  it("scopes counts per (tenant, agent) — never collapses two agents", async () => {
    const dir = tmpDataDir();
    await seed(dir, [
      { agentId: "alice", trajectoryId: "ta", outcome: "success", source: "tool", observedAt: 1 },
      { agentId: "bob", trajectoryId: "tb", outcome: "failure", source: "pipeline", observedAt: 2 },
    ]);
    const stats = readLearningStatsOffline(dir);
    expect(stats!.perAgent).toHaveLength(2);
    expect(stats!.perAgent.find((a) => a.agentId === "alice")!.outcomes).toEqual({ success: 1 });
    expect(stats!.perAgent.find((a) => a.agentId === "bob")!.outcomes).toEqual({ failure: 1 });
  });

  it("counts per-source volume as DISTINCT trajectories, not raw rows", async () => {
    // A single trajectory carrying MULTIPLE same-source rows (per-node residual
    // rows, or any future multi-row source) must NOT inflate the
    // per-source figure: `sources.pipeline` is "trajectories with a pipeline signal"
    // (COUNT(DISTINCT trajectory_id)), so three pipeline rows on one trajectory read
    // as 1, not 3. totalRows is the same distinct-signal sum.
    const dir = tmpDataDir();
    await seed(dir, [
      { trajectoryId: "t1", outcome: "success", source: "pipeline", observedAt: 1 },
      { trajectoryId: "t1", outcome: "success", source: "pipeline", observedAt: 2 },
      { trajectoryId: "t1", outcome: "failure", source: "pipeline", observedAt: 3 },
    ]);
    const stats = readLearningStatsOffline(dir);
    expect(stats).toBeDefined();
    const alice = stats!.perAgent.find((a) => a.agentId === "alice")!;
    expect(alice.sources).toEqual({ pipeline: 1 }); // one trajectory, not three rows
    expect(stats!.totalRows).toBe(1); // the distinct-signal headline, not raw row count
    expect(alice.trajectories).toBe(1);
  });

  it("is content-free: a hostile body/confidence/recalled-id never surfaces", async () => {
    const dir = tmpDataDir();
    await seed(dir, [
      {
        trajectoryId: "t1",
        outcome: "success",
        source: "tool",
        confidence: 0.4242,
        recalledIds: ["mem-7", "the user's password is hunter2"],
        observedAt: 1,
      },
    ]);
    const stats = readLearningStatsOffline(dir);
    const json = JSON.stringify(stats);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("mem-7");
    expect(json).not.toContain("0.4242");
  });
});
