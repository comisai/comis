// SPDX-License-Identifier: Apache-2.0
/**
 * OBS-02 (Phase 201, P2 skills shadow): tests for the OFFLINE learned-skill
 * funnel reader behind `comis memory skills`. Drives the PRODUCTION write path
 * (`createSqliteLearnedSkillStore.admit` + `promote`/`demote`/`evict`) into a
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
import { createSqliteLearnedSkillStore, openSqliteDatabase, initSchema } from "@comis/memory";
import type { AdmitSkillInput, LearningScope } from "@comis/core";
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

function admission(over: Partial<AdmitSkillInput>): AdmitSkillInput {
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
  rows: Array<{ input: Partial<AdmitSkillInput>; to?: "active" | "stale" | "archived"; scope?: LearningScope }>,
): Promise<void> {
  const db = openSqliteDatabase({
    dbPath: path.join(dataDir, "memory.db"),
    initSchema: (d) => void initSchema(d, 384),
  });
  try {
    const store = createSqliteLearnedSkillStore({ db });
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

  it("returns undefined when memory.db exists but has no learned_skills table", () => {
    const dir = tmpDataDir();
    fs.writeFileSync(path.join(dir, "memory.db"), "", "utf-8");
    expect(readSkillStatsOffline(dir)).toBeUndefined();
  });

  it("returns undefined when the learned_skills table exists but is empty", async () => {
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
