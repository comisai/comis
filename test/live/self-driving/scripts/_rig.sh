#!/usr/bin/env bash
# Shared MODE + PORTABILITY layer for the live-rig shell scripts. Source it after `.live-env`.
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
      echo "     remote values from .live-env (COMIS_USER/COMIS_HOME/DATA/PKG/EMU_DIR). Wrap that" >&2
      echo "     block in 'if [ \"\${RIG_MODE:-remote}\" = remote ]; then … fi', or set them inline." >&2
      case "${DATA:-}" in
      "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset DATA ;;
      esac
      case "${PKG:-}" in
      "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset PKG ;;
      esac
      case "${EMU_DIR:-}" in
      /root | /root/* | "$_leaked_comis_home" | "$_leaked_comis_home"/*) unset EMU_DIR ;;
      esac
      [ "${COMIS_USER:-}" = "comis" ] && unset COMIS_USER
      unset COMIS_HOME _leaked_comis_home
    fi
    : "${COMIS_USER:=$(id -un)}"
    : "${COMIS_HOME:=$HOME}"
    : "${DATA:=$HOME/.comis}"
    : "${REPO:=$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
    # In local mode the "installed package" IS the checkout — the source layout `_rig.mjs` detects.
    : "${PKG:=$REPO}"
    : "${SERVICE:=comis}"
    : "${GW_PORT:=4766}"
    : "${CHATID:=678314278}"
    # No rsync: the emulator runs straight out of the checkout.
    : "${EMU_DIR:=$REPO}"
    : "${KIT_DIR:=$REPO/test/live/self-driving/scripts}"
    : "${RIG_ENV:=$KIT_DIR/.rig-env}"
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
  fi
  : "${EMU_JSON:=/tmp/comis-emu.json}"
  export COMIS_USER COMIS_HOME DATA PKG SERVICE GW_PORT CHATID EMU_DIR KIT_DIR RIG_ENV EMU_JSON
  [ -n "${REPO:-}" ] && export REPO
  [ -n "${LOCAL_SUPERVISOR:-}" ] && export LOCAL_SUPERVISOR
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

# The daemon pid, or empty. Anchored at `^node ` so the pattern can never match this script's own
# shell / an ssh or sudo wrapper (the self-match trap that kills the calling shell with `pkill -f`).
rig_daemon_pid() {
  pgrep -f "^node .*daemon\.js" 2>/dev/null | head -1
}

# The emulator pid, or empty. Same anchoring rule.
rig_emu_pid() {
  pgrep -f "^node .*vps-emu" 2>/dev/null | head -1
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

# Is pm2 supervising this service right now? Local mode only; decides restart transport.
rig_pm2_manages() {
  command -v pm2 >/dev/null 2>&1 || return 1
  pm2 jlist 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { process.exit(JSON.parse(s).some(p=>p.name===process.argv[1]) ? 0 : 1); } catch { process.exit(1); }
    });' "${SERVICE:-comis}"
}

# Refuse to run a remote-only script in local mode with a message that names the local equivalent,
# instead of failing deep inside on a missing `ssh`/`systemctl`.
rig_remote_only() {
  rig_is_local || return 0
  echo "$(basename "${0:-this script}") is REMOTE-ONLY — it deploys to a VPS, and RIG_MODE=local." >&2
  [ -n "${1:-}" ] && echo "In local mode: $1" >&2
  return 3
}
