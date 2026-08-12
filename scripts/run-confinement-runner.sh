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
dev_crew_mount_root="${dev_crew_root}"
dev_crew_scratch=""

cleanup_companion_checkout() {
  if [[ -n "${dev_crew_scratch}" && -d "${dev_crew_scratch}" ]]; then
    rm -rf -- "${dev_crew_scratch}"
  fi
}

trap cleanup_companion_checkout EXIT

if [[ ! -f "${runner_root}/Dockerfile" || ! -x "${runner_root}/run-spike-gate.sh" || ! -x "${runner_root}/run-join-gate.sh" || ! -x "${runner_root}/run-e0-mechanics-gate.sh" || ! -x "${runner_root}/run-e0-journey.sh" ]]; then
  echo "confinement runner files are incomplete or not executable" >&2
  exit 1
fi
if ! git -C "${dev_crew_root}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "COMIS_DEV_CREW_ROOT must name the committed companion checkout" >&2
  exit 1
fi
readonly dev_crew_revision="$(git -C "${dev_crew_root}" rev-parse HEAD)"
if [[ -n "$(git -C "${dev_crew_root}" status --porcelain)" ]]; then
  echo "COMIS_DEV_CREW_ROOT must name a clean companion checkout" >&2
  exit 1
fi
if [[ -f "${dev_crew_root}/.git" ]]; then
  dev_crew_scratch="$(mktemp -d "${TMPDIR:-/tmp}/comis-dev-crew-runner.XXXXXX")"
  dev_crew_mount_root="${dev_crew_scratch}/source"
  git clone --local --no-hardlinks --no-checkout "${dev_crew_root}" "${dev_crew_mount_root}" >/dev/null
  git -C "${dev_crew_mount_root}" checkout --detach "${dev_crew_revision}" >/dev/null
fi
if [[ "${mode}" =~ ^(spike|join|observe|shell)$ && ! -f "${codex_auth_file}" ]]; then
  echo "Codex authentication file is unavailable" >&2
  exit 1
fi
case "${mode}" in
  spike | join | mechanics | observe | shell) ;;
  *)
    echo "usage: $0 [spike|join|mechanics|observe|shell]" >&2
    exit 2
    ;;
esac

echo "Comis authority: $(git -C "${comis_root}" rev-parse HEAD) at ${comis_root}"
echo "DevCrew authority: ${dev_crew_revision} at ${dev_crew_root}"

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
  --mount "type=bind,source=${dev_crew_mount_root},target=/workspace/comis-dev-crew"
)
if [[ "${mode}" =~ ^(spike|join|observe|shell)$ ]]; then
  docker_args+=(--mount "type=bind,source=${codex_auth_file},target=/home/comis/.codex/auth.json,readonly")
fi
docker_args+=(
  --mount type=volume,source=comis-confinement-runner,target=/runner
  --mount type=volume,source=comis-confinement-go-mod,target=/home/comis/go/pkg/mod
  --mount type=volume,source=comis-confinement-go-build,target=/home/comis/.cache/go-build
  --mount type=volume,source=comis-confinement-models,target=/home/comis/.comis/models
  "${runner_image}"
)

if [[ "${mode}" == "shell" ]]; then
  docker "${docker_args[@]}" /bin/bash
  exit
fi
if [[ "${mode}" == "join" ]]; then
  docker "${docker_args[@]}" /bin/bash /workspace/comis/test/confinement-runner/run-join-gate.sh
  exit
fi
if [[ "${mode}" == "mechanics" ]]; then
  docker "${docker_args[@]}" /bin/bash /workspace/comis/test/confinement-runner/run-e0-mechanics-gate.sh
  exit
fi
if [[ "${mode}" == "observe" ]]; then
  docker "${docker_args[@]}" /bin/bash /workspace/comis/test/confinement-runner/run-e0-journey.sh
  exit
fi
docker "${docker_args[@]}" /bin/bash /workspace/comis/test/confinement-runner/run-spike-gate.sh
