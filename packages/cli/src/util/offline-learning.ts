// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI entry point — errors propagate to the Commander error handler.
/**
 * OFFLINE outcome-learning telemetry for `comis memory learning`.
 *
 * The outcome ledger (`outcome_events`) lives in the local `~/.comis/memory.db`,
 * so a coverage read must not require a live gateway — the CLI reads the table
 * directly (the same offline-disk discipline `offline-obs.ts` uses for
 * `comis explain`/`fleet`). The CLI cannot import `@comis/agent`/`@comis/skills`
 * (closed graph) and the in-process daemon coverage gauge is not yet a queryable
 * RPC, so the offline `@comis/memory` read is the
 * sanctioned path — CLI→@comis/memory + better-sqlite3 are already allowed edges.
 *
 * COUNTS/IDS ONLY: the aggregates are pure COUNT(*) / COUNT(DISTINCT
 * trajectory_id) / GROUP BY over the closed-enum `outcome`/`source` columns + the
 * `(tenant_id, agent_id)` scope — never a body, a confidence value, or a
 * recalled/skill id (the ledger stores no
 * bodies by construction). The db is opened in WAL mode (concurrent with
 * a live daemon) and ONLY when the file already exists — the offline read never
 * creates it; a missing/unreadable store soft-fails to `undefined` so the command
 * prints an honest "no outcome events" message instead of a misleading empty table.
 *
 * @module
 */

import * as fs from "node:fs";
import { safePath } from "@comis/core";
import { openSqliteDatabase } from "./offline-secrets-store.js";

/** One agent's outcome-coverage roll-up (counts only). */
export interface LearningAgentStats {
  tenantId: string;
  agentId: string;
  /** Distinct trajectories that produced ≥1 outcome row. */
  trajectories: number;
  /** Distinct trajectories with ≥1 non-`unknown` (resolvable) outcome row. */
  resolved: number;
  /** Resolved / trajectories, 0–1 (0 when no trajectories). */
  coverage: number;
  /** Row counts per closed-enum outcome. */
  outcomes: Record<string, number>;
  /** Distinct trajectories carrying a signal of each closed-enum source. */
  sources: Record<string, number>;
}

/** The whole-ledger outcome-learning telemetry (counts only). */
export interface LearningStats {
  /** Total distinct-trajectory signals across all sources (NOT raw rows). */
  totalRows: number;
  totalTrajectories: number;
  totalResolved: number;
  coverage: number;
  perAgent: LearningAgentStats[];
}

interface ScopeRow {
  tenant_id: string;
  agent_id: string;
  trajectories: number;
  resolved: number;
}
interface EnumRow {
  tenant_id: string;
  agent_id: string;
  key: string;
  n: number;
}

/**
 * Read the counts-only outcome-learning telemetry from `~/.comis/memory.db`, or
 * `undefined` when the store is absent/unreadable (shadow-mode default-off — the
 * caller prints an honest empty message). Deterministic: pure aggregate SQL, no
 * clock, no model. Every value is a count or a closed-enum key — no bodies.
 */
export function readLearningStatsOffline(dataDir: string): LearningStats | undefined {
  const dbPath = safePath(dataDir, "memory.db");
  if (!fs.existsSync(dbPath)) return undefined;
  let db: ReturnType<typeof openSqliteDatabase> | undefined;
  try {
    db = openSqliteDatabase({ dbPath, initSchema: () => undefined });
    // A store whose outcome_events table is absent (a reset or partially-initialized db) → honest empty.
    const present = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outcome_events'")
      .get();
    if (present === undefined) return undefined;

    // Per-(tenant,agent) distinct-trajectory + resolved-trajectory counts. A
    // trajectory is "resolved" iff it carries ≥1 non-`unknown` outcome row (the
    // fail-closed coverage rule — mirrors the daemon gauge: unknown never counts).
    const scope = db
      .prepare(
        `SELECT tenant_id, agent_id,
                COUNT(DISTINCT trajectory_id) AS trajectories,
                COUNT(DISTINCT CASE WHEN outcome != 'unknown' THEN trajectory_id END) AS resolved
         FROM outcome_events GROUP BY tenant_id, agent_id`,
      )
      .all() as ScopeRow[];
    const byOutcome = db
      .prepare(
        "SELECT tenant_id, agent_id, outcome AS key, COUNT(*) AS n FROM outcome_events GROUP BY tenant_id, agent_id, outcome",
      )
      .all() as EnumRow[];
    // Per-source volume is counted as DISTINCT trajectories, so the figure
    // reads as "trajectories carrying a <source> signal" rather than raw rows — a
    // single trajectory with several same-source rows (per-node residual rows,
    // or any future multi-row source) does not inflate it. `totalRows` (the headline)
    // is the sum of these per-source distinct-trajectory counts.
    const bySource = db
      .prepare(
        "SELECT tenant_id, agent_id, source AS key, COUNT(DISTINCT trajectory_id) AS n FROM outcome_events GROUP BY tenant_id, agent_id, source",
      )
      .all() as EnumRow[];

    const keyOf = (t: string, a: string): string => `${t} ${a}`;
    const index = (rows: EnumRow[]): Map<string, Record<string, number>> => {
      const m = new Map<string, Record<string, number>>();
      for (const r of rows) {
        const k = keyOf(r.tenant_id, r.agent_id);
        const rec = m.get(k) ?? {};
        rec[r.key] = r.n;
        m.set(k, rec);
      }
      return m;
    };
    const outcomesIdx = index(byOutcome);
    const sourcesIdx = index(bySource);

    let totalRows = 0;
    let totalTrajectories = 0;
    let totalResolved = 0;
    const perAgent: LearningAgentStats[] = scope.map((s) => {
      const k = keyOf(s.tenant_id, s.agent_id);
      const outcomes = outcomesIdx.get(k) ?? {};
      const sources = sourcesIdx.get(k) ?? {};
      const rows = Object.values(sources).reduce((a, b) => a + b, 0);
      totalRows += rows;
      totalTrajectories += s.trajectories;
      totalResolved += s.resolved;
      return {
        tenantId: s.tenant_id,
        agentId: s.agent_id,
        trajectories: s.trajectories,
        resolved: s.resolved,
        coverage: s.trajectories > 0 ? s.resolved / s.trajectories : 0,
        outcomes,
        sources,
      };
    });

    return {
      totalRows,
      totalTrajectories,
      totalResolved,
      coverage: totalTrajectories > 0 ? totalResolved / totalTrajectories : 0,
      perAgent,
    };
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
