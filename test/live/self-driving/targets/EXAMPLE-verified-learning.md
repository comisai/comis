# TARGET (worked example) — the v2.31 Reflection engine (an OFFLINE / DB / event-resident capability)

> A **design-document** target whose capability is **not channel-shaped** — it lives in crons, DB tables,
> and the event stream. Shows the offline-testing class (`03 §offline-oracles`, `04 §B offline recipe`)
> and the impl-state-at-HEAD discipline. Contrast with `EXAMPLE-nvda-dag.md` (a channel/orchestrate target).
>
> **This is the OPERATOR's LIVE-01..05 runbook** for the real-provider VPS drive of the from-scratch live
> acceptance (Phase 227 §7 Phase 5). The darwin-host build-side analog ran autonomously
> (`test/integration/from-scratch-acceptance.test.ts` + `test/architecture/reflection-inv-belts-dist.test.ts`);
> the real-provider drive below is **operator-deferred** — it needs the VPS + real keys + a running daemon.

## Target
`design/new/memory-learning-reflection-redesign.md` — the v2.31 **one-reflection-engine** redesign:
**§3** the engine (the one `MentalModel` doc + Loops A/B/C/D), **§6** the INV-1..6 register, **§7 Phase 5**
the from-scratch live acceptance. This design **SUPERSEDES** the old `design/new/verified-learning.md` draft
(marked superseded) — that draft's outcome-gated/sandbox-validated/trust-tiered "WS"-numbered subsystems were
**deleted/folded** in v2.31. Test the SHIPPED reflect engine, not the superseded prose.

## STEP 1 — Verify impl-state at HEAD FIRST
The reflect engine SHIPPED (v2.31, phases 222–226, **default-on** under the master `memory.enabled`). It
replaced five over-engineered learning subsystems with **one** outcome-gated Reflection engine maintaining
named **Mental Model** docs (`kind ∈ skill | profile | topic`) via byte-stable delta-ops, surfaced through the
already-wired surface→attribute→promote reuse loop. Confirm the SHIPPED shape on the box before driving:
- `db.mjs tables` shows **`mental_models`** (NOT the deleted skill-synthesis table, the deleted per-intent
  tuning table, or the deleted social-modeling/relationship table — all removed in v2.31).
- `db.mjs schema mental_models` shows `trust_level TEXT NOT NULL CHECK (trust_level IN ('learned'))`,
  `kind TEXT NOT NULL CHECK (kind IN ('skill','profile','topic'))`, `state ... CHECK (state IN
  ('candidate','active','stale','archived'))`, and the `topic_key` / `structured_body` / `history` /
  `proof_count` / `evicted_at` columns — and **NO `scripts` column** (advisory text, no sandbox: §3.4).
- `cron.list {agentId:default}` shows the **3** learning crons: **`Reflection`** (`__REFLECT__`),
  **`Memory lifecycle`** (`__MEMORY_LIFECYCLE__`), and **`Memory review`** (accumulate-tier) — NOT the deleted
  usefulness-judge / triple-extraction / social-modeling / online-tuning / skill-synthesis crons.
- the config carries the **`memory.enabled`** master + per-agent **`agents.<id>.learning.{enabled,
  reflect.{schedule,minConfidence,promoteAtProofCount,maxDocsPerRun}, forget.{maxDormantDays,
  failureEvictionFloor,highProofFloor}}`** block — NOT the deleted master cost-features flag, nor the deleted
  per-loop skills/tuning/forgetting config blocks (those v2.26-era keys are now z.strictObject-REJECTED).

## Capabilities → requirements (all OFFLINE / DB / event-resident — drive via tool/graph turns + crons, observe via DB/events/the funnel)
- **LIVE-01 accumulate (Loop A, keyless):** a tool turn → the per-turn outcome resolves → an `outcome_events`
  row (`outcome='success'`) + a `memories` row. The raw facts/experiences tier.
- **LIVE-02 cross-session recall (Loop A, keyless):** teach a fact → **sever the LCD** (a fresh session, ideally
  a different channel so no shared live-conversation buffer) → the fresh session recalls the fact from the
  durable LTM **`memories`** table (hybrid vec+FTS), NOT from the LCD.
