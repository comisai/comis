// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMentalModelStore: the SOLE adapter for the segregated
 * `MentalModelStorePort` (@comis/core) — the Mental Model doc store that holds
 * learned skill/profile/topic docs.
 * It owns ALL the `mental_models` SQL — the idempotent `admit()` upsert (one row
 * per admitted doc), the scoped `get`/`list(scope, kind?)` reads, and the
 * `promote`/`demote`/`evict` lifecycle transitions.
 *
 * ## Idempotency
 *
 * `admit()` derives the row `id` as a deterministic sha256 hash of the UNIQUE
 * tuple `(tenant_id, agent_id, kind, topic_key, name)` in CODE before insert, AND
 * inserts `ON CONFLICT(id) DO UPDATE`. A re-admit of the same tuple is a
 * no-op-plus-refresh: the hash-id collides so it upserts the SAME primary key even
 * if the row was previously deleted/evicted (replay-stable), and the
 * `UNIQUE (tenant_id, agent_id, kind, topic_key, name)` backstop catches it
 * regardless.
 *
 * ## Trust ceiling — the keystone
 *
 * A learned doc can NEVER be `system`. The store writes the LITERAL `'learned'`
 * for `trust_level` on EVERY admit (it never reads a caller-supplied trust), and
 * the DB `CHECK (trust_level IN ('learned'))` rejects any other value at insert
 * time — belt (code coercion) AND suspenders (DB constraint).
 *
 * ## Isolation is the load-bearing security boundary
 *
 * Comis runs many agents in one DB. EVERY statement filters on
 * `(tenant_id, agent_id)` — parameterized — and the table keys/indexes lead on
 * those columns, so a doc under one (tenant, agent) is NEVER visible to a read
 * under another even when `name` is byte-identical. An UNRESOLVED
 * `(tenant, agent)` scope (empty id) fails-closed with `err(...)` — it NEVER
 * widens to a shared/global pool (the `get_current_schema()` leak vector). The
 * optional `kind` filter on `list()` is an ADDITIONAL `AND`, never a replacement
 * for the scope filter.
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
 * (AGENTS.md §2.7).
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
import { systemNowMs, validateMemoryWrite } from "@comis/core";
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

