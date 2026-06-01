# Comis Memory Benchmark — Datasets & Suite Runbook

The operator runbook for the v2.8 memory benchmark **SUITE**. Every tier runs by a
single command:

```bash
scripts/bench-memory.sh suite <tier>      # one tier
scripts/bench-memory.sh suite all         # every tier, in sequence
```

Each tier writes a committed, **secret-free** report under `benchmarks/results/<tier>/`.
After every tier the runner greps that report dir for credential **shapes**
(`sk-…{16,}` / `Bearer …` / `apiKey`) and **fails the run** on any match — belt-and-
suspenders over the harnesses' own in-test `JSON.stringify` omission gate.

Config (answer/judge model + dataset pointer) comes ONLY from the git-ignored
`scripts/bench-memory.env` (copy `scripts/bench-memory.env.example` → fill it). The
runner sources it automatically. **Never commit a real key.**

> **Vendored fixtures run by default.** Every external loader ships a tiny neutral-
> placeholder fixture under `packages/agent/src/memory/benchmark/__fixtures__/`. With
> `$COMIS_BENCH_DATA` UNSET, the suite runs the loader's structural test over that
> fixture — the **keyless proof** that the ingest→recall→score path parses the format.
> The FULL public corpora are operator-placed under `$COMIS_BENCH_DATA` and are **never
> committed** (licensing + size + leak hygiene).

---

## 1. Constructed tiers (no download)

These tiers GENERATE their corpus at run time — there is no external dataset to place.
Each runs end-to-end keyless (only the two LLM-judged tiers need answer+judge env).

| Tier | Command | Harness | Report | Keys | Notes |
|------|---------|---------|--------|------|-------|
| `poisoning` | `suite poisoning` | `poisoning-harness.bench.test.ts` | `benchmarks/results/poisoning/poisoning-report.json` | **answer + judge** | Adversarial ASR over the shipped trust+write-validate+recall-filter pipeline (filter ON vs OFF ablation). Security flagship. The 44–57% published bar + the adaptive-attack caveat live in the harness, never headlined. |
| `recall-learning` | `suite recall-learning` | `learning-lift-harness.bench.test.ts` | `benchmarks/results/recall-learning/learning-lift-report.json` | KEYLESS | Drives the SHIPPED FEED loop (`recordUsage` → usefulness fold → `usefulnessNorm`) over N episodes and measures the gold memory's rank lift. The differentiator Hindsight's dead `access_count` schema cannot follow. |
| `trust-contradiction` | `suite trust-contradiction` | `contradiction-harness.bench.test.ts` | `benchmarks/results/trust-contradiction/trust-contradiction-report.json` | **answer + judge** | Trust-first-correct rate: the rate at which the OLDER high-trust fact wins over a NEWER low-trust claim, over the shipped trust filter + `compareBoosted` tie-break. Feeds the Phase-100 KG gate. |
| `redaction` | `suite redaction` | `redaction-harness.bench.test.ts` | `benchmarks/results/redaction/redaction-report.json` | KEYLESS | Privacy/redaction leak-rate over the shipped write-time `validateMemoryWrite` block + recall-time `scrubSecretsFromText` scrub (mitigations ON vs OFF). The report commits **ONLY the aggregate leak-rate** — a planted secret is never serialized. |
| `beam` | `suite beam` | `beam-harness.bench.test.ts` | `benchmarks/results/beam/beam-1m-report.json` (+ `beam-10m-report.json` behind `COMIS_BENCH_BEAM_10M`) | KEYLESS | Long-context scale probe. The ~1M-token (10M stretch) haystack is **deterministically generated from a fixed seed (`BEAM_SEED = 1234`) at run time and NEVER committed** — only the generator + the seed are in git, so a run regenerates the byte-identical haystack. `COMIS_BENCH_BEAM_10M=1` additionally lights the 10M stretch tier (deferrable; default CI never pays the 10M cost). |

The poisoning / redaction / trust-contradiction reports' ablation rows (filter/mitigation
ON vs OFF) are the reproducible evidence the shipped defense is the lever.

---

## 2. External tiers (operator-placed)

These tiers run a defensive loader (Plan 07) over an external corpus. **Placement:** drop
each file under `$COMIS_BENCH_DATA` with the exact filename below. With `$COMIS_BENCH_DATA`
**set** (+ answer/judge env), the tier runs the QA harness against the operator corpus and
writes `benchmarks/results/<tier>/`. With it **unset**, the tier runs the loader's structural
test over the vendored fixture (the keyless proof) — full-corpus QA is operator-gated.

