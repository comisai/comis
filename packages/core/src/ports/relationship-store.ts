// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";

/**
 * RelationshipStore: the SEGREGATED hexagonal boundary for directional,
 * multi-party relationship modeling. A
 * relationship entry is a durable, DIRECTIONAL, HIGH-TRUST fact — `subjectUser`'s
 * representation OF `aboutUser` — scoped to one (tenant, agent, channel), built by
 * an offline LLM job and (optionally) injected LLM-free into the prompt. The edge
 * is NEVER symmetric: `(subject=A, about=B)` is a distinct entry from
 * `(subject=B, about=A)`.
 *
 * This is a NEW port — like UserRepresentationStore / MemoryCausalStore /
 * TripleStorePort it deliberately does NOT widen the security-reviewed
 * `MemoryPort` (store/search/delete). New capabilities arrive as their own
 * segregated port. The sole adapter is in the memory package (it owns the `db`
 * handle and runs all SQL over the additive `relationship` table); the agent-side
 * write path (the offline directional builder) and read path (the LLM-free
 * injection block) consume this port TYPE from @comis/core — they cannot import
 * the memory package (the agent↛memory build cut). No new authority is granted
 * beyond write/read within the caller's own (tenant, agent, channel) scope.
 *
 * It carries the WRITE (`upsert`) and the scoped READ (`read`) — the dual
 * write+read shape of UserRepresentationStore / TripleStorePort (NOT a split
 * read/write port).
 *
 * This file is type-only (mirrors user-representation-store.ts / triple-store.ts):
 * no zod, no memory-package import.
 */

/**
 * The isolation boundary for every relationship operation (the §5.2 pattern,
 * scoped by CHANNEL). Every adapter statement — INSERT, UPDATE,
 * SELECT — filters on `(tenantId, agentId, channelId)`. This is a load-bearing
 * SECURITY scope in a multi-agent, multi-channel DB, not a nicety: a relationship
 * populated in one (tenant, agent, channel) must NEVER be returned for another
 * scope (a cross-channel OR cross-tenant read is structurally impossible). The
 * directional `(subjectUserId, aboutUserId)` pair is ROW DATA inside this scope,
 * NOT part of the security filter. `channelId` is the NEW privacy axis that makes
 * this STRICTER than the earlier (tenant, agent, user) scope — `agentId` is
 * carried too (the per-agent partition within a channel — the SAFE default,
 * stricter than the bare (tenant, channel)).
 */
export interface RelationshipScope {
  /** Tenant partition (isolation boundary). */
  tenantId: string;
  /** Agent partition (isolation boundary). */
  agentId: string;
  /** Channel partition (the per-channel privacy isolation boundary). */
  channelId: string;
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
 * The HIGH-TRUST floor for a relationship entry, as a TYPE. DISTINCT
 * from the full `TripleTrust` ladder (`system`/`learned`/`external`): `external`
 * is STRUCTURALLY ABSENT here. The relationship is built only from high-trust
 * sources — an LLM-produced entry cannot type a forbidden trust value at the
 * contract layer (defense-in-depth with the DB CHECK in the adapter). Trust
 * is CODE-computed, never LLM-chosen.
 */
export type RelationshipTrust = "system" | "learned";

/**
 * A directional relationship entry to write. `content` is the
 * conversation-derived (untrusted) relationship text — DATA, never SQL; the
 * adapter binds every value as a `?` parameter and runs it through the redaction
 * firewall + `validateMemoryWrite`. The `(subjectUserId, aboutUserId)`
 * pair is the directional edge — subject's representation OF about; it is NEVER
 * symmetrized. `trust` admits ONLY the high-trust floor (the LLM has no say — it
 * is code-computed).
 */
export interface RelationshipInput {
  /** The SUBJECT of the edge — whose belief/statement this is (the speaker). */
  subjectUserId: string;
  /** The OBJECT of the edge — whom the relationship content concerns. */
  aboutUserId: string;
  /** The relationship text (untrusted, redaction-checked at the adapter). */
  content: string;
  /** Trust on the HIGH-TRUST floor — `external` is structurally excluded. */
  trust: RelationshipTrust;
  /** Provenance: the originating memory id (ON DELETE CASCADE in the table). */
  sourceMemoryId?: string;
}

/**
 * A relationship entry read back — the input shape plus the
 * adapter-assigned identity + bookkeeping timestamps.
 */
export interface RelationshipEntry extends RelationshipInput {
  /** The stable row id assigned by the adapter. */
  id: string;
  /** Epoch ms the entry was first written (the injected-clock `now`). */
  createdAt: number;
  /** Epoch ms of the last upsert that touched this entry (absent if never updated). */
  updatedAt?: number;
}

export interface RelationshipStore {
  /**
   * WRITE PATH. Upsert one directional relationship edge under the
   * caller's (tenant, agent, channel) scope. The adapter binds every value as a
   * `?` parameter, enforces the high-trust floor + redaction-clean + the
   * `validateMemoryWrite` boundary, and is idempotent (re-upserting an unchanged
   * edge writes 0 new rows). The directional
   * pair is preserved verbatim — A→B and B→A are distinct rows. Deterministic,
   * one synchronous transaction; the timestamp comes from `scope.now`.
   *
   * NOTE: this is the type contract only. The SQLite adapter is implemented
   * separately; the offline builder that produces edges lands later.
   */
  upsert(
    entry: RelationshipInput,
    scope: RelationshipScope,
  ): Promise<Result<void, Error>>;

  /**
   * READ PATH. The LLM-free relationship read: the relationship edges
   * for the caller's (tenant, agent, channel) scope ONLY, capped by `cap` (a sane
   * default bound). Takes `Omit<RelationshipScope, "now">` — no clock is needed to
   * read (mirror TripleStorePort.asOf). This is the deterministic read the
   * (optional) prompt-assembly injection block consumes with NO model call (the
   * milestone's #1 binding constraint — the recall hot path stays LLM-free). A
   * cross-channel OR cross-tenant read returns nothing (the structural
   * isolation); an empty array is returned when the channel has no edges (the
   * default-OFF byte-identity no-op).
   *
   * NOTE: this is the type contract only; the scoped SELECT is implemented
   * separately.
   */
  read(
    scope: Omit<RelationshipScope, "now">,
    cap?: number,
  ): Promise<Result<RelationshipEntry[], Error>>;
}