- **LIVE-03 reflect skill A→B + reuse-promote (Loop B + Loop C, LLM):** ≥2 corroborating **successful** sessions
  on ONE topic from **distinct `(session, sender)`** → the `Reflection` cron (`__REFLECT__`) reflects a
  `state='candidate'`, `kind='skill'`, `trust_level='learned'` doc into `mental_models` → a fresh session
  **surfaces + reuses** it (`read` of the materialized `.md` → `memory:skill_used` / `used_skill_ids`) → a
  successful reuse fires `learning:skill_promoted`, bumps `proof_count`, flips `candidate→active` at
  `promoteAtProofCount`. **This A→B→reuse loop is the killer feature** (outcome-gated + a closed
  reuse-feedback loop Hindsight lacks). Oracle: `db.mjs pick mental_models name,kind,state,trust_level,proof_count`
  + the `reflect:admitted` / `reflect:funnel` events + `reflect:funnel.admissionOutcome`.
- **LIVE-04 profile/topic docs (Loop B, LLM):** the SAME `__REFLECT__` cron maintains `kind='profile'` (the
  `<user_profile>` block, grouped by user) + `kind='topic'` docs (grouped domain knowledge); they surface in the
  prompt. Oracle: `db.mjs sql "select kind,count(*) from mental_models group by kind"`.
- **LIVE-05 supersede + evict (Loop A + Loop D):** a **corrected** fact supersedes (latest wins at recall; the
  prior value is preserved in the `memories.history` JSON array — **no delete**); a **corroborated low-proof**
  wrongness evicts under the **live `learning.forget` policy** (`evicted_at` set); a **pinned / high-proof** row
  survives the SAME failures (INV-4). Oracle: `db.mjs pick memories content,history` + a `db.mjs sql` `evicted_at` read.

## Must-pass predicates (oracle = DB / CLI obs / events — NOT a chat reply)
| id | predicate (works-bar) | oracle (ground truth) | HARD |
|---|---|---|---|
| REFL-1 (LIVE-01) | a tool turn produces a RESOLVED outcome + a stored fact | `db.mjs pick outcome_events source,outcome` → `outcome='success'`; `db.mjs count memories` grows | |
| REFL-2 (LIVE-02) | a fact taught in session A recalls in a FRESH session from LTM (not the LCD) | fresh-session recall returns the fact; `db.mjs count memories` (the fact is in `memories`, recalled cross-session) | |
| REFL-3 (LIVE-03) | A→B admit + reuse + promote | `db.mjs pick mental_models name,kind,state,trust_level,proof_count` shows a `kind='skill'` row move `candidate→active` with `proof_count` UP; `reflect:funnel.admissionOutcome` is `admitted`; `learning:skill_promoted` fired (`comis explain`) | ✅ trust ≤ learned |
| REFL-4 (LIVE-04) | profile + topic docs maintained + surface | `db.mjs sql "select kind,count(*) from mental_models group by kind"` shows `profile` and `topic` rows; they surface in the prompt | |
| REFL-5 (LIVE-05) | supersede keeps history + low-proof corroborated evicts + high-proof/pinned survives | `db.mjs pick memories content,history` → `history` populated, content is the corrected value; `evicted_at` SET on the corroborated-wrong row, **NULL** on the pinned/high-proof row under identical failures | ✅ INV-4 |
| INV-1 | trust ceiling — learning can NEVER raise trust | `db.mjs schema mental_models` → `trust_level TEXT NOT NULL CHECK (trust_level IN ('learned'))` (no trust-write column anywhere learning writes) | ✅ |
| INV-2 | anti-domination — N repetitions from ONE source = 1 | a single `(session,sender)` repeated → `reflect:funnel.admissionOutcome: uncorroborated` (`maxClusterCardinality: 1`); `db.mjs count mental_models` does NOT grow | ✅ |
| INV-3 | no learned-code execution — docs are advisory text | `db.mjs schema mental_models` has **NO `scripts` column**; the admitted doc `body` is markdown text the agent reads with its own permissioned tools (no sandbox path exists) | ✅ |
| INV-5 | untrusted-origin seeds nothing | a planted/untrusted-origin "success" → `reflect:funnel.admissionOutcome: untrusted_origin` (or `no_successes`); `db.mjs count mental_models` does NOT grow | ✅ |
| INV-6 | content-free telemetry | the `reflect:*` events carry counts + the closed `ReflectAdmissionOutcome` enum ONLY — never a doc body/prompt; `comis explain` shows the funnel counts + `admissionOutcome`, NO body | ✅ |

