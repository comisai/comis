#!/usr/bin/env bash
# CLI cold-start performance harness (WEB-CONTRACTS-17, Phase 35 Plan 35-22).
#
# Measures median + IQR cold-start latency for three representative CLI
# commands across two daemon states (up / down). Used to capture the
# performance baseline before/after the Wave A–D contracts migration so the
# 50 ms median-regression budget can be verified.
#
# Tool selection (CONTEXT D-09):
#   - hyperfine when available (multi-run median + statistical IQR + JSON
#     export). Preferred because hyperfine's own warmup and outlier handling
#     are statistically sound.
#   - bash fallback otherwise. Uses date(+%s%N) per-iteration timing, then
#     computes median, Q1, Q3, and IQR in awk. The fallback is honest about
#     resolution caveats but suffices for the 50 ms budget check.
#
# Usage:
#   scripts/perf/cli-coldstart.sh up     # daemon assumed running
#   scripts/perf/cli-coldstart.sh down   # daemon stopped first
#
# Output: stdout is parseable plain text; with hyperfine, a JSON file is
# also written at perf-cli-${DAEMON_STATE}.json (cwd-relative).

set -euo pipefail

DAEMON_STATE="${1:-up}"  # "up" or "down"

if [ "$DAEMON_STATE" != "up" ] && [ "$DAEMON_STATE" != "down" ]; then
  echo "ERROR: state must be 'up' or 'down' (got: $DAEMON_STATE)" >&2
  echo "Usage: $0 <up|down>" >&2
  exit 64
fi

# When the caller asks for the "down" cell, stop pm2-managed daemon first.
# pm2 may not be installed (production hosts run the daemon directly); the
# `|| true` lets the script work in either environment.
if [ "$DAEMON_STATE" = "down" ]; then
  if command -v pm2 >/dev/null 2>&1; then
    pm2 stop comis >/dev/null 2>&1 || true
  fi
fi

# 3 representative CLI commands × 10 invocations (matches D-09 corpus):
#   - comis status        (most-called CLI command; latency-sensitive)
#   - comis health        (polled by monitoring scripts)
#   - comis sessions list (largest response payload; contract-parse cost
#                          most visible)
#
# We invoke the published CLI directly via `node packages/cli/dist/cli.js`
# because the `comis` binary is intentionally NOT placed on PATH in this
# repo's dev environment (per CLAUDE.md: "The `comis` CLI is not on PATH —
# use `node packages/cli/dist/cli.js`."). Production VPS / `npm i -g
# comisai` installs DO put `comis` on PATH; the measured cold-start cost is
# identical either way (PATH lookup is a kernel-cached resolution).
COMMANDS=(
  "node packages/cli/dist/cli.js status"
  "node packages/cli/dist/cli.js health"
  "node packages/cli/dist/cli.js sessions list"
)

echo "## CLI cold-start baseline — daemon-${DAEMON_STATE}"
echo "Commands:"
for c in "${COMMANDS[@]}"; do echo "  - $c"; done
echo

if command -v hyperfine >/dev/null 2>&1; then
  echo "Tool: hyperfine $(hyperfine --version 2>&1 | head -n1 || echo unknown)"
  echo
  hyperfine \
    --warmup 1 \
    --runs 10 \
    --export-json "perf-cli-${DAEMON_STATE}.json" \
    --ignore-failure \
    "${COMMANDS[@]}"
else
  echo "Tool: bash fallback (hyperfine not installed)"
  echo
  for cmd in "${COMMANDS[@]}"; do
    echo "--- Command: $cmd"
    # 1 warmup + 10 timed runs; warmup output suppressed.
    eval "$cmd" >/dev/null 2>&1 || true

    # Collect 10 ms samples into an array, then compute median + IQR via awk.
    samples=()
    for _ in $(seq 1 10); do
      start_ns=$(date +%s%N)
      eval "$cmd" >/dev/null 2>&1 || true
      end_ns=$(date +%s%N)
      ms=$(( (end_ns - start_ns) / 1000000 ))
      samples+=("$ms")
    done

    # Quartiles & median via awk on the sorted samples.
    sorted=$(printf '%s\n' "${samples[@]}" | sort -n)
    stats=$(printf '%s\n' "$sorted" | awk '
      { a[NR] = $1 }
      END {
        n = NR
        # 10-sample quartiles using the simple (n+1)/4, (n+1)/2, 3(n+1)/4 rule:
        # Q1 = a[2] + 0.75*(a[3]-a[2])  (rank 2.75)
        # median = (a[5] + a[6]) / 2    (rank 5.5)
        # Q3 = a[8] + 0.25*(a[9]-a[8])  (rank 8.25)
        med   = (a[5] + a[6]) / 2.0
        q1    = a[2] + 0.75 * (a[3] - a[2])
        q3    = a[8] + 0.25 * (a[9] - a[8])
        iqr   = q3 - q1
        min_v = a[1]; max_v = a[n]
        printf "raw=%s median=%.1f q1=%.1f q3=%.1f iqr=%.1f min=%d max=%d\n",
               substr_join(a, n), med, q1, q3, iqr, min_v, max_v
      }
      function substr_join(arr, len,   i, s) {
        s = arr[1]; for (i = 2; i <= len; i++) s = s "," arr[i]
        return s
      }
    ')
    echo "$stats"
    echo
  done
fi
