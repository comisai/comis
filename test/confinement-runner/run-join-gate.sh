#!/usr/bin/env bash
set -euo pipefail

readonly COMIS_SOURCE=/workspace/comis
readonly DEV_CREW_SOURCE=/workspace/comis-dev-crew
readonly RUNNER_ROOT=/runner
readonly COMIS_COPY="${RUNNER_ROOT}/comis"
readonly JOIN_ROOT="${RUNNER_ROOT}/wave4-join"
readonly DEV_CREW_COPY="${JOIN_ROOT}/go-source"
readonly DEV_CREW_BIN="${JOIN_ROOT}/bin"
readonly DEV_CREW_COMMIT="99dc36691477d8567e696616ec03a0c0f5721511"
readonly LIVE_TEST=test/live/scenarios/capability-service/wave4-join.test.ts

if [[ "$(id -u)" -eq 0 || "$(uname -s)" != "Linux" ]]; then
  echo "the live JOIN gate requires an unprivileged Linux runner" >&2
  exit 1
fi
if [[ "$(git -C "${DEV_CREW_SOURCE}" rev-parse HEAD)" != "${DEV_CREW_COMMIT}" ]]; then
  echo "the companion checkout is not at the reviewed JOIN commit" >&2
  exit 1
fi
if [[ -n "$(git -C "${DEV_CREW_SOURCE}" status --porcelain)" ]]; then
  echo "the companion checkout must be clean before the live JOIN" >&2
  exit 1
fi
if [[ ! -r "${CODEX_HOME}/auth.json" || -w "${CODEX_HOME}/auth.json" ]]; then
  echo "Codex authentication must remain a read-only host mount" >&2
  exit 1
fi

rm -rf "${DEV_CREW_COPY}" "${DEV_CREW_BIN}"
mkdir -p "${COMIS_COPY}" "${DEV_CREW_COPY}" "${DEV_CREW_BIN}" /home/comis/.wave4-tools

# Build only from the reviewed commit object. The mounted checkout supplies the
# object database, but uncommitted files and later working-tree content cannot
# enter the binaries.
git -C "${DEV_CREW_SOURCE}" archive "${DEV_CREW_COMMIT}" | tar -x -C "${DEV_CREW_COPY}"
for binary in devcrew-service devcrew-mcp devcrew devcrew-report; do
  (cd "${DEV_CREW_COPY}" && go build -trimpath -o "${DEV_CREW_BIN}/${binary}" "./cmd/${binary}")
done
install -m 0555 "${DEV_CREW_BIN}/devcrew-report" /home/comis/.wave4-tools/devcrew-report

# Keep Linux dependencies and generated artifacts out of the mounted Comis
# worktree while preserving that mount as the exact source authority.
rsync -a --delete \
  --exclude .git \
  --exclude coverage \
  --exclude node_modules \
  "${COMIS_SOURCE}/" "${COMIS_COPY}/"

cd "${COMIS_COPY}"
pnpm install --frozen-lockfile --store-dir "${RUNNER_ROOT}/pnpm-store"
pnpm clean
pnpm build

echo "Running live wave-four JOIN against ${DEV_CREW_COMMIT}"
COMIS_LIVE=1 \
COMIS_DEV_CREW_COMMIT="${DEV_CREW_COMMIT}" \
COMIS_DEV_CREW_BIN_DIR="${DEV_CREW_BIN}" \
pnpm exec vitest run --config test/live/vitest.config.ts "${LIVE_TEST}" --reporter=verbose --retry=0

echo "WAVE4_JOIN_GATE_PASS"
