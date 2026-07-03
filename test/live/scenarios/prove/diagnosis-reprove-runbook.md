# DIAG-reprove — Operator RE-PROVE Runbook (the numeric ≤-target proof)

The **RE-PROVE**: the degraded session that the
baseline FAILED (it needed source reads + multi-call) is now root-caused in **one
`obs.explain` call, zero source reads, ≤ the baseline token target**.

Two tiers, the Stage-A/B-vs-Stage-C discipline (verbatim):

- **Stage-A/B** (`diagnosis-reprove.test.ts`, always-on, **keyless, in `pnpm
  validate`**) proves the deterministic STRUCTURE: the `obs.explain` tool over the
  678 fixture reaches `content_heuristic_misclassification` + degraded +
  breakerTimeline + costUsd (field-level), over the 503 fixture reaches
  `breaker_opened_repeated_failure` + `web_fetch` — both in **1 obs.explain call /
  0 source reads**. No `COMIS_LIVE`, no daemon, no token.
- **Stage-C** (`diagnosis-reprove.test.ts`, `it.skip`, **`COMIS_LIVE`-gated, NEVER
  in `pnpm validate`**) is the costed RUN this runbook documents: a fresh scripted
  ReAct agent **with** the `obs.explain` tool root-causes each fixture, recording
  per fixture (rootCauseReached via the judge, totalTokens, **obsExplainCalls = 1**,
  **distinctSourceReads = 0**) and writing the reprove ledger.

This tier is **operator-run**, **env-gated** (`COMIS_LIVE=1`), and **skip ≠ fail**:
with no key (or no operator), it is `SKIPPED(no-live)`, **never a failure** —
`pnpm validate` stays green.

> **NO new env var.** Stage-C reuses `COMIS_LIVE`, `COMIS_LIVE_BUDGET_USD`, and
> `COMIS_LIVE_JUDGE_PROVIDER` / `COMIS_LIVE_JUDGE_MODEL` / `COMIS_LIVE_JUDGE_API_KEY`
> (all already in `docs/reference/environment-variables.mdx`). The judge key is read
> for presence + forwarded to the provider option field only — **never logged**.
>
> **NO hard-coded token target.** The "≤ the baseline token target" number is produced by
> THIS run (the baseline + reprove ledgers from the same invocation), not asserted in
> any `pnpm validate`-tier check. The Stage-A/B substrate proves *structure* (1 call,
> 0 reads, the report fields) keyless; the judge + the 1-call/0-reads gate are the
> Stage-C assertions.

---

## Why obs.explain is the whole point

The baseline measured the cost of diagnosing today's surface: an agent had
to read ~3 Comis source files (`pi-event-bridge.ts`, `tool-retry-breaker.ts`,
`tool-metadata-registry.ts`) and make multiple `obs_query` calls to recover the
mechanism the logs never recorded. `obs.explain` provides a
single-call, bounded, causal `IncidentReport`. The RE-PROVE proves that with `obs.explain` the
SAME degraded session is root-caused in **1 call / 0 reads** — driving the baseline
cost to zero.

`read_source` is **kept available** in the RE-PROVE manifest so "0 source reads" is
**earned** by the agent choosing `obs.explain` first, not faked by removing the
fallback. The system prompt positions `obs.explain` as primary; the agent may still
fall back to `read_source` if it judges the report insufficient — and the gate fails
if it does.

---

## The 5 fixtures (the corpus under `test/live/fixtures/diagnosis/`)

| Fixture | Failure class | Gold mechanism (answer-key) |
|---|---|---|
| `session-678314278` | historical-c53ab0f | a status-200 body misclassified by a **substring** `403` scan flipped successes to failures, tripping the retry **breaker** |
| `live-503-breaker` | 503-breaker | repeated **503** → overloaded tripped the per-tool retry **breaker** for **web_fetch** (the dark breaker) |
| `live-exec-modulenotfound` | exec-modulenotfound | an **exec** **dependency** failure (**ModuleNotFoundError**) |
| `live-budget-exhaustion` | budget-exhaustion | rising **costUsd** crossed the **budget** ceiling → **exhausted** |
| `live-provider-timeout` | provider-timeout | a 30000ms **timeout** classified as **prompt_timeout** |

