#!/usr/bin/env bash
# Small-Model Excellence benchmark runner.
# Sources bench-small-model.env (if present), runs the TDD self-test gate, then
# the live baseline against BENCH_MODELS. Mirrors scripts/bench-memory.sh.
#
#   ./run.sh            # selftest + full live run
#   ./run.sh --selftest # scorer self-test only (no model needed)
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f bench-small-model.env ]]; then
  set -a; # shellcheck disable=SC1091
  source bench-small-model.env; set +a
fi

echo "── TDD self-test (scorer RED→GREEN gate) ─────────────────────────────"
node run.mjs --selftest

if [[ "${1:-}" == "--selftest" ]]; then exit 0; fi

echo ""
echo "── Pre-flight: Ollama reachable? ─────────────────────────────────────"
base="${BENCH_BASE_URL:-http://localhost:11434}"
if ! curl -fsS -m 5 "${base}/api/tags" >/dev/null 2>&1; then
  echo "ERROR: Ollama not reachable at ${base}. Start it (\`ollama serve\`) and pull the models." >&2
  exit 1
fi

echo ""
echo "── Live baseline ─────────────────────────────────────────────────────"
exec node run.mjs
