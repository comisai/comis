#!/usr/bin/env bash
#
# CI grep gate — emit-site redaction lock.
#
# THE durable regression lock for tool-param redaction at the producer boundary. Every
# `eventBus.emit("tool:executed", …)` / `eventBus.emit("tool:started", …)` site
# under `packages/*/src/` that forwards a `params` field MUST also call
# `redactValue(...)` in the SAME file — so raw tool params (secrets, message
# bodies, absolute paths) are redacted BEFORE the emit crosses the EventBus and
# no consumer ever holds the raw value.
#
# `tool:timeout` is EXEMPT — it carries no params (verified: events-agent.ts
# tool:timeout declaration has no params field).
#
# A NEW or refactored emit site that forwards raw params without a same-file
# redaction call re-opens the documented `tool-audit.ts:77` leak;
# this gate fails CI on exactly that.
#
# Usage:
#   bash scripts/check-tool-event-redaction.sh                Run; exit 0 on PASS
#   bash scripts/check-tool-event-redaction.sh --self-test    Verify it parses; exit 0
#
set -u   # fail on undefined var; do NOT use -e (we want every check to run)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
TOTAL=0

# Colors (mirrors scripts/docs-grep-checks.sh:21-25).
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
NC=$'\033[0m'

# The two redacting tool-event emit names this gate enforces. `tool:timeout`
# is deliberately absent — it is exempt (carries no params).
EMIT_PATTERN='eventBus\.emit\("tool:(executed|started)"'

# Strip comment lines (// … and leading-* JSDoc) before counting, so a header
# comment mentioning tool:executed / params never satisfies OR breaks the gate
# (the self-invalidating-grep-gate trap). NEVER count an unfiltered file.
strip_comments() {
  grep -v '^[[:space:]]*//' | grep -v '^[[:space:]]*\*'
}

# Enumerate canonical source files (packages/*/src/, NOT node_modules, NOT
# *.test.ts) that emit a redacting tool event. node_modules holds bundled
# copies of the same workspace source — checking them would double-count and
# couple the gate to install state.
#
# Portable array fill (no `mapfile` — keeps the gate working on bash 3.2 / macOS
# dev boxes as well as CI's bash 4+).
EMIT_FILES=()
while IFS= read -r _emit_file; do
  [ -n "$_emit_file" ] && EMIT_FILES+=("$_emit_file")
done < <(
  grep -RlE "$EMIT_PATTERN" "$REPO_ROOT/packages" \
    --include='*.ts' \
    --exclude='*.test.ts' 2>/dev/null \
    | grep -v '/node_modules/' \
    | sort -u
)

# --- Self-test mode -------------------------------------------------------
if [ "${1-}" = "--self-test" ]; then
  echo "  ${GREEN}PASS${NC}: scripts/check-tool-event-redaction.sh parses (self-test)"
  echo "  (run without --self-test to execute the real emit-site redaction checks)"
  exit 0
fi

# check_file_redacts <file>
# For a file that emits tool:executed/tool:started: if it forwards a `params`
# field (comment-filtered), assert it also calls redactValue / redactToolParams
# (comment-filtered). Files that emit but forward no params (e.g. a bare
# lifecycle ping) are not required to redact.
check_file_redacts() {
  local file="$1"
  local rel="${file#"$REPO_ROOT"/}"
  TOTAL=$((TOTAL + 1))

  if [ ! -f "$file" ]; then
    echo "  ${RED}FAIL${NC}: emit-site file vanished mid-run ($rel)"
    FAIL=$((FAIL + 1))
    return
  fi

  # Does the file forward a `params` field at all? (comment-filtered count)
  local params_count
  params_count=$(strip_comments < "$file" | grep -cE 'params\s*[:,]') || params_count=0

  if [ "$params_count" -eq 0 ]; then
    echo "  ${YELLOW}SKIP${NC}: $rel emits a tool event but forwards no params (nothing to redact)"
    PASS=$((PASS + 1))
    return
  fi

  # Forwards params → REQUIRE a same-file redaction call (comment-filtered).
  local redact_count
  redact_count=$(strip_comments < "$file" | grep -cE 'redactValue|redactToolParams') || redact_count=0

  if [ "$redact_count" -ge 1 ]; then
    echo "  ${GREEN}PASS${NC}: $rel forwards params AND calls redactValue ($redact_count call(s))"
    PASS=$((PASS + 1))
  else
    echo "  ${RED}FAIL${NC}: $rel forwards tool-event params with NO redactValue() call in scope -- raw-params leak (SEC-01/02/03, EVT-08) -- $rel"
    FAIL=$((FAIL + 1))
  fi
}

# --- Main checks ----------------------------------------------------------
echo
echo "-- tool-event emit-site redaction gate (EVT-08, §16.1) --"

EMIT_FILE_COUNT="${#EMIT_FILES[@]}"
if [ "$EMIT_FILE_COUNT" -eq 0 ]; then
  # Zero canonical emit sites is itself suspicious (the producers should exist).
  echo "  ${RED}FAIL${NC}: no canonical tool:executed/tool:started emit sites found under packages/*/src -- grep pattern drift?"
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
else
  for f in "${EMIT_FILES[@]}"; do
    check_file_redacts "$f"
  done
fi

# --- Result footer --------------------------------------------------------
echo
echo "-- RESULT --"
echo "  emit-site files checked: ${EMIT_FILE_COUNT}"
echo "  PASS: ${GREEN}${PASS}${NC} / ${TOTAL}"
echo "  FAIL: ${RED}${FAIL}${NC}"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
