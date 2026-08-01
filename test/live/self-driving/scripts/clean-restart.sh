#!/usr/bin/env bash
# Clean slate then relaunch. Wipes the test session + LCD + follow-up tasks + logs; PRESERVES
# config.yaml, secrets.db, and the master key (<dataDir>/.env). Then restarts the daemon via
# restart-daemon.sh (systemd on the remote rig; an explicit stop/relaunch locally).
#
# RIG_MODE=remote (default) — VPS, run as ROOT against the SERVICE user's data dir.
#   Usage:  [WIPE_CRONS=1] bash /root/clean-restart.sh
# RIG_MODE=local — THIS machine, against your own data dir. No sudo: the files are already yours.
#   Usage:  [WIPE_CRONS=1] ./clean-restart.sh
#
# ⚠ LOCAL MODE DESTROYS REAL STATE. `DATA` defaults to ~/.comis, so on a machine where that is your
# everyday Comis install this deletes YOUR sessions, memory.db and logs — not a scratch rig's. Point
# `DATA` at a dedicated directory (see `01-SETUP.md §Local mode`) before running a from-scratch
# workload, or accept that the wipe is real.
#
# Stateful relationship campaigns should set PROTECT_CONTINUITY_AFTER_RESTART=1 on their initial clean
# slate. Later invocations then refuse before stopping the daemon or deleting anything. Use a separate
# scratch DATA root for fix verification. ALLOW_CONTINUITY_WIPE=1 deliberately ends the relationship.
#
# Env: SERVICE, DATA, COMIS_USER, GW_PORT — the rig env file supplies per-rig values; explicit env wins.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_rig.sh
. "$HERE/_rig.sh" 2>/dev/null || {
  echo "missing $HERE/_rig.sh — re-run deploy-scripts.sh (the kit ships as a unit)" >&2
  exit 2
}
rig_load_env "$HERE/.live-env" "$HERE/.rig-env" /root/comis-rig.env
SERVICE="${SERVICE:-comis}"
DATA="${DATA:-/home/comis/.comis}"
COMIS_USER="${COMIS_USER:-comis}"
GW_PORT="${GW_PORT:-4766}"

# This must remain before every process stop and destructive operation. A protected relationship cannot
# tolerate a "guard" that fires only after the daemon is down or its durable state has already changed.
rig_refuse_continuity_wipe "$DATA"
rig_assert_local_lifecycle_owner || exit $?

# Run a wipe step as the data dir's owner. Remote: root drops to the service user. Local: the files
# are already the caller's, and a sudo here would leave root-owned leftovers in their own data dir —
# the EACCES class 01-SETUP §1 exists to prevent.
if rig_is_local; then
  as_service_user() { bash -c "$1"; }
else
  as_service_user() { sudo -u "$COMIS_USER" bash -c "$1"; }
fi
# WIPE_CRONS=1 → also clear the persisted cron store (default OFF). The scheduler persists jobs to
# <workspace>/.scheduler/cron-jobs.json which survives a memory.db wipe, so STALE crons registered by a
# PRIOR (different-dist) daemon linger into a "from-scratch" run — e.g. a daemon with 3 learning crons
# (Reflection/Memory lifecycle/Memory review) inherits 10 crons incl. the DELETED Skill synthesis /
# Online tuning / consolidation / reasoning / user-representation / usefulness-judge / triple-extraction
# sentinels, whose stale fires hit an unknown-sentinel path on the new code.
# The daemon re-registers its CURRENT cron set from config on boot, so wiping is safe. Learning / from-
# scratch-acceptance runs (EXAMPLE-verified-learning target) MUST set WIPE_CRONS=1 for a true clean slate.
WIPE_CRONS="${WIPE_CRONS:-0}"

if rig_is_local; then
  if [ "${LOCAL_SUPERVISOR:-auto}" != "direct" ] && rig_pm2_manages; then
    pm2 stop "$SERVICE" >/dev/null 2>&1 || true
  else
    _pid="$(rig_daemon_pid)"
    [ -n "$_pid" ] && kill "$_pid" 2>/dev/null || true
  fi
else
  systemctl stop "$SERVICE" 2>/dev/null || true
fi
sleep 2
# Reap orphan terminal-driver tmux servers scoped to this data root. Killing each server terminates its
# pane and child process tree, including its jailed coding CLI. The daemon is dead now, but the unit uses
# KillMode=process, so detached terminal workers can survive the stop and be recovered on the next boot.
# Process-name-wide cleanup is unsafe here: another Comis rig or the caller may also be running Codex.
for s in "$DATA"/terminal-worker/*.sock; do [ -e "$s" ] && { as_service_user "tmux -S '$s' kill-server" 2>/dev/null || true; }; done
rm -f "$DATA"/terminal-worker/*.sock 2>/dev/null || true
sleep 1
# IMPORTANT: the session dir is default/<chatId>/ — NOT default/telegram/. Replacing memory.db clears the
# LCD (prior-conversation replay); a bare jsonl rm is not enough (runbook §5).
as_service_user "
  # Wipe ALL default/* session dirs, NOT just default/<CHATID>.
  # A chatId-only wipe leaves STALE per-chat / cron@ / sub-agent dirs from prior (possibly different-config)
  # runs — they pollute (a) system activeChannels, (b) cross-run model greps (a prior CODEX run's cron@ dirs
  # showed gpt-5.x modelIds while THIS run's config was anthropic — a phantom 'chimera'), and (c) re-prime a
  # multi-sender test's session (a different sender's prior-run refusals reload from its surviving JSONL).
  # clean-restart is a from-scratch tool (memory.db is wiped globally below), so wiping every default session
  # is the correct slate. (Targeted single-session severs use session.reset_conversation, not this script.)
  rm -rf '$DATA'/workspace/sessions/default/* '$DATA'/workspace/sessions/*/sub-agent*
  rm -f '$DATA'/memory.db '$DATA'/memory.db-wal '$DATA'/memory.db-shm
  # Follow-up task authority is scoped to the sessions and workspace-policy snapshots wiped above.
  # Keeping it produces either orphaned work or a strict-schema boot failure after a code update.
  # Remove the authority, reset intent, quarantine, and lock so boot recreates one empty valid store.
  rm -f '$DATA'/workspace*/.scheduler/tasks.json '$DATA'/workspace*/.scheduler/tasks-reset-intent.json '$DATA'/workspace*/.scheduler/tasks-quarantine.jsonl '$DATA'/workspace*/.scheduler/tasks.lock
  # NOT just *.log — system's activeChannels/activeAgents enumerate session-index.<date>.jsonl
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
  # Graceful shutdown captures active channel lanes for replay on the next boot.
  # A clean slate must remove that handoff after systemd has stopped the daemon,
  # or the just-wiped session is reconstructed immediately on startup.
  rm -f '$DATA'/restart-continuations.json
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
if [ "${PROTECT_CONTINUITY_AFTER_RESTART:-0}" = "1" ]; then
  as_service_user "umask 077; : > '$DATA'/.continuity-protected"
fi
# Relaunch via systemd + verify the boot from the fresh structured log (restart-daemon.sh waits for
# a post-restart 'Comis daemon started' and probes the gateway port; the log wipe above guarantees
# whatever it finds belongs to THIS boot).
RIG_MODE="$(rig_mode)" SERVICE="$SERVICE" DATA="$DATA" GW_PORT="$GW_PORT" bash "$HERE/restart-daemon.sh"
