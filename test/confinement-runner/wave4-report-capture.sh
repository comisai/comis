#!/usr/bin/env bash
set -u

readonly REAL_REPORTER=/home/comis/.wave4-tools/devcrew-report
readonly REPORTER_LOG="${PWD}/.wave4-reporter.log"
readonly STDERR_FILE="${PWD}/.wave4-reporter-stderr.$$"

set +e
"${REAL_REPORTER}" "$@" 2>"${STDERR_FILE}"
readonly reporter_status=$?
set -e

{
  printf 'command=%s\n' "${1:-<missing>}"
  printf 'exit=%d\n' "${reporter_status}"
  sed 's/^/stderr=/' "${STDERR_FILE}"
} >>"${REPORTER_LOG}"
cat "${STDERR_FILE}" >&2
rm -f "${STDERR_FILE}"
exit "${reporter_status}"
