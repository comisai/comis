#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly comis_root="$(cd -- "${script_dir}/.." && pwd -P)"
readonly runner_root="${comis_root}/test/confinement-runner"
readonly common_git_dir="$(git -C "${comis_root}" rev-parse --path-format=absolute --git-common-dir)"
readonly primary_checkout="$(dirname -- "${common_git_dir}")"
readonly checkout_parent="$(dirname -- "${primary_checkout}")"
readonly dev_crew_root="${COMIS_DEV_CREW_ROOT:-${checkout_parent}/comis-dev-crew}"
readonly codex_auth_file="${COMIS_CODEX_AUTH_FILE:-${CODEX_HOME:-${HOME}/.codex}/auth.json}"
readonly runner_image="${COMIS_CONFINEMENT_IMAGE:-comis-stage4-confinement:node22-go1.26.5-codex0.147.0}"
readonly mode="${1:-spike}"

if [[ ! -f "${runner_root}/Dockerfile" || ! -x "${runner_root}/run-spike-gate.sh" ]]; then
  echo "confinement runner files are incomplete or not executable" >&2
  exit 1
fi
if ! git -C "${dev_crew_root}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "COMIS_DEV_CREW_ROOT must name the committed companion checkout" >&2
  exit 1
fi
if [[ ! -f "${codex_auth_file}" ]]; then
  echo "Codex authentication file is unavailable" >&2
  exit 1
fi
case "${mode}" in
  spike | shell) ;;
  *)
    echo "usage: $0 [spike|shell]" >&2
    exit 2
    ;;
esac

echo "Comis authority: $(git -C "${comis_root}" rev-parse HEAD) at ${comis_root}"
echo "DevCrew authority: $(git -C "${dev_crew_root}" rev-parse HEAD) at ${dev_crew_root}"

if [[ "${COMIS_CONFINEMENT_SKIP_BUILD:-0}" != "1" ]]; then
  docker build \
    --file "${runner_root}/Dockerfile" \
    --tag "${runner_image}" \
    "${comis_root}"
fi

# Docker Desktop's Linux VM rejected a genuine bwrap mount with only
# seccomp/AppArmor relaxation and again with SYS_ADMIN. Its unprivileged comis
# user succeeded only with --privileged. That single broad flag is therefore the
# bounded spike grant: no Docker socket or host root is mounted, the two explicit
# source authorities are the only read-write host mounts, and auth is read-only.
docker_args=(
  run
  --rm
  --privileged
  --network bridge
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=2g
  --mount "type=bind,source=${comis_root},target=/workspace/comis"
  --mount "type=bind,source=${dev_crew_root},target=/workspace/comis-dev-crew"
  --mount "type=bind,source=${codex_auth_file},target=/home/comis/.codex/auth.json,readonly"
  --mount type=volume,source=comis-confinement-runner,target=/runner
  --mount type=volume,source=comis-confinement-go-mod,target=/home/comis/go/pkg/mod
  --mount type=volume,source=comis-confinement-go-build,target=/home/comis/.cache/go-build
  "${runner_image}"
)

if [[ "${mode}" == "shell" ]]; then
  exec docker "${docker_args[@]}" /bin/bash
fi
exec docker "${docker_args[@]}" /bin/bash /workspace/comis/test/confinement-runner/run-spike-gate.sh
