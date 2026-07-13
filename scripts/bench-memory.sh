#!/usr/bin/env bash
# Comis memory benchmark runner — the turnkey entry point for a benchmark run.
#
# The run itself is the env-gated Vitest harness
# (packages/agent/src/memory/benchmark/*.bench.test.ts), gated by COMIS_BENCH=1.
#
# Modes:
#   dry        (default) KEYLESS: build + run the retrieval harness (recall@k / MRR,
#              FTS-only) AND the QA structural test on the tiny vendored fixtures.
#              No API keys, no model downloads, no cost. Proves the whole
#              ingest → recall → score pipeline works end-to-end.
#   retrieval  recall@k / MRR over the configured dataset (KEYLESS; lights up the
#              vector/rerank lanes if LLAMA_MODEL_PATH / LLAMA_RERANKER_MODEL_PATH are set).
#   qa         end-to-end QA + LLM-judge accuracy — REQUIRES the answer + judge env.
#   all        retrieval + qa.
#   suite <tier>  run one suite tier by name and write a committed, secret-free
#              report under benchmarks/results/<tier>/. Tiers:
#                poisoning            (answer+judge env) — adversarial ASR (security flagship)
#                recall-learning      KEYLESS              — FEED-loop gold-rank lift
#                trust-contradiction  (answer+judge env) — older-high-trust-wins rate
#                redaction            KEYLESS              — privacy/redaction leak-rate
#                beam                 KEYLESS              — long-context scale probe (COMIS_BENCH_BEAM_10M lights the 10M tier)
#                longmemeval-v2 | memoryagentbench | pref | perltqa | personamem | halumem
#                                     external loaders — with $COMIS_BENCH_DATA + answer+judge env
#                                     they run the QA harness against the operator corpus; UNSET runs the
#                                     loader's structural test as the keyless proof (see benchmarks/DATASETS.md).
#              `suite all` runs every tier in sequence. After each tier the runner greps
#              its committed report dir for credential SHAPES and FAILS on any match
#              (belt-and-suspenders over the harnesses' in-test omission gate).
#   head-to-head  KEYLESS ($0): drive the head-to-head proving machine
#              (real runner + cross-judge spread + significance + append-only ledger +
#              ablation sweep + skip-with-disclosure adapters + letta-fs control + a real
#              Comis recall cell) and write the committable PARTIAL manifest under
#              benchmarks/results/2026-06-01-phase104-prove/ (override via COMIS_PROVE_REPORT_DIR).
#              No keys, no provider call, no cost. Then the credential-shape sweep over the dir.
#   gate       per-release CONTINUOUS REGRESSION GATE: runs two
#              honest harnesses. (1) The head-to-head machine PROVES the append-only
#              never-overwrite ledger MECHANISM over a fresh tmp dir (writes NO dated row
#              to benchmarks/results/history/ on the keyless path). (2) The regression-gate
#              harness compares per-category accuracy vs the COMMITTED J1 baseline
#              (benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json): keyless
#              it proves the compareToBaseline MECHANISM; with COMIS_GATE_CURRENT_MANIFEST
#              pointing at a real run's manifest it EXITS NON-ZERO on a real category
#              regression (below baseline beyond tolerance AND statistically significant).
#              A keyless run claims NO regression-pass. This gate mode is what the
#              scheduled CI job (.github/workflows/bench-regression.yml) runs; the COSTED
#              pass (real keys + judge spend, secrets ONLY from scripts/bench-memory.env)
#              writes the current manifest the gate then compares.
#
# Config: copy scripts/bench-memory.env.example → scripts/bench-memory.env and fill it
# (the runner sources it automatically), or export the COMIS_BENCH_* / LLAMA_* vars yourself.
#
# Datasets (for retrieval/qa on REAL data): place longmemeval.json + locomo.json under
# $COMIS_BENCH_DATA (see the .env.example for download steps). NOTE: the harness today
# evaluates the FIRST item/sample of each file — full-array iteration (all 500 LongMemEval
# items / 10 LoCoMo samples) is the one pending extension. Leave COMIS_BENCH_DATA unset to
# run on the vendored fixtures.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-dry}"
ENV_FILE="$ROOT/scripts/bench-memory.env"
BENCH_DIR="packages/agent/src/memory/benchmark"
QA="$BENCH_DIR/qa-judge-harness.bench.test.ts"
RET="$BENCH_DIR/retrieval-harness.bench.test.ts"

