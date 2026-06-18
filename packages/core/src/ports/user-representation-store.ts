// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { UserRepresentationType } from "../domain/memory-entry.js";

/**
 * UserRepresentationStore: the SEGREGATED hexagonal boundary for the per-user
 * representation profile. A representation entry
 * is a durable, PREFIX-TYPED (`identity`/`preference`/`relationship`/
 * `instruction`), HIGH-TRUST fact about a single user, scoped to one
 * (tenant, agent, user) — Honcho's "representation" read, built by an offline
 * LLM job and injected LLM-free into the prompt.
 *
 * This is a NEW port — like MemoryCausalStore / TripleStorePort it deliberately
 * does NOT widen the security-reviewed `MemoryPort` (store/search/delete). New
 * capabilities arrive as their own segregated port. The sole adapter is in
 * @comis/memory (it owns the `db` handle and runs all SQL over the additive
 * `user_representation` table); the agent-side write path (the offline
 * profile-builder job) and read path (prompt-assembly's LLM-free
 * profile-injection block) consume this port TYPE from @comis/core — they cannot
 * import @comis/memory (the agent↛memory build cut). No new authority is granted
 * beyond write/read within the caller's own (tenant, agent, user) scope.
 *
 * It carries the WRITE (`upsert`) and the scoped READ (`read`) — the dual
 * write+read shape of MemoryCausalStore / TripleStorePort (NOT a split
 * read/write port).
 *
 * This file is type-only (mirrors memory-causal-store.ts / triple-store.ts):
 * no zod, no @comis/memory import.
 */

/**
 * The isolation boundary for every representation operation — the TripleScope
 * pattern, extended with `userId`. Every adapter statement —
 * INSERT, UPDATE, SELECT — filters on `(tenantId, agentId, userId)`. This is a
 * load-bearing SECURITY scope in a multi-agent, multi-user DB, not a nicety: a
 * representation entry written under one (tenant, agent, user) must NEVER be
 * returned for another scope. It is the TripleScope 2-way scope EXTENDED with
 * `userId` (the per-user partition that is the point of this port).
 */
export interface UserRepresentationScope {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /** User partition (the per-user isolation boundary). */
  userId: string;
  /**
   * Injected wall-clock epoch milliseconds for the write's bookkeeping
   * (`created_at`, and the `updated_at` stamp on an upsert of an existing
   * entry). NEVER `Date.now()` — the caller supplies it from an injected clock
   * so the write path stays deterministic/testable. The READ does not need it
   * (mirror TripleStorePort.asOf's `Omit<…, "now">`).
   */
  now: number;
}

/**
 * The HIGH-TRUST floor for a representation entry, as a TYPE. DISTINCT
 * from the full `TripleTrust` ladder (`system`/`learned`/`external`): `external`
 * is STRUCTURALLY ABSENT here. The profile is built only from high-trust
 * sources — an LLM-produced entry cannot type a forbidden trust value at the
 * contract layer (defense-in-depth with the DB CHECK in the adapter).
 * Trust is CODE-computed, never LLM-chosen.
 */
export type UserRepresentationTrust = "system" | "learned";

/**
 * A representation entry to write. `content` is the
 * conversation-derived (untrusted) profile text — DATA, never SQL; the adapter
 * binds every value as a `?` parameter and runs it through the redaction
 * firewall + `validateMemoryWrite`. `trust` admits ONLY the
 * high-trust floor (the LLM has no say — it is code-computed).
 */
export interface UserRepresentationInput {
  /** The prefix type (identity/preference/relationship/instruction). */
  entryType: UserRepresentationType;
  /** The profile text (untrusted, redaction-checked at the adapter). */
  content: string;
  /** Trust on the HIGH-TRUST floor — `external` is structurally excluded. */
  trust: UserRepresentationTrust;
  /** Provenance: the originating memory id (ON DELETE CASCADE in the table). */
  sourceMemoryId?: string;
}

/**
 * The decided branch of a {@link UserRepresentationStore.revise} call — the
 * AUTHORITATIVE per-slot resolution the adapter actually took, returned so the
 * caller's telemetry counts what was PERSISTED (REVISE-01/OBS-01) rather than
 * re-deriving the classification with a divergent heuristic:
 * - `inserted`              — no same-slot incumbent (or a topic-distinct coexist):
 *                             a NEW current-truth row was written.
 * - `corroborated`          — a same-belief near-restatement: the incumbent's
 *                             confidence was bumped IN PLACE; NO new row was written.
 * - `superseded`            — a higher/equal-trust contradiction: the incumbent was
 *                             soft-closed and `entry` written as the new current-truth.
 * - `recorded-not-believed` — a LOWER-trust contradiction (anti-poison): the
 *                             incumbent stays current; `entry` was NOT persisted.
 *
 * The agent cannot import the adapter (the agent↛memory build cut); this shared
 * type is how the adapter's real decision crosses the port boundary so the offline
 * builder's `learning:user_model_revised` counts match the action exactly.
 */
