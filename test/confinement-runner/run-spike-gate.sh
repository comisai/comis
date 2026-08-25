#!/usr/bin/env bash
set -euo pipefail

readonly COMIS_SOURCE=/workspace/comis
readonly DEV_CREW_SOURCE=/workspace/comis-dev-crew
readonly RUNNER_ROOT=/runner
readonly COMIS_COPY="${RUNNER_ROOT}/comis"
readonly DEV_CREW_COPY="${RUNNER_ROOT}/comis-dev-crew"
readonly WAVE_FOUR_TEST=packages/skills/src/tools/builtin/terminal-driver/terminal-worker-fork.linux.test.ts

if ! test "$(id -u)" -ne 0; then
  echo "confinement spike refuses to run as root" >&2
  exit 1
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "confinement spike requires Linux" >&2
  exit 1
fi
if [[ ! -d "${COMIS_SOURCE}/packages" || ! -d "${DEV_CREW_SOURCE}/internal" ]]; then
  echo "both committed source authorities must be mounted at their fixed paths" >&2
  exit 1
fi
if [[ ! -r "${CODEX_HOME}/auth.json" || -w "${CODEX_HOME}/auth.json" ]]; then
  echo "Codex authentication must be readable through a read-only file mount" >&2
  exit 1
fi

echo "Toolchain: node $(node --version), pnpm $(pnpm --version), $(go version), $(tmux -V), $(bwrap --version), $(codex --version)"

# This is a real kernel-boundary probe, not a binary-exists check. Only the
# leased directory is bound into the child; the sibling marker must be absent.
leased_probe="$(mktemp -d)"
sibling_probe="$(mktemp -d)"
cleanup_probe() {
  rm -rf "${leased_probe}" "${sibling_probe}"
}
trap cleanup_probe EXIT
printf '%s\n' LEASE > "${leased_probe}/marker"
printf '%s\n' SIBLING > "${sibling_probe}/marker"
bwrap --unshare-all \
  --share-net \
  --die-with-parent \
  --ro-bind /usr /usr \
  --symlink usr/bin /bin \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --dir /workspace \
  --bind "${leased_probe}" /workspace \
  --chdir /workspace \
  /usr/bin/bash -c \
    'test "$(cat marker)" = LEASE; test ! -e "$1"; echo BWRAP_CONFINEMENT_OK' \
    probe "${sibling_probe}/marker"
cleanup_probe
trap - EXIT

# Keep Linux-native dependencies and generated output inside the container.
# The fixed source mounts remain the exact authorities without replacing the
# host's Darwin node_modules or writing generated artifacts into either repo.
mkdir -p "${COMIS_COPY}" "${DEV_CREW_COPY}"
rsync -a --delete \
  --exclude .git \
  --exclude coverage \
  --exclude node_modules \
  "${COMIS_SOURCE}/" "${COMIS_COPY}/"
rsync -a --delete \
  --exclude .git \
  --exclude coverage \
  "${DEV_CREW_SOURCE}/" "${DEV_CREW_COPY}/"

cd "${COMIS_COPY}"
pnpm install --frozen-lockfile --store-dir "${RUNNER_ROOT}/pnpm-store"
pnpm clean
pnpm build

mapfile -d '' linux_tests < <(
  find packages test -type f -name '*.linux.test.ts' ! -path "./${WAVE_FOUR_TEST}" -print0 \
    | sort -z
)
if [[ ! -f "${WAVE_FOUR_TEST}" || "${#linux_tests[@]}" -eq 0 ]]; then
  echo "the Linux spike suites are incomplete" >&2
  exit 1
fi

echo "Running wave-four separate-process isolation proof"
pnpm exec vitest run "${WAVE_FOUR_TEST}" --reporter=verbose

echo "Running ${#linux_tests[@]} remaining Linux isolation test files"
pnpm exec vitest run "${linux_tests[@]}" --reporter=verbose

echo "CONFINEMENT_SPIKE_GATE_PASS"
