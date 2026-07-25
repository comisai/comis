#!/usr/bin/env bash
# LOCAL — prove the box is running THIS checkout's build (01-SETUP §2's discipline as one command).
# Three checks, strongest last:
#   1. provenance : /root/comis-deployed-build (written by install-vps.sh AND deploy-dist.sh)
#                   matches the local `git rev-parse --short HEAD`.
#   2. process    : the daemon PROCESS started AFTER that deploy was recorded (a deploy without a
#                   restart leaves the OLD code serving — the in-memory-dist trap).
#   3. symbol     : optional HEAD-only SYMBOL GREP — the definitive, timezone-immune proof that a
#                   symbol existing ONLY in your diff is in the deployed dist. Never use mtimes.
#
#   ./verify-build.sh                          # provenance + process checks
#   ./verify-build.sh <symbol> [pkg]           # + grep for <symbol> under @comis/<pkg> (default: all)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
REPO="${REPO:-$(git rev-parse --show-toplevel)}"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
COMIS_USER="${COMIS_USER:-comis}"
COMIS_HOME="${COMIS_HOME:-/home/$COMIS_USER}"
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"
SYMBOL="${1:-}"
SYMPKG="${2:-}"

fails=0
pass() { printf '  \033[32mPASS\033[0m  %-12s %s\n' "$1" "$2"; }
fail() { printf '  \033[31mFAIL\033[0m  %-12s %s\n' "$1" "$2"; fails=$((fails + 1)); }
warn() { printf '  \033[33mWARN\033[0m  %-12s %s\n' "$1" "$2"; }

LOCAL_SHA="$(cd "$REPO" && git rev-parse --short HEAD)"
LOCAL_DIRTY="$(cd "$REPO" && git diff --quiet && git diff --cached --quiet && echo clean || echo dirty)"
echo "=== verify-build (local $LOCAL_SHA/$LOCAL_DIRTY vs $VPS) ==="

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

# Process freshness: daemon start must postdate the recorded deploy.
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

if [ -n "$SYMBOL" ]; then
  scope="$PKG/node_modules/@comis/${SYMPKG:+$SYMPKG/}"
  [ -z "$SYMPKG" ] && scope="$PKG/node_modules/@comis/"
  # shellcheck disable=SC2029 # remote expansion intended
  hits="$(remote_root "grep -rl --include='*.js' -- '$SYMBOL' '$scope' 2>/dev/null | head -3")"
  if [ -n "$hits" ]; then
    pass "symbol" "'$SYMBOL' present in the deployed dist:"
    printf '%s\n' "$hits" | sed 's/^/          /'
  else
    fail "symbol" "'$SYMBOL' NOT in the deployed dist under $scope — the box is not running your diff"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then echo -e "\033[32m✅ the box serves this build\033[0m"; exit 0
else echo -e "\033[31m❌ verify-build: $fails check(s) failed\033[0m"; exit 1; fi
