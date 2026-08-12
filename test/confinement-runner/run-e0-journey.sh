#!/usr/bin/env bash
set -euo pipefail

readonly COMIS_SOURCE=/workspace/comis
readonly DEV_CREW_SOURCE=/workspace/comis-dev-crew
readonly RUNNER_ROOT=/runner
readonly COMIS_COPY="${RUNNER_ROOT}/comis"
readonly JOURNEY_ROOT="${RUNNER_ROOT}/e0-journey"
readonly DEV_CREW_COPY="${JOURNEY_ROOT}/go-source"
readonly DEV_CREW_BIN="${JOURNEY_ROOT}/bin"
readonly DEV_CREW_COMMIT="649601716a060da5345512b362fd9e8423e9d218"
readonly LIVE_TEST=test/live/scenarios/capability-service/e0-journey.test.ts

if [[ "$(id -u)" -eq 0 || "$(uname -s)" != "Linux" ]]; then
  echo "the E0 real-Codex journey observation requires an unprivileged Linux runner" >&2
  exit 1
fi
if [[ "$(git -C "${DEV_CREW_SOURCE}" rev-parse HEAD)" != "${DEV_CREW_COMMIT}" ]]; then
  echo "the companion checkout is not at the reviewed E0 observation commit" >&2
  exit 1
fi
if [[ -n "$(git -C "${DEV_CREW_SOURCE}" status --porcelain)" ]]; then
  echo "the companion checkout must be clean before the E0 observation" >&2
  exit 1
fi
if [[ ! -r "${CODEX_HOME}/auth.json" || -w "${CODEX_HOME}/auth.json" ]]; then
  echo "Codex authentication must remain a read-only host mount" >&2
  exit 1
fi

rm -rf "${DEV_CREW_COPY}" "${DEV_CREW_BIN}"
mkdir -p "${COMIS_COPY}" "${DEV_CREW_COPY}" "${DEV_CREW_BIN}" /home/comis/.wave4-tools

git -C "${DEV_CREW_SOURCE}" archive "${DEV_CREW_COMMIT}" | tar -x -C "${DEV_CREW_COPY}"
for binary in devcrew-service devcrew-mcp devcrew devcrew-report; do
  (cd "${DEV_CREW_COPY}" && go build -trimpath -o "${DEV_CREW_BIN}/${binary}" "./cmd/${binary}")
done
mkdir -p "${DEV_CREW_COPY}/cmd/wave4-reporter-client-diagnostic"
cp /usr/local/share/wave4-reporter-client-diagnostic.go \
  "${DEV_CREW_COPY}/cmd/wave4-reporter-client-diagnostic/main.go"
(cd "${DEV_CREW_COPY}" && go build -trimpath \
  -o "${DEV_CREW_BIN}/wave4-reporter-client-diagnostic" \
  ./cmd/wave4-reporter-client-diagnostic)
install -m 0555 "${DEV_CREW_BIN}/devcrew-report" /home/comis/.wave4-tools/devcrew-report
install -m 0555 "${DEV_CREW_BIN}/wave4-reporter-client-diagnostic" \
  /home/comis/.wave4-tools/wave4-reporter-client-diagnostic

rsync -a --delete \
  --exclude .git \
  --exclude coverage \
  --exclude node_modules \
  "${COMIS_SOURCE}/" "${COMIS_COPY}/"

cd "${COMIS_COPY}"
pnpm install --frozen-lockfile --store-dir "${RUNNER_ROOT}/pnpm-store"
pnpm clean
pnpm build

echo "Running non-gating real-Codex E0 journey observation against ${DEV_CREW_COMMIT}"
COMIS_LIVE=1 \
COMIS_E0_OBSERVE=1 \
COMIS_DEV_CREW_COMMIT="${DEV_CREW_COMMIT}" \
COMIS_DEV_CREW_BIN_DIR="${DEV_CREW_BIN}" \
pnpm exec vitest run --config test/live/vitest.config.ts "${LIVE_TEST}" --reporter=verbose --retry=0

echo "E0_CODEX_JOURNEY_OBSERVATION_COMPLETE"