# Suite tier harnesses routed by `suite <tier>` below.
POISONING_HARNESS="$BENCH_DIR/poisoning-harness.bench.test.ts"
LEARNING_HARNESS="$BENCH_DIR/learning-lift-harness.bench.test.ts"
CONTRADICTION_HARNESS="$BENCH_DIR/contradiction-harness.bench.test.ts"
REDACTION_HARNESS="$BENCH_DIR/redaction-harness.bench.test.ts"
BEAM_HARNESS="$BENCH_DIR/beam-harness.bench.test.ts"
# External-loader structural tests — the KEYLESS proof when $COMIS_BENCH_DATA is unset.
LONGMEMEVAL_V2_TEST="$BENCH_DIR/longmemeval-v2-loader.test.ts"
MEMORYAGENTBENCH_TEST="$BENCH_DIR/memoryagentbench-loader.test.ts"
PERSONALIZATION_TEST="$BENCH_DIR/personalization-loaders.test.ts"
# The keyless head-to-head proving-machine harness + the per-release continuous gate
# (routed by the `head-to-head` / `gate` modes below).
HEAD_TO_HEAD="$BENCH_DIR/head-to-head.bench.test.ts"
# The per-release REGRESSION gate harness. Keyless it proves the compareToBaseline
# MECHANISM against the committed J1 baseline; when COMIS_GATE_CURRENT_MANIFEST points
# at a real run's manifest it FAILS on a real category regression vs that baseline (the
# operator-costed pass). Routed by `gate`.
REGRESSION_GATE="$BENCH_DIR/regression-gate.bench.test.ts"

# The full tier allowlist (drives `suite all` + the usage line). The order is the
# keyless tiers first, then the answer+judge tiers, then the external loaders.
SUITE_TIERS="recall-learning redaction beam poisoning trust-contradiction longmemeval-v2 memoryagentbench pref perltqa personamem halumem"

# 1. Operator config. The env file (if present) is applied; comment out a line to fall
#    back to whatever is already exported in your shell.
if [ -f "$ENV_FILE" ]; then
  echo "→ loading $ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
fi
export COMIS_BENCH="${COMIS_BENCH:-1}"

# 2. Build (the bench imports @comis/* from dist via the Vitest alias — stale dist
#    silently masks src changes). Set SKIP_BUILD=1 to skip on a fast re-run.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "→ pnpm build  (set SKIP_BUILD=1 to skip)"
  pnpm build
fi

run() { echo "→ vitest run $*"; pnpm exec vitest run "$@"; }

# Guard the answer+judge env for the LLM-judged tiers — same pattern as qa/all modes.
require_answer_judge_env() {
  : "${COMIS_BENCH_ANSWER_PROVIDER:?suite '$1' needs COMIS_BENCH_ANSWER_* — see scripts/bench-memory.env.example}"
  : "${COMIS_BENCH_JUDGE_PROVIDER:?suite '$1' needs COMIS_BENCH_JUDGE_* — see scripts/bench-memory.env.example}"
}

# POST-RUN SECRET SWEEP. Belt-and-suspenders over the harnesses' in-test
# JSON.stringify omission gate (mirrors the redaction double-sweep): grep the tier's
# committed report dir for credential SHAPES only — sk-…{16,} / Bearer … / an apiKey
# key-value ASSIGNMENT (mirrors test/live/judge.ts) — and FAIL the run on any match.
# Anchored to credential shapes, NEVER the bare word `token` (a field like
# answerTokensPerQuery must not false-positive) and NEVER a bare `apiKey` mention in
# report prose (e.g. "the apiKey is resolved by name" or a quoted `apiKey: ""`) —
# only apiKey followed by a non-empty quoted value. A missing dir is a no-op.
sweep_tier_report() {
  local tier="$1" dir="$ROOT/benchmarks/results/$1"
  [ -d "$dir" ] || return 0
  if grep -REn 'sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]+|"?apiKey"?[[:space:]]*[=:][[:space:]]*["'\''][^"'\'']{4,}' "$dir" 2>/dev/null; then
    echo "✗ SECRET LEAK in benchmarks/results/$tier — failing the run." >&2
    exit 1
  fi
}

# Absolute-path variant of the credential-shape sweep. The head-to-head /
# gate modes let the operator override the output dir (COMIS_PROVE_REPORT_DIR);
# this sweeps the dir that was ACTUALLY written rather than a desynced hardcoded
# tier name, so the belt-and-suspenders sweep never skips the live dir. Same shapes
# (sk-…{16,} / Bearer … / apiKey key-value assignment), same FAIL-on-match. A missing
# dir is a no-op.
sweep_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  if grep -REn 'sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]+|"?apiKey"?[[:space:]]*[=:][[:space:]]*["'\''][^"'\'']{4,}' "$dir" 2>/dev/null; then
    echo "✗ SECRET LEAK in $dir — failing the run." >&2
    exit 1
  fi
}

