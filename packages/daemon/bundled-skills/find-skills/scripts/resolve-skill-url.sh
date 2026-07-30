#!/bin/bash

# Resolve an owner/repo@skill-name catalog identifier to the exact GitHub
# directory URL accepted by Comis's skills_manage import action.

set -euo pipefail

CATALOG_ID="${1:-}"
if [[ ! "$CATALOG_ID" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$ ]]; then
  echo "Usage: $0 <owner/repo@skill-name>" >&2
  exit 1
fi

OWNER_REPO="${CATALOG_ID%@*}"
SKILL_NAME="${CATALOG_ID##*@}"
DISCOVERY_DIR=$(mktemp -d "${PWD}/.comis-skill-discovery.XXXXXX")
trap 'rm -rf -- "$DISCOVERY_DIR"' EXIT

git clone --depth 1 --quiet "https://github.com/${OWNER_REPO}.git" "$DISCOVERY_DIR/repo"

SKILL_FILE=""
while IFS= read -r -d '' CANDIDATE; do
  MANIFEST_NAME=$(
    awk '
      NR == 1 && $0 == "---" { in_frontmatter = 1; next }
      in_frontmatter && $0 == "---" { exit }
      in_frontmatter && /^name:[[:space:]]*/ {
        sub(/^name:[[:space:]]*/, "")
        gsub(/^["'\'']|["'\'']$/, "")
        print
        exit
      }
    ' "$CANDIDATE"
  )
  if [[ "$MANIFEST_NAME" == "$SKILL_NAME" ]]; then
    SKILL_FILE="$CANDIDATE"
    break
  fi
done < <(find "$DISCOVERY_DIR/repo" -type f -name SKILL.md -print0)

if [[ -z "$SKILL_FILE" ]]; then
  echo "Skill '${SKILL_NAME}' was not found in ${OWNER_REPO}" >&2
  exit 1
fi

COMMIT=$(git -C "$DISCOVERY_DIR/repo" rev-parse HEAD)
SKILL_DIR=$(dirname "$SKILL_FILE")
RELATIVE_DIR="${SKILL_DIR#"$DISCOVERY_DIR/repo/"}"
if [[ "$RELATIVE_DIR" == "$SKILL_DIR" || -z "$RELATIVE_DIR" ]]; then
  echo "Skill '${SKILL_NAME}' must be stored in a repository directory" >&2
  exit 1
fi

printf 'https://github.com/%s/tree/%s/%s\n' "$OWNER_REPO" "$COMMIT" "$RELATIVE_DIR"
