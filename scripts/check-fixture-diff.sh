#!/usr/bin/env bash
#
# CI gate — golden-fixture undeclared-diff lock.
#
# Golden fixtures under `packages/channels/src/__tests__/__fixtures__/**/*.expected.json`
# pin the canonical recorded render stream. The contract: changing a fixture requires
# a separate commit with reviewer signoff, and CI fails on an undeclared diff. A fixture
# that changes in the SAME diff as a renderer `*-activity.ts` is the dangerous
# case — the renderer change could silently re-bless a wrong fixture (the
# self-heal trap `toMatchSnapshot` would allow; this gate is the producer-side
# lock that `toEqual` alone cannot enforce across commits).
#
# This gate FAILS (exit 1) when BOTH a MODIFIED fixture `*.expected.json` and a
# renderer `*-activity.ts` change in the compared range, UNLESS the change is
# declared via a `FIXTURE-DIFF-APPROVED` marker (a commit-message trailer in the
# range, or the env var FIXTURE_DIFF_APPROVED=1 set by a reviewer-signoff CI step).
#
# Only MODIFIED fixtures (git status M) are correlated — the lock targets *changing* an
# existing fixture, which is the self-heal/re-bless danger. A NET-NEW fixture
# (status A) born alongside its renderer in the same PR is legitimate initial
# creation, not a re-bless, and passes. A fixture-only change (no renderer) or a
# renderer-only change (no fixture) also passes.
#
# Compared range: ${BASE_REF:-origin/main}..HEAD (the PR merge target). Falls back
# to the working-tree+staged diff when the base ref is unavailable (local runs).
#
# Usage:
#   bash scripts/check-fixture-diff.sh                Run the gate; exit 0 on PASS, 1 on FAIL
#   bash scripts/check-fixture-diff.sh --self-test    Verify it parses; exit 0
#
# Portable to bash 3.2 (macOS dev boxes) and bash 4+ (CI): no `mapfile`, no
# associative arrays, no `${var,,}`.
set -u   # fail on undefined var; do NOT use -e (we want every check to run).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors (mirrors scripts/check-tool-event-redaction.sh:31-35).
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
NC=$'\033[0m'

# The two path signals this gate correlates.
FIXTURE_PATTERN='packages/channels/src/__tests__/__fixtures__/.*\.expected\.json$'
RENDERER_PATTERN='packages/channels/src/.*-activity\.ts$'
# The declared-diff marker: a commit-message trailer OR a reviewer-set env var.
APPROVAL_MARKER='FIXTURE-DIFF-APPROVED'

# --- Self-test mode -------------------------------------------------------
if [ "${1-}" = "--self-test" ]; then
  echo "  ${GREEN}PASS${NC}: scripts/check-fixture-diff.sh parses (self-test)"
  echo "  (run without --self-test to execute the real undeclared-fixture-diff check)"
  exit 0
fi

BASE_REF="${BASE_REF:-origin/main}"

# Enumerate changed files in the compared range. Prefer the merge-base range
# (PR semantics); fall back to staged+unstaged working-tree changes when the
# base ref is not resolvable (fresh clone, local dev without the remote).
# All changed files in the range (any status) — used for the renderer signal.
# Modified-only files (status M) — used for the fixture signal (§18.1 locks
# *changes* to existing fixtures, not net-new additions).
CHANGED=""
MODIFIED=""
if git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  RANGE_DESC="${BASE_REF}..HEAD"
  CHANGED="$(git -C "$REPO_ROOT" diff --name-only "${BASE_REF}...HEAD" 2>/dev/null)"
  MODIFIED="$(git -C "$REPO_ROOT" diff --name-only --diff-filter=M "${BASE_REF}...HEAD" 2>/dev/null)"
else
  RANGE_DESC="working tree (staged + unstaged; base ref '${BASE_REF}' unavailable)"
  CHANGED="$(git -C "$REPO_ROOT" diff --name-only HEAD 2>/dev/null)"
  MODIFIED="$(git -C "$REPO_ROOT" diff --name-only --diff-filter=M HEAD 2>/dev/null)"
fi

# node_modules holds bundled copies of workspace source — never correlate them.
CHANGED="$(printf '%s\n' "$CHANGED" | grep -v '/node_modules/' || true)"
MODIFIED="$(printf '%s\n' "$MODIFIED" | grep -v '/node_modules/' || true)"

# Fixtures: only MODIFICATIONS count (a net-new fixture is legitimate creation).
CHANGED_FIXTURES="$(printf '%s\n' "$MODIFIED" | grep -E "$FIXTURE_PATTERN" || true)"
# Renderers: any change (add or modify) in the range is a co-change signal.
CHANGED_RENDERERS="$(printf '%s\n' "$CHANGED" | grep -E "$RENDERER_PATTERN" || true)"

# Is the diff declared? Either a reviewer-set env var, or the marker appears in a
# commit message in the compared range.
APPROVED=0
if [ "${FIXTURE_DIFF_APPROVED:-0}" = "1" ]; then
  APPROVED=1
elif git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE_REF" >/dev/null 2>&1; then
  if git -C "$REPO_ROOT" log --format='%B' "${BASE_REF}..HEAD" 2>/dev/null | grep -q "$APPROVAL_MARKER"; then
    APPROVED=1
  fi
fi

echo
echo "-- golden-fixture undeclared-diff gate (CHAN-05, §18.1) --"
echo "  range: ${RANGE_DESC}"

# A fixture+renderer co-change without the marker is the failure case.
if [ -n "$CHANGED_FIXTURES" ] && [ -n "$CHANGED_RENDERERS" ] && [ "$APPROVED" -eq 0 ]; then
  echo
  echo "  ${RED}FAIL${NC}: golden fixture(s) changed alongside a renderer in the same range"
  echo "  ${RED}without a ${APPROVAL_MARKER} declaration.${NC}"
  echo
  echo "  Changed fixtures:"
  printf '    %s\n' $CHANGED_FIXTURES
  echo "  Changed renderers:"
  printf '    %s\n' $CHANGED_RENDERERS
  echo
  echo "  ${YELLOW}Hint:${NC} Golden-fixture changes need a separate reviewer-signoff commit"
  echo "        — CHAN-05 / §18.1. Either split the fixture change into its own commit,"
  echo "        add a '${APPROVAL_MARKER}' trailer to a commit in this range, or set"
  echo "        FIXTURE_DIFF_APPROVED=1 in the reviewer-gated CI step."
  exit 1
fi

# Otherwise: PASS (fixture-only, renderer-only, no change, or declared).
if [ -n "$CHANGED_FIXTURES" ] && [ -n "$CHANGED_RENDERERS" ]; then
  echo "  ${GREEN}PASS${NC}: fixture+renderer co-change is DECLARED (${APPROVAL_MARKER}) — allowed"
elif [ -n "$CHANGED_FIXTURES" ]; then
  echo "  ${GREEN}PASS${NC}: fixture change with no renderer change in range — allowed"
elif [ -n "$CHANGED_RENDERERS" ]; then
  echo "  ${GREEN}PASS${NC}: renderer change with no fixture change in range — allowed"
else
  echo "  ${GREEN}PASS${NC}: no fixture/renderer changes in range"
fi
exit 0
