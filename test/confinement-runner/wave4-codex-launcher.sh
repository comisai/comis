#!/usr/bin/env bash
set -euo pipefail

readonly REAL_CODEX=/usr/local/bin/codex
readonly REVIEWED_TOKEN=wave4-reviewed
readonly REPORTER_DIR=/home/comis/.wave4-tools
readonly START_FILE=.wave4-start
readonly SIBLING_FILE=.wave4-sibling.json
readonly EVIDENCE_FILE=.wave4-confinement.json
readonly LAUNCH_ERROR_FILE=.wave4-launch-error

fail_launch() {
  printf '%s\n' "$1" > "${LAUNCH_ERROR_FILE}"
  echo "$1" >&2
  exit "${2:-1}"
}

if [[ "${1:-}" == "--version" && "$#" -eq 1 ]]; then
  exec "${REAL_CODEX}" --version
fi
if [[ "$#" -ne 1 || "${1:-}" != "${REVIEWED_TOKEN}" ]]; then
  fail_launch "wave-four launcher rejected unreviewed arguments" 2
fi
if [[ ! -x "${REPORTER_DIR}/devcrew-report" || ! -r "${SIBLING_FILE}" ]]; then
  fail_launch "wave-four protected launch inputs are incomplete"
fi

for _ in $(seq 1 1200); do
  [[ -f "${START_FILE}" ]] && break
  sleep 0.05
done
if [[ ! -f "${START_FILE}" ]]; then
  fail_launch "wave-four concurrent-start barrier timed out"
fi

mapfile -t attachments < <(find /run/comis/attachments -maxdepth 1 -name 'attachment-*.sock' -print)
if [[ "${#attachments[@]}" -ne 1 ]]; then
  fail_launch "wave-four launch requires exactly one protected attachment"
fi
if ! test -S "${attachments[0]}"; then
  fail_launch "wave-four protected attachment is not a Unix socket"
fi
readonly own_attachment="${attachments[0]}"
readonly sibling_path="$(jq -er '.siblingPath' "${SIBLING_FILE}")"
readonly sibling_attachment="$(jq -er '.siblingAttachment' "${SIBLING_FILE}")"

sibling_read_blocked=false
sibling_write_blocked=false
sibling_attachment_absent=false
if ! test -r "${sibling_path}/.wave4-identity"; then sibling_read_blocked=true; fi
if ! touch "${sibling_path}/.wave4-cross-write" 2>/dev/null; then sibling_write_blocked=true; fi
if ! test -e "/run/comis/attachments/${sibling_attachment}"; then sibling_attachment_absent=true; fi
jq -n \
  --argjson siblingReadBlocked "${sibling_read_blocked}" \
  --argjson siblingWriteBlocked "${sibling_write_blocked}" \
  --argjson siblingAttachmentAbsent "${sibling_attachment_absent}" \
  '{siblingReadBlocked:$siblingReadBlocked,siblingWriteBlocked:$siblingWriteBlocked,siblingAttachmentAbsent:$siblingAttachmentAbsent}' \
  > "${EVIDENCE_FILE}"

export CODEX_HOME=/home/comis/.codex
export DEV_CREW_ATTACHMENT="${own_attachment}"
export PATH="${REPORTER_DIR}:${PATH}"
touch .wave4-real-codex-started

readonly bootstrap='This is a live integration worker. Before any task work, run exactly: devcrew-report acknowledge. Then run exactly: devcrew-report brief. Read that pinned brief. Create wave4-artifact.txt containing your task identity from the brief. Report progress with: devcrew-report progress --summary "protected worker active". Report the validation candidate with: devcrew-report candidate-complete --summary "live join candidate" --artifact "worktree:wave4-artifact.txt". Finally run: sleep 300. Do not finish or exit before that sleep is interrupted.'

# The enclosing bwrap jail owns confinement and exposes exactly one protected
# attachment. A nested Codex sandbox would deny that authorized Unix socket.
exec "${REAL_CODEX}" exec --json \
  --strict-config \
  --ignore-user-config \
  --ignore-rules \
  --ephemeral \
  --color never \
  --model "${COMIS_WAVE4_CODEX_MODEL:-gpt-5.5}" \
  --sandbox danger-full-access \
  -c 'model_reasoning_effort="high"' \
  --cd "${PWD}" \
  - <<<"${bootstrap}"
