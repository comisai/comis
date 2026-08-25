#!/usr/bin/env bash
# Shared MODE + PORTABILITY layer for the live-rig shell scripts.
#
# RIG_MODE=remote (default) — the production VPS rig: systemd `comis.service`, the daemon as a
#   dedicated service user, code at the npm-global `comisai` package, helpers shipped to /root.
#   This is the canonical rig: it tests the layout real users get, and it is the ONLY mode that can
#   exercise the Linux-only surfaces (bubblewrap sandbox/jail, systemd lifecycle, `*.linux.test.ts`).
#
# RIG_MODE=local — THIS machine: the daemon runs from this checkout against a local data dir
#   (default `~/.comis`), the emulator binds loopback here, and every "box" command runs in a local
#   shell instead of over ssh. No VPS, no ssh key, no deploy step — the checkout IS the build.
#   Use it for the fast inner loop (drive → read ground truth → patch → re-drive) and for any run
#   where an ssh round-trip per inject is the bottleneck. See `01-SETUP.md §Local mode` for the
#   honest capability degradation — a local macOS run CANNOT validate the sandbox/jail oracles.
#
# Everything below is mode-agnostic at the call site: a script sources this, calls `rig_defaults`,
# and then uses `remote_root` / `rig_port_listening` / `rig_epoch` / `rig_daemon_pid` without
# branching. Only the genuinely mode-shaped steps (deploy, systemd, sudo) branch on `rig_is_local`.

# The active mode, defaulted + validated. Any value other than remote|local is a hard error rather
# than a silent fallback to remote — a typo must not silently aim a "local" run at the VPS.
rig_mode() {
  case "${RIG_MODE:-remote}" in
  remote | local) printf '%s' "${RIG_MODE:-remote}" ;;
  *)
    echo "RIG_MODE must be 'remote' or 'local' (got '${RIG_MODE}')" >&2
    printf 'invalid'
    return 2
    ;;
  esac
}

rig_is_local() { [ "$(rig_mode)" = "local" ]; }

# A one-line banner every entry-point prints, so a transcript never leaves the reader guessing
# WHICH rig a result came from (a remote green misread as local — or worse — is a false result).
rig_banner() {
  if rig_is_local; then
    printf 'rig: LOCAL (%s, data=%s)\n' "$(hostname -s 2>/dev/null || echo this-machine)" "${DATA:-?}"
  else
    printf 'rig: REMOTE (%s, data=%s)\n' "${VPS:-?}" "${DATA:-?}"
  fi
}

# Return only actionable startup failures appended after the caller's console-log checkpoint. A Node
# crash can print enough stack frames to push the useful FATAL line beyond a short tail, while an
# unscoped grep can report a failure from an earlier launch of the same isolated rig.
rig_actionable_boot_failure() {
  local _console_log="${1:-}"
  local _prior_lines="${2:-0}"
  [ -f "$_console_log" ] || return 0
  case "$_prior_lines" in
  "" | *[!0-9]*) _prior_lines=0 ;;
  esac
  tail -n "+$((_prior_lines + 1))" "$_console_log" 2>/dev/null \
    | grep -aE '(^FATAL:|"level":(50|60),)' \
    | tail -3
}

