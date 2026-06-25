// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMentalModelStore: the SOLE adapter for the segregated
 * `MentalModelStorePort` (@comis/core, the v2.31 Mental Model doc store
 * generalized from the v2.26 Verified Learning WS2 / SKILL-01 procedural store).
 * It owns ALL the `mental_models` SQL — the idempotent `admit()` upsert (one row
 * per admitted doc), the scoped `get`/`list(scope, kind?)` reads, and the
 * `promote`/`demote`/`evict` lifecycle transitions.
 *
 * ## Idempotency (SKILL-01 / T-201-09)
 *
 * `admit()` derives the row `id` as a deterministic sha256 hash of the UNIQUE
 * tuple `(tenant_id, agent_id, kind, topic_key, name)` in CODE before insert, AND
 * inserts `ON CONFLICT(id) DO UPDATE`. A re-admit of the same tuple is a
 * no-op-plus-refresh: the hash-id collides so it upserts the SAME primary key even
 * if the row was previously deleted/evicted (replay-stable), and the
 * `UNIQUE (tenant_id, agent_id, kind, topic_key, name)` backstop catches it
 * regardless.
 *
 * ## Trust ceiling (SEC-01 / T-201-05) — the keystone
 *
 * A learned doc can NEVER be `system`. The store writes the LITERAL `'learned'`
 * for `trust_level` on EVERY admit (it never reads a caller-supplied trust), and
 * the DB `CHECK (trust_level IN ('learned'))` rejects any other value at insert
 * time — belt (code coercion) AND suspenders (DB constraint).
 *
 * ## Isolation is the load-bearing security boundary (SEC-01 / T-201-06)
 *
 * Comis runs many agents in one DB. EVERY statement filters on
 * `(tenant_id, agent_id)` — parameterized — and the table keys/indexes lead on
 * those columns, so a doc under one (tenant, agent) is NEVER visible to a read
 * under another even when `name` is byte-identical. An UNRESOLVED
 * `(tenant, agent)` scope (empty id) fails-closed with `err(...)` — it NEVER
 * widens to a shared/global pool (the `get_current_schema()` leak vector,
 * T-201-07). The optional `kind` filter on `list()` is an ADDITIONAL `AND`, never
 * a replacement for the scope filter.
 *
 * ## Soft lifecycle (never hard-delete)
 *
 * `evict()` sets `evicted_at` (and steps `state` to `archived`); it NEVER issues a
 * `DELETE` — an evicted doc stops surfacing but its provenance survives.
 *
 * ## Untrusted input
 *
 * Every id reaches SQL as a bound `?` parameter — never concatenated — and every
 * read parses through `createRowMapper` (no `as Foo[]` casts; `untyped-sqlite.test.ts`).
 * The persisted JSON columns (`source_traj_ids` etc.) are parsed with a
 * graceful-degrade `safeParse` (corrupt JSON → empty list, never a throw). Logs
 * carry counts/ids + metadata only — never doc bodies/descriptions
 * (§2.7 / T-201-10).
 *
 * @module
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  MentalModelStorePort,
  MentalModel,
  AdmitMentalModelInput,
  LearningScope,
  StructuredBody,
} from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";
import { MentalModelRowSchema } from "./mental-model-row-schema.js";

