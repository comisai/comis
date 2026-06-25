// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { LearningScope } from "./outcome-signal-port.js";
import type { StructuredBody } from "./reflection-port.js";

/**
 * MentalModelStorePort: the SEGREGATED hexagonal boundary for the v2.31 Mental
 * Model doc store (generalized from the v2.26 Verified Learning WS2 / SKILL-01
 * procedural store) — the durable `mental_models` table of admitted advisory
 * docs, each at `trust=learned` (a learned doc can NEVER be `system`). A row is
 * a `kind ∈ {skill, profile, topic}` doc; it admits a validated candidate
 * (`admit`), reads by name / lists (`get` / `list(scope, kind?)`), and runs the
 * lifecycle transitions a proof count / failure drives
 * (`promote` / `demote` / `evict`).
 *
 * This is a NEW port — like {@link OutcomeSignalPort} it deliberately does NOT
 * widen the security-reviewed `MemoryPort`. The sole ADAPTER lives in
 * @comis/memory (it owns the `db` handle and runs all SQL); the store is invoked
 * DAEMON-SIDE (the daemon injects the adapter into the synthesis job). Any
 * agent-side consumer imports this port TYPE only — it cannot import
 * @comis/memory (the agent↛memory build cut, the structural SEC-01 boundary).
 *
 * This file is type-only (mirrors outcome-signal-port.ts): no zod, no
 * @comis/memory import. Every method threads the {@link LearningScope}
 * isolation boundary and returns `Result<T, Error>` from @comis/shared — there
 * is no doc-specific error type.
 *
 * @module
 */

/**
 * One admitted mental-model doc row (the type-only mirror of the `mental_models`
 * table). `trustLevel` is the LITERAL `"learned"` (never a widened `string`) —
 * the type-layer mirror of the DB `CHECK (trust_level IN ('learned'))` keystone
 * (SEC-01 T-201-04): a learned doc cannot be `system` even at the type layer.
 * `kind` tags the doc family; `mutating` drives the approval gate; `proofCount`
 * drives promote/demote; `sourceTrajIds` is the opaque provenance.
 *
 * NOTE: `structuredBody` (the v2.31 Reflection section-AST) IS now mirrored
 * (Phase 223 / REFLECT-04) — `get`/`list` surface it (undefined when the
 * `structured_body` column is NULL or holds garbage) so a reflect refresh can
 * delta-op against the prior doc. The `history` column stays DB-only/NULL until
 * Phase 224 (FORGET-04 supersession) wires it.
 */
export interface MentalModel {
  /** Deterministic id (hash of the (tenant, agent, kind, topicKey, name) natural key — replay-stable). */
  id: string;
  /** Stable doc name (UNIQUE per (tenant, agent, kind, topicKey); the lookup key). */
  name: string;
  /** Short description of what the doc covers. */
  description: string;
  /** The doc body (markdown). */
  body: string;
  /** Doc family (closed union; CHECK-pinned at the DB). 'skill' for a learned procedure. */
  kind: "skill" | "profile" | "topic";
  /** The topic key a 'topic' doc clusters under; `''` for a skill/profile. */
  topicKey: string;
  /** ALWAYS the literal `"learned"` — the type mirror of the DB CHECK (never `system`). */
  trustLevel: "learned";
  /** Lifecycle state (closed union; CHECK-pinned at the DB). */
  state: "candidate" | "active" | "stale" | "archived";
  /** How many verified successes have reinforced this doc (drives promote/demote). */
  proofCount: number;
  /** Confidence in [0, 1] (the synthesis/validation-derived score). */
  confidence: number;
  /** Whether the doc describes a state-mutating action (drives the approval gate; read-only auto-admits). */
  mutating: boolean;
  /** Opaque source-trajectory ids the doc was distilled from — provenance (ids only). */
  sourceTrajIds: ReadonlyArray<string>;
  /**
   * The Reflection section-AST (v2.31 / REFLECT-04) — the structured form a
   * delta-op refresh reads and writes. `undefined` when the `structured_body`
   * column is NULL (a doc never reflected, or whose AST failed to parse). Render
   * to the `body` markdown via `renderStructuredBody`.
   */
  structuredBody?: StructuredBody | undefined;
  /** Injected epoch ms the row was admitted. */
  createdAt: number;
}

/**
 * The write payload for {@link MentalModelStorePort.admit} — the admitted
 * subset of a validated candidate. `trustLevel` is intentionally NOT a field:
 * the adapter ALWAYS writes `"learned"` (the SEC-01 keystone is enforced at the
 * store, never supplied by the caller). The id is derived (the deterministic
 * (tenant, agent, kind, topicKey, name) hash), so it is not supplied either.
 * `kind`/`topicKey` are OPTIONAL — omitted ⇒ the adapter applies `'skill'`/`''`,
 * so a skill admit stays unchanged.
 */
