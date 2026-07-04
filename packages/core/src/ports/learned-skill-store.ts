// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { LearningScope } from "./outcome-signal-port.js";
import type { StructuredBody } from "./reflection-port.js";

/**
 * MentalModelStorePort: the SEGREGATED hexagonal boundary for the Mental
 * Model doc store — the durable `mental_models` table of admitted advisory
 * docs, each at `trust=learned` (a learned doc can NEVER be `system`). A row is
 * a `kind ∈ {skill, profile, topic}` doc; it admits a validated candidate
 * (`admit`), reads by name / lists (`get` / `list(scope, kind?)`), and runs the
 * lifecycle transitions a proof count / failure drives
 * (`promote` / `demote` / `evict`).
 *
 * This is a SEPARATE port — like {@link OutcomeSignalPort} it deliberately does NOT
 * widen the security-reviewed `MemoryPort`. The sole ADAPTER lives in
 * @comis/memory (it owns the `db` handle and runs all SQL); the store is invoked
 * DAEMON-SIDE (the daemon injects the adapter into the synthesis job). Any
 * agent-side consumer imports this port TYPE only — it cannot import
 * @comis/memory (the agent↛memory build cut, a structural security boundary).
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
 * the type-layer mirror of the DB `CHECK (trust_level IN ('learned'))` keystone:
 * a learned doc cannot be `system` even at the type layer.
 * `kind` tags the doc family; `mutating` drives the approval gate; `proofCount`
 * drives promote/demote; `sourceTrajIds` is the opaque provenance.
 *
 * NOTE: `structuredBody` (the Reflection section-AST) IS mirrored —
 * `get`/`list` surface it (undefined when the
 * `structured_body` column is NULL or holds garbage) so a reflect refresh can
 * delta-op against the prior doc. `history` (the bi-temporal supersede
 * trail) IS mirrored too — `get`/`list` surface the appended
 * prior-body array (undefined when the `history` column is NULL or corrupt).
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
   * The Reflection section-AST — the structured form a
   * delta-op refresh reads and writes. `undefined` when the `structured_body`
   * column is NULL (a doc never reflected, or whose AST failed to parse). Render
   * to the `body` markdown via `renderStructuredBody`.
   */
  structuredBody?: StructuredBody | undefined;
  /**
   * The bi-temporal supersede trail — the ordered (oldest-
   * first) array of prior bodies a {@link MentalModelStorePort.supersede} appended,
   * each `{ previousContent, changedAt }`. `undefined` when the `history` column is
   * NULL (a doc never superseded) or holds corrupt JSON (degrade-to-absent, never a
   * throw). The shape mirrors `MemoryEntry["history"]`.
   */
  history?: ReadonlyArray<{ previousContent: string; changedAt: number }> | undefined;
  /**
   * The deterministic tool-NAME footprint of a learned PROCEDURE doc (advisory) —
   * the read-side mirror of the write-side `required_tools` bind. `undefined` for a
   * user-intent skill / profile / topic (the `required_tools` column is NULL), or
   * when the column holds corrupt JSON (degrade-to-absent, never a throw). It is
   * the SURFACE DISCRIMINATOR: the learned-skill surface caps the procedure-doc
   * subset (`requiredTools` populated) at a per-agent budget, leaving user-intent
   * skills + topic docs on a separate, uncapped path. Content-free (tool NAMES
   * only); advisory — the model re-authors the run under its already-permissioned
   * tools, this is not an executable surface.
   */
  requiredTools?: ReadonlyArray<string>;
  /** Injected epoch ms the row was admitted. */
  createdAt: number;
}

/**
 * The write payload for {@link MentalModelStorePort.admit} — the admitted
 * subset of a validated candidate. `trustLevel` is intentionally NOT a field:
 * the adapter ALWAYS writes `"learned"` (the trust keystone is enforced at the
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
   * The Reflection section-AST — bound to `structured_body`
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
  /**
   * DETERMINISTIC required-tools footprint (content-free tool NAMES) bound to the
   * `required_tools` column — the procedure run derives it from the AUDITED
   * descriptor (NEVER LLM-authored; INV-4). Omitted ⇒ the column is written NULL
   * (the user-intent skill path). Advisory only: the model re-authors the run under
   * its already-permissioned tools; this is metadata, not an executable surface.
   */
  requiredTools?: ReadonlyArray<string>;
  /**
   * The advisory params schema bound to the `params_schema` column — a fixed
   * content-free value (`"{}"`) for a procedure doc (advisory docs have no replay
   * parameters). Omitted ⇒ NULL.
   */
  paramsSchema?: string;
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
   * `err(...)` — never widens to a shared/global pool.
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
   * without activating (the premature-trust mitigation): a candidate
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
   * changed. The reuse-attribution carrier holds skill NAMES, not ids;
   * keeping the id derivation in the adapter (one place) avoids leaking the hash
   * formula to callers. `changed === false` means NO row matched the
   * `(tenant, agent, name)` (an unknown/evicted name) — the caller must NOT count
   * it as a promotion or emit a telemetry event (a 0-row write must never be
   * reported as a success). Scoped
   * to `(tenant, agent)`; unresolved scope fails-closed with `err(...)`.
   */
  promoteByName(
    name: string,
    scope: LearningScope,
    promoteAtProofCount: number,
  ): Promise<Result<{ changed: boolean }, Error>>;

  /**
   * Bi-temporal supersede. A profile/topic doc CORRECTION
   * UPDATEs the named doc's `body` (and `structuredBody` when supplied) and APPENDs
   * the PRIOR body to `history` (`{ previousContent, changedAt }`, oldest-first); the
   * row is UPDATEd, never DELETEd — deletion stays reserved for the security
   * eviction path ({@link evict}). Mirrors the `SqliteMemoryAdapter.supersede`
   * model exactly: the untrusted body passes `validateMemoryWrite` BEFORE
   * the transaction (a `critical` body — secret egress / dangerous command — is
   * rejected with `err`, never persisted; a `warn` is permitted because the row's
   * trust is the fixed `'learned'`), the SELECT-incumbent → history-append → UPDATE
   * runs inside ONE atomic transaction, and every statement is `(tenant, agent)`-
   * scoped with bound params. `trust_level` is NEVER touched — a correction cannot
   * escalate trust. Returns `"superseded"` on a successful revise, `"not-found"`
   * when no scoped incumbent matched (no row written), or `err` (firewall-rejected,
   * parse fault, or DB error — the transaction rolled back). Unresolved scope
   * fails-closed with `err(...)` — never widens to a shared/global pool.
   */
  supersede(
    input: { name: string; body: string; structuredBody?: StructuredBody },
    scope: LearningScope,
    now: number,
  ): Promise<Result<"superseded" | "not-found", Error>>;

  /**
   * WRITE (name-keyed demote — the reuse-outcome loop entry point). Resolve the
   * skill NAME to its hash id INTERNALLY and apply {@link demote}, returning whether
   * a row's STATE actually moved. A demote only transitions `active`/`candidate` →
   * `stale`; the UPDATE's WHERE pins `state IN ('active','candidate')` so a
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