/** Minimal pino-compatible logger (mirrors sqlite-outcome-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteMentalModelStore}. */
export interface MentalModelStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`).
const mentalModelRowMapper = createRowMapper(MentalModelRowSchema);

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

// Lenient parser for the structured_body AST column (the v2.31 Reflection
// section-list). The shape mirrors @comis/core's StructuredBody — a NULL column,
// non-JSON text, or a payload that does not match the shape degrades to
// `undefined` (NOT a throw — T-223-09: a corrupt AST row must not crash recall;
// the doc is treated as "no AST" and re-synthesized).
const StructuredBodySchema = z.object({
  sections: z.array(
    z.object({ id: z.string(), heading: z.string(), body: z.string() }),
  ),
});

/** Parse a nullable JSON-encoded structured-body AST; undefined on NULL or corrupt data. */
function parseStructuredBody(raw: string | null): StructuredBody | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = StructuredBodySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compute the deterministic row id from the UNIQUE
 * `(tenant, agent, kind, topic_key, name)` tuple. A stable sha256 hex of the
 * space-joined fields — never a wall-clock or random id, so a re-admit of the
 * same tuple yields the SAME id (the idempotency backstop beyond the UNIQUE
 * constraint; replay-stable even after a row deletion). For a skill the key is
 * `(tenant, agent, 'skill', '', name)`. The `createHash` precedent is
 * `sqlite-outcome-store.ts:outcomeRowId`.
 */
function mentalModelId(s: {
  tenantId: string;
  agentId: string;
  kind: string;
  topicKey: string;
  name: string;
}): string {
  return createHash("sha256")
    .update([s.tenantId, s.agentId, s.kind, s.topicKey, s.name].join(" "))
    .digest("hex");
}

/** Map a parsed `mental_models` row to the domain {@link MentalModel}. */
function rowToMentalModel(row: z.infer<typeof MentalModelRowSchema>): MentalModel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    kind: row.kind as MentalModel["kind"],
    topicKey: row.topic_key,
    // The DB CHECK guarantees 'learned'; the literal cast mirrors the type-layer
    // keystone (a learned doc is never `system`).
    trustLevel: "learned",
    state: row.state as MentalModel["state"],
    proofCount: row.proof_count,
    confidence: row.confidence,
    mutating: row.mutating === 1,
    sourceTrajIds: parseIdList(row.source_traj_ids),
    // The Reflection section-AST (REFLECT-04) — lenient parse so delta-ops read
    // the prior doc; undefined when the column is NULL or holds garbage (the
    // doc is then treated as new — synthesize fresh, A6). `history` stays DB-only
    // (Phase 224 supersession) — NOT surfaced here.
    structuredBody: parseStructuredBody(row.structured_body),
    createdAt: row.created_at,
  };
}

/**
 * Create the SQLite-backed {@link MentalModelStorePort} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it. Built
 * UNCONDITIONALLY (no model/IO cost, like every dormant store); the per-agent
 * enable flag gates the daemon-side `admit`/`get`/`list` call (Plan 07), not
 * construction.
 */
export function createSqliteMentalModelStore(
  deps: MentalModelStoreDeps,
): MentalModelStorePort {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // Idempotent admit keyed on the deterministic id (= hash of the
  // (tenant_id, agent_id, kind, topic_key, name) UNIQUE tuple). A re-admit upserts
  // the SAME row. trust_level is the LITERAL 'learned' (the SEC-01 keystone —
  // never a bound caller value); all other columns are bound `?` params (never
  // string-built). kind/topic_key are bound (default 'skill'/'' at the call site).
  // structured_body (the v2.31 Reflection section-AST, REFLECT-04) is bound as a
  // JSON `?` (NULL when the caller omits it) and updated in lockstep with body on
  // conflict. `history` stays the DB default NULL (Phase 224 owns supersession).
  // The dropped `scripts` column was the literal NULL — its removal is a no-op.
  const insertStmt = db.prepare(
    "INSERT INTO mental_models " +
      "(id, tenant_id, agent_id, kind, topic_key, name, description, body, structured_body, required_tools, params_schema, " +
      " trust_level, state, proof_count, confidence, strength, source_traj_ids, validation_result, " +
      " mutating, pinned, validated_at, created_at, updated_at, evicted_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'learned', 'candidate', ?, ?, ?, ?, NULL, ?, 0, NULL, ?, NULL, NULL) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "description = excluded.description, body = excluded.body, " +
      "structured_body = excluded.structured_body, proof_count = excluded.proof_count, " +
      "confidence = excluded.confidence, strength = excluded.strength, " +
      "source_traj_ids = excluded.source_traj_ids, mutating = excluded.mutating, " +
      // A re-admit of a previously-evicted doc resurrects it (clears evicted_at,
      // resets state to candidate) — the replay-stable path.
      "state = 'candidate', evicted_at = NULL, updated_at = excluded.created_at",
  );

  // Scoped reads — the `tenant_id = ? AND agent_id = ?` filter is the
  // load-bearing isolation boundary (SEC-01); every value is a bound `?` param.
  // SELECT_COLS drops `scripts` and adds kind/topic_key/structured_body/history —
  // kept in lockstep with the MentalModelRowSchema strictObject (a drift throws).
  const SELECT_COLS =
    "id, name, description, kind, topic_key, trust_level, state, body, structured_body, history, " +
    "required_tools, params_schema, mutating, pinned, proof_count, confidence, strength, " +
    "source_traj_ids, validation_result, evicted_at, created_at, updated_at";
  // get(): exclude soft-evicted rows (evicted_at IS NULL) so an evicted doc
  // stops surfacing.
  const getStmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM mental_models ` +
      "WHERE tenant_id = ? AND agent_id = ? AND name = ? AND evicted_at IS NULL",
  );
  // list(scope): all kinds within the scope.
  const listStmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM mental_models ` +
      "WHERE tenant_id = ? AND agent_id = ? AND evicted_at IS NULL ORDER BY created_at ASC, id ASC",
  );
  // list(scope, kind): the kind filter is an ADDITIONAL `AND` over the scope.
  const listByKindStmt = db.prepare(
    `SELECT ${SELECT_COLS} FROM mental_models ` +
      "WHERE tenant_id = ? AND agent_id = ? AND kind = ? AND evicted_at IS NULL ORDER BY created_at ASC, id ASC",
  );

  // Lifecycle transitions — all scoped to (tenant, agent) AND id (bound params).
  // promote: proof_count bumps on EVERY call, but the candidate→active flip is
  // GATED on the caller's proof bar — `proof_count + 1 >= promoteAtProofCount`
  // (D2 / T-202-04: a single attributed success must NOT mint an active
  // doc). The threshold is the FIRST bound `?` (promote runs its own bind
  // path, not the shared runTransition); an already-active doc keeps bumping
  // proof_count but the `state = 'candidate'` guard means its state never moves.
  const promoteStmt = db.prepare(
    "UPDATE mental_models SET proof_count = proof_count + 1, " +
      "state = CASE WHEN state = 'candidate' AND proof_count + 1 >= ? THEN 'active' ELSE state END, " +
      "updated_at = ? WHERE tenant_id = ? AND agent_id = ? AND id = ?",
  );
  // demote: step state back toward stale on a verified failure (soft, monotone).
  // WR-06: the WHERE pins `state IN ('active','candidate')` — the ONLY states a demote
  // moves. A terminal-state row (stale/archived) therefore matches 0 rows, so the
  // `updated_at` rewrite never inflates `info.changes` into a phantom transition and
  // demoteByName's `changed` reflects a REAL state delta (not a no-op write). The CASE
  // is now redundant with the guard but kept for defence-in-depth / readability.
  const demoteStmt = db.prepare(
    "UPDATE mental_models SET " +
      "state = CASE WHEN state = 'active' THEN 'stale' WHEN state = 'candidate' THEN 'stale' ELSE state END, " +
      "strength = CASE WHEN strength > 0 THEN strength - 1 ELSE strength END, " +
      "updated_at = ? WHERE tenant_id = ? AND agent_id = ? AND id = ? AND state IN ('active', 'candidate')",
  );
  // evict: SOFT — set evicted_at + archive; NEVER a hard DELETE (provenance survives).
  const evictStmt = db.prepare(
    "UPDATE mental_models SET evicted_at = ?, state = 'archived', updated_at = ? " +
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
      input: AdmitMentalModelInput,
      scope: LearningScope,
    ): Promise<Result<{ id: string; admitted: boolean }, Error>> {
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        // kind/topicKey default to the skill values when omitted (a skill admit
        // is unchanged); the widened id joins them so distinct kinds/topics never
        // collide on the same (tenant, agent, name).
        const kind = input.kind ?? "skill";
        const topicKey = input.topicKey ?? "";
        const id = mentalModelId({
          tenantId: scope.tenantId,
          agentId: scope.agentId,
          kind,
          topicKey,
          name: input.name,
        });
        insertStmt.run(
          id,
          scope.tenantId,
          scope.agentId,
          kind,
          topicKey,
          input.name,
          input.description,
          input.body,
          // structured_body: JSON-stringify the AST, or NULL when omitted. Updated
          // in lockstep with body on the idempotent ON CONFLICT upsert (REFLECT-04).
          input.structuredBody !== undefined ? JSON.stringify(input.structuredBody) : null,
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
    ): Promise<Result<MentalModel | undefined, Error>> {
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      try {
        const parsed = mentalModelRowMapper.parseOptionalRow(
          getStmt.get(scope.tenantId, scope.agentId, name),
        );
        if (!parsed.ok) return err(new Error(parsed.error.message));
        return ok(parsed.value === undefined ? undefined : rowToMentalModel(parsed.value));
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "learned-skill-get", err: error, errorKind: "internal" as const, hint: "learned-skill get failed" },
          "Learned-skill get failed",
        );
        return err(error);
      }
    },

    async list(
      scope: LearningScope,
      kind?: "skill" | "profile" | "topic",
    ): Promise<Result<MentalModel[], Error>> {
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        // The kind branch binds the ADDITIONAL `AND kind = ?`; the no-kind branch
        // returns every kind within the scope.
        const rows =
          kind === undefined
            ? listStmt.all(scope.tenantId, scope.agentId)
            : listByKindStmt.all(scope.tenantId, scope.agentId, kind);
        const parsed = mentalModelRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));
        const docs = parsed.value.map(rowToMentalModel);
        logger?.debug(
          { step: "learned-skill-list", count: docs.length, durationMs: systemNowMs() - startMs },
          "Learned-skill list complete",
        );
        return ok(docs);
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

    async promoteByName(
      name: string,
      scope: LearningScope,
      promoteAtProofCount: number,
    ): Promise<Result<{ changed: boolean }, Error>> {
      // Resolve the NAME → the deterministic hash id the lifecycle WHERE keys on
      // (the same derivation admit() uses — one place, never duplicated by the
      // caller). promoteByName resolves a SKILL by name, so kind/topicKey are the
      // skill defaults (byte-identity with the pre-generalization id). Then run
      // promote's dedicated bind path and report rows-changed so a 0-row write
      // (an unknown/evicted name) is detectable (not a silent lie).
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        const id = mentalModelId({
          tenantId: scope.tenantId,
          agentId: scope.agentId,
          kind: "skill",
          topicKey: "",
          name,
        });
        const now = scope.now ?? systemNowMs();
        const info = promoteStmt.run(promoteAtProofCount, now, scope.tenantId, scope.agentId, id);
        const changed = info.changes > 0;
        logger?.debug(
          { step: "learned-skill-promote-by-name", id, changed, promoteAtProofCount, durationMs: systemNowMs() - startMs },
          "Learned-skill promoteByName complete",
        );
        return ok({ changed });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "learned-skill-promote-by-name", err: error, errorKind: "internal" as const, hint: "learned-skill promoteByName failed" },
          "Learned-skill promoteByName failed",
        );
        return err(error);
      }
    },

    async demoteByName(name: string, scope: LearningScope): Promise<Result<{ changed: boolean }, Error>> {
      // Resolve the NAME → the hash id (same derivation as admit/promote; the
      // skill defaults), run demote, and report rows-changed so an unknown/evicted
      // name (0 rows) is never counted as a real demote.
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        const id = mentalModelId({
          tenantId: scope.tenantId,
          agentId: scope.agentId,
          kind: "skill",
          topicKey: "",
          name,
        });
        const now = scope.now ?? systemNowMs();
        const info = demoteStmt.run(now, scope.tenantId, scope.agentId, id);
        const changed = info.changes > 0;
        logger?.debug(
          { step: "learned-skill-demote-by-name", id, changed, durationMs: systemNowMs() - startMs },
          "Learned-skill demoteByName complete",
        );
        return ok({ changed });
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "learned-skill-demote-by-name", err: error, errorKind: "internal" as const, hint: "learned-skill demoteByName failed" },
          "Learned-skill demoteByName failed",
        );
        return err(error);
      }
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
