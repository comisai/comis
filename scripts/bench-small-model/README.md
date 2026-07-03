# Small-Model Excellence benchmark

Quantifies how small/local models behave on the executive-behavior failure modes
(goal derailment, false-success claims, context poisoning) that the agent scaffold
must compensate for, so scaffold work can be prioritized and re-measured by its
measured impact.

It drives models directly through Ollama's OpenAI-compatible API with a Comis-style
system prompt + tools and a minimal ReAct loop. It deliberately isolates **model
executive behavior** (the thing the scaffold must compensate for) and needs no
daemon, no real data, and no network beyond Ollama.

## TDD

The deterministic core (`harness.mjs` scorers) is pinned by a self-test that feeds
synthetic good/bad transcripts through every scorer and asserts the verdicts —
written RED-first, then the scorers made it GREEN:

```bash
node run.mjs --selftest      # 12/12 checks, no model needed
```

Never trust a metric whose scorer isn't in the self-test. Add a scenario → add its
`good`/`bad` fixtures to `run.mjs` `selftestFixtures()` in the same change.

## Run

```bash
cp bench-small-model.env.example bench-small-model.env   # optional; edit models/endpoint
./run.sh                                                  # selftest + full baseline
# or directly:
BENCH_MODELS=qwen3.6:35b,gemma4:31b node run.mjs
BENCH_SCENARIOS=goal-derailment-snake-then-stock node run.mjs   # one scenario
BENCH_PROMPT=bare node run.mjs                                   # no-guardrails prompt (test the scaffold hypothesis)
```

`BENCH_PROMPT`: `fair` (default — honesty/constraint/focus instructions present) or
`bare` (a raw agent with no guardrails, closer to the incident conditions).

Output: `results/<timestamp>/report.md` + `raw.json`, and `results/latest.md`.

### First baseline finding (2026-06-07)

`qwen3.6:35b` and `gemma4:31b` both score **6/6 correctness** here (qwen also 4/4 in
`bare` mode) — i.e. these 30B models are *not* the problem in isolation; reproducing
the derailment failures needs the **full Comis context**. The one
real failure found: `gemma4:31b` **runaway generation** (16× latency, 3.6× tokens;
one scenario 810 s / 56 K tokens). Next: a capability gradient (add `gpt-oss:20b`,
`qwen2.5:32b`, `llama3.2`) + a tokens/latency budget gate, then graduate to the
real Comis executor.

## Scenarios (the failure taxonomy)

| id | Layer | What it measures |
|---|---|---|
| `control-calculator` | sanity | can it use a tool + report the result |
| `multi-constraint-stock` | Reliability | constraint adherence (MSFT∧IBM∧Python∧image) |
| `goal-derailment-snake-then-stock` | Reliability | does turn-2 answer the new ask, not the prior task (the incident) |
| `false-success-deploy` | Reliability/honesty | does it claim success when the tool errored |
| `context-poison-math` | Reliability | does an irrelevant prior memory bleed into the answer |
| `multistep-tooling` | Compatibility | multi-step tool sequencing + malformed-call rate |

Metrics (per model × scenario): `success`, `constraintAdherence`, `derailed`,
`falseSuccess`, `poisoned`, malformed tool calls, tokens, latency. Lower
derail/false-success/poison = better; higher pass/adherence/success = better.

## Graduating to the real executor

This is the standalone baseline (model capability in isolation). The next stage
points the same scenarios + scorers at the **real Comis executor** (daemon + an
Ollama provider) so the numbers measure the platform+scaffold, not just the model.
The scenario/scorer contract is stable so both share one source of truth.
