#!/usr/bin/env bash
set -euo pipefail

readonly CODEX_EXECUTABLE=/home/comisdevcrew/worker-tools/bin/codex
readonly CLAUDE_EXECUTABLE=/home/comisdevcrew/worker-tools/bin/claude
readonly SIBLING_BINDING=.e0-sibling.json
readonly OWN_MARKER=.e0-identity
readonly EVIDENCE_FILE=.e0-confinement.json

case "$(basename "$0")" in
  codex-e0-launcher)
    readonly REAL_EXECUTABLE="${CODEX_EXECUTABLE}"
    ;;
  claude-e0-launcher)
    readonly REAL_EXECUTABLE="${CLAUDE_EXECUTABLE}"
    ;;
  *)
    echo "confinement launcher name is not recognized" >&2
    exit 2
    ;;
esac

if [[ "${1:-}" == "--version" && "$#" -eq 1 ]]; then
  exec "${REAL_EXECUTABLE}" "$@"
fi

if [[ ! -r "${SIBLING_BINDING}" || ! -r "${OWN_MARKER}" ]]; then
  echo "confinement probe inputs are incomplete" >&2
  exit 1
fi

mapfile -t attachments < <(find /run/comis/attachments -maxdepth 1 -name 'attachment-*.sock' -print)
if [[ "${#attachments[@]}" -ne 1 || ! -S "${attachments[0]}" ]]; then
  echo "confinement probe requires exactly one protected attachment" >&2
  exit 1
fi

readonly sibling_path="$(jq -er '.siblingPath' "${SIBLING_BINDING}")"
readonly sibling_attachment="$(jq -er '.siblingAttachment' "${SIBLING_BINDING}")"

sibling_read_blocked=false
sibling_write_blocked=false
sibling_attachment_absent=false
own_root_usable=false
own_attachment_usable=false

if ! test -r "${sibling_path}/${OWN_MARKER}"; then sibling_read_blocked=true; fi
if ! touch "${sibling_path}/.e0-cross-write" 2>/dev/null; then sibling_write_blocked=true; fi
if ! test -e "/run/comis/attachments/${sibling_attachment}"; then sibling_attachment_absent=true; fi
if test -r "${OWN_MARKER}" && touch .e0-own-write && rm .e0-own-write; then own_root_usable=true; fi
if test -S "${attachments[0]}"; then own_attachment_usable=true; fi

jq -n \
  --arg executable "${REAL_EXECUTABLE}" \
  --argjson siblingReadBlocked "${sibling_read_blocked}" \
  --argjson siblingWriteBlocked "${sibling_write_blocked}" \
  --argjson siblingAttachmentAbsent "${sibling_attachment_absent}" \
  --argjson ownRootUsable "${own_root_usable}" \
  --argjson ownAttachmentUsable "${own_attachment_usable}" \
  '{executable:$executable,siblingReadBlocked:$siblingReadBlocked,siblingWriteBlocked:$siblingWriteBlocked,siblingAttachmentAbsent:$siblingAttachmentAbsent,ownRootUsable:$ownRootUsable,ownAttachmentUsable:$ownAttachmentUsable}' \
  > "${EVIDENCE_FILE}"

if [[ "${sibling_read_blocked}" != true || "${sibling_write_blocked}" != true ||
      "${sibling_attachment_absent}" != true || "${own_root_usable}" != true ||
      "${own_attachment_usable}" != true ]]; then
  echo "confinement probe failed closed before provider execution" >&2
  exit 1
fi

exec "${REAL_EXECUTABLE}" "$@"
