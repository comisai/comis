# TARGET (worked example) — verified learning (an OFFLINE / DB / event-resident capability)

> A **design-document** target whose capability is **not channel-shaped** — it lives in crons, DB tables,
> and the event stream. Shows the offline-testing class (`03 §offline-oracles`, `04 §B offline recipe`)
> and the impl-state-at-HEAD discipline. Contrast with `EXAMPLE-nvda-dag.md` (a channel/orchestrate target).

## Target
`design/new/verified-learning.md` (rev.2 draft) — outcome-gated, sandbox-validated, trust-tiered learning (WS1–WS7).

## STEP 1 — Verify impl-state at HEAD FIRST (the doc is a stale draft)
The spec marks WS1–WS7 as "NEW / dormant / absent." **Do not trust that.** A focused codebase scan shows they **shipped (v2.26) and are DEFAULT-ON**: `outcome_events`/`learned_skills`/`tuned_alpha` tables exist; `runSkillSynthesis`/online-tuning/lifecycle crons are scheduled + dispatched; the `learning:*` events are bridged; the per-agent `learningOutcome/Skills/Tuning/Forgetting.enabled` flags default **`true`** under master `memory.costFeatures.enabled`. **Test what's live, not the prose.** (Confirm with `comis memory learning` → "ON by default"; `db.mjs tables`; `cron.list {agentId:default}`.)

## Capabilities → requirements (all OFFLINE — drive via tool/graph turns + crons, observe via DB/events)
- **WS1 outcome signal:** a tool turn → `tool:executed` → `observe`→`resolve` → `outcome_events` + `learning:outcome_observed`.
- **WS2 skill synthesis (A→B):** successful trajectories → `__SKILL_SYNTHESIS__` → `learned_skills` candidate → surfaced as a prompt-skill → `read` in a fresh session → `skill:prompt_invoked` + `used_skill_ids` → promote on reuse.
- **WS3 per-intent tuning:** `__ONLINE_TUNING__` (keyless) → `tuned_alpha` per-intent rows move.
- **WS4 wrongness eviction:** corroborated failure → `__MEMORY_LIFECYCLE__` (keyless) → `failure_count` → soft `evicted_at` + `learning:memory_evicted`.

## Must-pass predicates (oracle = DB / CLI obs / events — NOT a chat reply)
| id | predicate | oracle | HARD |
|---|---|---|---|
| VL-1 | a tool turn produces a resolved outcome | `comis memory learning` Coverage>0, success/source counts; `db.mjs pick outcome_events source,outcome` | |
| VL-H1 | trust can never be raised by learning | `db.mjs schema learned_skills` → `trust_level CHECK(... IN ('learned'))`; `db.mjs cols tuned_alpha` → no trust column (4 belts) | ✅ |
| VL-H2 | injected trajectory → no malicious procedure admitted | `db.mjs count learned_skills` stays 0 on an injection trajectory; per-field `validateMemoryWrite` | ✅ |
| VL-5 | synthesis admits a `candidate` (trust=learned) from successful trajectories | `comis memory skills` funnel; `db.mjs pick learned_skills name,state,trust_level` | ✅ trust≤learned |
| VL-6 | a surfaced skill `read` in a fresh session is attributed | `skill:prompt_invoked` event; `outcome_events.used_skill_ids` populated | |
| VL-H4 | a single external failure does NOT evict a high-proof memory | eviction needs ≥2 independent or 1 deterministic failure | ✅ |

## Stage / cost
The **deterministic outcome + tuning + eviction loops are keyless** ($0) — drive these first. Synthesis (WS2/VL-5) is LLM-gated (Anthropic). Stage B/C.

