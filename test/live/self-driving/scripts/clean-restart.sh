#!/usr/bin/env bash
# VPS (run as ROOT) — clean slate then relaunch. Wipes the test session + LCD + logs; PRESERVES
# config.yaml, secrets.db, and the master key (~/.comis/.env). Then launches the daemon as comis.
#   Usage:  [DATA=/home/comis/.comis CHATID=678314278] bash clean-restart.sh
set -euo pipefail
DATA="${DATA:-/home/comis/.comis}"
CHATID="${CHATID:-678314278}"

pkill -9 -f "^node .*daemon\.js" 2>/dev/null; sleep 2
# IMPORTANT: the session dir is default/<chatId>/ — NOT default/telegram/. Replacing memory.db clears the
# LCD (prior-conversation replay); a bare jsonl rm is not enough (runbook §5).
sudo -u comis bash -c "
  rm -rf '$DATA/workspace/sessions/default/$CHATID'
  # Also clear sub-agent session dirs (sub-agent@*) — they survive a chatId-only wipe and pollute
  # session.search + fleet activeChannels with prior-run sub-agents (F-OBS-1, 30uc-20260624 UC-04/07).
  rm -rf '$DATA'/workspace/sessions/default/sub-agent* '$DATA'/workspace/sessions/*/sub-agent*
  rm -f '$DATA'/memory.db '$DATA'/memory.db-wal '$DATA'/memory.db-shm
  # NOT just *.log — fleet's activeChannels/activeAgents enumerate session-index.<date>.jsonl
  # (the whole-day file, not time-windowed), and cache-trace.jsonl pollutes the cache lens, so a
  # bare '*.log' leaves a 'clean' rig surfacing prior runs (F-OBS-1, 30uc-20260624 Phase 0).
  rm -f '$DATA'/logs/*.log '$DATA'/logs/session-index.*.jsonl* '$DATA'/logs/cache-trace.jsonl
  rm -rf '$DATA'/graph-runs/* '$DATA'/subagent-results/*
  # The SUPERVISOR's stdout capture lives at \$HOME/comis-m1.log (NOT under \$DATA/logs), so the rm above
  # never touched it → it accumulated 14k+ lines across boots and the boot-grep below showed cumulative
  # 'N Comis daemon started', masking the current boot (the pm2 stale-log trap; M2 run 2026-06-24). Truncate
  # it here so each clean-restart's log belongs to THIS boot only (the daemon is dead at this point — line 9
  # SIGKILL'd it (137≠42 → supervisor loop exits), so the file is safe to truncate).
  : > /home/comis/comis-m1.log
"
su - comis -c "bash /home/comis/restart-m1.sh"
sleep 13

echo "=== boot ==="
grep -aoE 'Comis daemon started|"profile":"[a-z]+"|"model":"[a-z0-9._-]+"|aggregateBudgetUsd":[0-9]+|FATAL' \
  /home/comis/comis-m1.log 2>/dev/null | tail -5
ss -ltnp 2>/dev/null | grep -q ':4766' && echo 'gateway UP' || echo 'gateway DOWN — check /home/comis/comis-m1.log'
