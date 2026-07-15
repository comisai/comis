#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/../../../.." && pwd -P)"
PROFILE="$HERE/.live-env"
INSTALLER="$REPO/website/public/install.sh"
DOCKERFILE="$HERE/Dockerfile.production-replay-controller"
CONTROLLER_VOLUME="comis-production-replay-controller-v1"
CONTAINER_NAME="comis-production-replay-controller-$$"
CONTAINER_RUNNING=false

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

portable_mode() {
  stat -c '%a' -- "$1" 2>/dev/null || stat -f '%Lp' -- "$1"
}

portable_uid() {
  stat -c '%u' -- "$1" 2>/dev/null || stat -f '%u' -- "$1"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    shasum -a 256 -- "$1" | awk '{print $1}'
  fi
}

validate_regular_file() {
  local path="$1"
  local label="$2"
  [ ! -L "$path" ] || fail "$label must not be a symlink"
  [ -f "$path" ] || fail "$label must be a regular file"
  [ "$(portable_uid "$path")" = "$(id -u)" ] || fail "$label must be owned by the invoking user"
  local mode
  mode="$(portable_mode "$path")"
  case "$mode" in ''|*[!0-7]*) fail "$label mode is invalid" ;; esac
  [ $((8#$mode & 8#022)) -eq 0 ] || fail "$label must not be group or world writable"
}

for argument in "$@"; do
  case "$argument" in
    "--env"|"--installer") fail "controller input paths are fixed by the container runner" ;;
  esac
done

[ "$#" -gt 0 ] || fail "a production replay controller command is required"
command -v docker >/dev/null 2>&1 || fail "docker is required for the replay controller"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required to build the controller bundle"
docker info >/dev/null 2>&1 || fail "the docker daemon is unavailable"

validate_regular_file "$PROFILE" "controller profile"
[ "$(portable_mode "$PROFILE")" = 600 ] || fail "controller profile mode must be 0600"
validate_regular_file "$INSTALLER" "repository installer"

account_home=""
if command -v getent >/dev/null 2>&1; then
  account_home="$(getent passwd "$(id -u)" 2>/dev/null | awk -F: '{print $6}' || true)"
fi
if [ -z "$account_home" ]; then
  account_home="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
fi
[ -n "$account_home" ] || fail "the invoking account home directory is unavailable"

ssh_config="${COMIS_REPLAY_SSH_CONFIG:-$account_home/.ssh/config}"
known_hosts="${COMIS_REPLAY_KNOWN_HOSTS:-$account_home/.ssh/known_hosts}"
agent_socket="${SSH_AUTH_SOCK:-}"
validate_regular_file "$ssh_config" "controller SSH config"
validate_regular_file "$known_hosts" "controller known-hosts database"
[ -n "$agent_socket" ] || fail "SSH_AUTH_SOCK must name the operator SSH agent"
[ ! -L "$agent_socket" ] || fail "SSH_AUTH_SOCK must not be a symlink"
[ -S "$agent_socket" ] || fail "SSH_AUTH_SOCK must name a Unix socket"
agent_socket="$(realpath "$agent_socket")"
agent_mount_source="$agent_socket"
if [ "$(uname -s)" = Darwin ]; then
  # Docker Desktop exposes the host agent through this VM-owned proxy socket.
  agent_mount_source=/run/host-services/ssh-auth.sock
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/comis-replay-controller.XXXXXXXX")"
chmod 0700 "$scratch"
build_context="$scratch/build"
mount_inputs="$scratch/mounts"
install -d -m 0700 "$build_context" "$mount_inputs" "$mount_inputs/ssh"

cleanup() {
  if [ "$CONTAINER_RUNNING" = true ]; then
    docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
}

forward_signal() {
  docker kill --signal "$1" "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

trap cleanup EXIT
trap 'forward_signal HUP' HUP
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM

pnpm exec esbuild "$HERE/production-replay.ts" \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=esm \
  --outfile="$build_context/controller.mjs" \
  --alias:@comis/shared="$REPO/packages/shared/src/index.ts" >&2

controller_sha256="$(sha256_file "$build_context/controller.mjs")"
image_tag="comis-production-replay-controller:$controller_sha256"
image_id="$(docker build --quiet \
  --build-arg "CONTROLLER_SHA256=$controller_sha256" \
  --tag "$image_tag" \
  --file "$DOCKERFILE" \
  "$build_context")"
[ -n "$image_id" ] || fail "controller image build returned no image identity"
docker volume create "$CONTROLLER_VOLUME" >/dev/null

install -m 0600 "$PROFILE" "$mount_inputs/profile.env"
install -m 0555 "$INSTALLER" "$mount_inputs/install.sh"
install -m 0600 "$ssh_config" "$mount_inputs/ssh/config"
install -m 0600 "$known_hosts" "$mount_inputs/ssh/known_hosts"
cmp -s "$PROFILE" "$mount_inputs/profile.env" || fail "controller profile changed during staging"
cmp -s "$INSTALLER" "$mount_inputs/install.sh" || fail "repository installer changed during staging"
cmp -s "$ssh_config" "$mount_inputs/ssh/config" || fail "SSH config changed during staging"
cmp -s "$known_hosts" "$mount_inputs/ssh/known_hosts" || fail "known-hosts database changed during staging"
chmod 0600 "$mount_inputs/profile.env" "$mount_inputs/ssh/config" "$mount_inputs/ssh/known_hosts"

CONTAINER_RUNNING=true
docker run --rm \
  --name="$CONTAINER_NAME" \
  --init \
  --network=bridge \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --pids-limit=128 \
  --memory=1073741824 \
  --user=65532:65532 \
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,mode=0700,size=67108864 \
  --volume="$CONTROLLER_VOLUME:/var/lib/comis-replay-controller" \
  --volume="$mount_inputs/profile.env:/controller/profile.env:ro" \
  --volume="$mount_inputs/install.sh:/controller/install.sh:ro" \
  --volume="$mount_inputs/ssh/config:/home/comis-replay-controller/.ssh/config:ro" \
  --volume="$mount_inputs/ssh/known_hosts:/home/comis-replay-controller/.ssh/known_hosts:ro" \
  --volume="$agent_mount_source:/run/comis-replay-controller/ssh-agent.sock" \
  --env=SSH_AUTH_SOCK=/run/comis-replay-controller/ssh-agent.sock \
  "$image_id" \
  "$@" \
  --env /controller/profile.env \
  --installer /controller/install.sh &
docker_pid="$!"

while true; do
  set +e
  wait "$docker_pid"
  exit_code=$?
  set -e
  if kill -0 "$docker_pid" 2>/dev/null; then
    continue
  fi
  break
done
CONTAINER_RUNNING=false
exit "$exit_code"
