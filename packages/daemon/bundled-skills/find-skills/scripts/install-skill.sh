#!/bin/bash

# Install a skill from GitHub into the Comis shared skills directory.
# Clones the repo, locates the skill by name, and copies it to ~/.comis/skills/.
#
# Usage: ./scripts/install-skill.sh <owner/repo@skill-name>
# Example: ./scripts/install-skill.sh vercel-labs/agent-skills@vercel-react-best-practices

set -e

if [[ -z "$1" ]]; then
  echo "Usage: $0 <owner/repo@skill-name>"
  echo "Example: $0 vercel-labs/agent-skills@vercel-react-best-practices"
  exit 1
fi

FULL_SKILL_NAME="$1"
OWNER_REPO="${FULL_SKILL_NAME%@*}"
SKILL_NAME="${FULL_SKILL_NAME##*@}"

if [[ -z "$SKILL_NAME" || "$SKILL_NAME" == "$FULL_SKILL_NAME" ]]; then
  echo "Error: Invalid skill format. Expected: owner/repo@skill-name"
  exit 1
fi

if [[ -z "$OWNER_REPO" || "$OWNER_REPO" == "$FULL_SKILL_NAME" ]]; then
  echo "Error: Invalid skill format. Expected: owner/repo@skill-name"
  exit 1
fi

COMIS_SKILLS_DIR="${HOME}/.comis/skills"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Cloning ${OWNER_REPO}..."
git clone --depth 1 --quiet "https://github.com/${OWNER_REPO}.git" "$TEMP_DIR/repo"

# Find the skill directory (contains SKILL.md)
SKILL_FILE=$(find "$TEMP_DIR/repo" -type f -name "SKILL.md" -path "*/${SKILL_NAME}/*" | head -1)

if [[ -z "$SKILL_FILE" ]]; then
  echo "Error: Skill '${SKILL_NAME}' not found in ${OWNER_REPO}"
  exit 1
fi

SKILL_DIR=$(dirname "$SKILL_FILE")

# Copy to Comis shared skills directory
mkdir -p "$COMIS_SKILLS_DIR"
if [[ -d "$COMIS_SKILLS_DIR/$SKILL_NAME" ]]; then
  echo "Updating existing skill '${SKILL_NAME}'..."
  rm -rf "$COMIS_SKILLS_DIR/$SKILL_NAME"
fi
cp -r "$SKILL_DIR" "$COMIS_SKILLS_DIR/$SKILL_NAME"

echo "Skill '${SKILL_NAME}' installed to ${COMIS_SKILLS_DIR}/${SKILL_NAME}"