## Known traps for this target (learned the hard way — `03 §offline-oracles`)
- **Not channel-shaped:** the chat reply tells you nothing. Read the DB (`db.mjs`), the CLI obs, the `learning:*` events.
- **`cron.run` works for the operator (post-#240):** pass the job's NAME — `cron.run jobName "Memory online tuning"` → `{triggered:true}` (resolve names via `cron.list`). (Pre-#240 it returned `Capability denied: orch:cron`; fixed by the gateway's server-side orch-cap injection.)
- **System-health sweep WILL find unrelated bugs** here — this run found+fixed `memory_store` deny-by-origin (MD-02) just by driving a "remember this" teach turn. Driving a basic agent tool is part of the job (non-negotiable #6).
- **Clean-slate** must replace `memory.db` (the LCD + learning state live in its tables; `sessions reset` won't clear them).
- **⚠⚠ SKILL SYNTHESIS ADMISSION IS DEAD IN PRODUCTION AT HEAD (SYNTH-EMBED-DEAD — see `runs/FINDINGS-LEDGER.md`, found hindsight-verified-learning 2026-06-25).** The daemon's `buildSourceTrajectories` (`setup-channels-skill-synthesis-deps.ts`) never injects `embedding` into the `SynthesisSourceTrajectory`s, and `clusterSuccesses` treats an absent embedding as a singleton (`skill-synthesis-job.ts:109-110,263-266`) → **every trajectory is a singleton → `maxClusterCardinality` is ALWAYS 1 → `synthesized:0, admitted:0` on EVERY run, regardless of corroboration.** `learned_skills` is permanently empty live; `comis memory skills` always says "No learned skills yet." **Do NOT burn cycles trying to achieve `admitted≥1`** (it cost the hindsight run a 2-sender corroboration setup + sever-clean-session retries before the root cause was found in the code) — read the funnel, cite the finding, move on. The fix (expose the `EmbeddingPort` on `AppContainer` → inject embeddings in `buildSourceTrajectories`) is structural (~4 files) and documented with an implementation-ready direction in the ledger.
- **The corroboration gate IS real but currently MOOT (masked by SYNTH-EMBED-DEAD).** When embeddings ARE wired, admission needs a cluster of `maxClusterCardinality ≥ 2` where `cardinality = distinct (sessionId, sender)` (`skill-synthesis-job.ts:231` `distinctSenderCardinality` = `Set("${sessionId} ${sender}").size`). **`sessionId` is the per-CONVERSATION key (`default:<chatId>:<chatId>:peer:<chatId>`), STABLE across turns in one chat** — so N analogous successes from ONE chat = cardinality 1 (the anti-domination by design: "N successes from one sender count as 1"). To corroborate you need ≥2 DISTINCT sessions (e.g. two `allowFrom` senders), each in a CLEAN session (the clustering text is the whole session transcript — a polluted multi-topic transcript won't cosine-cluster ≥0.82 with a clean single-turn one). Synthesis correctly refuses a single uncorroborated/hostile instance (`step:"admit" → "skill candidate not admissible"`) — the SAME property that defeats skill-poisoning (VL-H2). Read the funnel (`submodule:"skill-synthesis-job"` → `candidates`/`selected`/`clusters`/`maxClusterCardinality`/`synthesized`/`admitted`), not just `db.mjs count learned_skills`.
- **The "Hindsight" capability splits at HEAD: fact-recall WORKS, skill-synthesis is DEAD.** "Knows where to go" (cross-session recall of accumulated `memories` facts: teach→sever→fresh-recall, correction-wins, forget-reconciles-vec+FTS) is **fully live**. "Knows the best route/strategy" as a reusable `learned_skill` (procedural synthesis A→B) is **dead** (SYNTH-EMBED-DEAD). Test + report both halves distinctly.
- **Wrongness-eviction (WS4) via `failure_count` is also effectively inert at HEAD (EVI-STRENGTH-FLOOR — ledger).** The lifecycle strength math floors at `>0.25` (`baseStrength ∈ (0.5,1] × (1−failureFactor∈[0,0.5))`) but the eviction threshold is ≤0.2, so the `strength < threshold` disjunct is mathematically unreachable — only the 90-day dormant-age disjunct evicts (not drivable live). Great for VL-H4 (induced-eviction impossible) but the "forget disproven mental models" path doesn't fire via failures. Prove it: drive failures, `cron.run "Memory lifecycle"`, observe `evicted:0`.
