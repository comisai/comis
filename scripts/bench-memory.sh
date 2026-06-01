#!/usr/bin/env bash
# Comis memory benchmark runner — the turnkey entry point for the J1 run.
#
# Implements Track J of .planning/MEMORY_SUPREMACY_DESIGN.md; the honest-protocol
# detail + the operator runbook live in .planning/MEMORY_BENCHMARK_PLAN.md. The run
# itself is the env-gated Vitest harness shipped in Phase 88–89
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
#   suite <tier>  run one v2.8 SUITE tier by name and write a committed, secret-free
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
#
# Config: copy scripts/bench-memory.env.example → scripts/bench-memory.env and fill it
# (the runner sources it automatically), or export the COMIS_BENCH_* / LLAMA_* vars yourself.
#
# Datasets (for retrieval/qa on REAL data): place longmemeval.json + locomo.json under
# $COMIS_BENCH_DATA (see the .env.example for download steps). NOTE: the harness today
# evaluates the FIRST item/sample of each file — full-array iteration (all 500 LongMemEval
# items / 10 LoCoMo samples) is the one pending extension (see MEMORY_BENCHMARK_PLAN.md
# "J1 Runbook"). Leave COMIS_BENCH_DATA unset to run on the vendored fixtures.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-dry}"
ENV_FILE="$ROOT/scripts/bench-memory.env"
BENCH_DIR="packages/agent/src/memory/benchmark"
QA="$BENCH_DIR/qa-judge-harness.bench.test.ts"
RET="$BENCH_DIR/retrieval-harness.bench.test.ts"

# v2.8 SUITE tier harnesses (Wave 1–2) routed by `suite <tier>` below.
POISONING_HARNESS="$BENCH_DIR/poisoning-harness.bench.test.ts"
LEARNING_HARNESS="$BENCH_DIR/learning-lift-harness.bench.test.ts"
CONTRADICTION_HARNESS="$BENCH_DIR/contradiction-harness.bench.test.ts"
REDACTION_HARNESS="$BENCH_DIR/redaction-harness.bench.test.ts"
BEAM_HARNESS="$BENCH_DIR/beam-harness.bench.test.ts"
# External-loader structural tests — the KEYLESS proof when $COMIS_BENCH_DATA is unset.
LONGMEMEVAL_V2_TEST="$BENCH_DIR/longmemeval-v2-loader.test.ts"
MEMORYAGENTBENCH_TEST="$BENCH_DIR/memoryagentbench-loader.test.ts"
PERSONALIZATION_TEST="$BENCH_DIR/personalization-loaders.test.ts"

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

# POST-RUN SECRET SWEEP (T-99-08-01). Belt-and-suspenders over the harnesses' in-test
# JSON.stringify omission gate (mirrors Plan 05's redaction double-sweep): grep the tier's
# committed report dir for credential SHAPES only — sk-…{16,} / Bearer … / apiKey — and FAIL
# the run on any match. Anchored to credential shapes, NEVER the bare word `token` (a field
# like answerTokensPerQuery must not false-positive). A missing dir is a no-op.
sweep_tier_report() {
  local tier="$1" dir="$ROOT/benchmarks/results/$1"
  [ -d "$dir" ] || return 0
  if grep -REn 'sk-[A-Za-z0-9_-]{16,}|Bearer [A-Za-z0-9._-]+|apiKey' "$dir" 2>/dev/null; then
    echo "✗ SECRET LEAK in benchmarks/results/$tier — failing the run (T-99-08-01)." >&2
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
# arg is never eval'd (T-99-08-03). Unknown/empty tier → usage + exit 2.
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
    echo "usage: $0 [dry|retrieval|qa|all|suite <tier>]" >&2
    exit 2
    ;;
esac

echo ""
echo "✓ done."
if [ -n "${COMIS_BENCH_DATA:-}" ]; then
  echo "  QA report (when qa/all ran): $COMIS_BENCH_DATA/qa-report.json  (the BENCH-04 manifest)"
else
  echo "  No COMIS_BENCH_DATA set → ran on vendored fixtures; reports/DBs were written to a fresh tmp dir."
fi
echo "  The accuracy / recall numbers are the 'BENCH …' lines in the output above."
