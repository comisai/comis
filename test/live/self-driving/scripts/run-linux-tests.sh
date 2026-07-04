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

# Relink workspace @comis/* symlinks from each package.json's `workspace:*` deps.
# deploy-dist ships dist only (no node_modules) and this script rsyncs src+package.json
# but never `pnpm install`s — so a NEW workspace (dev)dep (e.g. skills → @comis/infra, added
# in v2.32) is present in package.json but has no node_modules symlink on the box, and vitest
# fails to LOAD the test with "Cannot find package '@comis/infra'" (a whole suite reads as 0
# tests). This idempotent relink makes the box's workspace resolution match a fresh
# `pnpm install`, so a milestone that adds a workspace dep never silently fails-to-load here.
ssh -o ConnectTimeout=20 "$VPS" "cd '$SRC' && node -e '
const fs=require(\"fs\"),path=require(\"path\");
let n=0;
for(const pkg of fs.readdirSync(\"packages\")){
  const pj=path.join(\"packages\",pkg,\"package.json\"); if(!fs.existsSync(pj))continue;
  let j; try{j=JSON.parse(fs.readFileSync(pj,\"utf8\"))}catch(e){continue}
  const deps={...(j.dependencies||{}),...(j.devDependencies||{})};
  for(const [name,spec] of Object.entries(deps)){
    if(!name.startsWith(\"@comis/\")||!String(spec).startsWith(\"workspace:\"))continue;
    const short=name.slice(\"@comis/\".length);
    const nm=path.join(\"packages\",pkg,\"node_modules\",\"@comis\");
    fs.mkdirSync(nm,{recursive:true});
    const link=path.join(nm,short);
    try{fs.rmSync(link,{force:true,recursive:false})}catch(e){}
    try{fs.symlinkSync(path.join(\"..\",\"..\",\"..\",short),link);n++}catch(e){}
  }
}
console.log(\"relinked \"+n+\" workspace @comis/* symlinks\");
'" || true

echo "Running .linux tests on the box (real bwrap): ${TESTS[*]}"
# The box CLI is not on PATH concerns don't apply — pnpm runs from $SRC.
ssh -o ConnectTimeout=200 -o ServerAliveInterval=10 "$VPS" \
  "cd '$SRC' && CI=true pnpm vitest run ${TESTS[*]} 2>&1 | tail -30"