# The usage line for `suite` with no/unknown tier — lists EVERY tier (the allowlist).
suite_usage() {
  echo "usage: $0 suite <tier>" >&2
  echo "  tiers: $SUITE_TIERS all" >&2
  echo "  keyless: recall-learning redaction beam (+ external tiers when \$COMIS_BENCH_DATA is unset)" >&2
  echo "  answer+judge env required: poisoning trust-contradiction (+ external tiers when \$COMIS_BENCH_DATA is set)" >&2
  echo "  see benchmarks/DATASETS.md for per-tier dataset placement under \$COMIS_BENCH_DATA" >&2
}

# Run a single external-loader tier. With $COMIS_BENCH_DATA set + the answer/judge env,
# run the QA harness against the operator-placed corpus; UNSET → echo the DATASETS.md
# placement pointer and run the matching loader's structural test (the keyless proof).
run_external_tier() {
  local tier="$1" loader_test="$2"
  if [ -n "${COMIS_BENCH_DATA:-}" ]; then
    require_answer_judge_env "$tier"
    echo "→ suite $tier: \$COMIS_BENCH_DATA set → QA harness over the operator corpus."
    run "$QA"
  else
    echo "→ suite $tier: \$COMIS_BENCH_DATA UNSET → keyless structural proof ($loader_test)."
    echo "  Place the full $tier corpus under \$COMIS_BENCH_DATA to run the gated QA harness — see benchmarks/DATASETS.md."
    run "$loader_test"
  fi
}

# Dispatch ONE tier by name. A fixed nested case over the known tier allowlist — the
# arg is never eval'd. Unknown/empty tier → usage + exit 2.
run_suite_tier() {
  local TIER="$1"
  case "$TIER" in
    poisoning)
      require_answer_judge_env "$TIER"
      run "$POISONING_HARNESS"
      ;;
    recall-learning)
      run "$LEARNING_HARNESS"   # KEYLESS — FEED-loop gold-rank lift
      ;;
    trust-contradiction)
      require_answer_judge_env "$TIER"
      run "$CONTRADICTION_HARNESS"
      ;;
    redaction)
      run "$REDACTION_HARNESS"  # KEYLESS — leak detection is a deterministic string check
      ;;
    beam)
      # KEYLESS scale probe. COMIS_BENCH_BEAM_10M=1 additionally lights the 10M stretch tier.
      run "$BEAM_HARNESS"
      ;;
    longmemeval-v2)      run_external_tier "$TIER" "$LONGMEMEVAL_V2_TEST" ;;
    memoryagentbench)    run_external_tier "$TIER" "$MEMORYAGENTBENCH_TEST" ;;
    pref|perltqa|personamem|halumem)
      run_external_tier "$TIER" "$PERSONALIZATION_TEST" ;;
    *)
      suite_usage
      exit 2
      ;;
  esac
  sweep_tier_report "$TIER"
  echo "  → report (when written): benchmarks/results/$TIER/"
}

