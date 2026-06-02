---
phase: 114
milestone: v2.10
requirement: PROVE2-01, PROVE2-02
verdict: MEASURED (costed, cross-judged) — capability lift COMPLETE; competitor head-to-head PARTIAL
date: 2026-06-02
keyless: false
---

# Phase 114 (PROVE2) — Costed Cross-Judge Gate Report

The v2.10 "measure-first" keystone: the costed, cross-judged numbers that **gate the
activation phase (115)** and the publish phase (117). Operator-costed run (real API
spend on the operator's funded keys); competitors re-run by us under one protocol.

## §0. Protocol (the credibility moat)

`.planning/MEMORY_BENCHMARK_CREDIBILITY.md`: every published number reports **N +
significance**, is scored by **≥2 judges** with the **cross-judge spread** published, and
a number stands **only if it survives both judges** (spread ≤ 5.0 pts). Competitors are
**re-run by us** under one protocol/judge/machine. Cost + latency recorded. COI disclosed.
Binding constraint #8: **no "beats X" claim** before measured + cross-judged + competitor-re-run.

- **Answer LLM:** `anthropic / claude-sonnet-4-6` (temperature 0).
- **Judge 1:** `openai / gpt-4o-2024-11-20` (the LongMemEval reference judge; temp 0).
- **Judge 2:** `anthropic / claude-sonnet-4-6` (cross-judge; temp 0).
- **COI:** Judge 2 shares the answer provider — using claude to grade claude-authored
  answers is a self-preference COI. The headline relies on **judge 1 (gpt-4o)** + the
  **cross-judge spread**, never judge 2 alone.
- **Dataset:** LongMemEval (operator-placed full set) + LoCoMo, each item ingested into
  its OWN store (standard per-item protocol). Embeddings `local/nomic-embed-text-v1.5`,
  reranker `local/bge-reranker-v2-m3` — the **default shipping on-device config**.
- **Harness:** `packages/agent/src/memory/benchmark/prove2-qa-lift.bench.test.ts`
  (`HARNESS_VERSION phase-114-prove2-v1`). Each system's per-question recall context is
  precomputed LLM-free, then graded through the **same** answer + both judges. A
  per-(question, context-hash) verdict cache means a capability whose recall is
  byte-identical to another reuses its verdict at **$0** — a provably-0 lift.

## §2. PROVE2-02 — per-capability QA-lift (COMPLETE)

50 questions (40 LongMemEval + 10 LoCoMo), cross-judged. Cost **$2.71** (answer $2.59 +
judge $0.12; 50 unique answer calls — the capabilities reused the baseline verdict at $0).

| System | judge-1 (gpt-4o) | judge-2 (claude) | spread | survives | Δ vs baseline | recall byte-identical |
|---|---|---|---|---|---|---|
| **comis-baseline** (as shipped) | **98.0%** (n=50) | 94.0% | 4.0 | ✅ | — | — |
| comis-intent-reweight (LEARN-IQ) | 98.0% | 94.0% | 4.0 | ✅ | **+0.0 pt** (p=1.000) | 50/50 |
| comis-forget (FORGET decay) | 98.0% | 94.0% | 4.0 | ✅ | **+0.0 pt** (p=1.000) | 50/50 |
| comis-graphspread (KG) | — | — | — | — | **deferred** | needs `tripleStore` |

**Finding (measure-first):** Comis's as-shipped recall scores **98.0% (gpt-4o) / 94.0%
(claude), cross-judge spread 4.0 pts (survives)** on this 50-question sample. The two
recall-config-togglable v2.9 capabilities (intent-reweight, forget) produce recall that
is **byte-identical to baseline on all 50 questions** → **+0.0 pt** measured lift. KG
graph-spread requires a built `tripleStore` the standard verbatim-ingest protocol does not
build → honestly **deferred**.

**Two honest caveats this run surfaces (not weaknesses to hide — the reason the number is
believable):**
1. **Near-ceiling saturation.** At 98%/94% the bench leaves **no measurable headroom** for
   per-capability lift with this answer model. The letta-fs full-dump control (PROVE2-01,
   §3) tests whether the bench is even discriminating; a high control score confirms
   saturation. Measuring true per-capability lift needs a **harder bench or a weaker
   answer model** (a v2.11 follow-on).
2. **Enrichment state not built.** USER / SOCIAL / REASON / DIALECTIC (write-path / tool
   features), LEARN-RANK (needs a learned tuned-alpha store), and KG (needs a built graph)
   have **no recall-config toggle on verbatim-ingested docs** — their costed QA-lift needs
   an **enrichment-aware harness**. Their **v2.9 keyless mechanical proofs stand**
   (`benchmarks/results/2026-06-01-phase11{0,1,2}-*`, `2026-06-01-phase100-kg`, etc.).

## §3. PROVE2-01 — competitor head-to-head (PARTIAL — in progress)

Best-effort, competitors re-run by us under the same answer + judges (apples-to-apples).
- **mem0** (`mem0ai 2.0.4`, isolated venv, OpenAI extractor + embedder, in-memory qdrant)
  — runner `scripts/prove/mem0-runner.py`, grading the **byte-identical** sampled items it
  consumed from the harness's exported `prove2-sample.json`. **[results appended on completion]**
- **letta-fs control** (full-haystack dump, no ranking) — the honesty anchor / saturation probe.
- **Comis** (as-shipped recall) — same answer + judges.
- **Hindsight / Mnemosyne / Zep** — `../hindsight`, `../mnemosyne`, `../graphiti` cloned but
  not wired to the protocol in this run; **mem0 / Zep not installed as protocol adapters** →
  honestly **skip-with-disclosure** (never a fabricated number). The structurally-impossible-
  to-fabricate skeleton adapters (`competitor-adapter.ts`) hold the integrity invariant.

## §4. Activation decision (gates Phase 115)

Per the **activation invariant** (a default-OFF→ON flip requires BOTH a measured-lift
threshold from PROVE2 AND the frozen safety invariants):

> **No v2.9 capability meets the measured-lift-with-no-regression bar on this bench.**
> → Phase 115 builds the activation **framework** (ACT-01) but **flips nothing by default**
> (ACT-02 = byte-identity preserved for all capabilities — the honest measure-first
> outcome). SOCIAL (ACT-03) remains behind its `privacyReviewSignedOffBy` operator gate.
> `trustAlpha` / the trust filter stay **frozen** throughout.

This is the design working as intended: **nothing flips on faith.**

## §5. Reproduction

```bash
# capability lift (cross-judge), ~$3:
set -a; . scripts/bench-memory.env; set +a
export COMIS_BENCH_JUDGE2_PROVIDER=anthropic COMIS_BENCH_JUDGE2_MODEL=claude-sonnet-4-6
export COMIS_BENCH_JUDGE2_API_KEY="$COMIS_BENCH_ANSWER_API_KEY"
export COMIS_BENCH_LIMIT=40 COMIS_BENCH_LOCOMO_LIMIT=1 COMIS_BENCH_QUESTION_CAP=50 COMIS_PROVE2_SKIP_CONTROL=1
export COMIS_PROVE2_REPORT_DIR="$HOME/.comis/bench-data" COMIS_PROVE2_EXPORT_SAMPLE="$HOME/.comis/bench-data/prove2-sample.json"
SKIP_BUILD=1 pnpm exec vitest run packages/agent/src/memory/benchmark/prove2-qa-lift.bench.test.ts

# competitor head-to-head: run mem0 on the exported sample, then re-run with the control + contexts:
~/.comis/prove-venv/bin/python scripts/prove/mem0-runner.py --sample $HOME/.comis/bench-data/prove2-sample.json --out $HOME/.comis/bench-data/mem0-contexts.json --limit 25
export COMIS_BENCH_CONTEXTS_FILE="$HOME/.comis/bench-data/mem0-contexts.json"
export COMIS_BENCH_LIMIT=20 COMIS_BENCH_LOCOMO_LIMIT=0 COMIS_BENCH_QUESTION_CAP=20 && unset COMIS_PROVE2_SKIP_CONTROL
SKIP_BUILD=1 pnpm exec vitest run packages/agent/src/memory/benchmark/prove2-qa-lift.bench.test.ts
```

The committed `capability-lift-report.json` is the machine-readable manifest for §2 (every
number read back from it). The head-to-head report is appended as `head-to-head-report.json`.
