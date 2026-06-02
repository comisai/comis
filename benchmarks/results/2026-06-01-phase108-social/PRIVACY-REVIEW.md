# Phase 108 SOCIAL — Relationship / Multi-party Modeling · PRIVACY-REVIEW RECORD

**Track:** E2 (SOCIAL-01/02/03) · **Date authored:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat`
**Status of the feature in this commit:** DEFAULT-OFF. No committed config sets `socialModeling.enabled` or `privacyReviewSignedOffBy`.

This document is the **privacy-review analysis/record artifact** SOCIAL-03 requires. It is authored by the engineering work; it is **not** the operator's sign-off. The directional-relationship capability ships with the enforcement (the feature refuses to activate without a recorded sign-off) and this record; the actual **sign-off decision — and thus enabling — is the OPERATOR gate**. This run does NOT self-approve or self-enable (see §6).

---

## 1. What the feature stores

A directional, multi-party **relationship edge**: a row `(subjectUserId, aboutUserId, content)` encoding *subjectUser*'s representation OF *aboutUser* (e.g. "A trusts B"). The edge is:

- **Directional, never symmetric.** A→B is a DISTINCT row from B→A; the store never collapses or symmetrizes the pair.
- **Built OFFLINE only.** The single LLM use in the phase is the offline `runRelationshipBuild` job; the read/recall path is LLM-free.
- **High-trust only.** `trust ∈ {system, learned}` — `external`-trust content is structurally excluded (see §3).

The data retained per edge: the directional `(subjectUserId, aboutUserId)` user-id pair, the free-text `content`, a `trust` enum, an optional `sourceMemoryId` (FK → `memories`, `ON DELETE CASCADE`), and timestamps. No message bodies beyond the distilled `content`; no secrets (the redaction firewall rejects them, §3).

## 2. Structural isolation — the per-channel + per-tenant (+ per-agent) boundary (SOCIAL-02)

The relationship table is scoped by **`(tenant_id, agent_id, channel_id)`** and **every** SELECT/upsert filters `WHERE tenant_id = ? AND agent_id = ? AND channel_id = ?` (bound `?` params only — no string-concatenated SQL). The directional `(subject_user_id, about_user_id)` pair is **row data inside that scope**, never the security filter.

- **Channel is the new privacy boundary.** A relationship populated in channel X is **structurally ABSENT** when read under any different channel Y — a user's model of another never crosses a channel boundary.
- **Per-tenant + per-agent** isolation hold on the same scoped SELECT (carrying `agent_id` is STRICTER than the bare SOCIAL-02 `(tenant, channel)` requirement — never weaker — the safe default for a multi-agent DB).
- **Proven, not asserted.** Plan 108-02 RED-proves the **4-way isolation** (an edge under `(tenant_a, agent_x, channel_x, A→B)` is ABSENT under a foreign channel, a foreign tenant, AND a foreign agent, with a positive in-scope control + directional integrity A→B ≠ B→A). That proof was mutation-verified load-bearing (dropping `channel_id` from the WHERE makes the cross-channel test fail). The keyless bench (this manifest, `claim2`) re-measures the same isolation over the real adapter.

**Out of scope (REQUIREMENTS):** cross-boundary relationship reads. There is no read path that returns another channel's or tenant's edges.

## 3. Anti-poisoning + redaction-clean (the write boundary)

The directional edge is high-trust or it does not exist. Four layers reject untrusted/unsafe content:

1. **Port-type floor** (`@comis/core`): `RelationshipTrust = "system" | "learned"` — `external` is unassignable at the contract layer.
2. **DB CHECK** (`@comis/memory`): `CHECK(trust IN ('system','learned'))` — an `external` row throws at the storage layer.
3. **Adapter write-boundary reject**: a below-floor trust returns `err` with 0 rows.
4. **Builder external-exclude**: the offline job filters `external`-trust sources UNCONDITIONALLY *before* the build seam — the excluded content never reaches the LLM.

**Redaction firewall:** every builder candidate runs `validateMemoryWrite` (the secret-egress + dangerous-command + suspicious-pattern detectors). A non-clean verdict (`warn` OR `critical`) is **SKIPPED**, never down-stored — the relationship table has no reduced-weight `external` tier to launder into (the Pitfall-2 hardening). The keyless bench (`claim3`) re-measures: a forged `external` upsert is rejected, an external-only source set writes 0 rows, and a secret-shaped candidate is blocked and never stored.

## 4. The read-path injection is LLM-free + deterministic

If relationship context is injected (the optional `<channel_relationships>` standing block, Plan 108-04), it is a deterministic `relationshipStore.read(scope)` + a pure formatter pushed onto `memorySections` — **NO model call**. The block is scoped to `channelId = sessionKey.channelId` (the read-side channel boundary). The recall hot path stays LLM-free.

## 5. Default-OFF posture + the sign-off-required-to-enable enforcement (SOCIAL-03)

The feature ships **DEFAULT-OFF** (`socialModeling.enabled` defaults to `false`). **Enabling requires BOTH `enabled === true` AND a recorded non-empty `privacyReviewSignedOffBy`.** This dual gate is enforced at **three** activation sites (defense-in-depth):

1. **The cron WRITE gate** (`setup-channels-memory-crons.ts`, the `__SOCIAL_MODELING__` sentinel): short-circuits `ok` (0 builds, 0 writes) when `!enabled || !privacyReviewSignedOffBy`.
2. **The scheduler registration** (`setup-schedulers.ts`): registers the `__SOCIAL_MODELING__` cron ONLY when `enabled && privacyReviewSignedOffBy` — a knob-on-but-not-signed-off agent registers NO job (byte-identical scheduler state).
3. **The read INJECTION gate** (`prompt-assembly.ts`, Plan 108-04): the `<channel_relationships>` block injects only when `enabled && privacyReviewSignedOffBy && relationshipStore` — off OR no-sign-off ⇒ 0 reads + byte-identical prompt.

The keyless bench (`claim4`/`claim5`) re-measures the read-side gate (knob-on-no-sign-off ⇒ 0 reads + null block) and the default-OFF byte-identity (no rows ⇒ null block). The cron + scheduler gates are RED-proven in the daemon wiring tests (108-05).

**Logging:** counts/metadata only — the relationship `content` and the directional user-id pair are NEVER logged at any level (per AGENTS.md §2.7). The committed manifest carries only numbers + booleans + prose; a credential-shape sweep over it is empty.

## 6. The operator gate (NOT self-approved in this run)

This run produces the **capability + the three-site enforcement + this privacy-review record**, all default-OFF. The remaining steps are the **OPERATOR's**, and are explicitly DEFERRED:

- **The privacy-review SIGN-OFF decision** — a human reviews this record (and the deployment's tenancy/channel model) and, if satisfied, records `agents.<id>.socialModeling.privacyReviewSignedOffBy: "<reviewer>"` and sets `socialModeling.enabled: true`. This commit does **not** set either field anywhere in `packages/*/src` or any committed config (a `grep` for a string-valued `privacyReviewSignedOffBy` over non-test src is empty).
- **Any costed benchmark lift** — the costed QA accuracy delta (does the `<channel_relationships>` block raise grounded multi-party Q&A accuracy under a real answer model + judge?) is the operator-costed re-run; see `GATE-REPORT.md` / `run-provenance.json` (VERDICT: PARTIAL).

Until an operator both signs off and enables, the feature is structurally inert: 0 writes (no cron registered + the sentinel short-circuits), 0 reads (the injection gate is closed), and the prompt is byte-identical to a build without the feature.
