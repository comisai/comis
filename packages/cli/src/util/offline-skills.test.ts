// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the OFFLINE learned-skill
 * funnel reader behind `comis memory skills`. Drives the PRODUCTION write path
 * (`createSqliteMentalModelStore.admit` + `promote`/`demote`/`evict`) into a
 * temp `memory.db`, then asserts the counts-only admission funnel — the per-state
 * roll-up + the per-skill `{ name, state, proofCount, confidence, mutating }`
 * (IDS/COUNTS ONLY) — including the content-free guarantee (no body/script ever
 * surfaces) and the honest-empty soft-fail when the store or table is absent.
 *
 * `path.join` is test-only here (the no-path.join rule scopes to non-test src).
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSqliteMentalModelStore, openSqliteDatabase, initSchema } from "@comis/memory";
import type { AdmitMentalModelInput, LearningScope } from "@comis/core";
import { readSkillStatsOffline } from "./offline-skills.js";

const tmpDirs: string[] = [];
function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-skills-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const SCOPE: LearningScope = { tenantId: "default", agentId: "alice", now: 1_000 };

function admission(over: Partial<AdmitMentalModelInput>): AdmitMentalModelInput {
  return {
    name: "skill_a",
    description: "does a thing",
    body: "1. step one\n2. step two",
    mutating: false,
    proofCount: 1,
    confidence: 0.8,
    sourceTrajIds: ["t1"],
    createdAt: 1_000,
    ...over,
  };
}

/** Admit the rows; optionally transition each to a non-candidate state. */
async function seed(
  dataDir: string,
  rows: Array<{ input: Partial<AdmitMentalModelInput>; to?: "active" | "stale" | "archived"; scope?: LearningScope }>,
): Promise<void> {
  const db = openSqliteDatabase({
    dbPath: path.join(dataDir, "memory.db"),
    initSchema: (d) => void initSchema(d, 384),
  });
  try {
    const store = createSqliteMentalModelStore({ db });
    for (const r of rows) {
      const scope = r.scope ?? SCOPE;
      const admitR = await store.admit(admission(r.input), scope);
      expect(admitR.ok).toBe(true);
      const id = admitR.ok ? admitR.value.id : "";
      // threshold 1 → activate on the single promote (the seed wants the row 'active')
      if (r.to === "active") expect((await store.promote(id, scope, 1)).ok).toBe(true);
      if (r.to === "stale") expect((await store.demote(id, scope)).ok).toBe(true);
      if (r.to === "archived") expect((await store.evict(id, scope)).ok).toBe(true);
    }
  } finally {
    db.close();
  }
}

