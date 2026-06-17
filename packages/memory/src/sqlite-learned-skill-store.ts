// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteLearnedSkillStore: the SOLE adapter for the segregated
 * `LearnedSkillStorePort` (@comis/core, v2.26 Verified Learning WS2 / SKILL-01).
 * It owns ALL the `learned_skills` SQL — the idempotent `admit()` upsert (one row
 * per admitted procedure), the scoped `get`/`list` reads, and the
 * `promote`/`demote`/`evict` lifecycle transitions.
 *
 * ## Idempotency (SKILL-01 / T-201-09)
 *
 * `admit()` derives the row `id` as a deterministic sha256 hash of the UNIQUE
 * tuple `(tenant_id, agent_id, name)` in CODE before insert, AND inserts
 * `ON CONFLICT(id) DO UPDATE`. A re-admit of the same (tenant, agent, name) is a
 * no-op-plus-refresh: the hash-id collides so it upserts the SAME primary key even
 * if the row was previously deleted/evicted (replay-stable), and the
 * `UNIQUE (tenant_id, agent_id, name)` backstop catches it regardless.
 *
 * ## Trust ceiling (SEC-01 / T-201-05) — the keystone
 *
 * A synthesized procedure can NEVER be `system`. The store writes the LITERAL
 * `'learned'` for `trust_level` on EVERY admit (it never reads a caller-supplied
 * trust), and the DB `CHECK (trust_level IN ('learned'))` rejects any other value
 * at insert time — belt (code coercion) AND suspenders (DB constraint).
 *
 * ## Isolation is the load-bearing security boundary (SEC-01 / T-201-06)
 *
 * Comis runs many agents in one DB. EVERY statement filters on
 * `(tenant_id, agent_id)` — parameterized — and the table keys/indexes lead on
 * those columns, so a procedure under one (tenant, agent) is NEVER visible to a
 * read under another even when `name` is byte-identical. An UNRESOLVED
 * `(tenant, agent)` scope (empty id) fails-closed with `err(...)` — it NEVER
 * widens to a shared/global pool (the `get_current_schema()` leak vector,
 * T-201-07).
 *
 * ## Soft lifecycle (never hard-delete)
 *
 * `evict()` sets `evicted_at` (and steps `state` to `archived`); it NEVER issues a
 * `DELETE` — an evicted procedure stops surfacing but its provenance survives.
 *
 * ## Untrusted input
 *
 * Every id reaches SQL as a bound `?` parameter — never concatenated — and every
 * read parses through `createRowMapper` (no `as Foo[]` casts; `untyped-sqlite.test.ts`).
 * The persisted JSON columns (`source_traj_ids` etc.) are parsed with a
 * graceful-degrade `safeParse` (corrupt JSON → empty list, never a throw). Logs
 * carry counts/ids + metadata only — never procedure bodies/scripts/descriptions
 * (§2.7 / T-201-10).
 *
 * @module
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  LearnedSkillStorePort,
  LearnedSkill,
  AdmitSkillInput,
  LearningScope,
} from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";
import { LearnedSkillRowSchema } from "./learned-skill-row-schema.js";

