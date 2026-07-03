#!/usr/bin/env bash
# Token-fixture ground-truth runner.
# Sources token-fixtures.env (if present), pre-flights the requested legs, then
# execs generate.mjs. Mirrors scripts/bench-small-model/run.sh.
#
#   ./run.sh                  # both legs (needs ANTHROPIC_API_KEY + QWEN_GGUF_PATH)
#   ./run.sh --leg qwen       # local llama.cpp leg only (needs QWEN_GGUF_PATH)
#   ./run.sh --leg anthropic  # count_tokens leg only (needs key + model id)
#   ./run.sh --dry            # offline corpus audit (no network, no model load)
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f token-fixtures.env ]]; then
  set -a; # shellcheck disable=SC1091
  source token-fixtures.env; set +a
fi

LEG="both"
DRY=0
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--leg" ]]; then LEG="$arg"; fi
  if [[ "$arg" == "--dry" ]]; then DRY=1; fi
  prev="$arg"
done

echo "── Pre-flight: node >= 22? ───────────────────────────────────────────"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node.js >= 22." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if ((NODE_MAJOR < 22)); then
  echo "ERROR: node >= 22 required (found $(node --version))." >&2
  exit 1
fi

if ((DRY == 0)); then
  if [[ "$LEG" == "qwen" || "$LEG" == "both" ]]; then
    echo "── Pre-flight: QWEN_GGUF_PATH exists? ────────────────────────────────"
    if [[ ! -f "${QWEN_GGUF_PATH:-}" ]]; then
      echo "ERROR: QWEN_GGUF_PATH is unset or not a file." >&2
      echo "Discover the local Ollama blob with:" >&2
      echo "  ollama show qwen3-coder:30b --modelfile | grep '^FROM'" >&2
      echo "(see README.md — the qwen3.6/qwen35-arch blobs do NOT load; use qwen3-coder" >&2
      echo " or any small Qwen-family GGUF)." >&2
      exit 1
    fi
  fi
  if [[ "$LEG" == "anthropic" || "$LEG" == "both" ]]; then
    echo "── Pre-flight: Anthropic env set? ────────────────────────────────────"
    if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
      echo "ERROR: ANTHROPIC_API_KEY is not set." >&2
      echo "Copy token-fixtures.env.example to token-fixtures.env and fill it (never commit it)." >&2
      exit 1
    fi
    if [[ -z "${ANTHROPIC_COUNT_MODEL:-}" ]]; then
      echo "ERROR: ANTHROPIC_COUNT_MODEL is not set — use a CURRENT-tokenizer model id" >&2
      echo "(older ids under-measure by ~30%; see token-fixtures.env.example)." >&2
      exit 1
    fi
  fi
fi

exec node generate.mjs "$@"
