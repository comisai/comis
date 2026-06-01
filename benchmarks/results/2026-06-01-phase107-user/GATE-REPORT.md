# Phase 107 USER — Per-user Representation Gate Report (Track E1)

**Date:** 2026-06-01 · **Branch:** `feature/v2.9-understanding-learning-moat`
**System under test:** the per-user representation feature end-to-end — the SOLE `createSqliteUserRepresentationStore` adapter (USER-01), the offline `runUserRepresentationBuild` builder (USER-02), the LLM-free `<user_profile>` prompt-assembly injection (USER-03), and the daemon composition-root wiring + the keyless gate (this plan, 107-05 — USER-04).
**Keyless evidence (this run):** the five `claim*-report.json` files in this directory, produced by `packages/agent/src/memory/benchmark/user-representation-contribution.bench.test.ts` run with `COMIS_BENCH=1` (no answer model, no judge, no API key, no provider call, no cost).
**Baseline to hold:** `benchmarks/results/2026-06-01-phase106-baser/GATE-REPORT.md` (the v2.9 baseline — recall@5 0.845, overall 71.1 / 73.3 cross-judged; single-session-preference 30 / 45 UNSTABLE).

> **Reading rules (honesty protocol).** Two STRICTLY SEPARATE number families. §1 is the keyless MECHANICAL claims — counts, round-trips, rejects, presence/absence, byte-identity, call-counts — each tagged "mechanical, keyless, $0 — not a QA-accuracy lift". The costed QA-accuracy lift (does the standing `<user_profile>` block raise preference-recall accuracy under a real answer model + a real judge?) is **NOT measured here**; it is the operator-costed re-run (§4). This report quotes only numbers read back from the committed `claim*-report.json` files; it states no competitor number and makes no comparative-ranking claim (binding constraint #8).

> **VERDICT: PARTIAL** — the SIX mechanical claims are **MEASURED at $0** (the feature is wired end-to-end and its security/isolation/default-OFF/LLM-free invariants hold). The **costed preference-recall accuracy lift** (the LongMemEval preference category under a real answer model + cross-judge) is **NOT MEASURED** — it is the operator-costed re-run (keys + judge spend; see §4). A forced "PASS" would require quoting an unmeasured costed accuracy number, which the honesty protocol forbids. An honest PARTIAL with full disclosure is the correct outcome — the same outcome every v2.8 CLIMB phase reached.

This is the 6th application of the j1 / KG-05 / REASON-05 / IQ-04 / PROVE gate discipline. Every number below traces to a committed `claim*-report.json` read back from disk before quoting; the costed accuracy lift is explicitly "not measured — operator costed re-run", never a guessed number.

---

## §1 What was ACTUALLY measured (keyless, $0)

The keyless bench drives the **REAL** production code path — `createSqliteUserRepresentationStore` (the SOLE adapter, over a fresh `mkdtempSync` sqlite db), `runUserRepresentationBuild` (the offline builder with an INJECTED **stub** `build` seam — a pure fn returning fixed candidates, **no model, no key**), and `buildUserRepresentationBlock` (the pure LLM-free injection formatter). Each claim writes a confined `claim*-report.json` (the secret-shape sweep proves no credential substring).

| # | Mechanical claim (keyless, $0 — not a QA-accuracy lift) | Result | Source (committed, re-read) |
|---|---|---|---|
| 1 | **Prefix-typing round-trips** — upsert each of the four prefix-types (identity / preference / relationship / instruction); the scoped read returns them typed | 4 written / 4 read back — PASS | `claim1-prefix-typing-report.json` |
| 2 | **External REJECTED (anti-poisoning)** — a forged `external`-trust upsert is rejected at the write boundary (the high-trust floor + the DB CHECK), AND a builder run over an external-only source set writes 0 rows (the job's unconditional external-exclude before the build) | direct upsert rejected = true · external-only written = 0 · rows after = 0 — PASS | `claim2-external-rejected-report.json` |
| 3 | **Redaction-clean** — `validateMemoryWrite` flags a secret-shaped candidate; the builder SKIPS it (`blocked++`), NEVER down-stores it (the USER Pitfall-2 hardening — a `warn`/`critical` verdict has no reduced-weight tier) | firewall flagged = true · blocked ≥ 1 · leaked to store = false — PASS | `claim3-redaction-clean-report.json` |
| 4 | **(tenant, agent, user) isolation** — a row written under scope A is ABSENT across all three foreign axes (cross-tenant / cross-agent / cross-user) and PRESENT in-scope | in-scope = 1 · cross-tenant = 0 · cross-agent = 0 · cross-user = 0 — PASS | `claim4-isolation-report.json` |
| 5 | **Default-OFF byte-identity** — with no profile rows the formatter returns `null` (nothing pushed → byte-identical prompt); the block diverges ONLY when the store returns rows | empty block = null · rows block = non-null — PASS | `claim5-6-offgate-llmfree-report.json` |
| 6 | **LLM-free injection** — the read+format path makes NO `build()`/model call (only `store.read` + the pure formatter run; a build seam is provided but never touched) | build/model calls on the read path = 0 — PASS | `claim5-6-offgate-llmfree-report.json` |

**All six mechanical claims PASS at $0.** No answer model, no judge, no key, no provider call (`grep COMIS_BENCH_*_API_KEY` over the bench returns 0 — there is no key path). The bench SKIPS cleanly without `COMIS_BENCH` (5 skipped, exit 0).

---

## §2 Regression reference (the baseline this feature must not move)

The per-user representation feature is **DEFAULT-OFF** end-to-end: the prompt-assembly injection is gated on the `userRepresentationStore` dep being present AND the store returning rows; the offline builder cron is gated on `agents.<id>.memoryUserRepresentation.enabled` (default false). Claim 5 (default-OFF byte-identity) + claim 6 (LLM-free) are the no-regression-by-construction proof: with the feature off, the prompt is byte-identical and no model call is added to the recall hot path. The v2.9 baseline (`2026-06-01-phase106-baser/`: recall@5 0.845, overall 71.1 / 73.3, single-session-preference 30 / 45 UNSTABLE) is therefore unmoved by this phase with the feature off — and the costed ON measurement is the §4 deferred re-run.

---

## §3 Why the costed preference-recall lift is NOT in this report (the honest finding)

The mechanical claims prove the feature is **wired, secure, isolated, default-OFF, and LLM-free** — but they do NOT prove it **raises QA accuracy**. Measuring the accuracy lift requires:
- a real **answer model** to answer LongMemEval preference-category questions WITH vs WITHOUT the standing `<user_profile>` block, and
- a real **LLM judge** (cross-judge ≥2 per the credibility protocol) to grade the answers, and
- the offline builder run with a **real cheap cron model** (not the keyless stub seam) to populate profiles from a real high-trust source set.

All three cost real spend + keys. The keyless bench deliberately stubs the build seam and uses synthetic fixtures, so it can prove the MECHANISM at $0 but cannot produce an accuracy number. Quoting one here would be fabrication. The lift is therefore DEFERRED to the operator-costed re-run (§4). This is the same measure-first / defer-the-costed-lift discipline every v2.8 CLIMB phase followed (KG-05 / REASON-05 / IQ-04 / PROVE).

---

## §4 How to reproduce the costed preference-recall run (env-var NAMES only)

The costed run is OFF by default and requires the operator to populate the git-ignored `scripts/bench-memory.env` with the following **variable NAMES** (NO values are recorded here — the file is git-ignored and the credential-shape sweep over this manifest is empty):

- `COMIS_BENCH` — set to `1` to un-gate the harness.
- `COMIS_BENCH_ANSWER_PROVIDER` / `COMIS_BENCH_ANSWER_MODEL` / `COMIS_BENCH_ANSWER_API_KEY` — the answer-model lane.
- `COMIS_BENCH_JUDGE_PROVIDER` / `COMIS_BENCH_JUDGE_MODEL` / `COMIS_BENCH_JUDGE_API_KEY` — the judge lane (run TWO judges for the cross-judge fold; an answerer must never be its own provider's judge — BUG-004).

One-command reproduction (after populating `scripts/bench-memory.env`):

```
# Keyless mechanical claims (this report — $0, no key):
COMIS_BENCH=1 pnpm exec vitest run packages/agent/src/memory/benchmark/user-representation-contribution.bench.test.ts

# Costed preference-recall lift (operator re-run — keys + judge spend; DEFERRED):
#   1. populate scripts/bench-memory.env with the variable NAMES above
#   2. enable agents.<id>.memoryUserRepresentation.enabled + run the offline builder cron
#      (the __USER_REPRESENTATION__ sentinel) with a real cheap cron model
#   3. run the LongMemEval preference-category QA harness WITH vs WITHOUT the
#      <user_profile> block under the answer model + the two judges (cross-judge fold)
#   4. record the per-category accuracy delta + N + significance + cost + latency
```

---

## §5 VERDICT: PARTIAL

| Against the gate | Status |
|---|---|
| The feature is wired end-to-end (adapter → builder → injection → daemon composition root) | **MEASURED** — the daemon read+write threads compile + the forward-presence guard holds end-to-end |
| The six mechanical claims (prefix-typing, external-reject, redaction-clean, 3-way isolation, default-OFF byte-identity, LLM-free injection) | **MEASURED at $0** — all PASS (§1) |
| No regression with the feature off | **MEASURED** — default-OFF byte-identity + LLM-free (claims 5+6) are the by-construction proof (§2) |
| The costed preference-recall accuracy lift (LongMemEval preference category, real answer model + cross-judge) | **NOT MEASURED** — the operator-costed re-run (§3, §4) |

**The mechanical machine is MEASURED to work at $0; the costed accuracy lift is honestly DEFERRED with a reproduction command.** No competitor number is stated; no comparative-ranking claim is made; no secret is recorded.

---

## §6 Files in this manifest

- `GATE-REPORT.md` — this report (§1 measured / §2 regression ref / §3 why-deferred / §4 reproduce / §5 verdict).
- `README.md` — the one-screen PARTIAL summary + the keyless reproduce command + the costed pointer.
- `run-provenance.json` — the measured-vs-deferred split + the COI / honesty-protocol block.
- `claim1-prefix-typing-report.json` … `claim5-6-offgate-llmfree-report.json` — the five keyless claim reports (pure numbers + booleans; the secret-shape sweep is empty).
