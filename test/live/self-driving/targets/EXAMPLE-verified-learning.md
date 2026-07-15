# TARGET (worked example) — the Reflection engine (an OFFLINE / DB / event-resident capability)

> A **design-document** target whose capability is **not channel-shaped** — it lives in crons, DB tables,
> and the event stream. Shows the offline-testing class (`03 §offline-oracles`, `04 §B offline recipe`)
> and the impl-state-at-HEAD discipline. Contrast with `EXAMPLE-nvda-dag.md` (a channel/orchestrate target).
>
> **This is the OPERATOR's LIVE-01..05 runbook** for the real-provider VPS drive of the from-scratch live
> acceptance. The darwin-host build-side analog ran autonomously
> (`test/integration/from-scratch-acceptance.test.ts` + `test/architecture/reflection-inv-belts-dist.test.ts`);
> the real-provider drive below is **operator-deferred** — it needs the VPS + real keys + a running daemon.

## Target
The **one-reflection-engine** design: the engine (the one `MentalModel` doc + Loops A/B/C/D), the
INV-1..6 register, and the from-scratch live acceptance. Test the SHIPPED reflect engine — the earlier
outcome-gated/sandbox-validated/trust-tiered "WS"-numbered subsystems were **deleted/folded** and are not
the target.

## STEP 1 — Verify impl-state at HEAD FIRST
The reflect engine is **default-on** under the master `memory.enabled`. It
replaced five over-engineered learning subsystems with **one** outcome-gated Reflection engine maintaining
named **Mental Model** docs (`kind ∈ skill | profile | topic`) via byte-stable delta-ops, surfaced through the
already-wired surface→attribute→promote reuse loop. Confirm the SHIPPED shape on the box before driving:
- `db.mjs tables` shows **`mental_models`** (NOT the deleted skill-synthesis table, the deleted per-intent
  tuning table, or the deleted social-modeling/relationship table — all removed).
- `db.mjs schema mental_models` shows `trust_level TEXT NOT NULL CHECK (trust_level IN ('learned'))`,
  `kind TEXT NOT NULL CHECK (kind IN ('skill','profile','topic'))`, `state ... CHECK (state IN
  ('candidate','active','stale','archived'))`, and the `topic_key` / `structured_body` / `history` /
  `proof_count` / `evicted_at` columns — and **NO `scripts` column** (advisory text, no sandbox).
- `cron.list {agentId:default}` shows the **3** learning crons: **`Reflection`** (`__REFLECT__`),
  **`Memory lifecycle`** (`__MEMORY_LIFECYCLE__`), and **`Memory review`** (accumulate-tier) — NOT the deleted
  usefulness-judge / triple-extraction / social-modeling / online-tuning / skill-synthesis crons.
- the config carries the **`memory.enabled`** master + per-agent **`agents.<id>.learning.{enabled,
  reflect.{schedule,minConfidence,promoteAtProofCount,maxDocsPerRun}, forget.{maxDormantDays,
  failureEvictionFloor,highProofFloor}}`** block — NOT the deleted master cost-features flag, nor the deleted
  per-loop skills/tuning/forgetting config blocks (those legacy keys are now z.strictObject-REJECTED).

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
  reuse-feedback loop). Oracle: `db.mjs pick mental_models name,kind,state,trust_level,proof_count`
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

## Known traps for this target — learned the hard way (`03 §offline-oracles`)
- **Not channel-shaped:** the chat reply tells you nothing. Read GROUND TRUTH — `db.mjs`, `comis explain`, the
  `reflect:*` events + the funnel. A false success is the worst outcome.
- **Clean-slate must REPLACE `memory.db`:** the LCD AND the learning state (`mental_models`, `outcome_events`,
  `memory_usefulness`, `memories`) all live in its tables — a `session.reset_conversation` does NOT clear them.
  Replace `~/.comis/memory.db` for a true from-scratch run.
- **`cron.run` takes the job NAME (resolve via `cron.list`):** `cron.run jobName "Reflection"` →
  `{triggered:true}`; `cron.run jobName "Memory lifecycle"` for the forget sweep. Pass an explicit `agentId` for a
  non-default agent (TARGET-01 — otherwise the default agent is resolved from the connection).
- **The live eviction caveat (REFL-5 / LIVE-05):** the `Memory lifecycle` (`__MEMORY_LIFECYCLE__`) sweep is gated
  by the `learning.forget` (live-eviction) policy. Eviction IS reachable — the earlier
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
  fallback (only if the live drive shows the deterministic key under-merges). **Do NOT burn cycles forcing a
  merge** on the deterministic key.
- **A capable model REFUSES adversarial INV probes:** frame INV-5 / INV-2 **benignly** — a "planted transcript" /
  "a single repeated session", NOT "poison the agent." The invariant under test is admission-refusal, observed in
  the funnel verdict, not the model's willingness to be attacked.