/** Minimal pino-compatible logger (mirrors sqlite-outcome-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteLearnedSkillStore}. */
export interface LearnedSkillStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`).
const learnedSkillRowMapper = createRowMapper(LearnedSkillRowSchema);

// Lenient JSON-string[] parser for the source_traj_ids column: corrupt/non-array
// JSON degrades to [] (never a throw that breaks get()/list()).
const StringArraySchema = z.array(z.string());

/** Parse a nullable JSON-encoded string[] column; [] on NULL or corrupt data. */
function parseIdList(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed = StringArraySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Compute the deterministic row id from the UNIQUE `(tenant, agent, name)` tuple.
 * A stable sha256 hex of the space-joined fields — never a wall-clock or random
 * id, so a re-admit of the same tuple yields the SAME id (the idempotency
 * backstop beyond the UNIQUE constraint; replay-stable even after a row
 * deletion). The `createHash` precedent is `sqlite-outcome-store.ts:outcomeRowId`.
 */
function learnedSkillId(s: { tenantId: string; agentId: string; name: string }): string {
  return createHash("sha256").update([s.tenantId, s.agentId, s.name].join(" ")).digest("hex");
}

/** Map a parsed `learned_skills` row to the domain {@link LearnedSkill}. */
function rowToSkill(row: z.infer<typeof LearnedSkillRowSchema>): LearnedSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    // The DB CHECK guarantees 'learned'; the literal cast mirrors the type-layer
    // keystone (a synthesized procedure is never `system`).
    trustLevel: "learned",
    state: row.state as LearnedSkill["state"],
    proofCount: row.proof_count,
    confidence: row.confidence,
    mutating: row.mutating === 1,
    sourceTrajIds: parseIdList(row.source_traj_ids),
    createdAt: row.created_at,
  };
}

/**
 * Create the SQLite-backed {@link LearnedSkillStorePort} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it. Built
 * UNCONDITIONALLY (no model/IO cost, like every dormant store); the per-agent
 * enable flag gates the daemon-side `admit`/`get`/`list` call (Plan 07), not
 * construction.
 */
export function createSqliteLearnedSkillStore(
  deps: LearnedSkillStoreDeps,
): LearnedSkillStorePort {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // Idempotent admit keyed on the deterministic id (= hash of the
  // (tenant_id, agent_id, name) UNIQUE tuple). A re-admit upserts the SAME row.
  // trust_level is the LITERAL 'learned' (the SEC-01 keystone — never a bound
  // caller value); all other columns are bound `?` params (never string-built).
  const insertStmt = db.prepare(
    "INSERT INTO learned_skills " +
      "(id, tenant_id, agent_id, name, description, body, scripts, required_tools, params_schema, " +
      " trust_level, state, proof_count, confidence, strength, source_traj_ids, validation_result, " +
      " mutating, pinned, validated_at, created_at, updated_at, evicted_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'learned', 'candidate', ?, ?, ?, ?, NULL, ?, 0, NULL, ?, NULL, NULL) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "description = excluded.description, body = excluded.body, proof_count = excluded.proof_count, " +
      "confidence = excluded.confidence, strength = excluded.strength, " +
      "source_traj_ids = excluded.source_traj_ids, mutating = excluded.mutating, " +
      // A re-admit of a previously-evicted skill resurrects it (clears evicted_at,
      // resets state to candidate) — the replay-stable path.
      "state = 'candidate', evicted_at = NULL, updated_at = excluded.created_at",
  );

  // Scoped reads — the `tenant_id = ? AND agent_id = ?` filter is the
  // load-bearing isolation boundary (SEC-01); every value is a bound `?` param.
  const SELECT_COLS =
    "id, name, description, trust_level, state, body, scripts, required_tools, params_schema, " +
    "mutating, pinned, proof_count, confidence, strength, source_traj_ids, validation_result, " +
    "evicted_at, created_at, updated_at";
  // get(): exclude soft-evicted rows (evicted_at IS NULL) so an evicted skill
  // stops surfacing.
  const getStmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM learned_skills ` +
      "WHERE tenant_id = ? AND agent_id = ? AND name = ? AND evicted_at IS NULL",
  );
  const listStmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM learned_skills ` +
      "WHERE tenant_id = ? AND agent_id = ? AND evicted_at IS NULL ORDER BY created_at ASC, id ASC",
  );

  // Lifecycle transitions — all scoped to (tenant, agent) AND id (bound params).
  // promote: proof_count bumps on EVERY call, but the candidate→active flip is
  // GATED on the caller's proof bar — `proof_count + 1 >= promoteAtProofCount`
  // (D2 / T-202-04: a single attributed success must NOT mint an active
  // procedure). The threshold is the FIRST bound `?` (promote runs its own bind
  // path, not the shared runTransition); an already-active skill keeps bumping
  // proof_count but the `state = 'candidate'` guard means its state never moves.
  const promoteStmt = db.prepare(
    "UPDATE learned_skills SET proof_count = proof_count + 1, " +
      "state = CASE WHEN state = 'candidate' AND proof_count + 1 >= ? THEN 'active' ELSE state END, " +
      "updated_at = ? WHERE tenant_id = ? AND agent_id = ? AND id = ?",
  );
  // demote: step state back toward stale on a verified failure (soft, monotone).
  const demoteStmt = db.prepare(
    "UPDATE learned_skills SET " +
      "state = CASE WHEN state = 'active' THEN 'stale' WHEN state = 'candidate' THEN 'stale' ELSE state END, " +
      "strength = CASE WHEN strength > 0 THEN strength - 1 ELSE strength END, " +
      "updated_at = ? WHERE tenant_id = ? AND agent_id = ? AND id = ?",
  );
  // evict: SOFT — set evicted_at + archive; NEVER a hard DELETE (provenance survives).
  const evictStmt = db.prepare(
    "UPDATE learned_skills SET evicted_at = ?, state = 'archived', updated_at = ? " +
      "WHERE tenant_id = ? AND agent_id = ? AND id = ?",
  );

  /** Fail-closed scope guard — copy of sqlite-outcome-store.ts:239-248. */
  function rejectUnresolvedScope(scope: LearningScope): Result<never, Error> | undefined {
    if (scope.tenantId === "" || scope.agentId === "") {
      logger?.warn(
        {
          step: "learned-skill-store",
          errorKind: "config" as const,
          hint: "learned-skill store requires a resolved (tenant, agent) scope — refusing to widen to a shared pool",
        },
        "Learned-skill op rejected (unresolved scope)",
      );
      return err(new Error("learned-skill store requires a resolved (tenant, agent) scope"));
    }
    return undefined;
  }

  return {
    async admit(
      input: AdmitSkillInput,
      scope: LearningScope,
    ): Promise<Result<{ id: string; admitted: boolean }, Error>> {
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        const id = learnedSkillId({ tenantId: scope.tenantId, agentId: scope.agentId, name: input.name });
        insertStmt.run(
          id,
          scope.tenantId,
          scope.agentId,
          input.name,
          input.description,
          input.body,
          input.proofCount,
          input.confidence,
          // strength seeds from confidence (a verified candidate enters with a
          // positive strength budget that demote() draws down).
          input.confidence,
          input.sourceTrajIds.length > 0 ? JSON.stringify([...input.sourceTrajIds]) : null,
          input.mutating ? 1 : 0,
          input.createdAt,
        );
        logger?.debug(
          { step: "learned-skill-admit", id, durationMs: systemNowMs() - startMs },
          "Learned-skill admit complete",
        );
        return ok({ id, admitted: true });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "learned-skill-admit",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "learned-skill admit failed — check DB integrity / the trust CHECK",
          },
          "Learned-skill admit failed",
        );
        return err(error);
      }
    },

    async get(
      name: string,
      scope: LearningScope,
    ): Promise<Result<LearnedSkill | undefined, Error>> {
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      try {
        const parsed = learnedSkillRowMapper.parseOptionalRow(
          getStmt.get(scope.tenantId, scope.agentId, name),
        );
        if (!parsed.ok) return err(new Error(parsed.error.message));
        return ok(parsed.value === undefined ? undefined : rowToSkill(parsed.value));
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "learned-skill-get", err: error, errorKind: "internal" as const, hint: "learned-skill get failed" },
          "Learned-skill get failed",
        );
        return err(error);
      }
    },

    async list(scope: LearningScope): Promise<Result<LearnedSkill[], Error>> {
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        const parsed = learnedSkillRowMapper.parseRows(listStmt.all(scope.tenantId, scope.agentId));
        if (!parsed.ok) return err(new Error(parsed.error.message));
        const skills = parsed.value.map(rowToSkill);
        logger?.debug(
          { step: "learned-skill-list", count: skills.length, durationMs: systemNowMs() - startMs },
          "Learned-skill list complete",
        );
        return ok(skills);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "learned-skill-list", err: error, errorKind: "internal" as const, hint: "learned-skill list failed" },
          "Learned-skill list failed",
        );
        return err(error);
      }
    },

    async promote(
      id: string,
      scope: LearningScope,
      promoteAtProofCount: number,
    ): Promise<Result<void, Error>> {
      // Dedicated bind path (NOT runTransition): the threshold is the FIRST `?`,
      // then (now, tenant, agent, id). proof_count bumps unconditionally; the
      // candidate→active flip gates on proof_count + 1 >= promoteAtProofCount (D2).
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        const now = scope.now ?? systemNowMs();
        promoteStmt.run(promoteAtProofCount, now, scope.tenantId, scope.agentId, id);
        logger?.debug(
          { step: "learned-skill-promote", id, promoteAtProofCount, durationMs: systemNowMs() - startMs },
          "Learned-skill promote complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "learned-skill-promote", id, err: error, errorKind: "internal" as const, hint: "learned-skill promote failed" },
          "Learned-skill promote failed",
        );
        return err(error);
      }
    },

    async demote(id: string, scope: LearningScope): Promise<Result<void, Error>> {
      return runTransition("learned-skill-demote", demoteStmt, id, scope);
    },

    async evict(id: string, scope: LearningScope): Promise<Result<void, Error>> {
      // Soft-close: evict binds the eviction timestamp first, then the
      // updated_at (both = the injected clock), then the scope+id.
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      try {
        const now = scope.now ?? systemNowMs();
        evictStmt.run(now, now, scope.tenantId, scope.agentId, id);
        logger?.debug({ step: "learned-skill-evict", id }, "Learned-skill evict (soft) complete");
        return ok(undefined);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "learned-skill-evict", err: error, errorKind: "internal" as const, hint: "learned-skill evict failed" },
          "Learned-skill evict failed",
        );
        return err(error);
      }
    },
  };

  /** Shared scoped-UPDATE runner for demote (updated_at = injected clock). promote
   *  has its own bind path because it binds the proof-bar threshold first. */
  function runTransition(
    step: string,
    stmt: Database.Statement,
    id: string,
    scope: LearningScope,
  ): Result<void, Error> {
    const rejected = rejectUnresolvedScope(scope);
    if (rejected) return rejected;
    try {
      const now = scope.now ?? systemNowMs();
      stmt.run(now, scope.tenantId, scope.agentId, id);
      logger?.debug({ step, id }, "Learned-skill transition complete");
      return ok(undefined);
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger?.warn(
        { step, err: error, errorKind: "internal" as const, hint: "learned-skill transition failed" },
        "Learned-skill transition failed",
      );
      return err(error);
    }
  }
}