describe("readSkillStatsOffline", () => {
  it("returns undefined when memory.db is absent (honest empty — shadow default-off)", () => {
    expect(readSkillStatsOffline(tmpDataDir())).toBeUndefined();
  });

  it("returns undefined when memory.db exists but has no mental_models table", () => {
    const dir = tmpDataDir();
    fs.writeFileSync(path.join(dir, "memory.db"), "", "utf-8");
    expect(readSkillStatsOffline(dir)).toBeUndefined();
  });

  it("returns undefined when the mental_models table exists but is empty", async () => {
    const dir = tmpDataDir();
    await seed(dir, []); // initSchema creates the (empty) table
    expect(readSkillStatsOffline(dir)).toBeUndefined();
  });

  it("rolls up the per-state admission funnel (counts only)", async () => {
    const dir = tmpDataDir();
    await seed(dir, [
      { input: { name: "cand_1" } }, // candidate
      { input: { name: "cand_2" } }, // candidate
      { input: { name: "act_1" }, to: "active" }, // active
      { input: { name: "stale_1" }, to: "stale" }, // stale
      { input: { name: "arch_1" }, to: "archived" }, // archived
    ]);
    const stats = readSkillStatsOffline(dir);
    expect(stats).toBeDefined();
    expect(stats!.total).toBe(5);
    expect(stats!.byState).toMatchObject({ candidate: 2, active: 1, stale: 1, archived: 1 });
  });

  it("a store with only candidates → promoted/demoted roll-ups are 0", async () => {
    const dir = tmpDataDir();
    await seed(dir, [{ input: { name: "cand_1" } }, { input: { name: "cand_2" } }]);
    const stats = readSkillStatsOffline(dir)!;
    expect(stats.promoted).toBe(0);
    expect(stats.demoted).toBe(0);
    expect(stats.perAgent[0].promoted).toBe(0);
    expect(stats.perAgent[0].demoted).toBe(0);
  });

  it("derives promotion/demotion roll-ups from byState (counts only)", async () => {
    const dir = tmpDataDir();
    await seed(dir, [
      { input: { name: "cand_1" } }, // candidate (not yet promoted)
      { input: { name: "act_1" }, to: "active" }, // promoted → active
      { input: { name: "act_2" }, to: "active" }, // promoted → active
      { input: { name: "stale_1" }, to: "stale" }, // demoted → stale
      { input: { name: "arch_1" }, to: "archived" }, // demoted → archived
    ]);
    const stats = readSkillStatsOffline(dir)!;
    // promoted = active count; demoted = stale + archived count — DERIVED from byState.
    expect(stats.promoted).toBe(2); // act_1, act_2
    expect(stats.demoted).toBe(2); // stale_1 + arch_1
  });

  it("rolls promotion/demotion per agent (DERIVED from each agent's byState)", async () => {
    const dir = tmpDataDir();
    const bob: LearningScope = { tenantId: "default", agentId: "bob", now: 1_000 };
    await seed(dir, [
      { input: { name: "a_act" }, to: "active" }, // alice: 1 promoted
      { input: { name: "a_stale" }, to: "stale" }, // alice: 1 demoted
      { input: { name: "b_arch" }, to: "archived", scope: bob }, // bob: 1 demoted
    ]);
    const stats = readSkillStatsOffline(dir)!;
    const alice = stats.perAgent.find((a) => a.agentId === "alice")!;
    const bobStats = stats.perAgent.find((a) => a.agentId === "bob")!;
    expect(alice.promoted).toBe(1);
    expect(alice.demoted).toBe(1);
    expect(bobStats.promoted).toBe(0);
    expect(bobStats.demoted).toBe(1);
  });

  it("promotion/demotion roll-ups carry NO procedure body (counts-only firewall holds)", async () => {
    const dir = tmpDataDir();
    await seed(dir, [
      { input: { name: "deploy", body: "SECRET-PROCEDURE rm -rf /", description: "DESC-LEAK" }, to: "active" },
    ]);
    const stats = readSkillStatsOffline(dir)!;
    expect(stats.promoted).toBe(1);
    expect(stats.demoted).toBe(0);
    // The new DERIVED roll-up fields add no body/description columns to the projection.
    const json = JSON.stringify(stats);
    expect(json).not.toContain("SECRET-PROCEDURE");
    expect(json).not.toContain("rm -rf");
    expect(json).not.toContain("DESC-LEAK");
  });

  it("reports per-agent funnels scoped by (tenant, agent)", async () => {
    const dir = tmpDataDir();
    await seed(dir, [
      { input: { name: "a1" } },
      { input: { name: "b1" }, scope: { tenantId: "default", agentId: "bob", now: 1_000 } },
    ]);
    const stats = readSkillStatsOffline(dir)!;
    expect(stats.total).toBe(2);
    const agents = stats.perAgent.map((a) => a.agentId).sort();
    expect(agents).toEqual(["alice", "bob"]);
  });

  it("carries per-skill id/state/proofCount/confidence/mutating — NEVER a procedure body/script", async () => {
    const dir = tmpDataDir();
    await seed(dir, [
      { input: { name: "deploy", body: "SECRET-PROCEDURE rm -rf /", description: "DESC-LEAK", proofCount: 3, confidence: 0.9, mutating: true } },
    ]);
    const stats = readSkillStatsOffline(dir)!;
    const agent = stats.perAgent.find((a) => a.agentId === "alice")!;
    const skill = agent.skills.find((s) => s.name === "deploy")!;
    expect(skill.state).toBe("candidate");
    expect(skill.proofCount).toBe(3);
    expect(skill.confidence).toBeCloseTo(0.9);
    expect(skill.mutating).toBe(true);
    // The body / description / scripts never cross into the offline stats.
    const json = JSON.stringify(stats);
    expect(json).not.toContain("SECRET-PROCEDURE");
    expect(json).not.toContain("rm -rf");
    expect(json).not.toContain("DESC-LEAK");
  });
});
