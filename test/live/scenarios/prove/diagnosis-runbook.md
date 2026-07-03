# DIAG-baseline — Manual Real-Claude-Code Baseline Runbook

The **automatable** baseline (`diagnosis-baseline.test.ts`, Stage-C) drives a
**scripted** ReAct agent over the 5 frozen diagnosis fixtures and records, per
fixture, (root-cause-reached?, total tokens, distinct tool/RPC calls, distinct
source reads). That scripted loop is the **canonical** automatable baseline — it
runs under `COMIS_LIVE=1 pnpm test:live prove` with a model/judge key and writes
the gating table + ledger to the git-ignored `benchmarks/live/<date>-<sha>/`.

This runbook documents the **manual real-Claude-Code variant** — the
**one-week production canary** path. It measures
the SAME four dimensions, but using a real coding-agent session (e.g. Claude
Code) instead of the scripted loop, so the numbers reflect a real agent's
behavior on today's surface, not just a fixed harness.

This tier is **operator-run**, **env-gated** (`COMIS_LIVE=1`), and **skip ≠
fail**: with no key (or no operator), it is `SKIPPED(no-live)`, **never a
failure** — `pnpm validate` stays green.

> NO new env var. The scripted Stage-C reuses `COMIS_LIVE`, `COMIS_LIVE_BUDGET_USD`,
> and `COMIS_LIVE_JUDGE_PROVIDER` / `COMIS_LIVE_JUDGE_MODEL` / `COMIS_LIVE_JUDGE_API_KEY`
> (all in `docs/reference/environment-variables.mdx`). This manual variant needs
> only the operator's own Claude Code session — no Comis env var at all.

---

## Why a manual variant at all

The scripted loop measures "can a model reach root cause from today's obs surface
+ counted `read_source`." A real coding agent (Claude Code) reads files via its
**own** tools, not through `obs_query` — so its source-reads must be counted from
its **session transcript**, by hand. The manual variant is the honest check that
the scripted baseline's failure (source reads > 0, multi-call, high tokens)
reproduces with a real agent, and it is the form the operator runs as the
one-week canary against live degraded sessions.

---

## The 5 fixtures (the corpus under `test/live/fixtures/diagnosis/`)

| Fixture | Failure class | Gold mechanism (answer-key) |
|---|---|---|
| `session-678314278` | historical-c53ab0f | a status-200 body misclassified by a **substring** `403` scan flipped successes to failures, tripping the retry **breaker** |
| `live-503-breaker` | 503-breaker | repeated **503** → overloaded tripped the per-tool retry **breaker** for **web_fetch** (the dark breaker) |
| `live-exec-modulenotfound` | exec-modulenotfound | an **exec** **dependency** failure (**ModuleNotFoundError**) |
| `live-budget-exhaustion` | budget-exhaustion | rising **costUsd** crossed the **budget** ceiling → **exhausted** |
| `live-provider-timeout` | provider-timeout | a 30000ms **timeout** classified as **prompt_timeout** |

The answer-keys are written at **causal-mechanism** granularity, so a symptom-only
answer ("web_fetch failed many times") does **not** count as "reached" — the
measure-first lever. The substrate test
(`diagnosis-baseline.test.ts`, Stage-A/B) proves this over the whole corpus,
keyless.

---

## Procedure (per fixture)

1. **Point a real Claude Code session at the fixture transcript.** Open
   `test/live/fixtures/diagnosis/<fixture>/trajectory.jsonl` and give the agent
   the prompt:
   > "You are diagnosing a degraded Comis session. The session transcript is in
   > this JSONL file. Find the ROOT CAUSE — the causal mechanism (which field/rule
   > misclassified and the cascade), not just the symptom. You may read Comis
   > source files. When done, state the root cause."

   Hand it the SAME surface the scripted loop has: the trajectory JSONL, and
   (optionally) a read-only `obs_query`/RPC view of the daemon if one is booted.
   Do **not** hand it the answer-key.

2. **Let the agent work.** It will read source files (`pi-event-bridge.ts`,
   `tool-retry-breaker.ts`, `tool-metadata-registry.ts`, …) to recover the
   mechanism the logs never record.

3. **Count the four dimensions from the session transcript:**
   - **rootCauseReached?** — does the final answer name the gold mechanism (the
     bolded tokens in the table above)? Use the same rubric the scripted judge
     uses: *correct only if it identifies the causal mechanism + cascade, not the
     symptom.*
   - **totalTokens** — the session's total token usage (from the agent's usage
     report).
   - **distinctToolCalls** — count distinct tool/RPC names the agent invoked.
   - **distinctSourceReads** — count **distinct** source files the agent `Read`
     (the cost the obs.explain RE-PROVE must drive to **zero**).

4. **Record the row by hand** into the ledger, alongside the scripted run:
   `benchmarks/live/<date>-<sha>/manual-baseline.md` (git-ignored). Keep the
   committed corpus and `~/.comis` untouched — write only under `benchmarks/`.

---

## Recording table

Fill one row per fixture per run. `Reached` = yes / no / `SKIPPED(no-live)`.

| Fixture | Reached | Total tokens | Distinct tool/RPC calls | Distinct source reads | Date | Notes |
|---|---|---|---|---|---|---|
| session-678314278 | | | | | | |
| live-503-breaker | | | | | | |
| live-exec-modulenotfound | | | | | | |
| live-budget-exhaustion | | | | | | |
| live-provider-timeout | | | | | | |

---

## After the run — the GATE

The expectation today is **FAIL the goal**: source reads > 0, multi-call, high
tokens. That failure is the baseline the obs.explain RE-PROVE must beat (1 call, ≤ target
tokens, 0 source reads).

Transcribe the per-failure-class **gating table** (which classes are already
root-caused from the obs surface alone — the TRIM-CANDIDATEs — vs which need new
surface) into a planning note so it prioritizes the follow-up work (the machine
table lives in the git-ignored ledger). The scripted Stage-C run produces this table
automatically via `renderGatingMarkdown`; the manual variant confirms it.
