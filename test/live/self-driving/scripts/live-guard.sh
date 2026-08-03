#!/usr/bin/env bash
# Continuous LIVE-INSTALL guard for a campaign that shares a host with a real deployment.
#
# Why this exists: this run asserted "live install untouched" for hours by comparing only the
# config sha256 — a property that cannot change when a daemon is merely killed. Meanwhile
# `comis.service` sat in `Failed with result 'start-limit-hit'` for ~6h. A check that cannot
# fail on the property it protects is not a check. This asserts the properties that actually move.
set -u
UNIT=${LIVE_UNIT:-comis}
LIVE_DATA=${LIVE_DATA:-/home/comis/.comis}
BASE=${LIVE_BASELINE:-/tmp/live-guard-baseline}

snap() {
  printf 'active=%s\n' "$(systemctl show "$UNIT" -p ActiveState --value 2>/dev/null)"
  printf 'sub=%s\n'    "$(systemctl show "$UNIT" -p SubState --value 2>/dev/null)"
  printf 'start=%s\n'  "$(systemctl show "$UNIT" -p ExecMainStartTimestamp --value 2>/dev/null)"
  printf 'cfg=%s\n'    "$(sudo -n sha256sum "$LIVE_DATA/config.yaml" 2>/dev/null | cut -d' ' -f1)"
  printf 'sessions=%s\n' "$(sudo -n find "$LIVE_DATA/workspace/sessions" -name '*.jsonl' 2>/dev/null | wc -l)"
  printf 'port=%s\n'   "$(ss -ltn 'sport = :4766' 2>/dev/null | grep -c LISTEN)"
}

case "${1:-check}" in
  baseline) snap > "$BASE"; echo "live-guard: baseline recorded"; sed 's/^/  /' "$BASE" ;;
  check)
    [ -f "$BASE" ] || { echo "live-guard: NO BASELINE — run 'live-guard.sh baseline' first" >&2; exit 2; }
    snap > "$BASE.now"
    if diff -q "$BASE" "$BASE.now" >/dev/null; then
      echo "live-guard: OK — live install unchanged"
    else
      echo "live-guard: ⚠ LIVE INSTALL CHANGED — STOP AND INVESTIGATE" >&2
      diff "$BASE" "$BASE.now" | sed 's/^/  /' >&2
      exit 1
    fi ;;
  *) echo "usage: live-guard.sh [baseline|check]" >&2; exit 2 ;;
esac
