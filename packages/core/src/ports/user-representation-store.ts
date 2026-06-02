// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { UserRepresentationType } from "../domain/memory-entry.js";

/**
 * UserRepresentationStore: the SEGREGATED hexagonal boundary for the per-user
 * representation profile (Phase 107, Track E1 — USER-01). A representation entry
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
 * The isolation boundary for every representation operation (T-107-01-03, the
 * §5.2 / ENT-03 pattern, extended with `userId`). Every adapter statement —
 * INSERT, UPDATE, SELECT — filters on `(tenantId, agentId, userId)`. This is a
 * load-bearing SECURITY scope in a multi-agent, multi-user DB, not a nicety: a
 * representation entry written under one (tenant, agent, user) must NEVER be
 * returned for another scope. It is the TripleScope 2-way scope EXTENDED with
 * `userId` (the per-user partition that is the point of this phase).
 */
export interface UserRepresentationScope {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /** User partition (the per-user isolation boundary — the Track E1 point). */
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
 * The HIGH-TRUST floor for a representation entry, as a TYPE (USER-01). DISTINCT
 * from the full `TripleTrust` ladder (`system`/`learned`/`external`): `external`
 * is STRUCTURALLY ABSENT here. The profile is built only from high-trust
 * sources — an LLM-produced entry cannot type a forbidden trust value at the
 * contract layer (T-107-01-01, defense-in-depth with the DB CHECK in Plan 02).
 * Trust is CODE-computed, never LLM-chosen.
 */
export type UserRepresentationTrust = "system" | "learned";

/**
 * A representation entry to write (USER-01). `content` is the
 * conversation-derived (untrusted) profile text — DATA, never SQL; the adapter
 * binds every value as a `?` parameter and runs it through the redaction
 * firewall + `validateMemoryWrite` (Plan 02/03). `trust` admits ONLY the
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
 * A representation entry read back (USER-01) — the input shape plus the
 * adapter-assigned identity + bookkeeping timestamps.
 */
export interface UserRepresentationEntry extends UserRepresentationInput {
  /** The stable row id assigned by the adapter. */
  id: string;
  /** Epoch ms the entry was first written (the injected-clock `now`). */
  createdAt: number;
  /** Epoch ms of the last upsert that touched this entry (absent if never updated). */
  updatedAt?: number;
}

export interface UserRepresentationStore {
  /**
   * WRITE PATH (USER-01). Upsert one representation entry under the caller's
   * (tenant, agent, user) scope. The adapter binds every value as a `?`
   * parameter, enforces the high-trust floor + redaction-clean + the
   * `validateMemoryWrite` boundary, and is idempotent (re-upserting an unchanged
   * entry writes 0 new rows — Plan 03's idempotence contract). Deterministic,
   * one synchronous transaction; the timestamp comes from `scope.now`.
   *
   * NOTE (Plan 107-01): this is the type contract only. The SQLite adapter is
   * implemented in Plan 107-02; the offline builder that produces entries lands
   * in Plan 107-03.
   */
  upsert(
    entry: UserRepresentationInput,
    scope: UserRepresentationScope,
  ): Promise<Result<void, Error>>;

  /**
   * READ PATH (USER-01). The LLM-free profile read: the representation entries
   * for the caller's (tenant, agent, user) scope ONLY, capped by `cap` (a sane
   * default bound). Takes `Omit<UserRepresentationScope, "now">` — no clock is
   * needed to read (mirror TripleStorePort.asOf). This is the deterministic read
   * the prompt-assembly injection block (Plan 107-04) consumes with NO model
   * call (the milestone's #1 binding constraint — the recall hot path stays
   * LLM-free). Returns an empty array when the user has no profile (the
   * default-OFF byte-identity no-op).
   *
   * NOTE (Plan 107-01): this is the type contract only; the scoped SELECT is
   * implemented in Plan 107-02.
   */
  read(
    scope: Omit<UserRepresentationScope, "now">,
    cap?: number,
  ): Promise<Result<UserRepresentationEntry[], Error>>;
}