- **System-health sweep WILL find unrelated bugs** here (driving a basic memory/teach turn is part of the job,
  non-negotiable #6) — close each one test-first per `02-DISCIPLINE.md` before continuing.

## LIVE-RUN lessons — don't re-discover
- **The box may be on a STALE dist.** A run once found the VPS running a stale dist (no `schema-mental-models.js`);
  deploy YOUR current dist + PROVE on new code via ground truth (fresh `memory.db` has `mental_models`, NOT
  `learned_skills`; the 3 crons via `cron.list`; fresh daemon-entrypoint.js process start) before trusting any result.
- **Migrate the config FIRST or the daemon FATALs at parse.** A leftover legacy `memory.costFeatures.enabled`
  is an unknown key under the `z.strictObject` `MemoryConfigSchema` → Bootstrap FATAL. cfg-patch
  `{"memory":{"costFeatures":"__DELETE__","enabled":true}}` before the first restart.
- **Clean-slate MUST wipe the cron store for a true from-scratch** (`clean-restart.sh WIPE_CRONS=1`):
  crons persist in `<workspace>/.scheduler/cron-jobs.json` which SURVIVES the `memory.db` wipe, so a daemon
  inherits STALE crons (incl. the DELETED `__SKILL_SYNTHESIS__`/`__ONLINE_TUNING__`/…) from a prior dist. With
  the wipe, exactly the 3 crons re-register from config (Reflection/Memory lifecycle/Memory review).
- **`drive.mjs` arg order is `<chatId> "<text>" [quiesceMs=8000] [maxMs=240000] [DATA]`** — passing DATA in the
  maxMs slot makes `maxMs=NaN` → the poll loop never runs → an INSTANT false `0s [TIMEOUT] — NO SUBSTANTIVE
  ANSWER` on a reply that landed. Now guarded (loud exit), but mind the order.
- **The Reflection LLM call takes ~20-25s — POLL, don't fixed-sleep.** `cron.run jobName "Reflection"` returns
  `{triggered:true}` immediately but the admit lands ~22s later (the LLM call). Reading `mental_models` after a
  `sleep 12` shows `count:0` (a false negative). Poll the daemon log for `"Reflection complete (all kinds)"` (or
  `"reflection run complete"` with `admissionOutcome`) BEFORE reading the store.
- **REFL-3 surface RACES the async boot-refresh.** A freshly-admitted learned skill surfaces on the
  NEXT session, AND the per-session `promptSkillsXml` snapshot freezes on the session's FIRST turn — so a turn that
  races the async surface boot-refresh freezes the stale (pre-admit) skill list. Confirm `surfacedCount:N` in the
  log (the surface cache populated) and use a FRESH session AFTER the refresh settles, else the agent lists only
  the bundled skills (a false "the learned skill doesn't surface"). Once settled, the agent lists the learned skill.
- **REFL-5 oracle precision (corrects the table above):** the raw-`memories` supersede is **recency-based** (a
  correction adds a NEW row that wins recall; the prior row is KEPT, no delete; the `memories.history` column stays
  NULL). The `history` JSON-array is the **MentalModel-tier** (kind:profile/topic) supersede column, NOT raw
  `memories`. So REFL-5 oracle = `memories`: latest-wins-recall + prior-row-kept; `mental_models`: `history` array.
- **Eviction (REFL-5b/INV-4) — the deterministic-gate method:** the live failure-accrual chain (recall→fail→
  attribute, corroborated) is fragile/LLM-dependent. Prove the eviction BELT + INV-4 exemption like a gate-probe:
  SEED `memory_usefulness.failure_count >= failureEvictionFloor(3)` on 3 memories (low-proof / high-proof≥5 /
  pinned) via the daemon's better-sqlite3 (read-WRITE), then run the REAL `cron.run jobName "Memory lifecycle"` and
  read `evicted_at` — low-proof EVICTS, high-proof+pinned SURVIVE. (`schema-memory-lifecycle.ts`'s "SCAFFOLD-DORMANT,
  evicts NOTHING" comment is STALE — the wire passes `evictionEnabled:true`; eviction IS reachable.)
- **The reflection content-yield caveat is REPRODUCED** (carried, NOT obsolete for content-quality): the REFL-3 admit
  MECHANISM is GREEN (cardinality≥2 → admit kind=skill candidate trust=learned proof=1; all INV oracles hold), but
  the reflection LLM (sonnet) distills THIN tool-orchestration transcripts UNRELIABLY — it over-generalized a
  delivery-checklist into an ungrounded "research briefing" doc, and declined a cold-chain task (`empty_reflection`).
  This is content-quality/LLM-yield (telemetry honest = NOT a false success), not a mechanism/security failure. Use
  a RICH, distinctive, fabrication-free transcript if you need a grounded admit; don't expect a clean grounded skill
  from a 1-line "write a file" task.

## reflect-obs LIVE-RUN lessons — the obs surface; don't re-discover
- **The aggregate `admissionOutcome` was LAST-KIND-WINS (now fixed).** A reflection runs 3 kinds
  (skill/profile/topic); the SUMMED funnel verdict used to take the LAST non-admitted kind's outcome, so a skill
  kind that was `uncorroborated` (selected≥1, card 1) or `empty_reflection` (card≥2, LLM empty) got OVERWRITTEN by
  the trailing profile/topic `no_successes` — surfacing a verdict that CONTRADICTS its own `selected`/`src` counts
  (e.g. `selected:2` with `no_successes`) and misdirects the operator. Fix: re-classify the aggregate from the
  SUMMED counts via `classifyReflectOutcome` (consistent-by-construction). Now `cron.runs`/`learning_health`/the
  funnel show `uncorroborated`/`empty_reflection`/`untrusted_origin`/`admitted` correctly. If you see a verdict that
  disagrees with its own counts, that regressed.
- **INV-5 untrusted-origin MUST use the `external` trust tier (or an UNMAPPED sender), NOT `"user"`.** `deriveTrustedOrigin`
  (`setup-channels-skill-synthesis-deps.ts`) returns `tier !== "external"` — so `user`/`admin`/any-non-external IS a
  TRUSTED origin (a real channel interaction). Only `external` (or unmapped → `defaultTrustLevel:"external"`) is
  untrusted. Setting `senderTrustMap:{id:"user"}` and expecting `untrusted_origin` is a FALSE-FAIL (it correctly
  ADMITS — user is trusted). For the INV-5 oracle, map the senders to `"external"` (or remove them from
  senderTrustMap so they default to external) → `selected:0, untrustedDrops≥2, outcome:untrusted_origin, no-grow`.
- **The `explain` learning block is at `report.learning` (TOP-LEVEL), NOT `report.signals.learning`.** `toIncidentSignals`
  builds an internal `IncidentSignals.learning`, but `assembleIncidentReport` MAPS it onto the report's top-level
  `learning` field (and `report.signals` is not exposed). Querying `j.signals.learning` returns `undefined` = a
  FALSE-FAIL. Oracle: `comis explain <S> --offline --format json` → `.learning.{skillsUsed,skillsPromoted}`.
- **Poll for the EXACT `"Reflection complete (all kinds)"` line — `"Reflection.*complete"` FALSE-matches the dispatch.**
  The `__REFLECT__` sentinel is fire-and-forget: `cron.run` returns immediately and the scheduler logs `"Job completed"`
  (durationMs ~15, jobName "Reflection") within ~1s — a loose `grep "Reflection.*complete"` matches THAT, not the
  ~20s async reflection. Grep the literal `"Reflection complete (all kinds)"` (the SUMMED daemon emit) for the verdict.
- **cron.runs jobId match (de-risked):** the Reflection cron id IS `reflect-<agentId>` (`reflect-default`),
  which equals the jobId `recordReflectFunnelRun` writes → `cron.runs jobName "Reflection"` resolves the funnel run.
  If a future rename breaks that equality, cron.runs goes silently empty (the built-but-not-wired risk).
- **Seeding a grounded skill for the reuse→promote + explain chain** (since the reflection content-yield caveat makes a reflected admit flaky):
  `INSERT INTO mental_models (...kind='skill', state='candidate', proof_count=promoteAtProofCount-1, mutating=0,
  trust_level='learned', pinned=0...)` via better-sqlite3 (NOT null: `source_who`); restart (boot surface-refresh
  materializes `<workspace>/.learned-skills/<name>/SKILL.md` + logs `surfacedCount` at INFO); drive a task that points
  at the playbook → the agent `read`s the SKILL.md → `skill.prompt_invoked` + `used_skill_ids` → a success reuse →
  `proof_count++` candidate→active + `learning.skill_promoted`. Then `explain` shows `skillsUsed`+`skillsPromoted`.
- **`clean-restart.sh WIPE_CRONS=1` also wipes `execution.jsonl`** — without it a "from-scratch"
  daemon inherits the prior session's `cron.runs` history (a stale `reflect: admitted` record on a wiped memory.db),
  masking the "cron.runs empty on a fresh daemon" case. NOTE it still wipes only `sessions/default/$CHATID` — a 2nd
  corroboration sender (e.g. 678314279) keeps its session dir across clean-restarts (benign; re-drive fresh).
- **The `obs.explain` admin-trust deny is BY DESIGN, not a bug:** `obs.explain` RPC is admin-trust-only BY DESIGN; the deny now names the
  route ("operators use `comis explain`, which assembles offline") and the CLI (no `--offline`) prints "obs.explain is
  admin-trust-only — report assembled offline" + still returns the report. The operator route works; not a bug.
