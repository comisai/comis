#!/usr/bin/env bash
# VPS (run as ROOT) — clean slate then relaunch. Wipes the test session + LCD + logs; PRESERVES
# config.yaml, secrets.db, and the master key (~/.comis/.env). Then launches the daemon as comis.
#   Usage:  [DATA=/home/comis/.comis CHATID=678314278] bash clean-restart.sh
set -euo pipefail
DATA="${DATA:-/home/comis/.comis}"
CHATID="${CHATID:-678314278}"
# WIPE_CRONS=1 → also clear the persisted cron store (default OFF). The scheduler persists jobs to
# <workspace>/.scheduler/cron-jobs.json which survives a memory.db wipe, so STALE crons registered by a
# PRIOR (different-dist) daemon linger into a "from-scratch" run — e.g. a v2.31 daemon (3 learning crons:
# Reflection/Memory lifecycle/Memory review) inherits 10 crons incl. the DELETED Skill synthesis /
# Online tuning / consolidation / reasoning / user-representation / usefulness-judge / triple-extraction
# sentinels, whose stale fires hit an unknown-sentinel path on the new code (hindsight-reflection-20260626).
# The daemon re-registers its CURRENT cron set from config on boot, so wiping is safe. Learning / from-
# scratch-acceptance runs (EXAMPLE-verified-learning target) MUST set WIPE_CRONS=1 for a true clean slate.
WIPE_CRONS="${WIPE_CRONS:-0}"

pkill -9 -f "^node .*daemon\.js" 2>/dev/null; sleep 2
# IMPORTANT: the session dir is default/<chatId>/ — NOT default/telegram/. Replacing memory.db clears the
# LCD (prior-conversation replay); a bare jsonl rm is not enough (runbook §5).
sudo -u comis bash -c "
  # KIT-2 (dispatch-learning-20260627): wipe ALL default/* session dirs, NOT just default/<CHATID>.
  # A chatId-only wipe leaves STALE per-chat / cron@ / sub-agent dirs from prior (possibly different-config)
  # runs — they pollute (a) fleet activeChannels, (b) cross-run model greps (a prior CODEX run's cron@ dirs
  # showed gpt-5.x modelIds while THIS run's config was anthropic — a phantom 'chimera'), and (c) re-prime a
  # multi-sender test's session (a different sender's prior-run refusals reload from its surviving JSONL).
  # clean-restart is a from-scratch tool (memory.db is wiped globally below), so wiping every default session
  # is the correct slate. (Targeted single-session severs use session.reset_conversation, not this script.)
  rm -rf '$DATA'/workspace/sessions/default/* '$DATA'/workspace/sessions/*/sub-agent*
  rm -f '$DATA'/memory.db '$DATA'/memory.db-wal '$DATA'/memory.db-shm
  # NOT just *.log — fleet's activeChannels/activeAgents enumerate session-index.<date>.jsonl
  # (the whole-day file, not time-windowed), and cache-trace.jsonl pollutes the cache lens, so a
  # bare '*.log' leaves a 'clean' rig surfacing prior runs (F-OBS-1, 30uc-20260624 Phase 0).
  rm -f '$DATA'/logs/*.log '$DATA'/logs/session-index.*.jsonl* '$DATA'/logs/cache-trace.jsonl
  rm -rf '$DATA'/graph-runs/* '$DATA'/subagent-results/*
  # Optional (WIPE_CRONS=1): clear the persisted cron store so a from-scratch run inherits NO stale crons
  # from a prior (different-dist) daemon. The daemon re-registers its current cron set from config on boot.
  # ALSO wipe execution.jsonl — the ExecutionTracker's per-job run HISTORY persists there (NOT in memory.db),
  # so without this a "from-scratch" daemon inherits a prior session's cron.runs history. This bit the
  # reflect-obs run 2026-06-27: a stale `reflect: outcome=admitted …` record from a previous daemon showed
  # up in `cron.runs jobName "Reflection"` on a freshly-wiped memory.db (mental_models=0), masking E-5
  # (cron.runs empty on a fresh daemon) and muddying a from-scratch OBS-2/6b reflection-run proof.
  if [ '$WIPE_CRONS' = '1' ]; then rm -f '$DATA'/workspace*/.scheduler/cron-jobs.json '$DATA'/workspace*/.scheduler/cron-jobs.json.bak '$DATA'/workspace*/.scheduler/cron-jobs.json.lock '$DATA'/workspace*/.scheduler/execution.jsonl; fi
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
