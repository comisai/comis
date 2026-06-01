# Phase 106 BASER — Baseline Refresh & Gap Report (the keystone deliverable)

**Date:** 2026-06-01 · **Commit:** `da3e0140` · **Branch:** `feature/v2.9-understanding-learning-moat`
**Baseline diffed against:** `benchmarks/results/2026-05-31-j1-baseline/` (the prior cross-judged baseline + its GAP-REPORT.md) + the phase100-kg / phase101-reason / phase102-iq / phase104-prove v2.8 manifests.
**Keyless evidence (this run, Wave 1):** `benchmarks/results/2026-06-01-phase106-baser/keyless-run-log.md` (system under test `010d9973` — v2.8 merged via PR #146; no `packages/*/src/**` changed since).
**Intended costed-pass models:** answer = anthropic/`claude-sonnet-4-6` · judges = openai/`gpt-4o-2024-11-20` + openai/`gpt-4.1` (cross-**model**); claude-opus-4-8 cross-**provider** is the costed re-run, opus-as-judge only when the answer lane is non-Anthropic (BUG-004: an answerer must never be its own provider's judge).

> **Reading rules (honesty protocol).** Every prioritization decision below is driven **only by cross-judge-SURVIVING per-category numbers.** `single-session-preference` (30 / 45 = **15pt** cross-judge spread) is **UNSTABLE** — treated as a directional signal, **not** a precise figure or a hard gate. `locomo` is comparability-only (never headlined). QA accuracy is a prior **costed** cross-judge run on a disclosed category-stratified subset (n=20/category); it is **re-stated, NOT re-measured** here. The keyless mechanical re-measurement (Wave 1) re-confirms **structural invariants only** (counts, monotone @k, `ON <= OFF`, rankLift sign, off=byte-identity) and produces **no** QA-accuracy number. This report **RECORDS** the four open decisions from already-verified codebase evidence; it does not re-investigate them.

> **VERDICT: PARTIAL** — the keyless mechanical claims (Wave 1) + the four open decisions are **MEASURED / RESOLVED at $0 with no regression**, and the CLIMB phases 107–113 are reordered/gated against the re-stated cross-judged baseline. The **fresh cross-judged QA-accuracy refresh** + the **competitor head-to-head** are **NOT MEASURED** — they are the operator-costed re-run (keys + competitor installs + LLM judge spend; see §4). A forced "PASS" would require quoting unmeasured costed claims, which the honesty protocol forbids. An honest PARTIAL with full disclosure is the correct outcome — the same outcome every v2.8 phase reached.

This is the 5th application of the j1 / KG-05 / REASON-05 / IQ-04 / PROVE gate discipline. Every re-stated number below traces to a committed manifest that was read back from disk before quoting; every keyless delta traces to `keyless-run-log.md`; the fresh cross-judged refresh + the head-to-head are explicitly "not measured — operator costed re-run", never a guessed number.

---

## §1 Refreshed baseline — two clearly-labelled number families

### §1a — Cross-judged QA accuracy (prior costed run, re-stated — NOT re-measured this phase)

Produced by a real costed cross-judge run on 2026-05-31 / 06-01; every row traces to `benchmarks/results/2026-05-31-j1-baseline/` (and is corroborated by `benchmarks/results/2026-06-01-phase104-prove/GATE-REPORT.md` §2). These are the v2.9 baseline-to-hold; the **fresh** cross-judge refresh is deferred to the operator-costed re-run (§4).

**Retrieval (FULL set — recall@k / MRR):**

| Metric | Value | Source (committed, re-read) |
|---|---|---|
| recall@1 | 0.573 | `2026-05-31-j1-baseline/` |
| recall@3 | 0.783 | `2026-05-31-j1-baseline/` |
| recall@5 | **0.845** | `2026-05-31-j1-baseline/` |
| MRR | 0.788 | `2026-05-31-j1-baseline/` |

**Per-category QA accuracy (judge gpt-4o / gpt-4.1, n=20 each, disclosed category-stratified subset):**

| Category | acc (A / B) | Cross-judge class | Strength |
|---|---|---|---|
| single-session-user | 100 / 95 | STABLE | STRONG |
| single-session-assistant | 100 / 100 | STABLE | STRONG |
| knowledge-update | 75 / 75 | STABLE | moderate |
| multi-session | 60 / 65 | STABLE | WEAK |
| temporal-reasoning | 45 / 40 | STABLE | weakest stable |
| single-session-preference | 30 / 45 | **UNSTABLE (15pt spread)** | weak-but-noisy — NOT a hard gate |
| locomo *(comparability-only)* | 93.3 / 100 | UNSTABLE | never headlined |

**Overall:** 71.1 / 73.3 (gpt-4o / gpt-4.1; cross-judge spread 2.2pt).
**Cost / latency:** ~15.5k tokens/query · end-to-end latency P50 **6.25s** / P95 **9.97s**.
**Filesystem-baseline control (letta-fs):** 52.6 / 36.3 — a labelled control row, far below Comis's recall (the benchmark is not weak); **never** Comis's headline.

### §1b — Mechanical, keyless, $0 — NOT a QA-accuracy lift

The Wave-1 re-measurement (`keyless-run-log.md`) re-confirms **structural invariants** on the merged v2.8 system. **Each item below is tagged "mechanical, keyless, $0 — not a QA-accuracy lift"** and is kept STRICTLY SEPARATE from §1a. A keyless run has no judge → it produces no QA accuracy; any fresh accuracy number here would be fabricated.

| Mechanical invariant (keyless, $0 — not a QA-accuracy lift) | This run | Source |
|---|---|---|
| `recall-learning` rankLift = firstRank − lastRank is **positive** (gold doc climbs as FEED usefulness accrues) | 2/2 PASS (directional) | `keyless-run-log.md` §2a |
| `redaction` leak-rate `scoreOn.leakRate <= scoreOff.leakRate` (the firewall never increases leak-rate) | 2/2 PASS (directional) | `keyless-run-log.md` §2b |
| `gate` append-only never-overwrite **ledger MECHANISM** (2nd same-path write refused, prior bytes byte-identical; different-date row coexists; NO row written to `benchmarks/results/history/` on the keyless path) | 7/7 PASS | `keyless-run-log.md` §1a |
| `head-to-head` ablation **off = byte-identity** for all 5 v2.8 factors (`lanes.graphSpread.enabled` / `mmr.enabled` / `queryUnderstanding.intentReweight` / `queryUnderstanding.temporalParse` / write-side `memoryReasoning.enabled`) | 7/7 PASS | `keyless-run-log.md` §1b |
| `head-to-head` cross-judge spread fold over **INJECTED** deterministic verdicts survives **3/4** (single-session-preference 30-vs-45 = 15pt flagged UNSTABLE) + significance never-NaN + mem0 skip-with-disclosure (no numeric field) + letta-fs control ran + a real Comis recall cell (lanes ON) returned ranked results | 7/7 PASS | `keyless-run-log.md` §1b |
| `beam` recall@k-at-scale | **SKIPPED** (logged; ~2h budget; BEAM measures recall@k not footprint → the FORGET-scope finding is static regardless) | `keyless-run-log.md` §2 |

**No-regression (Wave 1):** every structural invariant held; **no FINDING, no BLOCKER** (no source changed since #146). The keyless deltas are mechanical re-confirmation, **not** an accuracy lift over §1a.

---

## §2 Per-track gap analysis → reorder / gate Phases 107–113

The numeric phase order is NOT renumbered; this section is the prioritization layer each later `/gsd-plan-phase` run reads. Each weak axis (cross-judge-stable unless noted) maps to its track. The ROADMAP carries CLIMB phases **107–113** (107 USER · 108 SOCIAL · 109 DIALECTIC · 110 LEARN-IQ · 111 LEARN-RANK · 112 FORGET · 113 RE-PROVE+PUB).

| Weak / target axis (from §1a, stable unless noted) | Why | Track → Phase | Will it MOVE the number? |
|---|---|---|---|
| temporal-reasoning **45 / 40** (stable, weakest stable) + knowledge-update **75 / 75** | time + supersession | Track F (trust-first bi-temporal KG) — **ALREADY SHIPPED v2.8 Phase 100** | Confirms the climb baseline (the KG lane already targets this; the costed cross-judge lift is the §4 deferred re-run) |
| single-session-preference **30 / 45** (**UNSTABLE**, 15pt) | no per-user preference model | **Track E1 / Phase 107 (USER)** — **NOW A FULL BUILD** per §3 OD1 (E1 not shipped) | BUILD — but preference instability lowers confidence; PrefEval / a cross-provider judge would give a stable preference number (deferred to §4) |
| multi-session **60 / 65** (stable, WEAK) | merge-only consolidation can't multi-hop across sessions | reasoning observations (**SHIPPED v2.8 Phase 101**) + the dialectic (**Phase 109**) | BUILD (Phase 109 dialectic); the reasoning substrate is shipped |
| the **learning-lift** axis (Tier-3; a self-measured axis no competitor posts a number on) | recall does not yet improve from recall-outcome feedback as a tuned loop | **Phases 110–111 (LEARN-IQ + LEARN-RANK)** | BUILD — the H1 query-conditional usefulness (110) then the H2 bandit (111, **conditional** per §3 OD2) |
| footprint / memory growth at scale | no measured footprint-pressure signal exists (see §3 OD4) | **Phase 112 (FORGET)** | DECAY-ONLY parity (FORGET-01) is a BUILD; eviction (FORGET-02) is DEFERRED/conditional |
| relationship / multi-party | group-channel directional modeling not built | **Phase 108 (SOCIAL)** | BUILD — but GATED on a privacy-review sign-off (§3 OD3), default-OFF until signed |

**Recommended order:** the default brief order **107 → 108 → 109 → 110 → 111 → 112 → 113**.

**Confidence note on E1 / Phase 107:** the sole axis Phase 107 directly targets (single-session-preference) is the **one cross-judge-UNSTABLE category** (15pt). That lowers the confidence of the preference-recall target — the gain is real and directionally lowest, but n=20 + a 15pt cross-judge spread is too noisy to set a precise lift target now. A stable preference number requires PrefEval (a purpose-built preference benchmark) or a cross-provider judge — **deferred to the costed pass (§4).** Phase 107 still proceeds as a full build (the substrate doesn't exist — §3 OD1); its benchmark gate (USER-04) tracks the preference lift but treats it as directional until a stable measure exists.

**What MOVES the number (build) vs gated/conditional:**
- **Build, high-leverage:** Phase 109 (dialectic → multi-session 60–65) · Phase 110 (H1 query-conditional usefulness → the learning-lift axis).
- **Build, lower-confidence (unstable target):** Phase 107 (USER → preference 30–45, unstable).
- **Conditional / gated:** Phase 111 (H2 bandit — conditional on Phase 110 under-delivering + trust-frozen tests, OD2) · Phase 108 (SOCIAL — gated on a privacy-review sign-off, OD3) · Phase 112 FORGET-02 eviction (deferred — no footprint signal, OD4).
- **Already shipped (baseline confirmation):** Track F KG (Phase 100) + reasoning observations (Phase 101).

---

## §3 The four open-decision resolutions (RECORDED with cited evidence)

All four are resolved from codebase evidence already verified in RESEARCH (greps over `packages/*/src/**`, re-confirmed live). This report records them; it does not re-investigate.

### OD1 — E1 (per-user representation) is **NOT SHIPPED** → Phase 107 is a FULL build

**Verdict: NOT SHIPPED. Do NOT collapse Phase 107 (USER) to a benchmark-validation no-op — it proceeds as a full build on the shipped substrate.**

Cited evidence (greps over `packages/*/src/**`):
- `grep -rl "UserRepresentation" packages/*/src/` → **0 hits.**
- `grep -rEl "IDENTITY.*PREFERENCE|PREFERENCE.*RELATIONSHIP" packages/*/src/` → **0 hits** — the `IDENTITY/PREFERENCE/RELATIONSHIP/INSTRUCTION` prefix-typing USER-01 specifies does not exist.
- The shipped `memoryType` enum is `z.enum(["working","episodic","semantic","procedural"])` (`packages/core/src/domain/memory-entry.ts:71,148`) — a DIFFERENT vocabulary from the USER prefix-typing.
- The only "profile store" in the tree is `packages/memory/src/oauth-profile-store-encrypted.ts` — OAuth **credential** storage, NOT a memory / user-representation store.

**Build-on-substrate (not greenfield):** the `memories` table (`tenant_id` / `agent_id` / `user_id` / `trust_level`), the redaction firewall, and `validateMemoryWrite` ARE shipped. Phase 107 builds a `UserRepresentationStore` (type-only port in `@comis/core` + the sole adapter in `@comis/memory` + daemon wiring — the architecture cut) on top of that substrate.

### OD2 — H2 bandit (gates Phase 111 LEARN-RANK) → **CONDITIONAL GATE**

**Verdict: CONDITIONAL.** Ship the H2 online weight-tuning bandit at Phase 111 **only if** Phase 110's H1 (query-conditional usefulness) under-delivers **AND** it clears the trust-frozen invariant tests. This is recorded as a gate, not a now-decision. Substrate present: `packages/memory/src/sqlite-memory-usefulness-store.ts` (the FEED store) + the scoring alphas `{recency, temporal, proof, trust}` + `usefulnessAlpha`. **The bandit ranges over recency/temporal/proof/usefulness alphas only — `trustAlpha` and the trust filter are frozen + clamped** (the binding constraint; trust is a HARD boundary, frozen under online tuning).

### OD3 — E2 multi-party privacy (gates Phase 108 SOCIAL) → **per-channel, default-OFF until privacy-review sign-off**

**Verdict: per-channel only, default-OFF until a privacy-review sign-off is recorded (SOCIAL-03, a Phase 108 deliverable).** This records the privacy-review gate; the actual sign-off is the Phase 108 deliverable. Cross-boundary relationship reads (a user's model of another crossing a channel-privacy or tenant boundary) are out of scope — visibility is enforced in SQL so a cross-boundary read is structurally impossible (SOCIAL-02).

### OD4 — FORGET scope (gates Phase 112) → **decay-only (FORGET-01); eviction (FORGET-02) DEFERRED**

**Verdict: decay-only parity (FORGET-01), byte-identical at neutral importance; full eviction / lifecycle (FORGET-02) DEFERRED to v2.10** unless a footprint probe is added first. No footprint-pressure signal is measurable from the committed artifacts or the BEAM harness.

Cited evidence:
- `grep -rEl "footprint|dbSize|diskUsage|memoryGrowth|byteLength" packages/agent/src/memory/benchmark/beam*` → **0 hits** — the BEAM harness measures **recall@k only**, never bytes / footprint / growth (`beam-scorer.ts` macro-averages recall@1/3/5 + MRR per ability).
- `find benchmarks -iname '*beam*'` → **0** — there is **no committed BEAM manifest** under `benchmarks/results/`.
- `assertStructural` (`beam-harness.bench.test.ts`) explicitly refuses a hard recall floor — it asserts `[0,1]` + monotone @k only.
- **FORGET-01's dependency IS satisfied:** the persisted `memory_type` column is on disk (`packages/memory/src/row-mapper.ts:111`; DB CHECK constraint `IN ('working','episodic','semantic','procedural')`), so per-type β decay is implementable from shipped state.
- **Precedent:** the v2.8 j1-baseline GAP-REPORT.md OD3 already provisionally deferred FORGET pending a BEAM footprint signal that was never measured. Running `beam` 1M this phase would re-confirm recall@k-at-scale no-regression but would STILL produce no footprint number — the absence is **structural**, not a not-yet-run gap.

**Scope for Phase 112 (if kept):** FORGET-01 (the FadeMem decay math, byte-identity at neutral importance) + the benchmark-gate byte-identity proof; FORGET-02 (hysteresis-banded promote/demote + usefulness-aware eviction) is conditional on a future footprint signal (a `db.statSync` / row-count-at-scale measurement the BEAM harness does not currently take).

---

## §4 The operator-costed deferral block + the one-command reproduction

The fresh cross-judged QA-accuracy refresh + the competitor head-to-head are **NOT MEASURED** this phase — they require the operator-costed re-run. Reproduce (mirrors `benchmarks/results/2026-06-01-phase104-prove/GATE-REPORT.md` §4; ENV-VAR NAMES only — no key values):

```bash
# 1. Populate the git-ignored operator env (NEVER committed):
cp scripts/bench-memory.env.example scripts/bench-memory.env
#    fill COMIS_BENCH_ANSWER_* (the answer model) + COMIS_BENCH_JUDGE_* (judge #1).
#    For the cross-judge spread, run a SECOND judge pass and publish the spread.
# 2. Install the competitor systems (operator/external — NEVER a Comis dependency):
#    mem0:      set MEM0_API_KEY + install the mem0ai package
#    zep:       set ZEP_API_KEY + install the @getzep/zep-js SDK
#    hindsight: clone + build ../hindsight
#    mnemosyne: clone + build ../mnemosyne
# 3. Run the per-release continuous gate. KEYLESS, it PROVES the never-overwrite
#    ledger MECHANISM over a tmp dir (it writes NO row to benchmarks/results/history/).
#    The COSTED pass (this command with the env + competitor installs above) is what
#    appends the real dated row to benchmarks/results/history/<date>-<commit>.json
#    and releases the raw answer + judge transcripts alongside it:
scripts/bench-memory.sh gate
```

**Deferred to this costed re-run:**
1. **The fresh cross-judged QA-accuracy refresh** — answering the J1 corpus with the answer model and grading with ≥2 independent judges. There is no keyless judge; a fresh accuracy number this phase would be fabricated. Diff it against the §1a baseline.
2. **The competitor head-to-head (mem0 / zep / hindsight / mnemosyne)** — each competitor adapter is a skip-with-disclosure skeleton; **none is a Comis dependency** (the exact-pin + bundling supply-chain invariant). The keyless CI always hits the skip branch (that IS the wiring proof). A real competitor cell needs the operator's installs + keys + LLM judge spend; a vendor self-reported number is non-comparable across protocols (the COI). Diff against `benchmarks/results/2026-05-31-j1-baseline/` (overall 71.1/73.3, recall@5 0.845, temporal 45/40, control 52.6/36.3).

---

## §5 Verdict against the BASER-01 gate

| BASER-01 clause | Required | Result | Evidence |
|---|---|---|---|
| (a) v2.8 suite runs on the merged system; no regression vs the committed baseline | keyless measured | ✅ **PASS** — all keyless tiers GREEN, every structural invariant held | §1b, `keyless-run-log.md` §3 |
| (b) updated baseline (recall@k/MRR + per-category QA + tokens/query + latency) in a committed reproducibility manifest | re-stated + committed | ✅ **PASS** — re-stated in §1a, this manifest is TRACKED under `benchmarks/results/` | §1a |
| (c) a gap report reorders/gates 107–113 and resolves the 4 open decisions | authored | ✅ **PASS** — §2 reorders/gates; §3 resolves OD1–OD4 with cited evidence | §2, §3 |
| (d) the number stands only if it survives ≥2 judges (cross-judge spread recorded) | recorded | ✅ **PASS** — the cross-judge spread is re-stated (single-session-preference 15pt flagged UNSTABLE; 3/4 fold re-confirmed keyless) | §1a, §1b |
| (e) honesty gate green; no secret; no superiority-comparison framing | gated | ✅ **PASS** — `check-publish-honesty.sh --strict` exit 0; credential-shape sweep clean; no superiority-comparison framing | §7, run-provenance.json |
| The **fresh cross-judged QA-accuracy refresh** + the **competitor head-to-head** | measured | ⏳ **NOT MEASURED** — operator costed re-run | §4, run-provenance.json |

### VERDICT: PARTIAL

- **The keyless mechanical claims + the four open decisions are MEASURED / RESOLVED at $0** with no regression (§1b, §3); the CLIMB phases 107–113 are reordered/gated against the re-stated cross-judged baseline (§2).
- **The fresh cross-judged QA-accuracy refresh + the competitor head-to-head are NOT MEASURED** — they require the operator-costed re-run (keys + competitor installs + LLM judge spend; §4).
- A forced "PASS" would require quoting unmeasured costed claims (forbidden by the honesty protocol). PARTIAL with full disclosure is the correct, consistent outcome — the same outcome every v2.8 phase reached.

---

## §6 Benchmark regression-gate reference for Phases 107–113

The cross-judge-stable per-category numbers (§1a) are the regression reference. Each CLIMB phase re-runs the suite: **no stable category regresses** beyond tolerance, **AND** a target lift on the category/axis its track targets. Preference is tracked but, being cross-judge-UNSTABLE, is **not a hard gate** until a stable measure exists; LoCoMo stays comparability-only.

**Overall floor to HOLD:** ~71% (cross-judge) overall · recall@5 **0.845**.

| Phase | Track | Target axis | Baseline to HOLD (stable) | Target lift |
|---|---|---|---|---|
| 107 (USER) | E1 | single-session-preference | 30–45 (UNSTABLE — directional, not a hard gate) | preference recall up; zero category regression |
| 108 (SOCIAL) | E2 | (privacy-gated; no accuracy target) | all categories HOLD | zero regression; default-OFF byte-identity |
| 109 (DIALECTIC) | G + D3 | multi-session | 60–65 | multi-session up; recall stays LLM-free (asserted) |
| 110 (LEARN-IQ) | H1 + H3 | the learning-lift (Tier-3) axis | all categories HOLD | positive query-conditional usefulness signal at recall |
| 111 (LEARN-RANK) | H2 | the learning-lift (Tier-3) axis | all categories HOLD; **trust-first invariant frozen** | positive bounded lift over episodes (conditional gate, OD2) |
| 112 (FORGET) | C | footprint (no signal yet) + all categories | all categories HOLD | FORGET-01 byte-identity at neutral importance; footprint bounded |
| 113 (RE-PROVE+PUB) | J + K | the full suite + learning-lift + head-to-head refresh | the §1a baseline (cross-judged) | cross-judged refresh + head-to-head, no "X" framing before measured |

Each gate is **default-OFF byte-identity to the Phase-106 baseline** unless the track's feature is enabled (the v2.8 discipline). The learning-lift (Tier-3) axis is the self-measured axis: a positive bounded lift over episodes with the trust-first invariant preserved.

---

## §7 Files in this manifest

| File | Provides |
|---|---|
| `GATE-REPORT.md` | this report — the gap report: the re-stated baseline (§1a) kept separate from the keyless mechanical deltas (§1b), the 107–113 reorder/gate (§2), the four decision resolutions (§3), the operator-costed deferral + reproduction (§4), the PARTIAL verdict (§5), the regression-gate reference (§6) |
| `run-provenance.json` | commit / branch / intended-models + `measurementsTaken` / `measurementsDeferredToOperatorCostedReRun` + the `decisionsResolved` + a `coi` / `ossLicense` / `rawTranscriptRelease` + `honestyProtocol` block |
| `README.md` | the one-screen manifest summary + the keyless reproduce command + the costed-pass pointer |
| `keyless-run-log.md` | Wave 1 (Plan 01): the captured $0 keyless tier outcomes (gate / head-to-head / recall-learning / redaction) + the no-regression comparison vs the committed v2.8 baseline — the source of §1b + the §5 no-regression clause |

**Honesty:** every re-stated number in §1a traces to a committed manifest under `benchmarks/results/2026-05-31-j1-baseline/`; the §1b mechanical deltas trace to `keyless-run-log.md`; the fresh cross-judged refresh + the competitor head-to-head are "not measured — operator costed re-run" (§4), never a guess. No superiority-comparison framing and no credential shape appears anywhere in this manifest.
