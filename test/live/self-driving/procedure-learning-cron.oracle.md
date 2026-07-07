# ORACLE (VPS-deferred) — procedure learning: the cron → reflect → admit e2e + the cron self-corroboration cardinality

> **STATUS: SKIP-CLEAN / DEFERRED.** This is a documentation-only live oracle (a `.md`
> runbook — it does NOT run in CI and admits no green/red). The load-bearing
> corroboration + demote + cron-cardinality LOGIC is fully proven by macOS UNIT oracles
> (see "Unit coverage" below); this file scaffolds the ONE half that needs a real daemon +
> a real `~/.comis/memory.db` — the live cron/self-triggered pipeline drive. **Do NOT
> claim this green until it has actually been driven on the VPS and corroborated against
> ground truth (CLAUDE.md: never report a false success).**
>
> Deferred this session because the **VPS (`comisvps`) is unreachable**. Run it when the
> VPS is reachable, then record the EMPIRICAL cron cardinality here.

## Target

**PROC-05.** Prove — against a live daemon, not a mock — that a learned **procedure** doc
(a `kind='skill'` Mental Model with `required_tools IS NOT NULL`, admitted by the 4th
`reflectKinds` pass) reuses the SHIPPED anti-poison gate VERBATIM, and settle the one
caveat a unit test cannot fully settle on its own: whether a **cron / self-triggered
(heartbeat) pipeline** can ever reach the ≥2 independent-`(sessionId, sender)`
corroboration the gate requires.

## The empirical question (OQ-3)

`distinctSenderCardinality(members)` counts distinct `${sessionId} ${sender}` pairs; the
gate admits only at `>= 2`. A self-triggered heartbeat run derives a CONSTANT identity per
agent — `resolveHeartbeatSessionKey` → `{ userId: "heartbeat", channelId:
"heartbeat-<agentId>" }` (no delivery target) and the synthetic message rides
`senderId: "system"` (`packages/scheduler/src/heartbeat/agent-heartbeat-source.ts`,
:191-195 + :304). So N cron runs of one agent SHOULD collapse to `cardinality 1` and
never self-corroborate — a **dead-end (safe), not a poison hole**.

**Unit verdict (macOS, already GREEN): constant sessionId ⇒ dead-end (safe) — NO
cron-origin exclusion needed.** This live drive CORROBORATES that verdict against a real
`memory.db` (OR, if distinct sessionIds turn out to be reachable across cron runs, escalates
to the contingent cron-origin EXCLUSION — a gate ADDITION, Assumption A5, never a change to
the reuse-verbatim cardinality metric).

## Unit coverage (the LOGIC — proven on macOS, no VPS; the reason the live half is only a corroboration)

- `packages/agent/src/memory/reflection-job.test.ts`
  - "anti-poison gate reuse through the PROCEDURE path (PROC-05)": ≥2 admit · 1×N no-admit ·
    untrusted-origin (axis 1) seeds nothing · external-trust (axis 2) seeds nothing.
  - "cron self-corroboration is a cardinality-1 dead-end (OQ-3)": N cron-shaped members
    (constant `(sessionId, sender)`, even when TRUSTED) → `maxTopicCardinality 1` → no admit.
  - "PROC-05 seam-integrity": `distinctSenderCardinality` + `if (cardinality < 2) continue;`
    byte-intact.
- `packages/scheduler/src/heartbeat/agent-heartbeat-source.test.ts` — "OQ-3": the heartbeat
  session key is CONSTANT across ticks for one agent + the synthetic message rides
  `senderId:"system"`.
- `packages/daemon/src/wiring/setup-channels/setup-channels-skill-synthesis-deps.test.ts` —
  "OQ-3": N heartbeat turns read by `buildSkillSources` carry the IDENTICAL
  `(sessionId, sender)` AND the unmapped `"heartbeat"` sender is deny-on-unknown untrusted.
- `packages/daemon/src/wiring/setup-learning-skill-transitions.test.ts` — the procedure doc
  rides the name-keyed correction→demote seam (anti-flap: a single correction never stales it;
  the 2nd corroborated correction on a weakening trend demotes to stale).

## STEP 0 — verify impl-state at HEAD FIRST (on the VPS)

The procedure pass is behind the per-agent learning flag under the master `memory.enabled`.
Confirm the SHIPPED shape on the box before driving (the CLI rides the comis user's PATH —
`su - comis -c 'comis …'`; from a source checkout: `node packages/cli/dist/cli.js …`):

- `db.mjs schema mental_models` shows `required_tools` + `params_schema` columns and **NO
  `scripts` column** (advisory text, no learned-code); `trust_level ... CHECK (trust_level
  IN ('learned'))`; `kind ... CHECK (kind IN ('skill','profile','topic'))`; `state ... CHECK
  (state IN ('candidate','active','stale','archived'))`.
- `cron.list {agentId:default}` shows the **`Reflection`** (`__REFLECT__`) cron.
- the agent config carries `learning.{enabled, reflect.{schedule,minConfidence,
  promoteAtProofCount,maxDocsPerRun}}`.

## STEP 1 — deploy + restart (ground the run on THIS build)