| Dataset (tier) | Source | Filename under `$COMIS_BENCH_DATA` | Loader symbol (Plan 07) | Vendored fixture | Keys | Note |
|----------------|--------|------------------------------------|-------------------------|------------------|------|------|
| LongMemEval-V2 (`longmemeval-v2`) | HuggingFace `LongMemEval` (v2 / `_s` split) — github.com/xiaowu0162/LongMemEval | `longmemeval-v2.json` | `loadLongMemEvalV2` / `loadLongMemEvalV2Dataset` (`longmemeval-v2-loader.ts`) | `__fixtures__/longmemeval-v2-sample.json` | **answer + judge** (corpus); keyless (fixture) | Academic-core HEADLINE. Byte-identical schema to v1 (`haystack_sessions` / `haystack_session_ids` / `haystack_dates` "YYYY/MM/DD (Day) HH:MM" / `answer_session_ids`). Per-turn `has_answer` is an eval-leak flag — STRIPPED. Apache-2.0. |
| MemoryAgentBench (`memoryagentbench`) | arXiv 2507.05257, ICLR 2026 (MIT, UCSD/McAuley) — github.com/HUST-AI-HYZ/MemoryAgentBench | `memoryagentbench.json` | `loadMemoryAgentBench` / `loadMemoryAgentBenchDataset` (`memoryagentbench-loader.ts`) | `__fixtures__/memoryagentbench-sample.json` | **answer + judge** (corpus); keyless (fixture) | 4 abilities (accurate-retrieval / test-time-learning / long-range / **conflict-resolution**). **Conflict-Resolution is the SUITE-08 headline split** (maps to Comis's Track-F contradiction handling). No per-doc timestamp → synthesized deterministic `createdAt`. |
| PrefEval (`pref`) | ICLR 2025 Oral — github.com/amazon-science/PrefEval | `prefeval.json` | `loadPrefEval` (`personalization-loaders.ts`) | `__fixtures__/prefeval-sample.json` | **answer + judge** (corpus); keyless (fixture) | Preference-adherence triplets `{ preference, query, gold }` → `{ items }` (NO docs — the preference+query are the whole probe). The uncontested preference-following lane. |
| PerLTQA (`perltqa`) | github.com/Elvin-Yiming-Du/PerLTQA | `perltqa.json` | `loadPerLtqa` (`personalization-loaders.ts`) | `__fixtures__/perltqa-sample.json` | **answer + judge** (corpus); keyless (fixture) | Personal episodic+semantic QA `{ profile, qa[] }`. **Chinese-origin; the loader is LANGUAGE-AGNOSTIC** — a non-ASCII bio round-trips unharmed through the content string. Profile → one synth-dated doc. |
| PersonaMem / -v2 (`personamem`) | github.com/bowen-upenn/PersonaMem | `personamem.json` | `loadPersonaMem` (`personalization-loaders.ts`) | `__fixtures__/personamem-sample.json` | **answer + judge** (corpus); keyless (fixture) | Evolving persona `{ persona_sessions[], probes[] }` → dated session docs + probe questions (the late-session value the persona EVOLVED to is the gold). Dual-date: `session.date` "YYYY/MM/DD (Day) HH:MM" when present, else a synthesized strictly-increasing epoch. |
| HaluMem (`halumem`) | github.com/MemTensor/HaluMem | `halumem.json` | `loadHaluMem` (`personalization-loaders.ts`) | `__fixtures__/halumem-sample.json` | **answer + judge** (corpus); keyless (fixture) | Memory hallucination at extract/update/QA `{ memory_ops[], qa[], hallucination_labels }`. The faithfulness labels ride a **separate `Map<questionId, boolean>` gold channel** — never doc content. **CC-BY-NC-ND + COI caveats** (see `.planning/MEMORY_BENCHMARK_CREDIBILITY.md`). |

> The `pref`, `perltqa`, `personamem`, `halumem` tiers all share one structural test
> (`personalization-loaders.test.ts`) for their keyless proof; `longmemeval-v2` and
> `memoryagentbench` each have their own.

---

## 3. Secret hygiene

- **Keys come ONLY from the git-ignored `scripts/bench-memory.env`** (the answer LLM +
  judge LLM credentials). The committed `scripts/bench-memory.env.example` is a TEMPLATE
  with commented placeholders — no real value.
- **Every committed report under `benchmarks/results/` is secret-free.** Two independent
  nets enforce this: each harness asserts its serialized report matches none of
  `/apiKey|sk-|Bearer/` (the in-test omission gate, reinforced by `buildSuiteReport`
  structurally rebuilding each row field-by-field), and the runner re-greps the tier's
  report dir for credential **shapes** after the run and fails on any match.
- **The redaction report commits ONLY the aggregate leak-rate**, never a planted secret —
  the scorer takes boolean leak flags, not secret strings (T-99-05-01 / T-99-08-01).
- **Full external corpora are never committed** — operator-placed under `$COMIS_BENCH_DATA`
  (licensing + size). Only the tiny neutral-placeholder fixtures ship in the repo.

---

## 4. Reproducibility

- **One command per tier:** `scripts/bench-memory.sh suite <tier>` (or `suite all`).
- **Reports are committed** under `benchmarks/results/<tier>/` — the numbers travel with git.
- **Constructed tiers regenerate from a seed** (BEAM) or construct their probes in-harness
  (poisoning / recall-learning / trust-contradiction / redaction): no external corpus, fully
  reproducible from the command + git.
- **External tiers are operator-gated:** the keyless structural proof runs by default
  (vendored fixture); the full-corpus QA run requires the operator to place the dataset
  under `$COMIS_BENCH_DATA` and supply the answer+judge env. The exact judge/answer model
  snapshots used must be recorded with each external report for cross-run comparability
  (see `.planning/MEMORY_BENCHMARK_CREDIBILITY.md` — pin a dated snapshot; run ≥2 judges).

---

*Suite runner: `scripts/bench-memory.sh` (the `suite <tier>` dispatcher).*
*Loaders + harnesses: `packages/agent/src/memory/benchmark/`.*
*Protocol + credibility: `.planning/MEMORY_BENCHMARK_PLAN.md`, `.planning/MEMORY_BENCHMARK_CREDIBILITY.md`.*
