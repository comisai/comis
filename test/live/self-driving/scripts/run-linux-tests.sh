#!/usr/bin/env bash
# LOCAL — run this checkout's `.linux` tests (the real-bwrap containment gate) ON THE VPS.
#
# `.linux.test.ts` files `describe.skipIf(!linux+bwrap)` — they SKIP on macOS, so the local
# `pnpm validate` floor never runs them; the mission requires running them on the Linux box.
# `deploy-dist.sh` ships only `dist/`, but vitest needs the `.ts` SOURCE, so this rsyncs the
# current `packages/*/src` (+ the vitest/tsconfig configs) to $SRC, then runs `pnpm vitest`
# there. @comis/* imports resolve to the deployed `dist/` — so run `deploy-dist.sh` FIRST so
# src and dist are the same HEAD.
#
#   ./run-linux-tests.sh                                  # runs the wake-gate + orchestrate jail gate
#   ./run-linux-tests.sh packages/daemon/src/wiring/wake-gate-runner.linux.test.ts   # a specific file
#   ./run-linux-tests.sh 'packages/**/*.linux.test.ts'   # every .linux test (quote the glob)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
SRC="${SRC:-/root/comis-src}"

# Default: the containment gate the wake-gate/orchestrate jail runs assert.
DEFAULT_TESTS=(
  "packages/daemon/src/wiring/wake-gate-runner.linux.test.ts"
  "packages/skills/src/tools/builtin/orchestrate/orchestrate-jail.linux.test.ts"
)
TESTS=("$@"); [ "${#TESTS[@]}" -eq 0 ] && TESTS=("${DEFAULT_TESTS[@]}")

echo "Rsync $REPO/packages/*/src → $VPS:$SRC (excl node_modules/dist/.git) …"
rsync -az -e "ssh -o ConnectTimeout=20" \
  --exclude=node_modules --exclude=dist --exclude='*.tsbuildinfo' --exclude=.git \
  "$REPO/packages/" "$VPS:$SRC/packages/"
# The vitest + base tsconfig the transform reads (best-effort — ignore if absent).
rsync -az -e "ssh -o ConnectTimeout=20" \
  "$REPO/vitest.config.ts" "$REPO/tsconfig.base.json" "$VPS:$SRC/" 2>/dev/null || true

echo "Running .linux tests on the box (real bwrap): ${TESTS[*]}"
# The box CLI is not on PATH concerns don't apply — pnpm runs from $SRC.
ssh -o ConnectTimeout=200 -o ServerAliveInterval=10 "$VPS" \
  "cd '$SRC' && CI=true pnpm vitest run ${TESTS[*]} 2>&1 | tail -30"
