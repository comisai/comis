#!/usr/bin/env bash
# VPS (run as ROOT) — clean slate then relaunch. Wipes the test session + LCD + logs; PRESERVES
# config.yaml, secrets.db, and the master key (~/.comis/.env). Then restarts the PRODUCTION daemon
# via systemd (the installed comis.service — the unit handles the SIGUSR2 exit-42 hot-restart, so
# there is no supervisor to manage).
#   Usage:  [WIPE_CRONS=1] bash /root/clean-restart.sh
# Env: SERVICE (comis), DATA (/home/comis/.comis), COMIS_USER (comis), GW_PORT (4766) —
# /root/comis-rig.env (rendered by deploy-scripts.sh) supplies per-box values; explicit env wins.
set -euo pipefail
[ -f /root/comis-rig.env ] && . /root/comis-rig.env
SERVICE="${SERVICE:-comis}"
DATA="${DATA:-/home/comis/.comis}"
COMIS_USER="${COMIS_USER:-comis}"
GW_PORT="${GW_PORT:-4766}"
# WIPE_CRONS=1 → also clear the persisted cron store (default OFF). The scheduler persists jobs to
# <workspace>/.scheduler/cron-jobs.json which survives a memory.db wipe, so STALE crons registered by a
# PRIOR (different-dist) daemon linger into a "from-scratch" run — e.g. a daemon with 3 learning crons
# (Reflection/Memory lifecycle/Memory review) inherits 10 crons incl. the DELETED Skill synthesis /
# Online tuning / consolidation / reasoning / user-representation / usefulness-judge / triple-extraction
# sentinels, whose stale fires hit an unknown-sentinel path on the new code.
# The daemon re-registers its CURRENT cron set from config on boot, so wiping is safe. Learning / from-
# scratch-acceptance runs (EXAMPLE-verified-learning target) MUST set WIPE_CRONS=1 for a true clean slate.
WIPE_CRONS="${WIPE_CRONS:-0}"

systemctl stop "$SERVICE" 2>/dev/null || true
sleep 2
# Reap orphan terminal-driver tmux servers + their jailed coding-CLIs (claude/codex). The daemon is dead
# now, but the unit uses KillMode=process (so durable drives CAN survive restarts) — the tmux servers are
# detached and the bwrap jails are `--die-with-parent` on the TMUX PANE (not the daemon), so they SURVIVE
# the stop. Worse, the durable-drive store cleared below would otherwise RESURRECT them on the next boot —
# recover-on-boot replays the persisted journal and RE-LAUNCHES + re-runs the drive (not a clean
# re-attach), so a prior run's backgrounded "build X" drive comes back into a from-scratch run, burning
# model tokens (the sockets are PID-named `tmux-<pid>.sock`, so the new daemon can't re-attach the pane).
for s in "$DATA"/terminal-worker/*.sock; do [ -e "$s" ] && { sudo -u "$COMIS_USER" tmux -S "$s" kill-server 2>/dev/null || true; }; done
pkill -9 -f "share/claude/versions|share/codex|bwrap.*permission-mode" 2>/dev/null || true
rm -f "$DATA"/terminal-worker/*.sock 2>/dev/null || true
sleep 1
# IMPORTANT: the session dir is default/<chatId>/ — NOT default/telegram/. Replacing memory.db clears the
# LCD (prior-conversation replay); a bare jsonl rm is not enough (runbook §5).
sudo -u "$COMIS_USER" bash -c "
  # Wipe ALL default/* session dirs, NOT just default/<CHATID>.
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
  # bare '*.log' leaves a 'clean' rig surfacing prior runs.
  rm -f '$DATA'/logs/*.log '$DATA'/logs/session-index.*.jsonl* '$DATA'/logs/cache-trace.jsonl
  rm -rf '$DATA'/graph-runs/* '$DATA'/subagent-results/*
  # Clear the DURABLE TERMINAL DRIVE + WAKE-STATE stores. A backgrounded coding-CLI drive persists its
  # descriptor/journal in <DATA>/terminal-drive/ AND its wake-dispatch FSM state in <DATA>/terminal-wake/
  # {sessionId}.json. On boot, recoverWakeStates RE-HYDRATES the wake-state + re-fires the wake →
  # re-runs the drive's agent turn → spawns a FRESH coding CLI, so a prior run's drive RESURRECTS into a
  # from-scratch run and (worse) RESPAWNS in a loop. Both live OUTSIDE workspace/sessions, so the
  # session + memory.db wipe above does NOT catch them. terminal-wake is the LOAD-BEARING one (the
  # re-fire trigger); clearing only terminal-drive leaves the wake-state to resurrect.
  rm -rf '$DATA'/terminal-drive/* '$DATA'/terminal-wake/*
  # Optional (WIPE_CRONS=1): clear the persisted cron store so a from-scratch run inherits NO stale crons
  # from a prior (different-dist) daemon. The daemon re-registers its current cron set from config on boot.
  # ALSO wipe execution.jsonl -- the ExecutionTracker per-job run HISTORY persists there (NOT in memory.db),
  # so without this a from-scratch daemon inherits a prior session cron.runs history: a stale reflect
  # outcome=admitted record from a previous daemon can show up in cron.runs jobName Reflection on a
  # freshly-wiped memory.db (mental_models=0), masking the cron.runs-empty-on-a-fresh-daemon check
  # and muddying a from-scratch reflection-run proof.
  # NOTE: this comment lives INSIDE the sudo -u bash -c double-quoted string, so it must carry NO
  # backticks / inner double-quotes / dollar-signs -- the OUTER shell command-substitutes/word-toggles them
  # BEFORE bash -c ever sees the leading hash (the reflect/cron.runs command-not-found noise that
  # a backtick in THIS very comment once re-triggered -- keep it plain text).
  if [ '$WIPE_CRONS' = '1' ]; then rm -f '$DATA'/workspace*/.scheduler/cron-jobs.json '$DATA'/workspace*/.scheduler/cron-jobs.json.bak '$DATA'/workspace*/.scheduler/cron-jobs.json.lock '$DATA'/workspace*/.scheduler/execution.jsonl; fi
"
# Relaunch via systemd + verify the boot from the fresh structured log (restart-daemon.sh waits for
# a post-restart 'Comis daemon started' and probes the gateway port; the log wipe above guarantees
# whatever it finds belongs to THIS boot).
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVICE="$SERVICE" DATA="$DATA" GW_PORT="$GW_PORT" bash "$HERE/restart-daemon.sh"
