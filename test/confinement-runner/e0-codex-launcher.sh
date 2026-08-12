#!/usr/bin/env bash
set -euo pipefail

readonly REAL_CODEX=/usr/local/bin/codex
readonly REVIEWED_TOKEN=e0-reviewed
readonly REPORTER_DIR=/home/comis/.wave4-tools
readonly REPORTER_CAPTURE_DIR=/usr/local/lib/wave4
readonly START_FILE=.e0-start
readonly ROLE_FILE=.e0-role
readonly SIBLING_FILE=.e0-sibling.json
readonly EVIDENCE_FILE=.e0-confinement.json

fail_launch() {
  printf '%s\n' "$1" > .e0-launch-error
  echo "$1" >&2
  exit "${2:-1}"
}

if [[ "${1:-}" == "--version" && "$#" -eq 1 ]]; then
  exec "${REAL_CODEX}" --version
fi
if [[ "$#" -ne 1 || "${1:-}" != "${REVIEWED_TOKEN}" ]]; then
  fail_launch "E0 launcher rejected unreviewed arguments" 2
fi
if [[ ! -x "${REPORTER_DIR}/devcrew-report" || ! -r "${ROLE_FILE}" || ! -r "${SIBLING_FILE}" ]]; then
  fail_launch "E0 protected launch inputs are incomplete"
fi

for _ in $(seq 1 1200); do
  [[ -f "${START_FILE}" ]] && break
  sleep 0.05
done
[[ -f "${START_FILE}" ]] || fail_launch "E0 concurrent-start barrier timed out"

mapfile -t attachments < <(find /run/comis/attachments -maxdepth 1 -name 'attachment-*.sock' -print)
[[ "${#attachments[@]}" -eq 1 ]] || fail_launch "E0 launch requires exactly one protected attachment"
test -S "${attachments[0]}" || fail_launch "E0 protected attachment is not a Unix socket"
readonly own_attachment="${attachments[0]}"
readonly sibling_path="$(jq -er '.siblingPath' "${SIBLING_FILE}")"
readonly sibling_attachment="$(jq -er '.siblingAttachment' "${SIBLING_FILE}")"
readonly role="$(tr -d '\r\n' < "${ROLE_FILE}")"
[[ "${role}" == "ship" || "${role}" == "scout" ]] || fail_launch "E0 worker role is invalid"

sibling_read_blocked=false
sibling_write_blocked=false
sibling_attachment_absent=false
if ! test -r "${sibling_path}/.e0-identity"; then sibling_read_blocked=true; fi
if ! touch "${sibling_path}/.e0-cross-write" 2>/dev/null; then sibling_write_blocked=true; fi
if ! test -e "/run/comis/attachments/${sibling_attachment}"; then sibling_attachment_absent=true; fi
jq -n \
  --argjson siblingReadBlocked "${sibling_read_blocked}" \
  --argjson siblingWriteBlocked "${sibling_write_blocked}" \
  --argjson siblingAttachmentAbsent "${sibling_attachment_absent}" \
  '{siblingReadBlocked:$siblingReadBlocked,siblingWriteBlocked:$siblingWriteBlocked,siblingAttachmentAbsent:$siblingAttachmentAbsent}' \
  > "${EVIDENCE_FILE}"

export CODEX_HOME=/home/comis/.codex
export COMIS_EXECUTION_ATTACHMENT="${own_attachment}"
export COMIS_EXECUTION_ATTACHMENT_TARGET_NAME="${own_attachment##*/}"
export PATH="${REPORTER_CAPTURE_DIR}:${REPORTER_DIR}:${PATH}"
touch .e0-real-codex-started

if [[ "${role}" == "ship" ]]; then
  readonly bootstrap='This is the ship worker in a live E0 integration. Run exactly: devcrew-report acknowledge. Then run exactly: devcrew-report brief. Read that pinned brief. Run: devcrew-report progress --summary "ship worker active". Run: devcrew-report decision --key "decision-e0-0001" --question "May the prepared developer intervention proceed?". Then use a shell command to wait until .e0-answer exists. Read .e0-answer. Run: devcrew-report resolved --key "decision-e0-0001" --summary "operator answer received". Run: devcrew-report paused --summary "safe developer intervention point". Finally run: sleep 300. Do not report a candidate and do not exit before the sleep is interrupted.'
else
  readonly bootstrap='This is the scout worker in a live E0 integration. Run exactly: devcrew-report acknowledge. Then run exactly: devcrew-report brief. Read that pinned brief and the already committed report.md. Run: devcrew-report progress --summary "scout worker active". Run: devcrew-report candidate-complete --summary "scout report candidate" --artifact "worktree:report.md". Finally run: sleep 300. Do not modify the repository and do not exit before the sleep is interrupted.'
fi

exec "${REAL_CODEX}" exec --json \
  --strict-config \
  --ignore-user-config \
  --ignore-rules \
  --ephemeral \
  --color never \
  --model "${COMIS_WAVE4_CODEX_MODEL:-gpt-5.5}" \
  --sandbox workspace-write \
  -c 'model_reasoning_effort="high"' \
  -c 'sandbox_workspace_write.network_access=true' \
  --cd "${PWD}" \
  - <<<"${bootstrap}"
