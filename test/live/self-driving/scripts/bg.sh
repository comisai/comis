#!/usr/bin/env bash
# bg.sh — run a long box command DETACHED + pollable (the flaky-VPS-link prescription, as a helper).
#
# A dropped ssh link can lose a 300s foreground drive, and hand-rolling
# `nohup … >/tmp/x.out & … poll /tmp/x.done` every time is error-prone. This standardizes the pattern
# so a long orchestration (esp. drive-sim-workload.sh) survives the ssh link dropping — launch detached,
# then poll in short ssh calls.
#
#   bash bg.sh <tag> <command...>        launch <command> in a detached process group; writes
#                                        /tmp/bg-<tag>.out (stdout+stderr) and /tmp/bg-<tag>.done (on exit,
#                                        containing the exit code). Returns immediately.
#   bash bg.sh --poll <tag> [maxSec=600] wait until /tmp/bg-<tag>.done exists (or timeout), then tail the out.
#   bash bg.sh --tail <tag> [n=20]       tail the current out without waiting.
set -uo pipefail

process_is_running() {
  local pid_file="$1" pid
  [ -f "$pid_file" ] || return 1
  pid="$(cat "$pid_file" 2>/dev/null)"
  case "$pid" in
    ""|*[!0-9]*) return 1 ;;
  esac
  kill -0 "$pid" 2>/dev/null
}

if [ "${1:-}" = "--poll" ]; then
  TAG="${2:?usage: bg.sh --poll <tag> [maxSec]}"; MAX="${3:-600}"
  OUT="/tmp/bg-$TAG.out"; DONE="/tmp/bg-$TAG.done"; PID="/tmp/bg-$TAG.pid"
  waited=0
  while [ ! -f "$DONE" ] && process_is_running "$PID" && [ "$waited" -lt "$MAX" ]; do
    sleep 5
    waited=$((waited + 5))
  done
  if [ -f "$DONE" ]; then
    echo "[bg:$TAG] done (exit $(cat "$DONE" 2>/dev/null)) after ~${waited}s"
  elif process_is_running "$PID"; then
    echo "[bg:$TAG] STILL RUNNING after ${MAX}s (re-poll)"
  else
    echo "[bg:$TAG] not running (no live process or completion marker)"
    echo "---- tail $OUT ----"
    tail -"${4:-20}" "$OUT" 2>/dev/null || echo "(no output yet)"
    exit 1
  fi
  echo "---- tail $OUT ----"; tail -"${4:-20}" "$OUT" 2>/dev/null || echo "(no output yet)"
  exit 0
fi
if [ "${1:-}" = "--tail" ]; then
  TAG="${2:?usage: bg.sh --tail <tag> [n]}"
  OUT="/tmp/bg-$TAG.out"; DONE="/tmp/bg-$TAG.done"; PID="/tmp/bg-$TAG.pid"
  if [ -f "$DONE" ]; then
    echo "[bg:$TAG] done (exit $(cat "$DONE" 2>/dev/null))"
  elif process_is_running "$PID"; then
    echo "[bg:$TAG] running"
  else
    echo "[bg:$TAG] not running (no live process or completion marker)"
    tail -"${3:-20}" "$OUT" 2>/dev/null || echo "(no output yet)"
    exit 1
  fi
  tail -"${3:-20}" "/tmp/bg-$TAG.out" 2>/dev/null || echo "(no output yet)"
  exit 0
fi

TAG="${1:?usage: bg.sh <tag> '<command string>'   |   bg.sh --poll <tag> [maxSec]   |   bg.sh --tail <tag> [n]}"
shift
[ "$#" -ge 1 ] || { echo "bg.sh: no command given" >&2; exit 2; }
OUT="/tmp/bg-$TAG.out"; DONE="/tmp/bg-$TAG.done"; PID="/tmp/bg-$TAG.pid"; RUNNER="/tmp/bg-$TAG.cmd.sh"
rm -f "$OUT" "$DONE" "$PID"
# Robustness (two traps the bg.sh self-test caught): (1) write the command (args joined) to a RUNNER file
# instead of re-quoting through nested `bash -c` — preserves quoting in a `bash -c 'a; b'` command; PASS the
# whole command as ONE quoted arg. (2) run the command as a CHILD (`bash RUNNER`) so its own `exit N` exits
# only the child — the wrapper then captures $? into the done-marker (an `exit` inside a `{ …; }` group
# would have killed the wrapper before the marker write, leaving --poll stuck on "STILL RUNNING").
printf '%s\n' "$*" > "$RUNNER" || { echo "bg.sh: cannot write detached runner" >&2; exit 1; }
if command -v setsid >/dev/null 2>&1; then
  command -v nohup >/dev/null 2>&1 || { echo "bg.sh: nohup is required" >&2; exit 127; }
  setsid nohup bash -c "bash '$RUNNER' > '$OUT' 2>&1; echo \$? > '$DONE'" >/dev/null 2>&1 &
  PID_VALUE="$!"
else
  command -v node >/dev/null 2>&1 || {
    echo "bg.sh: node is required to detach when setsid is unavailable" >&2
    exit 127
  }
  PID_VALUE="$(node -e '
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], ["-c", process.argv[2]], {
  detached: true,
  stdio: "ignore",
});
child.unref();
if (!Number.isInteger(child.pid)) process.exit(1);
process.stdout.write(String(child.pid));
' "$(command -v bash)" "bash '$RUNNER' > '$OUT' 2>&1; echo \$? > '$DONE'")" || {
    echo "bg.sh: could not create detached process" >&2
    exit 1
  }
fi
case "$PID_VALUE" in
  ""|*[!0-9]*) echo "bg.sh: detached process returned an invalid pid" >&2; exit 1 ;;
esac
printf '%s\n' "$PID_VALUE" > "$PID" || { echo "bg.sh: cannot record detached process" >&2; exit 1; }
echo "[bg:$TAG] launched detached (cmd: $*) → poll with: bash bg.sh --poll $TAG"