// Lenient parser for the structured_body AST column (the Reflection
// section-list). The shape mirrors @comis/core's StructuredBody — a NULL column,
// non-JSON text, or a payload that does not match the shape degrades to
// `undefined` (NOT a throw: a corrupt AST row must not crash recall;
// the doc is treated as "no AST" and re-synthesized).
const StructuredBodySchema = z.object({
  sections: z.array(
    z.object({ id: z.string(), heading: z.string(), body: z.string() }),
  ),
  // The cluster's common-core opening-request tokens for reuse attribution. Optional —
  // legacy/seeded docs omit it. Kept on parse (a plain z.object strips unknown keys, so it
  // MUST be declared here to round-trip on read).
  topicTokens: z.array(z.string()).optional(),
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

/** One prior-body history entry (the supersede trail). */
type HistoryEntry = { previousContent: string; changedAt: number };

// The canonical `mental_models.history` JSON shape — an
// ordered (oldest-first) array of prior bodies, mirroring the
// `SqliteMemoryAdapter` `SupersedeHistorySchema` byte-for-byte
// ({ previousContent, changedAt }). A strictObject so a malformed/legacy column
// degrades to "absent" (→ a fresh array in supersede / undefined in get) instead
// of throwing — never blocking a correction (or a read) on a corrupt payload.
const HistorySchema = z.array(
  z.strictObject({ previousContent: z.string(), changedAt: z.number().int().positive() }),
);

/**
 * Parse a nullable JSON-encoded `history` column into the typed prior-body array,
 * or `undefined` when the column is NULL / corrupt (degrade-to-absent, mirrors
 * `parseStructuredBody` / the adapter's `parseHistoryColumn`). supersede() then starts a
 * fresh array, so a damaged column self-heals on the next correction.
 */
function parseHistoryColumn(raw: string | null): HistoryEntry[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = HistorySchema.safeParse(JSON.parse(raw));
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
    // The Reflection section-AST — lenient parse so delta-ops read
    // the prior doc; undefined when the column is NULL or holds garbage (the
    // doc is then treated as new — synthesize fresh).
    structuredBody: parseStructuredBody(row.structured_body),
    // The supersede trail — lenient parse; undefined when the
    // column is NULL (never superseded) or corrupt (degrade-to-absent).
    history: parseHistoryColumn(row.history),
    createdAt: row.created_at,
  };
}

/**
 * Create the SQLite-backed {@link MentalModelStorePort} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it. Built
 * UNCONDITIONALLY (no model/IO cost, like every dormant store); the per-agent
 * enable flag gates the daemon-side `admit`/`get`/`list` call, not
 * construction.
 */
export function createSqliteMentalModelStore(
  deps: MentalModelStoreDeps,
): MentalModelStorePort {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // Idempotent admit keyed on the deterministic id (= hash of the
  // (tenant_id, agent_id, kind, topic_key, name) UNIQUE tuple). A re-admit upserts
  // the SAME row. trust_level is the LITERAL 'learned' (the trust-ceiling keystone —
  // never a bound caller value); all other columns are bound `?` params (never
  // string-built). kind/topic_key are bound (default 'skill'/'' at the call site).
  // structured_body (the Reflection section-AST) is bound as a
  // JSON `?` (NULL when the caller omits it) and updated in lockstep with body on
  // conflict. required_tools / params_schema are the DETERMINISTIC advisory metadata
  // the procedure run derives from the AUDITED descriptor — bound `?` (NULL for the
  // user-intent skill path) and updated in lockstep with body too; NEVER the
  // trust_level (that stays the 'learned' LITERAL — the trust keystone). `history`
  // stays the DB default NULL on admit (supersede() owns the trail). The dropped
  // `scripts` column was the literal NULL — its removal is a no-op (no learned code).
  const insertStmt = db.prepare(
    "INSERT INTO mental_models " +
      "(id, tenant_id, agent_id, kind, topic_key, name, description, body, structured_body, required_tools, params_schema, " +
      " trust_level, state, proof_count, confidence, strength, source_traj_ids, validation_result, " +
      " mutating, pinned, validated_at, created_at, updated_at, evicted_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'learned', 'candidate', ?, ?, ?, ?, NULL, ?, 0, NULL, ?, NULL, NULL) " +
      "ON CONFLICT(id) DO UPDATE SET " +
      "description = excluded.description, body = excluded.body, " +
      "structured_body = excluded.structured_body, required_tools = excluded.required_tools, " +
      "params_schema = excluded.params_schema, proof_count = excluded.proof_count, " +
      "confidence = excluded.confidence, strength = excluded.strength, " +
      "source_traj_ids = excluded.source_traj_ids, mutating = excluded.mutating, " +
      // A re-admit of a previously-evicted doc resurrects it (clears evicted_at,
      // resets state to candidate) — the replay-stable path.
      "state = 'candidate', evicted_at = NULL, updated_at = excluded.created_at",
  );

  // Scoped reads — the `tenant_id = ? AND agent_id = ?` filter is the
  // load-bearing isolation boundary; every value is a bound `?` param.
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
  // (a single attributed success must NOT mint an active
  // doc). The threshold is the FIRST bound `?` (promote runs its own bind
  // path, not the shared runTransition); an already-active doc keeps bumping
  // proof_count but the `state = 'candidate'` guard means its state never moves.
  const promoteStmt = db.prepare(
    "UPDATE mental_models SET proof_count = proof_count + 1, " +
      "state = CASE WHEN state = 'candidate' AND proof_count + 1 >= ? THEN 'active' ELSE state END, " +
      "updated_at = ? WHERE tenant_id = ? AND agent_id = ? AND id = ?",
  );
  // promoteByName keys on the NAME (not the re-derived id) — a reflected
  // doc is admitted WITH a non-empty topicKey, so re-deriving the id with an assumed
  // `topicKey:''` MISSES it. The reflection job names a doc `skill-<full-topicKey>`
  // (the FULL topicKey, not a 16-char truncation), so the name EMBEDS the
  // unique topic_key and is therefore unique per (tenant, agent, kind) — a name-keyed
  // UPDATE resolves the SAME single row get() does, with no truncation-collision risk.
  // Identical proof-bar CASE to promoteStmt; only the WHERE key differs (name vs id).
  const promoteByNameStmt = db.prepare(
    "UPDATE mental_models SET proof_count = proof_count + 1, " +
      "state = CASE WHEN state = 'candidate' AND proof_count + 1 >= ? THEN 'active' ELSE state END, " +
      "updated_at = ? WHERE tenant_id = ? AND agent_id = ? AND name = ?",
  );
  // demote: step state back toward stale on a verified failure (soft, monotone).
  // The WHERE pins `state IN ('active','candidate')` — the ONLY states a demote
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
  // demoteByName keys on the NAME (not the re-derived id) — the mirror of
  // promoteByNameStmt. Same monotone state step + the `state IN
  // ('active','candidate')` terminal-state guard; only the WHERE key differs.
  const demoteByNameStmt = db.prepare(
    "UPDATE mental_models SET " +
      "state = CASE WHEN state = 'active' THEN 'stale' WHEN state = 'candidate' THEN 'stale' ELSE state END, " +
      "strength = CASE WHEN strength > 0 THEN strength - 1 ELSE strength END, " +
      "updated_at = ? WHERE tenant_id = ? AND agent_id = ? AND name = ? AND state IN ('active', 'candidate')",
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
          // in lockstep with body on the idempotent ON CONFLICT upsert.
          input.structuredBody !== undefined ? JSON.stringify(input.structuredBody) : null,
          // required_tools / params_schema: the DETERMINISTIC advisory metadata (bound only on
          // the procedure run — NULL for the user-intent skill path). required_tools is the
          // JSON-encoded content-free tool-NAME set; params_schema is the fixed content-free
          // string. NEVER the trust_level (the 'learned' LITERAL above is the trust keystone).
          input.requiredTools !== undefined ? JSON.stringify([...input.requiredTools]) : null,
          input.paramsSchema !== undefined ? input.paramsSchema : null,
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
      // Resolve the row by `(tenant, agent, name)` — the SAME key get() resolves by.
      // The reuse loop holds only the skill NAME, and a reflected doc is admitted WITH a
      // non-empty topicKey, so re-deriving the id with a hardcoded `topicKey:''` would MISS
      // any reflected doc (and `changed` would always be false). The reflection name embeds
      // the FULL topicKey (`skill-<full-topicKey>`), so the name is unique per (tenant, agent,
      // kind) — a name-keyed UPDATE finds the SINGLE row get() resolves by (no 16-char
      // truncation collision). Reports rows-changed so a 0-row write (an unknown/
      // evicted name) stays detectable.
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        const now = scope.now ?? systemNowMs();
        const info = promoteByNameStmt.run(promoteAtProofCount, now, scope.tenantId, scope.agentId, name);
        const changed = info.changes > 0;
        logger?.debug(
          { step: "learned-skill-promote-by-name", name, changed, promoteAtProofCount, durationMs: systemNowMs() - startMs },
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
      // Resolve the row by `(tenant, agent, name)` — the mirror of promoteByName.
      // Re-deriving the id with `topicKey:''` would miss any reflected doc
      // (non-empty topicKey); the reflection name embeds the FULL topicKey
      // (`skill-<full-topicKey>`), so it is unique per (tenant, agent, kind).
      // The terminal-state guard lives in the statement, so an unknown/evicted/
      // stale name yields 0 rows → changed:false (never a phantom transition).
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();
      try {
        const now = scope.now ?? systemNowMs();
        const info = demoteByNameStmt.run(now, scope.tenantId, scope.agentId, name);
        const changed = info.changes > 0;
        logger?.debug(
          { step: "learned-skill-demote-by-name", name, changed, durationMs: systemNowMs() - startMs },
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

    async supersede(
      input: { name: string; body: string; structuredBody?: StructuredBody },
      scope: LearningScope,
      now: number,
    ): Promise<Result<"superseded" | "not-found", Error>> {
      // A profile/topic CORRECTION → UPDATE body (+ structured_body when supplied) and
      // APPEND the prior body to `history` ({previousContent, changedAt}); the row is
      // UPDATEd, never DELETEd (deletion stays reserved for the evict() security path).
      // Mirrors SqliteMemoryAdapter.supersede.
      const rejected = rejectUnresolvedScope(scope);
      if (rejected) return rejected;
      const startMs = systemNowMs();

      // Redaction firewall on the untrusted correction, BEFORE the txn — a
      // CRITICAL classification (dangerous command / secret egress) is REJECTED and
      // never persisted. A `warn` is permitted: a learned doc's trust is the fixed
      // 'learned' (the supersede never touches trust_level), so only `critical` blocks
      // (mirror sqlite-memory-adapter.ts:556 — a learned body already passed
      // validateLearnedDocBody in the engine; this is the store-side belt).
      const verdict = validateMemoryWrite(input.body);
      if (verdict.severity === "critical") {
        logger?.warn(
          {
            step: "mental-model-supersede",
            errorKind: "validation" as const,
            severity: verdict.severity,
            criticalPatterns: verdict.criticalPatterns,
            hint: "correction body failed validateMemoryWrite (redaction firewall) — supersession not applied",
            durationMs: systemNowMs() - startMs,
          },
          "Mental-model supersede rejected (redaction firewall)",
        );
        return err(new Error("mental-model supersede: body failed redaction validation"));
      }

      try {
        // Scoped statements — the (tenant, agent, name) filter is the isolation
        // boundary; every value a bound `?` (NEVER concatenated). The doc is keyed by
        // name within scope (the same key get() resolves by), `evicted_at IS NULL` so a
        // correction never silently revives a soft-evicted doc.
        const selectIncumbent = db.prepare(
          `SELECT body, history FROM mental_models ` +
            "WHERE tenant_id = ? AND agent_id = ? AND name = ? AND evicted_at IS NULL",
        );
        const updateBody = db.prepare(
          "UPDATE mental_models SET body = ?, structured_body = ?, history = ?, updated_at = ? " +
            "WHERE tenant_id = ? AND agent_id = ? AND name = ? AND evicted_at IS NULL",
        );

        // The revise unit — ONE synchronous transaction (mirror the adapter's supersede).
        // better-sqlite3 auto-ROLLBACKs on ANY throw, so SELECT-incumbent →
        // history-append → UPDATE is atomic; a parse fault THROWS → ROLLBACK (caught
        // below → err). The decided branch is returned for the metadata log.
        const tx = db.transaction((): "superseded" | "not-found" => {
          const row = selectIncumbent.get(scope.tenantId, scope.agentId, input.name) as
            | { body: string; history: string | null }
            | undefined;
          // No incumbent under THIS scope (cross-scope correction the WHERE rejects, an
          // unknown name, or a soft-evicted doc) → no-op. NO row written.
          if (row === undefined) return "not-found";
          // Append the prior body (oldest-first), then update. History is appended
          // REGARDLESS of whether body changed — a correction is the durable signal
          // (mirror the adapter's supersede). The mental_models_au/_tri_au WHEN-guarded triggers re-sync the
          // FTS/trigram twins on the body UPDATE (schema-mental-models.ts:226,252) — no
          // NEW trigger work.
          const prior: HistoryEntry[] = [
            ...(parseHistoryColumn(row.history) ?? []),
            { previousContent: row.body, changedAt: now },
          ];
          updateBody.run(
            input.body,
            input.structuredBody !== undefined ? JSON.stringify(input.structuredBody) : null,
            JSON.stringify(prior),
            now,
            scope.tenantId,
            scope.agentId,
            input.name,
          );
          return "superseded";
        });
        const outcome = tx();
        logger?.debug(
          { step: "mental-model-supersede", outcome, durationMs: systemNowMs() - startMs, hint: "mental-model supersede complete (history-append, non-destructive)" },
          "Mental-model supersede complete",
        );
        return ok(outcome);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "mental-model-supersede",
            err: error,
            errorKind: "internal" as const,
            durationMs: systemNowMs() - startMs,
            hint: "mental-model supersede failed — check DB integrity (the transaction rolled back)",
          },
          "Mental-model supersede failed",
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
