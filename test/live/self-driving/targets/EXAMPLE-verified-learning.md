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
- **To live-demonstrate skill REUSE (A→B / VL-5/VL-6), the trajectories must CORROBORATE — drive ≥2 analogous successful tasks in ONE batch, THEN run synthesis once** (hermes-usecases 2026-06-25). Admission is gated on `maxClusterCardinality ≥ 2`: synthesis correctly refuses to admit a "skill" from a single uncorroborated instance (`synthesized:N, admitted:0`, `step:"admit" → "skill candidate not admissible"`). If you run `cron.run "Skill synthesis"` *between* the analogous tasks, each task lands in its own cardinality-1 cluster and is never admitted — so you'll wrongly conclude reuse is broken when the gate is working as designed. This conservatism is the SAME property that defeats skill-poisoning (VL-H2): a single hostile/injected trajectory can't be admitted either. Read the funnel in the log (`submodule:"skill-synthesis"` → `candidates`/`clusters`/`maxClusterCardinality`/`synthesized`/`admitted`), not just `db.mjs count learned_skills`.