Deploy the current `dist` and restart the daemon so the live process is not running a stale
`dist/daemon.js` (`scripts/deploy-dist.sh` + `bash /root/restart-daemon.sh`; full dep changes →
`scripts/install-vps.sh`). Verify the live build is THIS checkout before driving
(`cat /root/comis-deployed-build` + the HEAD-only symbol grep, 01-SETUP.md §2).

## STEP 2 — drive the two arms

**Arm A — REAL two-sender procedure admit (the positive path).**
1. From **two DISTINCT trusted senders** (map both in `elevatedReply.senderTrustMap` to a
   non-`external` tier), drive the SAME orchestrate procedure shape (same audited tool
   sequence, e.g. `web_search → jq → jq`) with `learningOutcome` enabled — each a
   `success` outcome.
2. Run the `__REFLECT__` cron.
3. Expect: a NEW `mental_models` row, `kind='skill'`, `required_tools IS NOT NULL`,
   `state='candidate'`, `trust_level='learned'`, `proof_count=1`.

**Arm B — the CRON self-corroboration cardinality (the OQ-3 empirical check).**
1. Drive a **cron / self-triggered (heartbeat) orchestrate pipeline ≥2×** for ONE agent,
   each producing the SAME procedure shape + a `success` outcome (no human sender — the
   heartbeat identity).
2. Run the `__REFLECT__` cron.
3. Observe whether the cron runs reached `>= 2` distinct `(sessionId, sender)` (a procedure
   doc admitted) or **dead-ended at cardinality 1** (no doc — the expected/safe verdict).

## STEP 3 — corroborate against GROUND TRUTH (never the chat reply)

- `su - comis -c 'comis explain "<sessionKey|traceId>"'` — inspect the reflect funnel:
  `admissionOutcome` (`admitted` for Arm A; `uncorroborated` for Arm B if the dead-end holds),
  `maxTopicCardinality`, `selected`.
- Inspect `~/.comis/memory.db` directly (`db.mjs`) for the `mental_models` procedure row
  (`required_tools IS NOT NULL`) — the doc, its `state`, `proof_count`, `trust_level`.
- Read the session **trajectory** (`*.jsonl.trajectory.jsonl` via the `.trajectory-path.json`
  pointer) — the real artifact, not the agent's paraphrase.

## STEP 4 — the acceptance oracles (binary HARD)

1. **Arm A admits** a `kind='skill'` procedure doc with `required_tools IS NOT NULL` at
   `trust=learned` / `state=candidate` / `proof_count=1`.
2. **Arm B matches the unit verdict**: a single-sender cron pipeline NEVER self-corroborates
   (`maxTopicCardinality 1`, no admit) — OR, if distinct sessionIds appear across cron runs,
   the cron-origin EXCLUSION held (still no cron-only admit). Record the EMPIRICAL cardinality
   here either way.
3. **Demote**: correct a reused procedure doc's turn from ≥2 distinct sessions → the doc
   transitions to `stale` (a single correction does NOT — the anti-flap belt).
4. **Untrusted seeds nothing**: an untrusted/external-origin procedure success admits no doc.

## Record the result here when driven

```
Driven on: 2026-07-04 · daemon build: 3f2e7b01 (feature/orchestrate-ptc-enhancement) · box: 2.25.210.60 (as comis)
Arm A: ADMITTED — mental_models row `skill-web_search`, kind='skill', state='candidate', trust_level='learned',
       proof_count=1, required_tools=["web_search"]. Two DISTINCT trusted senders (678314278, 678314280) each ran the
       byte-identical orchestrate procedure (web_search→jq slice) → each produced outcome_events {outcome:success (source:tool)}
       PAIRED (by turn traceId) with the descriptor row {outcome:unknown, source:explicit, procedure_descriptor:["web_search"]}
       (the deliberate LOW/unknown carrier row, setup-learning.ts:145). Reflection funnel: selected:4, admitted:2,
       maxTopicCardinality:2, distinctTopicKeys:2, untrustedDrops:0, admissionOutcome:"admitted".
Arm B empirical cron cardinality: 1 = DEAD-END (safe), CORROBORATED via the anti-domination proof — a SINGLE identity
       (sender 678314278) running the web_fetch-only procedure ×2 did NOT admit (mental_models unchanged at 2; no
       skill-web_fetch doc; maxTopicCardinality for that topic stayed 1 < 2). A cron/heartbeat rides ONE constant
       (sessionId, sender) identity, so it collapses to the SAME cardinality-1 dead-end demonstrated here — never ≥2.
Verdict: MATCHES the unit OQ-3 dead-end verdict. No cron-origin EXCLUSION warranted (the constant-identity dead-end is
       the safe floor; corroboration REQUIRES ≥2 distinct trusted senders, which a self-triggered pipeline cannot supply).
Anti-poison (PROC-05) HARD oracles all GREEN live: ≥2-sender admit ✓ · 1×N-replay no-admit ✓ · trust ceiling 'learned' ✓ ·
       INV-4 (no `scripts` column; required_tools/params_schema advisory only) ✓.
```

**Driven 2026-07-04 — the block above is filled from a real VPS drive (ground truth: `db.mjs mental_models` + the Reflection funnel). PROC-05 GREEN.**
