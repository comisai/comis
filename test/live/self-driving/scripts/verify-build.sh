#!/usr/bin/env bash
# LOCAL — prove the rig is running THIS checkout's build (01-SETUP §2's discipline as one command).
#
# RIG_MODE=remote (default) — three checks, strongest last:
#   1. provenance : /root/comis-deployed-build (written by install-vps.sh AND deploy-dist.sh)
#                   matches the local `git rev-parse --short HEAD`.
#   2. process    : the daemon PROCESS started AFTER that deploy was recorded (a deploy without a
#                   restart leaves the OLD code serving — the in-memory-dist trap).
#   3. symbol     : optional HEAD-only SYMBOL GREP — the definitive, timezone-immune proof that a
#                   symbol existing ONLY in your diff is in the deployed dist. Never use mtimes.
#
# RIG_MODE=local — there is no deploy step (the checkout IS the build), so provenance becomes the
#   question that actually bites locally: is `dist/` newer than `src/`? An edit without a rebuild is
#   the local twin of a deploy without a restart — the daemon happily serves the OLD dist and every
#   result is void. mtimes ARE trustworthy here: one machine, one clock (the timezone hazard the
#   remote path warns about only exists across two hosts).
#     1. build   : every packages/*/dist is newer than the newest packages/*/src file
#     2. process : the daemon started after that dist was built
#     3. symbol  : the same grep, against the local dist
#
#   ./verify-build.sh                          # provenance/build + process checks
#   ./verify-build.sh <symbol> [pkg]           # + grep for <symbol> under @comis/<pkg> (default: all)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
rig_defaults
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"
SYMBOL="${1:-}"
SYMPKG="${2:-}"

fails=0
pass() { printf '  \033[32mPASS\033[0m  %-12s %s\n' "$1" "$2"; }
fail() {
  printf '  \033[31mFAIL\033[0m  %-12s %s\n' "$1" "$2"
  fails=$((fails + 1))
}
warn() { printf '  \033[33mWARN\033[0m  %-12s %s\n' "$1" "$2"; }

LOCAL_SHA="$(cd "$REPO" && git rev-parse --short HEAD)"
LOCAL_DIRTY="$(cd "$REPO" && git diff --quiet && git diff --cached --quiet && echo clean || echo dirty)"
echo "=== verify-build ($LOCAL_SHA/$LOCAL_DIRTY) — $(rig_banner) ==="

if rig_is_local; then
  # Newest src mtime vs oldest dist mtime, across every built package. Reported in one node pass so
  # the comparison is identical on macOS and Linux (no `stat -c` / `stat -f` divergence).
  build="$(node -e '
    const { readdirSync, statSync, existsSync } = require("node:fs");
    const { join } = require("node:path");
    const repo = process.argv[1];
    const newest = (dir, skip) => {
      let t = 0;
      const walk = (d) => {
        let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          const p = join(d, e.name);
          if (e.isDirectory()) { if (!skip || e.name !== skip) walk(p); }
          else { const m = statSync(p).mtimeMs; if (m > t) t = m; }
        }
      };
      walk(dir);
      return t;
    };
    let src = 0, dist = 0, built = 0, missing = [];
    for (const pkg of readdirSync(join(repo, "packages"))) {
      const s = join(repo, "packages", pkg, "src");
      const d = join(repo, "packages", pkg, "dist");
      if (!existsSync(s)) continue;
      src = Math.max(src, newest(s));
      if (!existsSync(d)) { missing.push(pkg); continue; }
      built++;
      dist = Math.max(dist, newest(d));
    }
    console.log(JSON.stringify({ src, dist, built, missing }));
  ' "$REPO" 2>/dev/null)"
  if [ -z "$build" ]; then
    fail "build" "could not read $REPO/packages — is REPO right?"
  else
    src_ms="$(printf '%s' "$build" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).src))')"
    dist_ms="$(printf '%s' "$build" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).dist))')"
    missing="$(printf '%s' "$build" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).missing.join(",")))')"
    if [ -n "$missing" ]; then
      fail "build" "no dist for: $missing — run 'pnpm build'"
    elif [ "${dist_ms%.*}" -ge "${src_ms%.*}" ] 2>/dev/null; then
      pass "build" "dist is newer than src (stale-dist trap clear)"
    else
      fail "build" "src is NEWER than dist — you edited without rebuilding. Run 'pnpm build'"
    fi
  fi
  DEPLOY_MS="${dist_ms:-0}"
