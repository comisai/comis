#!/usr/bin/env bash
# LOCAL — run this checkout's `.linux` tests (the real-bwrap containment gate) ON the VPS.
#
# `.linux.test.ts` files `describe.skipIf(!linux+bwrap)` — they SKIP on macOS, so the local
# `pnpm validate` floor never runs them; the mission requires running them on the Linux box.
# The PRODUCTION installation carries no source tree, so this maintains a SELF-CONTAINED scratch
# checkout at $LINUX_TEST_DIR (default /root/comis-linux-tests) — src + dist + manifests rsync'd
# from this checkout, its own `pnpm install` (first run / lockfile change only; needs the box's
# corepack) — and runs `pnpm vitest` there. It never touches the installed daemon.
#
#   ./run-linux-tests.sh                                  # runs the wake-gate + orchestrate jail gate
#   ./run-linux-tests.sh packages/daemon/src/wiring/wake-gate-runner.linux.test.ts   # a specific file
#   ./run-linux-tests.sh 'packages/**/*.linux.test.ts'   # every .linux test (quote the glob)
# Run `pnpm build` first so src and dist are the same HEAD (vitest resolves cross-package @comis/*
# imports through each package's dist).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
TESTS_DIR="${LINUX_TEST_DIR:-/root/comis-linux-tests}"

# Default: the containment gate the wake-gate/orchestrate jail runs assert.
DEFAULT_TESTS=(
  "packages/daemon/src/wiring/wake-gate-runner.linux.test.ts"
  "packages/skills/src/tools/builtin/orchestrate/orchestrate-jail.linux.test.ts"
)
TESTS=("$@")
[ "${#TESTS[@]}" -eq 0 ] && TESTS=("${DEFAULT_TESTS[@]}")

echo "Rsync src+dist+manifests → $VPS:$TESTS_DIR (excl node_modules/.git) …"
# rsync creates the LAST path component but not missing PARENTS — pre-create the nested targets on a
# first-ever run (the scratch tree doesn't exist yet), else it dies "mkdir …/packages: No such file".
ssh -o ConnectTimeout=15 "$VPS" "mkdir -p '$TESTS_DIR/packages' '$TESTS_DIR/test' '$TESTS_DIR/website/public'"
rsync -az -e "ssh -o ConnectTimeout=20" \
  --exclude=node_modules --exclude='*.tsbuildinfo' --exclude=.git \
  "$REPO/packages/" "$VPS:$TESTS_DIR/packages/"
rsync -az -e "ssh -o ConnectTimeout=20" \
  "$REPO/vitest.config.ts" "$REPO/tsconfig.base.json" "$REPO/package.json" \
  "$REPO/pnpm-lock.yaml" "$REPO/pnpm-workspace.yaml" "$VPS:$TESTS_DIR/" 2>/dev/null || true
# The architecture project + shared test support (vitest projects reference them).
rsync -az -e "ssh -o ConnectTimeout=20" --exclude=node_modules \
  "$REPO/test/support" "$REPO/test/architecture" "$VPS:$TESTS_DIR/test/" 2>/dev/null || true
rsync -az -e "ssh -o ConnectTimeout=20" "$REPO/scripts/" "$VPS:$TESTS_DIR/scripts/" 2>/dev/null || true
rsync -az -e "ssh -o ConnectTimeout=20" "$REPO/website/public/install.sh" "$VPS:$TESTS_DIR/website/public/install.sh" 2>/dev/null || true

# One-time (and on lockfile change): real `pnpm install --frozen-lockfile` in the scratch tree — the
# workspace symlinks + native builds (better-sqlite3, sharp) exactly like a fresh checkout. corepack
# ships with the box's Node; pnpm version comes from package.json's packageManager pin.
echo "Ensure scratch node_modules (pnpm install on first run / lockfile change) …"
ssh -o ConnectTimeout=30 -o ServerAliveInterval=10 "$VPS" "
  set -e
  cd '$TESTS_DIR'
  want=\$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
  have=\$(cat .lockfile-installed 2>/dev/null || true)
  if [ ! -d node_modules ] || [ \"\$want\" != \"\$have\" ]; then
    command -v pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || npm i -g pnpm >/dev/null 2>&1
    CI=true pnpm install --frozen-lockfile 2>&1 | tail -3
    echo \"\$want\" > .lockfile-installed
  else
    echo '  node_modules up to date (lockfile unchanged)'
  fi
"

echo "Running .linux tests on the box (real bwrap): ${TESTS[*]}"
ssh -o ConnectTimeout=200 -o ServerAliveInterval=10 "$VPS" \
  "cd '$TESTS_DIR' && CI=true pnpm vitest run ${TESTS[*]} 2>&1 | tail -30"
