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
QA="packages/agent/src/memory/benchmark/qa-judge-harness.bench.test.ts"
RET="packages/agent/src/memory/benchmark/retrieval-harness.bench.test.ts"

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
  *)
    echo "usage: $0 [dry|retrieval|qa|all]" >&2
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