else
  record="$(remote_root 'cat /root/comis-deployed-build 2>/dev/null')"
  if [ -z "$record" ]; then
    fail "provenance" "no /root/comis-deployed-build on the box — deploy with install-vps.sh / deploy-dist.sh"
  else
    box_sha="$(printf '%s' "$record" | awk '{print $1}')"
    if [ "$box_sha" = "$LOCAL_SHA" ]; then
      pass "provenance" "$record"
      [ "$LOCAL_DIRTY" = "dirty" ] && warn "provenance" "local tree is DIRTY — the record can't see uncommitted edits; use the symbol check"
    else
      fail "provenance" "box has '$record' — local HEAD is $LOCAL_SHA (redeploy, or you're on the wrong branch)"
    fi
  fi
fi

# Process freshness: the daemon start must postdate the build/deploy it is supposed to be serving.
if rig_is_local; then
  pid="$(rig_daemon_pid)"
  if [ -z "$pid" ]; then
    fail "process" "no daemon process — ./restart-daemon.sh"
  else
    start_ts="$(rig_epoch "$(ps -o lstart= -p "$pid" 2>/dev/null)")"
    dist_ts=$((${DEPLOY_MS%.*} / 1000))
    if [ "${start_ts:-0}" -ge "$dist_ts" ] 2>/dev/null; then
      pass "process" "daemon pid $pid started after the current dist was built"
    else
      fail "process" "daemon pid $pid PREDATES the dist — old code is in memory. ./restart-daemon.sh"
    fi
  fi
else
  proc="$(remote_root '
  rec=$(date -d "$(sed -E "s/.*deployed |.*dist-overlay //" /root/comis-deployed-build 2>/dev/null)" +%s 2>/dev/null || echo 0)
  pid=$(pgrep -f "node.*daemon\.js" | head -1)
  if [ -z "$pid" ]; then echo "NOPROC"; else
    start=$(date -d "$(ps -o lstart= -p "$pid")" +%s 2>/dev/null || echo 0)
    echo "$rec $start $pid"
  fi
')"
  if [ "$proc" = "NOPROC" ]; then
    fail "process" "no daemon process — bash /root/restart-daemon.sh"
  else
    rec_ts="$(printf '%s' "$proc" | awk '{print $1}')"
    start_ts="$(printf '%s' "$proc" | awk '{print $2}')"
    pid="$(printf '%s' "$proc" | awk '{print $3}')"
    if [ "${start_ts:-0}" -ge "${rec_ts:-0}" ] 2>/dev/null; then
      pass "process" "daemon pid $pid started after the recorded deploy"
    else
      fail "process" "daemon pid $pid PREDATES the deploy — old code is serving. bash /root/restart-daemon.sh"
    fi
  fi
fi

if [ -n "$SYMBOL" ]; then
  if rig_is_local; then
    scope="$REPO/packages/${SYMPKG:+$SYMPKG/}"
    hits="$(grep -rl --include='*.js' --exclude-dir=node_modules -- "$SYMBOL" "$scope"*/dist 2>/dev/null | head -3)"
    [ -n "$SYMPKG" ] && hits="$(grep -rl --include='*.js' -- "$SYMBOL" "$REPO/packages/$SYMPKG/dist" 2>/dev/null | head -3)"
  else
    scope="$PKG/node_modules/@comis/${SYMPKG:+$SYMPKG/}"
    [ -z "$SYMPKG" ] && scope="$PKG/node_modules/@comis/"
    # shellcheck disable=SC2029 # remote expansion intended
    hits="$(remote_root "grep -rl --include='*.js' -- '$SYMBOL' '$scope' 2>/dev/null | head -3")"
  fi
  if [ -n "$hits" ]; then
    pass "symbol" "'$SYMBOL' present in the dist under test:"
    printf '%s\n' "$hits" | sed 's/^/          /'
  else
    fail "symbol" "'$SYMBOL' NOT in the dist under test — the rig is not running your diff"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then
  echo -e "\033[32m✅ the rig serves this build\033[0m"
  exit 0
else
  echo -e "\033[31m❌ verify-build: $fails check(s) failed\033[0m"
  exit 1
fi