export interface AdmitMentalModelInput {
  /** Stable doc name (UNIQUE per (tenant, agent, kind, topicKey)). */
  name: string;
  /** Short description of the doc. */
  description: string;
  /** The doc body (rendered markdown — typically `renderStructuredBody(structuredBody)`). */
  body: string;
  /**
   * The Reflection section-AST (v2.31 / REFLECT-04) — bound to `structured_body`
   * (JSON) so a later reflect refresh can delta-op against it. Omitted ⇒ the
   * column is written NULL (a doc with no structured form). Updated in lockstep
   * with `body` on a re-admit (the idempotent upsert).
   */
  structuredBody?: StructuredBody | undefined;
  /** Whether the doc describes a state-mutating action (drives the approval gate). */
  mutating: boolean;
  /** Doc family — omitted ⇒ `'skill'` (a skill admit stays unchanged). */
  kind?: "skill" | "profile" | "topic";
  /** The topic key for a 'topic' doc — omitted ⇒ `''`. */
  topicKey?: string;
  /** Initial proof count at admission (capped LOW regardless of cluster size — anti-domination). */
  proofCount: number;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Opaque source-trajectory ids the doc was distilled from. */
  sourceTrajIds: ReadonlyArray<string>;
  /** Injected epoch ms the row is admitted at (NEVER `Date.now()` — supplied by the caller's clock). */
  createdAt: number;
}

export interface MentalModelStorePort {
  /**
   * WRITE (idempotent). Admit a validated candidate, upserting the
   * `(tenantId, agentId, name)` row at `trust=learned`, `state=candidate`. The
   * adapter forces `trust_level = 'learned'` (never trusts the caller) and uses
   * a deterministic id so a replay upserts even if the row was evicted. Returns
   * `ok({ id, admitted })`; never throws. Unresolved scope fails-closed with
   * `err(...)` — never widens to a shared/global pool (SEC-01).
   */
  admit(input: AdmitMentalModelInput, scope: LearningScope): Promise<Result<{ id: string; admitted: boolean }, Error>>;

  /**
   * READ. Fetch the doc named `name` within `(tenant, agent)`, or `ok(undefined)`
   * when none exists. Unresolved scope fails-closed with `err(...)`.
   */
  get(name: string, scope: LearningScope): Promise<Result<MentalModel | undefined, Error>>;

  /**
   * READ. List docs within `(tenant, agent)`, optionally filtered to a single
   * `kind` (omitted ⇒ all kinds). The kind filter is an ADDITIONAL `AND` over the
   * load-bearing `(tenant, agent)` scope filter, never a replacement for it.
   * Unresolved scope fails-closed with `err(...)`.
   */
  list(
    scope: LearningScope,
    kind?: "skill" | "profile" | "topic",
  ): Promise<Result<MentalModel[], Error>>;

  /**
   * WRITE. Reinforce the skill `id`: `proof_count` is incremented on EVERY call,
   * but the `candidate → active` transition fires ONLY when crossing the proof
   * bar — i.e. when `proof_count + 1 >= promoteAtProofCount` (the caller-supplied
   * threshold; default policy 3). A single attributed success bumps the count
   * without activating (the D2 / T-202-04 premature-trust mitigation): a candidate
   * at `promoteAtProofCount=3` stays `candidate` after the 1st and 2nd promote and
   * becomes `active` on the 3rd. An already-`active` skill keeps bumping
   * `proof_count` but never changes state. `trust_level` is never touched. Scoped
   * to `(tenant, agent)`; unresolved scope fails-closed with `err(...)`.
   */
  promote(id: string, scope: LearningScope, promoteAtProofCount: number): Promise<Result<void, Error>>;

  /**
   * WRITE. Penalize the skill `id` on a verified failure (decrement strength /
   * step state back toward `stale`). Scoped to `(tenant, agent)`.
   */
  demote(id: string, scope: LearningScope): Promise<Result<void, Error>>;

  /**
   * WRITE (name-keyed promote — the reuse-outcome loop entry point). Resolve the
   * skill NAME to its deterministic `(tenant, agent, name)` hash id INTERNALLY and
   * apply {@link promote}'s proof-bar transition, returning whether a row actually
   * changed. The reuse-attribution carrier (ATTR-01) holds skill NAMES, not ids;
   * keeping the id derivation in the adapter (one place) avoids leaking the hash
   * formula to callers. `changed === false` means NO row matched the
   * `(tenant, agent, name)` (an unknown/evicted name) — the caller must NOT count
   * it as a promotion or emit a telemetry event (the 0-row-write-lies fix). Scoped
   * to `(tenant, agent)`; unresolved scope fails-closed with `err(...)`.
   */
  promoteByName(
    name: string,
    scope: LearningScope,
    promoteAtProofCount: number,
  ): Promise<Result<{ changed: boolean }, Error>>;

  /**
   * WRITE (name-keyed demote — the reuse-outcome loop entry point). Resolve the
   * skill NAME to its hash id INTERNALLY and apply {@link demote}, returning whether
   * a row's STATE actually moved. A demote only transitions `active`/`candidate` →
   * `stale`; the UPDATE's WHERE pins `state IN ('active','candidate')` (WR-06) so a
   * row in a TERMINAL state (`stale`/`archived`) — like an unknown/evicted name —
   * matches 0 rows and yields `changed === false` (the `updated_at` rewrite never
   * fakes a transition). The caller must NOT count or emit when `changed === false`.
   * Scoped to `(tenant, agent)`; unresolved scope fails-closed with `err(...)`.
   */
  demoteByName(name: string, scope: LearningScope): Promise<Result<{ changed: boolean }, Error>>;

  /**
   * WRITE. Soft-evict the skill `id` (mark archived / set `evicted_at`) so it no
   * longer surfaces. Scoped to `(tenant, agent)`.
   */
  evict(id: string, scope: LearningScope): Promise<Result<void, Error>>;
}
