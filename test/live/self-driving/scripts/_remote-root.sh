#!/usr/bin/env bash
# Shared transport for local live-rig scripts that need a root shell on the target.
#
# REMOTE_SUDO=0: the SSH target is already root.
# REMOTE_SUDO=1: the SSH target is an unprivileged deployment user with passwordless sudo.
#
# The command is SSH metadata while the caller's stdin remains untouched. This lets callers stream
# archives and protected file contents without embedding those bytes in a process argument.

remote_root() {
  if [ "$#" -ne 1 ]; then
    echo "remote_root expects one shell command" >&2
    return 2
  fi
  : "${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"

  local command="$1"
  local quoted
  printf -v quoted '%q' "$command"

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
