#!/usr/bin/env bash
# Shared transport for local live-rig scripts that need a root shell on the target.
#
# RIG_MODE=remote (default) — the command runs on the SSH target:
#   REMOTE_SUDO=0: the SSH target is already root.
#   REMOTE_SUDO=1: the SSH target is an unprivileged deployment user with passwordless sudo.
#
# RIG_MODE=local — the command runs in a LOCAL shell on this machine. There is no ssh hop and no
#   privilege escalation: the local rig's daemon, data dir and emulator are all owned by the invoking
#   user, so a `sudo` here would be both unnecessary and a real hazard (it would write root-owned
#   files into the caller's own `~/.comis`, the exact EACCES class 01-SETUP §1 exists to prevent).
#   REMOTE_SUDO is therefore IGNORED in local mode rather than honored.
#
# The command is transport metadata while the caller's stdin remains untouched in BOTH modes. This
# lets callers stream archives and protected file contents without embedding those bytes in a
# process argument — the property the tar-streaming deploy paths depend on.

# shellcheck source=./_rig.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_rig.sh"

remote_root() {
  if [ "$#" -ne 1 ]; then
    echo "remote_root expects one shell command" >&2
    return 2
  fi

  local command="$1"
  local quoted
  printf -v quoted '%q' "$command"

  if rig_is_local; then
    # Same contract as the ssh path: the command is metadata, stdin passes straight through.
    bash -c "$command"
    return $?
  fi

  : "${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"

  local remote="bash -c $quoted"
  case "${REMOTE_SUDO:-0}" in
  0) ;;
  1) remote="sudo -n -- $remote" ;;
  *)
    echo "REMOTE_SUDO must be 0 or 1" >&2
    return 2
    ;;
  esac

  ssh \
    -o ConnectTimeout="${REMOTE_CONNECT_TIMEOUT:-20}" \
    -o ServerAliveInterval="${REMOTE_SERVER_ALIVE_INTERVAL:-10}" \
    "$VPS" "$remote"
}
