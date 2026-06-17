// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI entry point — errors propagate to the Commander error handler.
/**
 * OBS-02 (Phase 201, P2 skills shadow): OFFLINE procedural-learning telemetry
 * for `comis memory skills`.
 *
 * The learned-skill funnel (`learned_skills`) lives in the local
 * `~/.comis/memory.db`, so reading it must not require a live gateway — the CLI
 * reads the table directly (the same offline-disk discipline `offline-obs.ts` /
 * `offline-learning.ts` use). The CLI cannot import `@comis/agent`/`@comis/skills`
 * (closed graph) and the daemon coverage gauge is not a queryable RPC, so the
 * offline `@comis/memory` read is the sanctioned path — CLI→@comis/memory +
 * better-sqlite3 are already allowed edges.
 *
 * COUNTS/IDS ONLY (T-201-44): the SELECT projects `name` (the skill id) +
 * `state`/`proof_count`/`confidence`/`mutating` (closed enum + counts/booleans) +
 * the `(tenant_id, agent_id)` scope — and NEVER `body`, `scripts`, `description`,
 * `trigger`, `params_schema`, `required_tools`, `source_traj_ids`, or
 * `validation_result` (the procedure-body columns). A body never crosses into the
 * CLI output (SEC-01). The db is opened in WAL mode (concurrent with a live
 * daemon) and ONLY when the file already exists — the offline read never creates
 * it; a missing/unreadable/empty store soft-fails to `undefined` so the command
 * prints an honest "no learned skills" default-off message instead of a misleading
 * empty table.
 *
 * @module
 */

import * as fs from "node:fs";
import { safePath } from "@comis/core";
import { openSqliteDatabase } from "./offline-secrets-store.js";

/** The closed learned-skill lifecycle states (mirrors the DB CHECK). */
export const SKILL_STATES = ["candidate", "active", "stale", "archived"] as const;
export type SkillState = (typeof SKILL_STATES)[number];

/** One skill's funnel entry — IDS/COUNTS/closed-enum only (NEVER a body/script). */
export interface SkillFunnelEntry {
  /** The stable skill name (the id) — never a body. */
  name: string;
  /** Lifecycle state (closed enum). */
  state: SkillState;
  /** Verified-success reinforcement count (drives promote/demote). */
  proofCount: number;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Whether the procedure mutates state (drives the approval gate). */
  mutating: boolean;
}

/** One agent's learned-skill funnel roll-up (counts only). */
export interface SkillAgentStats {
  tenantId: string;
  agentId: string;
  /** Total learned skills in scope. */
  total: number;
  /** Row counts per closed-enum state. */
  byState: Record<string, number>;
  /** Per-skill ids/counts (NEVER bodies). */
  skills: SkillFunnelEntry[];
}

/** The whole-store learned-skill funnel telemetry (counts only). */
export interface SkillStats {
  /** Total learned skills across all (tenant, agent) scopes. */
  total: number;
  /** Row counts per closed-enum state, store-wide. */
  byState: Record<string, number>;
  perAgent: SkillAgentStats[];
}

/** One raw `learned_skills` row — the counts/ids projection ONLY (no body columns). */
interface SkillRow {
  tenant_id: string;
  agent_id: string;
  name: string;
  state: string;
  proof_count: number;
  confidence: number;
  mutating: number;
}

/** A fresh zeroed per-state tally (every closed state present at 0). */
function zeroByState(): Record<string, number> {
  const m: Record<string, number> = {};
  for (const s of SKILL_STATES) m[s] = 0;
  return m;
}

/** Narrow a raw `state` string to a closed `SkillState` (off-vocabulary → undefined). */
function narrowState(v: string): SkillState | undefined {
  return (SKILL_STATES as readonly string[]).includes(v) ? (v as SkillState) : undefined;
}

/**
 * Read the counts-only learned-skill funnel from `~/.comis/memory.db`, or
 * `undefined` when the store is absent/unreadable/empty (shadow-mode default-off
 * — the caller prints an honest empty message). Deterministic: a single ordered
 * SELECT, no clock, no model. Every value is a skill id, a count, a closed enum,
 * or a boolean — no procedure bodies.
 */
export function readSkillStatsOffline(dataDir: string): SkillStats | undefined {
  const dbPath = safePath(dataDir, "memory.db");
  if (!fs.existsSync(dbPath)) return undefined;
  let db: ReturnType<typeof openSqliteDatabase> | undefined;
  try {
    db = openSqliteDatabase({ dbPath, initSchema: () => undefined });
    // A store whose learned_skills table is absent (an old/reset db) → honest empty.
    const present = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_skills'")
      .get();
    if (present === undefined) return undefined;

    // Counts/ids projection ONLY — name is the id; state/proof_count/confidence/
    // mutating are closed-enum/counts/booleans. NO body/scripts/description/etc.
    const rows = db
      .prepare(
        "SELECT tenant_id, agent_id, name, state, proof_count, confidence, mutating " +
          "FROM learned_skills ORDER BY tenant_id, agent_id, name",
      )
      .all() as SkillRow[];
    if (rows.length === 0) return undefined; // empty table → honest empty

    const keyOf = (t: string, a: string): string => `${t} ${a}`;
    const byAgent = new Map<string, SkillAgentStats>();
    const storeByState = zeroByState();
    let total = 0;

    for (const r of rows) {
      const state = narrowState(r.state);
      if (state === undefined) continue; // drop an off-vocabulary state (defence-in-depth)
      total += 1;
      storeByState[state] += 1;
      const k = keyOf(r.tenant_id, r.agent_id);
      let agent = byAgent.get(k);
      if (agent === undefined) {
        agent = { tenantId: r.tenant_id, agentId: r.agent_id, total: 0, byState: zeroByState(), skills: [] };
        byAgent.set(k, agent);
      }
      agent.total += 1;
      agent.byState[state] += 1;
      agent.skills.push({
        name: r.name,
        state,
        proofCount: r.proof_count,
        confidence: r.confidence,
        mutating: r.mutating === 1,
      });
    }

    if (total === 0) return undefined; // every row dropped (all off-vocabulary) → honest empty
    return { total, byState: storeByState, perAgent: [...byAgent.values()] };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // A close after the read finished is harmless.
    }
  }
}
