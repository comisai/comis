#!/usr/bin/env bash
# drive-quiet.sh — drive a turn ONLY when the session is quiescent.
#
# Why: when background work is in flight, a new turn's immediate reply can DENY the request
# ("No new request detected." / "I don't see a new request…") while the work is dispatched
# anyway (F-SIDEEFFECT-1). A row driven in that state yields a non-answer that looks like a
# product verdict but is really a scheduling artefact — it cost several rows before the cause
# was isolated. So: round-trip a cheap sentinel first, and only drive the real prompt once the
# sentinel comes back.
#
#   Usage:  drive-quiet.sh <chatId> "<prompt>" [maxWaitSecs=240]
#           drive-quiet.sh <chatId> @/abs/path/to/prompt.txt
#
# Exit 0 = the real drive ran (its output is on stdout).
# Exit 4 = never reached quiescence inside maxWaitSecs; the row must be recorded NOT-RUN with
#          that reason, NOT scored from whatever the agent happened to say.
set -uo pipefail
CHAT="${1:?usage: drive-quiet.sh <chatId> <prompt|@file> [maxWaitSecs]}"
PROMPT="${2:?missing prompt}"
MAX="${3:-240}"
KIT="${KIT_DIR:-$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"

TOKEN="QUIET-$$-$RANDOM"
started=$(date +%s)
attempt=0
while :; do
  attempt=$((attempt + 1))
  reply=$(node "$KIT/drive.mjs" "$CHAT" "reply with exactly $TOKEN and nothing else" 2>/dev/null \
          | sed -n '/SUBSTANTIVE/,$p' | sed -n '2p')
  case "$reply" in
    *"$TOKEN"*)
      echo "drive-quiet: session quiescent after ${attempt} probe(s)" >&2
      exec node "$KIT/drive.mjs" "$CHAT" "$PROMPT"
      ;;
  esac
  now=$(date +%s)
  if [ $((now - started)) -ge "$MAX" ]; then
    echo "drive-quiet: NOT quiescent after ${MAX}s (${attempt} probes); last sentinel reply: ${reply:-<none>}" >&2
    echo "drive-quiet: refusing to drive — record the row NOT-RUN (quiescence gate), do not score this" >&2
    exit 4
  fi
  sleep 15
done
