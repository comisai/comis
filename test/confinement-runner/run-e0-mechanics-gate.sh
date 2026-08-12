#!/usr/bin/env bash
set -euo pipefail

readonly COMIS_SOURCE=/workspace/comis
readonly DEV_CREW_SOURCE=/workspace/comis-dev-crew
readonly RUNNER_ROOT=/runner
readonly COMIS_COPY="${RUNNER_ROOT}/comis"
readonly MECHANICS_ROOT="${RUNNER_ROOT}/e0-mechanics"
readonly DEV_CREW_COPY="${MECHANICS_ROOT}/go-source"
readonly DEV_CREW_BIN="${MECHANICS_ROOT}/bin"
readonly DEV_CREW_COMMIT="4c6b00e2cfddb5fd86a5ddbc66b740fc95a24501"
readonly LIVE_TEST=test/live/scenarios/capability-service/e0-mechanics.test.ts

if [[ "$(id -u)" -eq 0 || "$(uname -s)" != "Linux" ]]; then
  echo "the deterministic E0 mechanics gate requires an unprivileged Linux runner" >&2
  exit 1
fi
if [[ "$(git -C "${DEV_CREW_SOURCE}" rev-parse HEAD)" != "${DEV_CREW_COMMIT}" ]]; then
  echo "the companion checkout is not at the reviewed E0 mechanics commit" >&2
  exit 1
fi
if [[ -n "$(git -C "${DEV_CREW_SOURCE}" status --porcelain)" ]]; then
  echo "the companion checkout must be clean before the E0 mechanics gate" >&2
  exit 1
fi

rm -rf "${DEV_CREW_COPY}" "${DEV_CREW_BIN}"
mkdir -p "${COMIS_COPY}" "${DEV_CREW_COPY}" "${DEV_CREW_BIN}"

git -C "${DEV_CREW_SOURCE}" archive "${DEV_CREW_COMMIT}" | tar -x -C "${DEV_CREW_COPY}"
for binary in devcrew-service devcrew-mcp devcrew devcrew-report; do
  (cd "${DEV_CREW_COPY}" && go build -trimpath -o "${DEV_CREW_BIN}/${binary}" "./cmd/${binary}")
done

rsync -a --delete \
  --exclude .git \
  --exclude coverage \
  --exclude node_modules \
  "${COMIS_SOURCE}/" "${COMIS_COPY}/"

cd "${COMIS_COPY}"
pnpm install --frozen-lockfile --store-dir "${RUNNER_ROOT}/pnpm-store"
pnpm clean
pnpm build

echo "Running deterministic E0 mechanics against ${DEV_CREW_COMMIT}"
COMIS_E0_MECHANICS=1 \
COMIS_DEV_CREW_COMMIT="${DEV_CREW_COMMIT}" \
COMIS_DEV_CREW_BIN_DIR="${DEV_CREW_BIN}" \
pnpm exec vitest run --config test/live/vitest.config.ts "${LIVE_TEST}" --reporter=verbose --retry=0

echo "E0_MECHANICS_GATE_PASS"