The 678 fixture is asserted at the **IncidentReport field level**
(`assert678Report`), NOT via `compareToAnswerKey` — the 678 report resolves
`token=status`, so the answer-key's literal `"403"` is absent and
`compareToAnswerKey(...).reached` is permanently false. The 503 report also
satisfies `compareToAnswerKey` structurally (asserted as a bonus). The judge is
authoritative for `rootCauseReached` in the live RUN.

---

## The operator RUN — ONE command (baseline + reprove together)

So "≤ the baseline token target" is a **same-run comparison**, run the baseline and the
reprove in a single invocation. The `prove` group globs **both**
`diagnosis-baseline.test.ts` and `diagnosis-reprove.test.ts` (the runner passes the
`test/live/scenarios/prove` directory to vitest):

```
COMIS_LIVE=1 \
  COMIS_LIVE_JUDGE_PROVIDER=<provider> \
  COMIS_LIVE_JUDGE_MODEL=<model> \
  COMIS_LIVE_JUDGE_API_KEY=<key> \
  pnpm test:live prove
```

Optional: cap spend with `COMIS_LIVE_BUDGET_USD=<usd>` (default `$2.00`). A
budget-exceeded fixture is emitted as an explicit budget-skipped row, so the
gate always shows all 5 classes and loudly flags a partial run — it never presents a
partial corpus as the full gate.

The agent model reuses the documented `COMIS_LIVE_JUDGE_*` provider/model/key (no new
env var). To target any OpenAI-compatible endpoint, set `COMIS_LIVE_JUDGE_PROVIDER` to
its **base URL** (e.g. `https://my-proxy.example.com` — the agent loop appends
`/v1/chat/completions`); the literal `openai` (or unset) defaults the agent base URL to
`https://api.openai.com`.

> **Tool name.** The RE-PROVE manifest registers the third tool as `obs_explain` (the
> product's wire-safe MCP tool name) — **not** a dotted `obs.explain`, which the OpenAI
> Chat Completions function-name schema (`^[A-Za-z0-9_-]{1,64}$`) rejects with HTTP 400.
> A keyless Stage-A/B guard asserts every manifest function name is wire-valid, so the
> dotted name can no longer ship and break the costed RUN.

---

## After the run — read the ≤-baseline-target comparison

Both runs write append-only ledgers under the git-ignored
`benchmarks/live/<date>-<sha>/`. Keep the committed corpus and `~/.comis` untouched —
the RE-PROVE's `obs.explain` dispatch uses the in-process assembler over a **fixture**
reader (no daemon, no `~/.comis`); only `benchmarks/` is written.

1. **Baseline** (the pre-milestone number to beat) → `gating-table.md`
   (`renderGatingMarkdown` output): per failure class, `Source reads` > 0,
   multi-call, high `Tokens`.
2. **Reprove** (the RE-PROVE proof) → `reprove-table.md`: per failure class, **`Source
   reads` = 0**, **1 `obs.explain` call**, lower `Tokens`.

Confirm, per fixture, that the **reprove tokens ≤ the baseline tokens** with
**`#calls` = 1** and **`#reads` = 0**. That same-run delta IS the "≤ the baseline token
target" proof — there is no hard-coded number to maintain; the target is whatever the
baseline recorded in the same invocation.

The Stage-C run also asserts `obsExplainCalls === 1` and `distinctSourceReads === 0`
per fixture as the RE-PROVE GATE (both halves — a correct verdict reached via source reads or
multi-call is NOT the RE-PROVE). With no judge key the run **skips cleanly**, writing
nothing and failing nothing.

---

## Recording table (transcribe per run)

`Reached` = yes / no / `SKIPPED(no-live)`. Fill the baseline + reprove columns from
the two ledgers of the same invocation.

| Fixture | Reached (reprove) | Reprove tokens | Baseline tokens | obs.explain calls | Source reads | Date | Notes |
|---|---|---|---|---|---|---|---|
| session-678314278 | | | | | | | |
| live-503-breaker | | | | | | | |
| live-exec-modulenotfound | | | | | | | |
| live-budget-exhaustion | | | | | | | |
| live-provider-timeout | | | | | | | |

The expectation: reprove tokens ≤ baseline tokens, `obs.explain calls` = 1,
`Source reads` = 0 for every measured class — the RE-PROVE.
