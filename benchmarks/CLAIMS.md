# CLAIMS.md — the Phase 105 trim contract (PUB-03)

**Every published memory claim maps here** to a shipped **Track / Phase** and a **committed
manifest path** under `benchmarks/results/`. Any claim without shipped evidence is **CUT** — it
must never appear in a published surface. This file is the single source of truth for what
Phase 105 (the publish phase) is allowed to say, and it is enforced mechanically by
[`scripts/check-publish-honesty.sh`](../scripts/check-publish-honesty.sh): that gate greps the
published surfaces for forbidden tokens and asserts every committed-manifest path cited here
resolves on disk (no orphan claim).

## The honesty contract (binding constraint #8)

- **No "beats X" / superiority claim ships** until the number is (1) measured under the
  disclosed protocol, (2) survives a cross-judge spread, and (3) the competitor was re-run
  under that same protocol. **The Phase-114 head-to-head now satisfies all three** (mem0
  `2.0.4` re-run by us, cross-judge spread 0.0, best-effort N=8) — and the **outcome was a TIE**:
  Comis 87.5% == mem0 87.5%, statistically indistinguishable at N=8. So "beats" **still never
  ships** — not because the number is missing, but because there is **no superiority result to
  claim**. The published framing is **"competitive-with mem0 / at-$0-on-device,"** never "beats."
  Every competitor comparison still also points at **"reproduce/extend via the gate,"** never a
  fabricated cell. (Source: `benchmarks/results/2026-06-02-phase114-prove2/head-to-head-report.json`.)
- **Conflict of interest is disclosed:** Comis authored this benchmark. Vendor-reported
  competitor numbers are **non-comparable** across protocols; competitors are invited to
  reproduce on their own harness. (Source: `benchmarks/results/2026-06-01-phase104-prove/head-to-head-report.json` → `coi`.)
- **No overclaiming token / unmeasured costed lift is published, even where the capability now
  ships:** the v2.9 milestone ships principled ranking decay (Track C / Phase 112), learning-to-rank
  with trust frozen (Track H2 / Phase 111), a per-user profile + per-channel relationship model
  (Tracks E1/E2 / Phases 107–108), and an opt-in ask-your-memory tool (Track G / Phase 109) — listed
  in the PUBLISHED table with the gate-safe wording. What stays CUT is the literal marketing token
  the gate forbids (FORGET / per-type decay / usefulness-aware eviction / lifecycle, bounded online
  weight-tuning "weights adapt", theory-of-mind, the dialectic / `memory_ask`), the comparative
  ranking claim, and the per-capability **costed QA-accuracy lift** — each the deferred operator-costed
  re-run. The capability ships; the overclaiming phrasing + the costed comparison do not. See the CUT
  rows below.
- **No placeholder numbers** (`__%`, `__×`, `TODO`, `FIXME`) ship (PUB-02).

## Mechanical-vs-accuracy framing (CRITICAL — read before publishing any number)

There are **two distinct kinds** of measured claim, and they must never be conflated:

- **`accuracy, cross-judged`** — the Phase-98 baseline (set A). These are the **only** real
  end-to-end QA-accuracy numbers Comis has measured, scored by two independent LLM judges
  (gpt-4o + gpt-4.1) and reported only where the cross-judge spread is stable.
- **`mechanical, keyless, $0`** — the four v2.8 deterministic gate deltas (sets B/C/D/E). These
  are **structural** claims (a lane surfaces a linked doc; a write lands at the right trust tier;
  an off-knob is byte-identical) measured **keyless at $0** — no answer model, no judge, no key,
  no cost. They are **NOT** end-to-end QA-accuracy lifts. The QA-accuracy lift for each v2.8
  track is honestly deferred to the operator-costed re-run. A "+1 linked-doc recall delta" is
  **not** "+1% accuracy" — quoting it as an accuracy lift is exactly the fabrication binding
  constraint #8 forbids.

`Surfaces` legend: **R** = `README.md`, **L** = `website/src/pages/memory.astro` (leaderboard),
**M** = `docs/agents/memory-benchmarks.mdx` (methodology), **B** = the launch blog post.

---

## PUBLISHED CLAIMS (allowed to ship — each cites a committed manifest)