case "$MODE" in
  dry)
    echo "→ DRY RUN — keyless, vendored fixtures (retrieval recall@k/MRR + QA structural)."
    echo "  Watch for the 'BENCH recall@k/MRR …' line: that is the pipeline proving itself."
    run "$RET" "$QA"
    ;;
  retrieval)
    run "$RET"
    ;;
  qa)
    : "${COMIS_BENCH_ANSWER_PROVIDER:?qa mode needs COMIS_BENCH_ANSWER_* — see scripts/bench-memory.env.example}"
    : "${COMIS_BENCH_JUDGE_PROVIDER:?qa mode needs COMIS_BENCH_JUDGE_* — see scripts/bench-memory.env.example}"
    run "$QA"
    ;;
  all)
    : "${COMIS_BENCH_ANSWER_PROVIDER:?qa/all mode needs COMIS_BENCH_ANSWER_* — see scripts/bench-memory.env.example}"
    : "${COMIS_BENCH_JUDGE_PROVIDER:?qa/all mode needs COMIS_BENCH_JUDGE_* — see scripts/bench-memory.env.example}"
    run "$RET" "$QA"
    ;;
  head-to-head)
    # The KEYLESS ($0) proving-machine run. Drives the
    # real runner + cross-judge spread + significance + append-only ledger + ablation
    # sweep + the skip-with-disclosure adapters + the letta-fs control + a real Comis
    # recall cell, all at $0 (no key, no provider call). Writes the committable PARTIAL
    # manifest to benchmarks/results/2026-06-01-phase104-prove (default when unset), then
    # greps that dir for credential SHAPES and FAILS on any match.
    export COMIS_PROVE_REPORT_DIR="${COMIS_PROVE_REPORT_DIR:-$ROOT/benchmarks/results/2026-06-01-phase104-prove}"
    run "$HEAD_TO_HEAD"
    # Sweep the dir the run ACTUALLY wrote (the same override the harness
    # used), not a desynced hardcoded tier name — so an overridden output dir is
    # always the dir that gets credential-swept.
    sweep_dir "$COMIS_PROVE_REPORT_DIR"
    echo "  → manifest: $COMIS_PROVE_REPORT_DIR"
    ;;
  gate)
    # The per-release CONTINUOUS REGRESSION GATE entry point.
    # Two harnesses run, both honest about keyless vs costed:
    #
    #  (1) head-to-head.bench.test.ts — PROVES the append-only never-overwrite
    #      ledger MECHANISM over a fresh tmp history dir (write a dated row, refuse a
    #      2nd same-path write with prior bytes byte-identical, let a different-date
    #      row coexist). The keyless run writes a SYNTHETIC row to a tmp dir — it does
    #      NOT touch the committed benchmarks/results/history/.
    #
    #  (2) regression-gate.bench.test.ts — the per-category regression
    #      comparison vs the COMMITTED J1 baseline
    #      (benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json, judge A
    #      = gpt-4o). KEYLESS it proves the compareToBaseline MECHANISM (baseline vs
    #      itself = no regression; a synthetic significant drop = detected). When the
    #      operator sets COMIS_GATE_CURRENT_MANIFEST to a real run's manifest, it
    #      additionally runs the COSTED comparison and EXITS NON-ZERO on a real
    #      category regression (a drop below baseline beyond the tolerance band AND
    #      statistically significant) — `set -e` propagates the non-zero out of the
    #      gate. COMIS_GATE_CURRENT_MANIFEST is a committed-results PATH pointer, never
    #      a secret; the secrets that PRODUCE that manifest come ONLY from
    #      scripts/bench-memory.env (the costed qa/all/prove2 run that writes it).
    #
    # The CI `schedule:` cron (.github/workflows/bench-regression.yml) runs THIS gate
    # mode: keyless when no secrets are configured (mechanism proof only, no costed
    # regression-pass claim), or — with the benchmark secrets in scripts/bench-memory.env
    # — the costed qa/all run + this gate's costed comparison vs the committed baseline.
    run "$HEAD_TO_HEAD"
    run "$REGRESSION_GATE"
    HISTORY_DIR="$ROOT/benchmarks/results/history"
    # HONESTY: only claim a dated row + a history sweep when the dir actually
    # exists with operator-costed rows. The keyless run never writes here, so by
    # default we say plainly that the gate proves the MECHANISM and the real append
    # is the costed pass — never success-shaped text after appending nothing.
    if [ -d "$HISTORY_DIR" ] && [ -n "$(ls -A "$HISTORY_DIR" 2>/dev/null)" ]; then
      sweep_dir "$HISTORY_DIR"
      echo "  → swept benchmarks/results/history/ (operator-costed dated rows)"
    fi
    # HONESTY — the regression-gate verdict, split by whether a REAL current
    # manifest was supplied. With COMIS_GATE_CURRENT_MANIFEST set, the costed
    # comparison ABOVE already ran and (since we got here) found no regression — that
    # is a real pass. Without it, the keyless run proved only the MECHANISM and makes
    # NO regression-pass claim.
    if [ -n "${COMIS_GATE_CURRENT_MANIFEST:-}" ]; then
      echo "  → regression gate: the current run ($COMIS_GATE_CURRENT_MANIFEST) shows"
      echo "    NO category regression vs the committed J1 baseline"
      echo "    (benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json)."
    else
      echo "  → keyless gate: the regression-comparison MECHANISM is PROVEN against the"
      echo "    committed J1 baseline (baseline-vs-itself = no regression; a synthetic"
      echo "    significant drop is detected). NO real current manifest was supplied, so"
      echo "    NO regression-pass is claimed. The real costed pass sets"
      echo "    COMIS_GATE_CURRENT_MANIFEST to a fresh costed run's qa-report manifest —"
      echo "    reproduce with the steps in"
      echo "    benchmarks/results/2026-06-01-phase104-prove/GATE-REPORT.md §4."
    fi
    ;;
  suite)
    TIER="${2:-}"
    if [ -z "$TIER" ]; then
      suite_usage
      exit 2
    fi
    if [ "$TIER" = "all" ]; then
      echo "→ suite all — running every tier in sequence: $SUITE_TIERS"
      for t in $SUITE_TIERS; do
        echo ""
        echo "──────── suite $t ────────"
        run_suite_tier "$t"
      done
    else
      run_suite_tier "$TIER"
    fi
    ;;
  *)
    echo "usage: $0 [dry|retrieval|qa|all|suite <tier>|head-to-head|gate]" >&2
    exit 2
    ;;
esac

echo ""
echo "✓ done."
if [ -n "${COMIS_BENCH_DATA:-}" ]; then
  echo "  QA report (when qa/all ran): $COMIS_BENCH_DATA/qa-report.json"
else
  echo "  No COMIS_BENCH_DATA set → ran on vendored fixtures; reports/DBs were written to a fresh tmp dir."
fi
echo "  The accuracy / recall numbers are the 'BENCH …' lines in the output above."