export type ReviseOutcome = "inserted" | "corroborated" | "superseded" | "recorded-not-believed";

/**
 * A representation entry read back — the input shape plus the
 * adapter-assigned identity + bookkeeping timestamps.
 */
export interface UserRepresentationEntry extends UserRepresentationInput {
  /** The stable row id assigned by the adapter. */
  id: string;
  /** Epoch ms the entry was first written (the injected-clock `now`). */
  createdAt: number;
  /** Epoch ms of the last upsert that touched this entry (absent if never updated). */
  updatedAt?: number;
  /**
   * REVISE-02 (Phase 203): the valid-time window for the asOf projection.
   * `validFrom` = epoch ms the entry became believed (mirrors `memory_triples.t_valid_start`;
   * absent on rows predating bi-temporal columns = valid-since-creation). `validTo`
   * null/undefined = CURRENT truth; a non-null value = the epoch ms the entry was
   * soft-closed (superseded). Surfaced ONLY by the explicit `asOf()` read — `read()`
   * returns current-truth (validTo IS NULL) only.
   */
  validFrom?: number;
  /** REVISE-02: epoch ms this entry was soft-closed (superseded); null/undefined = current truth. */
  validTo?: number;
}

export interface UserRepresentationStore {
  /**
   * WRITE PATH. Upsert one representation entry under the caller's
   * (tenant, agent, user) scope. The adapter binds every value as a `?`
   * parameter, enforces the high-trust floor + redaction-clean + the
   * `validateMemoryWrite` boundary, and is idempotent (re-upserting an unchanged
   * entry writes 0 new rows). Deterministic,
   * one synchronous transaction; the timestamp comes from `scope.now`.
   *
   * NOTE: this is the type contract only. The SQLite adapter and the offline
   * builder that produces entries are implemented separately.
   */
  upsert(
    entry: UserRepresentationInput,
    scope: UserRepresentationScope,
  ): Promise<Result<void, Error>>;

  /**
   * READ PATH. The LLM-free profile read: the representation entries
   * for the caller's (tenant, agent, user) scope ONLY, capped by `cap` (a sane
   * default bound). Takes `Omit<UserRepresentationScope, "now">` — no clock is
   * needed to read (mirror TripleStorePort.asOf). This is the deterministic read
   * the prompt-assembly injection block consumes with NO model
   * call (the milestone's #1 binding constraint — the recall hot path stays
   * LLM-free). Returns an empty array when the user has no profile (the
   * default-OFF byte-identity no-op).
   *
   * NOTE: this is the type contract only; the scoped SELECT is implemented
   * separately.
   */
  read(
    scope: Omit<UserRepresentationScope, "now">,
    cap?: number,
  ): Promise<Result<UserRepresentationEntry[], Error>>;

  /**
   * REVISE-01 WRITE PATH (the bi-temporal trust-first supersession). Classifies
   * `entry` vs the live incumbent for (tenant, agent, user, entryType): a
   * corroboration bumps confidence (no new row); a higher/equal-trust contradiction
   * soft-closes the incumbent (sets t_valid_end + expired_at, NEVER deletes) and
   * inserts `entry` as current-truth; a LOWER-trust contradiction is recorded-not-believed
   * (anti-poison). One synchronous db.transaction (throw → rollback). Same high-trust
   * floor + validateMemoryWrite boundary as upsert(). Bounded per-record history
   * (oldest superseded rows beyond historyCap trimmed). Type contract only.
   *
   * Returns the AUTHORITATIVE {@link ReviseOutcome} the adapter took (the decided
   * branch), so the caller's telemetry counts what was actually PERSISTED instead of
   * re-deriving the classification — the single source of truth for the
   * `learning:user_model_revised` counts (REVISE-01/OBS-01).
   */
  revise(
    entry: UserRepresentationInput,
    scope: UserRepresentationScope,
  ): Promise<Result<ReviseOutcome, Error>>;

  /**
   * REVISE-02 bi-temporal AS-OF read. Returns the entries BELIEVED true at epoch `t`
   * (mode "valid", default: t_valid_start <= t AND (t_valid_end IS NULL OR t_valid_end > t))
   * or RECORDED as of `t` (mode "txn": created_at <= t AND (expired_at IS NULL OR expired_at > t)),
   * for the caller's (tenant, agent, user) scope ONLY. Superseded history is reachable ONLY here;
   * read() returns current-truth (t_valid_end IS NULL) only. Type contract only.
   */
  asOf(
    t: number,
    scope: Omit<UserRepresentationScope, "now">,
    mode?: "valid" | "txn",
  ): Promise<Result<UserRepresentationEntry[], Error>>;
}