# Discard only an obsolete remote-layout block after a caller has selected local mode. This runs
# before the rendered rig env is sourced so its isolated DATA/GW_PORT values can fill the gap left
# by the discarded block. Running the same cleanup only inside rig_defaults() is too late: defaults
# would select ~/.comis and a bare local-up would repoint the operator's everyday install.
rig_drop_leaked_remote_layout() {
  local _drop_scope="${1:-paths}"
  if rig_is_local; then
    # A `.live-env` written before RIG_MODE existed assigns the REMOTE layout unconditionally, and
    # the default-assigns below would then KEEP it — silently pointing a "local" run at
    # /home/comis paths that do not exist on this machine (the wrong-rig false result this kit
    # exists to prevent, in its most confusing form: every probe fails for the wrong reason). The
    # remote layout is one group, so detect it by its anchor. Drop only values that actually
    # belong to that leaked home/root layout: an explicit DATA=/tmp/isolated-rig override must
    # survive even when the same .live-env supplied a stale COMIS_HOME.
    if [ -n "${COMIS_HOME:-}" ] && [ ! -d "${COMIS_HOME}" ]; then
      _leaked_comis_home="$COMIS_HOME"
      echo "rig: RIG_MODE=local but COMIS_HOME=$COMIS_HOME does not exist here — ignoring the" >&2
      echo "     remote topology from .live-env (service, data, package, emulator, and RPC paths). Wrap that" >&2
      echo "     block in 'if [ \"\${RIG_MODE:-remote}\" = remote ]; then … fi', or set them inline." >&2
      if [ "$_drop_scope" = "all" ]; then
        unset COMIS_USER COMIS_HOME COMIS_DATA_DIR COMIS_CONFIG_PATHS COMIS_TRAJECTORY_DIR
        unset DATA PKG SERVICE GW_PORT KIT_DIR RIG_ENV GWTOKEN
        unset EMU_DIR EMU_JSON EMU_LOG EMU_TMUX_SESSION
        unset LOCAL_SUPERVISOR LOCAL_TMUX_SESSION LOCAL_DAEMON_PID_FILE
        unset _leaked_comis_home
        return 0
      fi
      case "${DATA:-}" in
      "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset DATA ;;
      esac
      case "${PKG:-}" in
      "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset PKG ;;
      esac
      case "${EMU_DIR:-}" in
      /root | /root/* | "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset EMU_DIR ;;
      esac
      case "${KIT_DIR:-}" in
      /root | /root/* | "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset KIT_DIR ;;
      esac
      case "${RIG_ENV:-}" in
      /root | /root/* | "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset RIG_ENV ;;
      esac
      case "${EMU_JSON:-}" in
      /tmp/*-emu.json | /tmp/comis-emu.json | /root/* | "$_leaked_comis_home"/*) unset EMU_JSON ;;
      esac
      case "${EMU_LOG:-}" in
      /root | /root/* | "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset EMU_LOG ;;
      esac
      [ "${EMU_TMUX_SESSION:-}" = "emu" ] && unset EMU_TMUX_SESSION
      # 4766 is the shared default carried by the obsolete remote block. A non-default value may
      # be an explicit local override and must survive just like an explicit isolated DATA path.
      [ "${GW_PORT:-}" = "4766" ] && unset GW_PORT
      [ "${COMIS_USER:-}" = "comis" ] && unset COMIS_USER
      unset COMIS_HOME _leaked_comis_home
    fi
  fi
}

# Load the first rendered rig env after determining its persisted mode.
# A pre-RIG_MODE .live-env is the exceptional case: its nonexistent remote home is removed before
# the rendered local file is sourced, allowing the last selected isolated rig to be reused safely.
rig_load_persisted_env() {
  local _rig_env_file=""
  local _rig_mode_line=""
  for _candidate in "$@"; do
    if [ -n "$_candidate" ] && [ -f "$_candidate" ]; then
      _rig_env_file="$_candidate"
      break
    fi
  done

  if [ -z "${RIG_MODE:-}" ] && [ -n "$_rig_env_file" ]; then
    _rig_mode_line="$(grep -E '^(export[[:space:]]+)?RIG_MODE=' "$_rig_env_file" 2>/dev/null | head -1)"
    case "$_rig_mode_line" in
    *local*) RIG_MODE=local ;;
    *remote*) RIG_MODE=remote ;;
    esac
    [ -n "${RIG_MODE:-}" ] && export RIG_MODE
  fi

  rig_drop_leaked_remote_layout
  if [ -n "$_rig_env_file" ]; then
    # shellcheck disable=SC1090 # the rig env path is selected at run time
    . "$_rig_env_file"
    rig_drop_leaked_remote_layout all
  fi
  [ "${RIG_LOAD_DEFER_DEFAULTS:-0}" = "1" ] || rig_defaults
}

rig_load_env() {
  local _live_env="${1:-}"
  shift || true
  local _key=""
  local _index=0
  local _explicit_data=0
  local _explicit_trajectory=0
  local -a _explicit_keys=()
  local -a _explicit_values=()
  local -a _selected_keys=()
  local -a _selected_values=()
  local _rig_keys="RIG_MODE COMIS_USER COMIS_HOME COMIS_DATA_DIR COMIS_TRAJECTORY_DIR DATA REPO PKG SERVICE GW_PORT CHATID EMU_DIR KIT_DIR RIG_ENV EMU_JSON EMU_LOG EMU_TMUX_SESSION EMU_MESSAGE_ID_STATE_DIR LOCAL_SUPERVISOR LOCAL_TMUX_SESSION LOCAL_DAEMON_PID_FILE NODE_ARGS VPS REMOTE_SUDO GWTOKEN EMU_GROUPS"
  local _explicit_keys_source="$_rig_keys COMIS_CONFIG_PATHS COMIS_CONFIG GW_HOST WH_BASE WH_PATH SKIP_BUILD PROTECT_CONTINUITY_AFTER_RESTART ALLOW_CONTINUITY_WIPE CONTINUITY_SENTINEL WIPE_CRONS"

  for _key in $_explicit_keys_source; do
    if declare -p "$_key" >/dev/null 2>&1; then
      _explicit_keys[_index]="$_key"
      _explicit_values[_index]="${!_key}"
      _index=$((_index + 1))
      [ "$_key" = "DATA" ] && _explicit_data=1
      [ "$_key" = "COMIS_TRAJECTORY_DIR" ] && _explicit_trajectory=1
    fi
  done

  if [ -n "$_live_env" ] && [ -f "$_live_env" ]; then
    # shellcheck disable=SC1090 # the live env path is selected at run time
    . "$_live_env"
    # This source is the only point where every value is known to come from the reusable live file.
    # Drop the entire remote topology here; explicit one-run overrides are restored immediately below.
    rig_drop_leaked_remote_layout all
  fi
  for ((_index = 0; _index < ${#_explicit_keys[@]}; _index++)); do
    export "${_explicit_keys[_index]}=${_explicit_values[_index]}"
  done

  _index=0
  for _key in $_rig_keys; do
    if declare -p "$_key" >/dev/null 2>&1; then
      _selected_keys[_index]="$_key"
      _selected_values[_index]="${!_key}"
      _index=$((_index + 1))
    fi
  done

  RIG_LOAD_DEFER_DEFAULTS=1 rig_load_persisted_env "${RIG_ENV:-}" "$@"
  for ((_index = 0; _index < ${#_selected_keys[@]}; _index++)); do
    export "${_selected_keys[_index]}=${_selected_values[_index]}"
  done
  for ((_index = 0; _index < ${#_explicit_keys[@]}; _index++)); do
    export "${_explicit_keys[_index]}=${_explicit_values[_index]}"
  done
  if rig_is_local && [ "$_explicit_data" = 1 ] && [ "$_explicit_trajectory" = 0 ]; then
    COMIS_TRAJECTORY_DIR="$DATA/trajectories"
    export COMIS_TRAJECTORY_DIR
  fi
  rig_defaults
}

# Per-mode defaults for every rig value. Explicit env / .live-env still wins (`:=` default-assign),
# so a run can override any single value without editing a file.
rig_defaults() {
  # ABORT on an invalid mode — do not merely complain. `rig_mode` can only *report* the error (it is
  # called inside `$( )`, so an exit there dies in the subshell), and `rig_is_local` then reads false,
  # which would send a run typo'd as "loca"/"vps" straight at the REMOTE box. This function is called
  # at the top level of every entry point, so exiting here actually stops the script.
  case "${RIG_MODE:-remote}" in
  remote | local) ;;
  *)
    echo "RIG_MODE must be 'remote' or 'local' (got '${RIG_MODE}') — refusing to run: a typo here" >&2
    echo "would aim this run at the REMOTE rig." >&2
    exit 2
    ;;
  esac
  rig_drop_leaked_remote_layout
  if rig_is_local; then
    : "${COMIS_USER:=$(id -un)}"
    : "${COMIS_HOME:=$HOME}"
    : "${DATA:=$HOME/.comis}"
    : "${REPO:=$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
    # In local mode the "installed package" IS the checkout — the source layout `_rig.mjs` detects.
    : "${PKG:=$REPO}"
    : "${SERVICE:=comis}"
    : "${GW_PORT:=4766}"
    : "${COMIS_TRAJECTORY_DIR:=$DATA/trajectories}"
    : "${CHATID:=678314278}"
    # No rsync: the emulator runs straight out of the checkout.
    : "${EMU_DIR:=$REPO}"
    # KIT_DIR is the directory THIS file lives in, by definition — never REPO + a hardcoded
    # suffix. `REPO` above falls back to `pwd` when `git rev-parse` fails (a deployed kit, or a
    # service user who cannot read the checkout), so appending the in-repo path produced a
    # DOUBLED path like `<…>/self-driving/scripts/test/live/self-driving/scripts/.rig-env` and
    # rig-doctor then reported a missing rig-env at a path that cannot exist. Deriving it from
    # BASH_SOURCE is correct in both layouts: the checkout and a deployed copy.
    : "${KIT_DIR:=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
    : "${RIG_ENV:=$KIT_DIR/.rig-env}"
    : "${EMU_JSON:=$DATA/emulator-wiring.json}"
    : "${EMU_LOG:=$DATA/emulator.log}"
    : "${EMU_TMUX_SESSION:=emu-${SERVICE}}"
    : "${EMU_MESSAGE_ID_STATE_DIR:=$DATA/emulator-message-id-state}"
    : "${LOCAL_SUPERVISOR:=auto}"
  else
    : "${COMIS_USER:=comis}"
    : "${COMIS_HOME:=/home/$COMIS_USER}"
    : "${DATA:=$COMIS_HOME/.comis}"
    : "${PKG:=$COMIS_HOME/.npm-global/lib/node_modules/comisai}"
    : "${SERVICE:=comis}"
    : "${GW_PORT:=4766}"
    : "${CHATID:=678314278}"
    : "${EMU_DIR:=/root/comis-emu}"
    : "${KIT_DIR:=/root}"
    : "${RIG_ENV:=/root/comis-rig.env}"
    : "${EMU_JSON:=/tmp/comis-emu.json}"
    : "${EMU_LOG:=/root/emu.log}"
    : "${EMU_TMUX_SESSION:=emu}"
    : "${EMU_MESSAGE_ID_STATE_DIR:=/var/lib/comis-emu/message-id-state}"
  fi
  export COMIS_USER COMIS_HOME DATA PKG SERVICE GW_PORT CHATID EMU_DIR KIT_DIR RIG_ENV EMU_JSON EMU_LOG EMU_TMUX_SESSION EMU_MESSAGE_ID_STATE_DIR
  [ -n "${REPO:-}" ] && export REPO
  [ -n "${LOCAL_SUPERVISOR:-}" ] && export LOCAL_SUPERVISOR
  [ -n "${COMIS_TRAJECTORY_DIR:-}" ] && export COMIS_TRAJECTORY_DIR
  return 0
}

rig_canonical_path() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const target = path.resolve(process.argv[1]);
    const missing = [];
    let existing = target;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    process.stdout.write(path.resolve(fs.realpathSync.native(existing), ...missing));
  ' "$1"
}

rig_local_trajectory_dir() {
  local _selected="${COMIS_TRAJECTORY_DIR:-${DATA:-}/trajectories}"
  local _canonical=""
  local _canonical_data=""

  if ! rig_is_local; then
    echo "trajectory isolation is a local-rig boundary" >&2
    return 2
  fi
  case "$_selected" in
  /*) ;;
  *)
    echo "COMIS_TRAJECTORY_DIR must be an absolute path inside DATA (got '$_selected')" >&2
    return 2
    ;;
  esac
  case "$_selected" in
  *"'"*)
    echo "COMIS_TRAJECTORY_DIR must not contain a single quote" >&2
    return 2
    ;;
  esac
  _canonical="$(rig_canonical_path "$_selected")" || return 2
  _canonical_data="$(rig_canonical_path "${DATA:-}")" || return 2
  if [ "$_selected" != "$_canonical" ]; then
    echo "COMIS_TRAJECTORY_DIR must be canonical and symlink-free (use '$_canonical')" >&2
    return 2
  fi
  case "$_canonical" in
  "$_canonical_data" | "$_canonical_data"/*)
    printf '%s' "$_canonical"
    ;;
  *)
    echo "COMIS_TRAJECTORY_DIR must stay inside the isolated DATA root '$_canonical_data'" >&2
    return 2
    ;;
  esac
}

rig_assert_isolated_local_selection() {
  local _selected_data="${1:-}"
  local _selected_port="${2:-}"
  local _selected_service="${3:-}"
  local _canonical_data=""
  local _everyday_data=""

  if ! rig_is_local; then
    echo "local-up requires RIG_MODE=local" >&2
    return 2
  fi
  if [ -z "$_selected_data" ] || [ -z "$_selected_port" ] || [ -z "$_selected_service" ]; then
    echo "local-up requires explicit DATA, GW_PORT, and SERVICE values" >&2
    return 2
  fi
  if [ "$DATA" != "$_selected_data" ] || [ "$GW_PORT" != "$_selected_port" ] || [ "$SERVICE" != "$_selected_service" ]; then
    echo "resolved local rig selection does not match the requested DATA, GW_PORT, and SERVICE" >&2
    return 2
  fi
  if [ "${COMIS_DATA_DIR:-}" != "$DATA" ] || [ "${COMIS_CONFIG_PATHS:-}" != "$DATA/config.yaml" ]; then
    echo "COMIS_DATA_DIR and COMIS_CONFIG_PATHS must resolve to the selected DATA root" >&2
    return 2
  fi
  case "$DATA" in
  /*) ;;
  *)
    echo "DATA must be an absolute path (got '$DATA')" >&2
    return 2
    ;;
  esac
  case "$DATA" in
  *"'"*)
    echo "DATA must not contain a single quote" >&2
    return 2
    ;;
  esac
  _canonical_data="$(rig_canonical_path "$DATA")"
  _everyday_data="$(rig_canonical_path "$HOME/.comis")"
  if [ "$DATA" != "$_canonical_data" ]; then
    echo "DATA must be canonical and symlink-free (use '$_canonical_data')" >&2
    return 2
  fi
  case "$_canonical_data" in
  "$_everyday_data" | "$_everyday_data"/*)
    echo "DATA must not be the operator's everyday $HOME/.comis tree" >&2
    return 2
    ;;
  esac
  case "$GW_PORT" in
  '' | *[!0-9]*)
    echo "GW_PORT must be an integer between 1024 and 65535" >&2
    return 2
    ;;
  esac
  if [ "$GW_PORT" -lt 1024 ] || [ "$GW_PORT" -gt 65535 ]; then
    echo "GW_PORT must be an integer between 1024 and 65535" >&2
    return 2
  fi
  case "$SERVICE" in
  comis | '' | *[!A-Za-z0-9_.-]*)
    echo "SERVICE must name a dedicated local rig and must not be 'comis'" >&2
    return 2
    ;;
  esac
  if rig_pm2_has_service && ! rig_pm2_manages; then
    echo "pm2 service '$SERVICE' belongs to a different DATA root; refusing to repoint it" >&2
    return 2
  fi
  if rig_tmux_has_session && ! rig_tmux_manages; then
    echo "tmux session '${LOCAL_TMUX_SESSION:-comis-$SERVICE}' belongs to a different DATA root" >&2
    return 2
  fi
  if rig_port_listening "$GW_PORT" && [ -z "$(rig_daemon_pid)" ]; then
    echo "GW_PORT $GW_PORT is already owned by another process" >&2
    return 2
  fi
  return 0
}

# Refuse a destructive clean restart when a stateful campaign has marked its data root as carrying
# load-bearing continuity. The marker is intentionally durable across daemon restarts and code deploys.
# A caller may override it only when deliberately ending that relationship.
rig_refuse_continuity_wipe() {
  local _data_dir="${1:-${DATA:-}}"
  if [ -z "$_data_dir" ]; then
    echo "cannot check continuity protection without a DATA root" >&2
    return 2
  fi

  local _sentinel="${CONTINUITY_SENTINEL:-$_data_dir/.continuity-protected}"
  if [ -e "$_sentinel" ] && [ "${ALLOW_CONTINUITY_WIPE:-0}" != "1" ]; then
    echo "Refusing clean-restart: $_data_dir is continuity-protected." >&2
    echo "Use restart-daemon.sh for this rig, or use a separate scratch DATA root for clean-slate verification." >&2
    echo "Set ALLOW_CONTINUITY_WIPE=1 only when intentionally ending the relationship." >&2
    return 3
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Portable probes — the three places the box-side payloads were Linux-only.
# ---------------------------------------------------------------------------

# Is <port> being LISTENed on? `ss` (Linux) → `lsof` (macOS/BSD) → `netstat` (last resort).
# A bare `ss -ltn | grep :PORT` is a false negative on macOS, where `ss` does not exist at all.
rig_port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[:.]${port}[[:space:]]"
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  netstat -an 2>/dev/null | grep -qE "[.:]${port}[[:space:]].*LISTEN"
}

# A date string → epoch seconds (0 when unparseable). Delegated to node on purpose: `date -d` is
# GNU-only and the BSD `date -j -f` equivalents need per-format strings AND get the timezone wrong
# on the UTC `"time":"…Z"` stamps in the structured log. `Date.parse` handles both the Pino ISO
# stamp and the `ps -o lstart=` form, identically on both platforms.
rig_epoch() {
  node -e 'const t=Date.parse(process.argv[1]||"");process.stdout.write(String(Number.isFinite(t)?Math.floor(t/1000):0))' "$1" 2>/dev/null || printf '0'
}

# The daemon pid, or empty.
rig_daemon_pid() {
  if rig_is_local; then
    local _pid=""
    local _entry=""
    local _supervisor="${LOCAL_SUPERVISOR:-auto}"
    local _pid_file="${LOCAL_DAEMON_PID_FILE:-${DATA:-}/.local-daemon.pid}"
    local _tmux_session="${LOCAL_TMUX_SESSION:-comis-${SERVICE:-comis}}"
    if [ "$_supervisor" = "pm2" ]; then
      rig_pm2_manages && pm2 pid "${SERVICE:-comis}" 2>/dev/null | head -1
      return 0
    fi
    if [ "$_supervisor" = "auto" ] && rig_pm2_manages; then
      pm2 pid "${SERVICE:-comis}" 2>/dev/null | head -1
      return 0
    fi
    if [ "$_supervisor" = "tmux" ] || { [ "$_supervisor" = "auto" ] && rig_tmux_manages; }; then
      rig_tmux_manages || return 0
      _pid="$(tmux list-panes -t "=$_tmux_session" -F '#{pane_pid}' 2>/dev/null | head -1)"
      _pid="$(pgrep -P "${_pid:-0}" 2>/dev/null | head -1)"
    elif { [ "$_supervisor" = "direct" ] || [ "$_supervisor" = "auto" ]; } && [ -f "$_pid_file" ]; then
      _pid="$(tr -d '[:space:]' <"$_pid_file" 2>/dev/null)"
    fi
    case "$_pid" in
    '' | *[!0-9]*) return 0 ;;
    esac
    _entry="$(rig_daemon_entry)"
    if [ -n "$_entry" ] && kill -0 "$_pid" 2>/dev/null && ps -o command= -p "$_pid" 2>/dev/null | grep -F -- "$_entry" >/dev/null; then
      printf '%s' "$_pid"
    fi
    return 0
  fi
  # Production units commonly exec an absolute Node path (`/usr/bin/node …`),
  # so a `^node` process-name probe reports an active systemd daemon as absent.
  # Prefer the selected unit's authoritative MainPID and validate that it is a
  # daemon process. A campaign may use a small composition wrapper instead of
  # invoking daemon.js directly; accept it only when the readable wrapper
  # imports this rig's daemon distribution. Once systemd resolves the selected
  # unit, fail closed instead of falling through to a sibling daemon's PID.
  # Retain a path-tolerant fallback only for rigs without a resolvable unit.
  if command -v systemctl >/dev/null 2>&1 && [ -n "${SERVICE:-}" ]; then
    local _systemd_pid _systemd_command _systemd_entry
    if ! _systemd_pid="$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)"; then
      _systemd_pid=""
    else
      case "$_systemd_pid" in
      '' | 0 | *[!0-9]*) ;;
      *)
        if kill -0 "$_systemd_pid" 2>/dev/null; then
          _systemd_command="$(ps -o command= -p "$_systemd_pid" 2>/dev/null)"
          if printf '%s\n' "$_systemd_command" | grep -E '(^|/)node .*daemon\.js' >/dev/null; then
            printf '%s' "$_systemd_pid"
            return 0
          fi
          _systemd_entry="$(printf '%s\n' "$_systemd_command" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /\.(mjs|cjs|js)$/) { print $i; exit } }')"
          if [ -n "$_systemd_entry" ] && rig_entry_uses_daemon_dist "$_systemd_entry"; then
            printf '%s' "$_systemd_pid"
            return 0
          fi
        fi
        ;;
      esac
      return 0
    fi
  fi
  pgrep -f '(^|/)node .*daemon\.js' 2>/dev/null | head -1
}

# The selected emulator pid, or empty. The wiring path is scoped per local DATA root, so this never
# returns a sibling rig's emulator merely because its command line also contains `vps-emu`.
rig_emu_pid() {
  local _pid=""
  [ -f "${EMU_JSON:-}" ] || return 0
  _pid="$(node -e '
    try {
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).pid;
      if (Number.isInteger(value) && value > 0) process.stdout.write(String(value));
    } catch {}
  ' "$EMU_JSON" 2>/dev/null)"
  case "$_pid" in
  '' | *[!0-9]*) return 0 ;;
  esac
  if kill -0 "$_pid" 2>/dev/null && ps -o command= -p "$_pid" 2>/dev/null | grep -F -- "vps-emu" >/dev/null; then
    printf '%s' "$_pid"
  fi
}

# Resolve the daemon entrypoint for THIS mode's layout (installed package vs source checkout), so a
# caller never hand-builds either path.
rig_daemon_entry() {
  if [ -f "${PKG:-}/node_modules/@comis/daemon/dist/daemon.js" ]; then
    printf '%s' "${PKG}/node_modules/@comis/daemon/dist/daemon.js"
  elif [ -f "${PKG:-}/packages/daemon/dist/daemon.js" ]; then
    printf '%s' "${PKG}/packages/daemon/dist/daemon.js"
  elif [ -f "${REPO:-}/packages/daemon/dist/daemon.js" ]; then
    printf '%s' "${REPO}/packages/daemon/dist/daemon.js"
  else
    printf ''
  fi
}

# A deployment may start a composition wrapper instead of the daemon entrypoint directly. Accept
# that topology only when the wrapper is a readable file that names the selected package's daemon
# distribution; an unrelated JavaScript entrypoint must still fail the package-coherence gate.
rig_entry_uses_daemon_dist() {
  local _entry="${1:-}" _daemon_entry="" _daemon_dist=""
  [ -f "$_entry" ] || return 1
  _daemon_entry="$(rig_daemon_entry)"
  [ -n "$_daemon_entry" ] || return 1
  _daemon_dist="${_daemon_entry%/*}/"
  grep -F -- "$_daemon_dist" "$_entry" >/dev/null 2>&1
}

# Is pm2 supervising this service right now? Local mode only; decides restart transport.
rig_pm2_has_service() {
  command -v pm2 >/dev/null 2>&1 || return 1
  pm2 jlist 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { process.exit(JSON.parse(s).some(p=>p.name===process.argv[1]) ? 0 : 1); } catch { process.exit(1); }
    });' "${SERVICE:-comis}"
}

rig_pm2_manages() {
  command -v pm2 >/dev/null 2>&1 || return 1
  pm2 jlist 2>/dev/null | node -e '
    const path = require("node:path");
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try {
        const proc=JSON.parse(s).find(p=>p.name===process.argv[1]);
        const env=proc?.pm2_env?.env ?? proc?.pm2_env ?? {};
        const data=env.COMIS_DATA_DIR;
        process.exit(data && path.resolve(data)===path.resolve(process.argv[2]) ? 0 : 1);
      } catch { process.exit(1); }
    });' "${SERVICE:-comis}" "${DATA:-}"
}

rig_tmux_has_session() {
  command -v tmux >/dev/null 2>&1 || return 1
  tmux has-session -t "=${LOCAL_TMUX_SESSION:-comis-${SERVICE:-comis}}" 2>/dev/null
}

rig_tmux_manages() {
  local _owner=""
  rig_tmux_has_session || return 1
  _owner="$(tmux show-environment -t "=${LOCAL_TMUX_SESSION:-comis-${SERVICE:-comis}}" COMIS_LOCAL_DATA_OWNER 2>/dev/null)"
  [ "${_owner#COMIS_LOCAL_DATA_OWNER=}" = "$DATA" ]
}

rig_assert_local_lifecycle_owner() {
  rig_is_local || return 0
  if rig_pm2_has_service && ! rig_pm2_manages; then
    echo "pm2 service '$SERVICE' belongs to a different DATA root; refusing to repoint it" >&2
    return 2
  fi
  if rig_tmux_has_session && ! rig_tmux_manages; then
    echo "tmux session '${LOCAL_TMUX_SESSION:-comis-$SERVICE}' belongs to a different DATA root" >&2
    return 2
  fi
  return 0
}

# Refuse to run a remote-only script in local mode with a message that names the local equivalent,
# instead of failing deep inside on a missing `ssh`/`systemctl`.
rig_remote_only() {
  rig_is_local || return 0
  echo "$(basename "${0:-this script}") is REMOTE-ONLY — it deploys to a VPS, and RIG_MODE=local." >&2
  [ -n "${1:-}" ] && echo "In local mode: $1" >&2
  return 3
}