> `ReflectAdmissionOutcome` is the CLOSED 7-value verdict enum on `reflect:funnel.admissionOutcome`:
> `admitted | uncorroborated | rejected_validation | rejected_name_length | untrusted_origin |
> empty_reflection | no_successes`. It answers "why was 0 admitted" from ONE field — no DEBUG-log grep.
> `maxClusterCardinality` is the distinct `(session, sender)` **corroboration cardinality** (a value of 1 = a
> single uncorroborated instance → admission CORRECTLY refused) — it is **NOT** an embedding/cosine cluster size.

## Stage / cost
The deterministic **accumulate / recall / supersede / evict** loops (REFL-1/2/5, INV-1/3) are **keyless** ($0) —
drive these FIRST. The **reflection LLM call** that admits a doc (REFL-3/4 + INV-2/5/6, the `Reflection` cron) is
**provider-gated** (Anthropic, or the agent's main provider). **Stage B/C.**

## Known traps for this target (v2.31) — learned the hard way (`03 §offline-oracles`)
- **Not channel-shaped:** the chat reply tells you nothing. Read GROUND TRUTH — `db.mjs`, `comis explain`, the
  `reflect:*` events + the funnel. A false success is the worst outcome (I8).
- **Clean-slate must REPLACE `memory.db`:** the LCD AND the learning state (`mental_models`, `outcome_events`,
  `memory_usefulness`, `memories`) all live in its tables — a `session.reset_conversation` does NOT clear them.
  Replace `~/.comis/memory.db` for a true from-scratch run.
- **`cron.run` takes the job NAME (resolve via `cron.list`):** `cron.run jobName "Reflection"` →
  `{triggered:true}`; `cron.run jobName "Memory lifecycle"` for the forget sweep. Pass an explicit `agentId` for a
  non-default agent (TARGET-01 — otherwise the default agent is resolved from the connection).
- **The live eviction caveat (REFL-5 / LIVE-05):** the `Memory lifecycle` (`__MEMORY_LIFECYCLE__`) sweep is gated
  by the `learning.forget` (live-eviction) policy. The v2.31 eviction IS reachable — the two v2.26-era
  eviction-dead-on-arrival findings (the dead-embedding skill-synthesis singleton and the math-unreachable
  eviction-strength floor) are **GONE** (the dead FadeMem strength disjunct was deleted; the two reachable
  disjuncts are now dormant-age and corroborated-failure). To drive it: seed **corroborated failures**
  on a low-proof memory AND confirm the live policy is on (`learning.forget.failureEvictionFloor`), THEN
  `cron.run jobName "Memory lifecycle"` and read `evicted_at` on the target row via `db.mjs`. **Do NOT conclude
  "eviction is dead" from a default-dormant sweep** (a default sweep evicts nothing by design — that would be a
  false-negative). The pinned / high-proof row under the SAME failures MUST survive (INV-4).
- **The `topicKey` is deterministic + content-light** (the normalized opening request / a topic tag), NOT an
  embedding cluster. Synonyms/abbreviations (`prod` ≠ `production`, non-ASCII stripped) may **under-merge** on
  real VPS transcripts → if the live drive shows `admissionOutcome: uncorroborated` / `maxClusterCardinality: 1`
  DESPITE genuine corroboration on the same topic, the **pre-authorized escalation** is the LLM topic-tag
  fallback (cite `227-CONTEXT.md` Deferred Ideas — "topicKey LLM-tag fallback, only if the live drive shows the
  deterministic key under-merges"). **Do NOT burn cycles forcing a merge** on the deterministic key.
- **A capable model REFUSES adversarial INV probes:** frame INV-5 / INV-2 **benignly** — a "planted transcript" /
  "a single repeated session", NOT "poison the agent." The invariant under test is admission-refusal, observed in
  the funnel verdict, not the model's willingness to be attacked.
- **System-health sweep WILL find unrelated bugs** here (driving a basic memory/teach turn is part of the job,
  non-negotiable #6) — close each one test-first per `02-DISCIPLINE.md` before continuing.