| Published claim | Track / Phase | Shipped? | Kind | Manifest / evidence | Surfaces |
|-----------------|---------------|----------|------|---------------------|----------|
| Overall **71.1 / 73.3** cross-judged (n=135, incl. locomo; spread 2.2, stable) | BENCH 88–89 / Phase 98 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-05-31-j1-baseline/cross-judge-spread.md` · `benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json` · `benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-b.json` | R, L, M |
| **recall@5 0.845** (full-set retrieval, vector lane + on-device rerank both lit) | BENCH 88–89 / Phase 98 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-05-31-j1-baseline/retrieval-metrics.json` (`recallAt5` 0.8450799…; `recallAt1` 0.5734, `recallAt3` 0.7827, `mrr` 0.7883) | R, L, M |
| **knowledge-update 75/75**, **multi-session 60/65**, **temporal 45/40** cross-judged (per-category, stable) | BENCH 88–89 / Phase 98 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json` · `benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-b.json` | L, M |
| **≈15.5k tokens/query**; end-to-end latency **P50 6.25s / P95 9.97s** | BENCH 88–89 / Phase 98 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-05-31-j1-baseline/GAP-REPORT.md` (§1 context rows) | L, M |
| Graph-spread lane: linked-doc recall **delta +1** (OFF: linked absent → ON: linked surfaced purely by the KG edge) | KG / Phase 100 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase100-kg/graph-spread-contribution-report.json` (`linkedDocRecallDelta` 1) | L, M |
| Trust-first KG write-path invalidation **100% (2/2)** on SUITE-04 (older-high-trust-wins via the real `upsertTriple`) | KG / Phase 100 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase100-kg/trust-first-kg-invalidation-report.json` (`trustFirstCorrectRate` 100) | L, M |
| Inductive observation write **capped ≤ `learned`** (0 `system`-trust inductive rows) | REASON / Phase 101 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase101-reason/reasoning-write-correctness-report.json` (`inductiveTrustIsLearned` true; `systemInductiveRows` 0) | L, M |
| MMR diversity: diverse-doc rank **OFF 3 → ON 2** (`diversityRankLift` 1); λ=1.0 byte-identical to OFF | IQ / Phase 102 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase102-iq/mmr-diversity-report.json` | L, M |
| Intent reweight: temporal candidate rank **OFF 2 → ON 1** (`reweightRankLift` 1; intentMultiplier 1.5) | IQ / Phase 102 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase102-iq/intent-reweight-report.json` | L, M |
| NL temporal-range: in-window precision **OFF 0.5 → ON 1.0**; unparseable query → no filter (byte-identity) | IQ / Phase 102 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase102-iq/temporal-range-report.json` | L, M |
| Default-OFF **byte-identity / zero-regression** (every v2.8 factor; OFF = byte-identical to Phase-98 shipping config) | KG/IQ/PROVE / Phases 100, 102, 104 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase100-kg/` · `benchmarks/results/2026-06-01-phase102-iq/default-off-byte-identity-report.json` · `benchmarks/results/2026-06-01-phase104-prove/ablation-contribution-report.json` | M |
| Cross-judge spread **survives fold 3/4** (the proving machine, injected verdicts, $0; the 15pt preference category does not survive — disclosed) | PROVE / Phase 104 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase104-prove/cross-judge-spread.json` | M, B |
| COI disclosed; competitors **invited to reproduce via the gate** (no fabricated competitor cell) | PROVE / Phase 104 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase104-prove/head-to-head-report.json` (`coi`; `adapter-conformance-report.json` → `fabricatedNumber:false`) | L, M, B |

### v2.9 capabilities (shipped + keyless-proven; each → a committed manifest)

The v2.9 milestone **ships** these capabilities (TDD-green) and proves them **keyless at $0**.
Every row is `mechanical, keyless, $0` — a structural invariant of the shipped code, **NOT** an
end-to-end QA-accuracy lift. The per-capability costed QA-accuracy lift + the competitor
head-to-head stay **deferred** (the CUT rows below; binding constraint #8). The wording here is
the gate-safe phrasing the published surfaces copy verbatim.

| Published claim | Track / Phase | Shipped? | Kind | Manifest / evidence | Surfaces |
|-----------------|---------------|----------|------|---------------------|----------|
| **Per-user profile** — typed per-user records round-trip; an external-trust upsert is rejected (0 rows); (tenant, agent, user) isolation; default-OFF byte-identical; recall stays LLM-free | USER (Track E1) / Phase 107 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase107-user/claim1-prefix-typing-report.json` (prefix-typing round-trips 4/4) | L, M, B |
| **Per-channel relationship model** (ships DEFAULT-OFF / dormant) — directional A→B and B→A stored as two distinct edges; the sign-off gate holds (enabled-but-unsigned ⇒ 0 reads, null block) | SOCIAL (Track E2) / Phase 108 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase108-social/claim4-signoff-gate-report.json` | L, M |
| **Ask-your-memory tool** (opt-in / default-OFF) — recall stays LLM-free (0 model calls on read); citations are a subset of the recalled ids; mandatory abstention on empty recall | DIALECTIC (Tracks G + D3) / Phase 109 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase109-dialectic/claim2-recall-llm-free-report.json` | L, M, B |
| **Query-conditional usefulness reorder** — a memory used for intent X ranks 1 vs 2 for an X- vs Y-query (`perIntentRankLift` 1); citation→FEED accrual; default-OFF byte-identical | LEARN-IQ (Tracks H1 + H3) / Phase 110 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase110-learn-iq/claim1-per-intent-bucket-report.json` | L, M |
| **Learning-to-rank, trust frozen** — an opt-in loop learns which memories prove useful and bounded-tunes recall ranking from that signal; trust stays frozen under tuning; default-OFF byte-identical | LEARN-RANK (Track H2) / Phase 111 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase111-learn-rank/claim1-bandit-rank-lift-report.json` | L, M, B |
| **The one measured learning signal**: bandit recall-**SCORE** lift **+0.1** over 5 episodes (`goldScoreLift` 0.1, MEASURED-POSITIVE); the gold's **rank position is FLAT** on the keyless lane (`rankLift` 0, MEASURED-FLAT) — never rounded into "+0.1% accuracy" | LEARN-RANK (Track H2) / Phase 111 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase111-learn-rank/claim1-bandit-rank-lift-report.json` (`goldScoreLift` 0.1; `rankLift` 0) | L, M, B |
| **Principled ranking decay of stale memories** (eviction dormant / default-OFF) — old + unused rank lower (old/unused factor **0.553** < fresh **0.995**; gap 0.441); decay RANKS, never GATES; byte-identical at neutral; dormant footprint 5→5 | FORGET (Track C) / Phase 112 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase112-forget/claim2-deterministic-decay-report.json` | L, M, B |
| **Consolidated v2.9 keyless re-prove** — the four keyless modes re-pass on the climbed system ($0, no env); the six capabilities consolidated; the costed comparison recorded as deferred | PROVE (Track J) / Phase 113 | ✅ | mechanical, keyless, $0 | `benchmarks/results/2026-06-01-phase113-reprove/` (`GATE-REPORT.md` · `run-provenance.json` · `README.md`) | L, M, B |

### v2.10 competitor head-to-head (the costed, cross-judged re-run — finally measured)

The v2.10 milestone runs the operator-costed competitor head-to-head that v2.9 honestly
deferred. These are `accuracy, cross-judged` numbers (the second real end-to-end QA-accuracy
set after the Phase-98 baseline), **competitors re-run by us under one protocol** (answer
`claude-sonnet-4-6` + judges gpt-4o **and** claude, cross-judge spread **0.0 on every cell**),
best-effort **N=8** LongMemEval. **Binding constraint #8 holds: Comis TIED mem0 — the framing
is "competitive-with mem0 / at-$0-on-device," NEVER "beats."** At N=8 the two are statistically
indistinguishable on accuracy (a 1-question gap is 12.5 pt); the differentiator is cost /
latency / locality, not a quality edge.

| Published claim | Track / Phase | Shipped? | Kind | Manifest / evidence | Surfaces |
|-----------------|---------------|----------|------|---------------------|----------|
| **Competitive with mem0**: Comis as-shipped recall **87.5%** (7/8) and mem0 (`mem0ai 2.0.4`, re-run by us) **87.5%** (7/8) score the same; cross-judge spread **0.0** (both judges agreed); statistically indistinguishable at N=8 — competitive-with, never "beats" | PROVE2 / Phase 114 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-06-02-phase114-prove2/head-to-head-report.json` (comis + mem0 each `judge1.overall` 87.5, `correct` 7/8, `crossJudge.overallSpread` 0) | R, L, M |
| **Both beat the letta-fs full-dump control by +37.5 pt** (Comis/mem0 87.5% vs control **50.0%**, 4/8) — the bench discriminates (ranked/extracted memory ≫ naive full-context dump) | PROVE2 / Phase 114 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-06-02-phase114-prove2/head-to-head-report.json` (control `judge1.overall` 50, `vsBaseline.deltaPts` -37.5) | L, M |
| **The differentiator is locality, not quality**: Comis recall is **LLM-free at $0 on-device** (local embed + rerank); mem0 spent paid OpenAI fact-extraction (~53 min ingest / 8 items). Equal answer quality, very different production economics | PROVE2 / Phase 114 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-06-02-phase114-prove2/GATE-REPORT.md` (§3 cost/latency + LLM-free note) · `benchmarks/results/2026-06-02-phase114-prove2/head-to-head-report.json` | R, L, M |
| **Per-capability QA-lift, measure-first**: Comis baseline **98.0% / 94.0%** cross-judged (spread 4.0, survives) on a 50-item mix; **no recall-config capability showed measured QA-lift** (intent-reweight + forget byte-identical to baseline 50/50, +0.0 pt) → Phase 115 flips nothing by default | PROVE2 / Phase 114 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-06-02-phase114-prove2/capability-lift-report.json` (baseline `judge1.overall` 98 / `judge2.overall` 94; intent-reweight + forget `vsBaseline.deltaPts` 0, `identicalToBaselineCount` 50) | L, M |
| **Honest scope**: N=8 / N=50 are best-effort operator-costed samples, not the definitive scale; Zep / Hindsight / Mnemosyne were skip-with-disclosure (not wired this run — never a fabricated cell) | PROVE2 / Phase 114 | ✅ | accuracy, cross-judged | `benchmarks/results/2026-06-02-phase114-prove2/run-provenance.json` (`headToHead.competitorsSkippedWithDisclosure`; `headToHead.status` best-effort N=8) | M, B |

---

## CUT CLAIMS (DEFERRED / NOT SHIPPED — must NEVER appear in any published surface)

These are the explicit **no-FORGET / no-"beats X" / no-online-tuning / no-dialectic / no-ToM**
register. Every row is `Surfaces = NONE`. The gate forbids the tokens that would smuggle these
back in. **v2.9 note:** several of these *capabilities* now ship (Phases 107–112, in the PUBLISHED
table above using the gate-safe wording). What stays CUT is the **overclaiming token / the
comparative ranking claim / the unmeasured costed QA-lift** — the gate still forbids the literal
marketing token even though the capability landed, so the published prose uses the honest synonym.

| Cut claim | Track / Phase | Shipped? | Kind | Reason cut | Surfaces |
|-----------|---------------|----------|------|------------|----------|
| "**beats** mem0 / Zep / Hindsight / Mnemosyne" / any "beats X" / "outperforms" / "#1" / "best agent memory" headline | PROVE2 / Phase 114 | ❌ NO SUPERIORITY RESULT | — | The costed head-to-head ran (Phase 114, PUBLISHED above) — and Comis **TIED** mem0 (87.5% == 87.5%, indistinguishable at N=8). So "beats" stays CUT: there is no superiority outcome to claim (binding constraint #8). Frame as "competitive-with" + "reproduce/extend via the gate." | NONE |
| Any "**the only** agent memory" / "**no other** agent memory does this" comparative | — | ❌ NOT SHIPPED | — | Unverified competitor claim — the *capability* may be shipped, the *comparison* is not. Cut the comparative. | NONE |
| "per-type **forgetting**" / "per-type **decay**" / "usefulness-aware **eviction**" / memory **lifecycle** / **FadeMem** | FORGET (Track C) / Phase 112 | ⚠️ capability SHIPS; this *token* CUT | — | The *capability* ships as **principled ranking decay** (Phase 112, PUBLISHED above). The overclaiming token + the costed QA-accuracy-impact lift stay CUT/deferred; live eviction ships dormant/default-OFF. | NONE |
| "recall **weights adapt** over time" / "bounded **online tuning**" | Track H2 / Phase 111 | ⚠️ capability SHIPS; this *token* CUT | — | The *capability* ships as **learning-to-rank, trust frozen** (Phase 111, PUBLISHED above — the +0.1 recall-score lift / flat rank). The "weights adapt as fact" framing + the costed QA-lift stay CUT/deferred. | NONE |
| "**theory-of-mind**" / multi-party user model framed as shipped | Track E2 / Phases 107–108 | ⚠️ capability SHIPS; this *token* CUT | — | The *capability* ships as a **per-user profile** (Phase 107) + a **per-channel relationship model**, dormant/default-OFF (Phase 108, PUBLISHED above). The "theory-of-mind" framing stays CUT. | NONE |
| "the **dialectic**" / "**memory_ask**" NL Q&A | Track G / Phase 109 | ⚠️ capability SHIPS; this *token* CUT | — | The *capability* ships as an opt-in **ask-your-memory tool**, recall stays LLM-free (Phase 109, PUBLISHED above). The "dialectic" / `memory_ask` token + the costed answer-faithfulness lift stay CUT/deferred. | NONE |
| Any `__%` / `__×` / `TODO` / `FIXME` **placeholder** benchmark number | — | ❌ NOT A NUMBER | — | PUB-02 forbids placeholder numbers; every published number traces to a manifest above. | NONE |

---

> **Note (framing rule the leaderboard + methodology must honor):** the v2.8 gate deltas
> (sets B/C/D/E above) are **MECHANICAL / STRUCTURAL** claims measured at **$0** — NOT
> end-to-end QA-accuracy lifts. The **only** accuracy numbers Comis can publish are the Phase-98
> cross-judged baseline (set A). Keep the two in clearly separated sections; never blend a
> rank-delta into a "Comis score" or round a "+1 linked-doc recall delta" into a percentage.
