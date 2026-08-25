#!/usr/bin/env bash
set -u

readonly REAL_REPORTER="${WAVE4_REAL_REPORTER:-/home/comis/.wave4-tools/devcrew-report}"
readonly REPORTER_LOG="${PWD}/.wave4-reporter.log"
readonly STDERR_FILE="${PWD}/.wave4-reporter-stderr.$$"
readonly CANDIDATE_BARRIER_FILE="${PWD}/.wave4-candidate-barrier"
readonly CANDIDATE_RELEASE_FILE="${PWD}/.wave4-candidate-release"

if [[ "${1:-}" == "candidate-complete" && -f "${CANDIDATE_BARRIER_FILE}" ]]; then
  for _ in $(seq 1 3600); do
    [[ -f "${CANDIDATE_RELEASE_FILE}" ]] && break
    sleep 0.05
  done
  if [[ ! -f "${CANDIDATE_RELEASE_FILE}" ]]; then
    printf '%s\n' "candidate report barrier timed out" >"${STDERR_FILE}"
    reporter_status=1
  fi
fi

if [[ -z "${reporter_status+x}" ]]; then
  set +e
  "${REAL_REPORTER}" "$@" 2>"${STDERR_FILE}"
  reporter_status=$?
  set -e
fi
readonly reporter_status

{
  printf 'command=%s\n' "${1:-<missing>}"
  printf 'exit=%d\n' "${reporter_status}"
  sed 's/^/stderr=/' "${STDERR_FILE}"
} >>"${REPORTER_LOG}"
cat "${STDERR_FILE}" >&2
rm -f "${STDERR_FILE}"
exit "${reporter_status}"
