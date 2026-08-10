#!/usr/bin/env bash
set -euo pipefail

readonly REAL_CODEX=/usr/local/bin/codex
readonly REVIEWED_TOKEN=wave4-reviewed
readonly REPORTER_DIR=/home/comis/.wave4-tools
readonly START_FILE=.wave4-start
readonly SIBLING_FILE=.wave4-sibling.json
readonly EVIDENCE_FILE=.wave4-confinement.json

if [[ "${1:-}" == "--version" && "$#" -eq 1 ]]; then
  exec "${REAL_CODEX}" --version
fi
if [[ "$#" -ne 1 || "${1:-}" != "${REVIEWED_TOKEN}" ]]; then
  echo "wave-four launcher rejected unreviewed arguments" >&2
  exit 2
fi
if [[ ! -x "${REPORTER_DIR}/devcrew-report" || ! -r "${SIBLING_FILE}" ]]; then
  echo "wave-four protected launch inputs are incomplete" >&2
  exit 1
fi

mapfile -t attachments < <(find /run/comis/attachments -maxdepth 1 -type s -name 'attachment-*.sock' -print)
if [[ "${#attachments[@]}" -ne 1 ]]; then
  echo "wave-four launch requires exactly one protected attachment" >&2
  exit 1
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

for _ in $(seq 1 1200); do
  [[ -f "${START_FILE}" ]] && break
  sleep 0.05
done
if [[ ! -f "${START_FILE}" ]]; then
  echo "wave-four concurrent-start barrier timed out" >&2
  exit 1
fi

export CODEX_HOME=/home/comis/.codex
export DEV_CREW_ATTACHMENT="${own_attachment}"
export PATH="${REPORTER_DIR}:${PATH}"
touch .wave4-real-codex-started

readonly bootstrap='This is a live integration worker. Before any task work, run exactly: devcrew-report acknowledge. Then run exactly: devcrew-report brief. Read that pinned brief. Create wave4-artifact.txt containing your task identity from the brief. Report progress with: devcrew-report progress --summary "protected worker active". Report the validation candidate with: devcrew-report candidate-complete --summary "live join candidate" --artifact "worktree:wave4-artifact.txt". Finally run: sleep 300. Do not finish or exit before that sleep is interrupted.'

exec "${REAL_CODEX}" exec --json \
  --strict-config \
  --ignore-user-config \
  --ignore-rules \
  --ephemeral \
  --color never \
  --model "${COMIS_WAVE4_CODEX_MODEL:-gpt-5.5-codex}" \
  --sandbox workspace-write \
  -c 'model_reasoning_effort="high"' \
  --cd "${PWD}" \
  - <<<"${bootstrap}"
