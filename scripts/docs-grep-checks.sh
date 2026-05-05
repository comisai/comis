#!/usr/bin/env bash
#
# Comis Documentation Validator (Phase 12)
#
# Encodes every grep assertion from .planning/phases/12-codex-oauth-documentation/12-VALIDATION.md
# Per-Task Verification Map. Runs in <1s and exits 0 only when all SC-12-*
# assertions pass.
#
# Usage:
#   bash scripts/docs-grep-checks.sh                Run all checks; exit 0 on PASS
#   bash scripts/docs-grep-checks.sh --self-test    Verify script parses; exit 0
#
set -u   # fail on undefined var; do NOT use -e (we want every check to run)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCS_DIR="$REPO_ROOT/docs"
PASS=0
FAIL=0
TOTAL=0

# Colors (mirrors test/run-tests.sh:21-25; ANSI-C quoting works with plain `echo`)
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
NC=$'\033[0m'

# --- Helpers --------------------------------------------------------------

# check_grep_min_count <description> <pattern> <file> <expected_min>
# Uses `grep -e -- "$pattern"` so patterns starting with "-" are accepted.
check_grep_min_count() {
  local desc="$1" pattern="$2" file="$3" expected="$4"
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$file" ]; then
    echo "  ${RED}FAIL${NC}: $desc (file not found: $file)"
    FAIL=$((FAIL + 1))
    return
  fi
  local actual
  # `grep -c` exits 1 (and prints "0") when no matches; suppress that exit so
  # `set -u`/the `|| echo` chain doesn't double-print.
  actual=$(grep -cE -e "$pattern" -- "$file" 2>/dev/null) || actual=0
  if [ "$actual" -ge "$expected" ]; then
    echo "  ${GREEN}PASS${NC}: $desc (got $actual, expected >= $expected)"
    PASS=$((PASS + 1))
  else
    echo "  ${RED}FAIL${NC}: $desc (got $actual, expected >= $expected) -- $file"
    FAIL=$((FAIL + 1))
  fi
}

# check_grep_exact_count <description> <pattern> <file> <expected_count>
check_grep_exact_count() {
  local desc="$1" pattern="$2" file="$3" expected="$4"
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$file" ]; then
    echo "  ${RED}FAIL${NC}: $desc (file not found: $file)"
    FAIL=$((FAIL + 1))
    return
  fi
  local actual
  actual=$(grep -cE -e "$pattern" -- "$file" 2>/dev/null) || actual=0
  if [ "$actual" -eq "$expected" ]; then
    echo "  ${GREEN}PASS${NC}: $desc (got $actual, expected = $expected)"
    PASS=$((PASS + 1))
  else
    echo "  ${RED}FAIL${NC}: $desc (got $actual, expected = $expected) -- $file"
    FAIL=$((FAIL + 1))
  fi
}

# check_no_match <description> <pattern> <file>
# Asserts the pattern does NOT appear in the file.
check_no_match() {
  local desc="$1" pattern="$2" file="$3"
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$file" ]; then
    echo "  ${YELLOW}SKIP${NC}: $desc (file not found: $file)"
    return
  fi
  if grep -qE -e "$pattern" -- "$file" 2>/dev/null; then
    echo "  ${RED}FAIL${NC}: $desc (found '$pattern' but expected absent) -- $file"
    FAIL=$((FAIL + 1))
  else
    echo "  ${GREEN}PASS${NC}: $desc (absent as expected)"
    PASS=$((PASS + 1))
  fi
}

# check_min_word_count <description> <file> <expected_min>
check_min_word_count() {
  local desc="$1" file="$2" expected="$3"
  TOTAL=$((TOTAL + 1))
  if [ ! -f "$file" ]; then
    echo "  ${RED}FAIL${NC}: $desc (file not found: $file)"
    FAIL=$((FAIL + 1))
    return
  fi
  local actual
  actual=$(wc -w < "$file" | tr -d ' ')
  if [ "$actual" -ge "$expected" ]; then
    echo "  ${GREEN}PASS${NC}: $desc (got $actual words, expected >= $expected)"
    PASS=$((PASS + 1))
  else
    echo "  ${RED}FAIL${NC}: $desc (got $actual words, expected >= $expected) -- $file"
    FAIL=$((FAIL + 1))
  fi
}

# check_oq1_invariant — either docs/operations/proxy.mdx exists OR
# packages/agent/src/model/oauth-errors.ts no longer cites it.
check_oq1_invariant() {
  TOTAL=$((TOTAL + 1))
  local proxy_doc="$DOCS_DIR/operations/proxy.mdx"
  local errors_ts="$REPO_ROOT/packages/agent/src/model/oauth-errors.ts"
  local cites=0
  if [ -f "$errors_ts" ]; then
    cites=$(grep -c "docs/operations/proxy" "$errors_ts" 2>/dev/null) || cites=0
  fi
  if [ -f "$proxy_doc" ] || [ "$cites" -eq 0 ]; then
    echo "  ${GREEN}PASS${NC}: OQ-1 invariant (proxy.mdx exists OR oauth-errors.ts citation removed)"
    PASS=$((PASS + 1))
  else
    echo "  ${RED}FAIL${NC}: OQ-1 invariant violated (proxy.mdx missing AND oauth-errors.ts still cites it)"
    FAIL=$((FAIL + 1))
  fi
}

# --- Self-test mode -------------------------------------------------------
# Verifies the script parses and the helpers exist. Does NOT run docs
# assertions (Wave 0 ships before any docs are written).
if [ "${1-}" = "--self-test" ]; then
  echo "  ${GREEN}PASS${NC}: scripts/docs-grep-checks.sh parses (self-test)"
  echo "  (run without --self-test to execute real docs assertions)"
  exit 0
fi

# --- Main checks (encode every VALIDATION.md row) -------------------------

echo
echo "-- SC-12-1: comis auth commands documented (cli.mdx) --"
check_grep_min_count "comis auth section header" '^### `comis auth`' "$DOCS_DIR/reference/cli.mdx" 1
check_grep_min_count "auth subcommands (login/list/logout/status)" '^#### `auth (login|list|logout|status)`' "$DOCS_DIR/reference/cli.mdx" 4
check_grep_min_count "--profile flag in auth section" '\-\-profile' "$DOCS_DIR/reference/cli.mdx" 1
check_grep_min_count "--method device-code flag" '\-\-method device-code' "$DOCS_DIR/reference/cli.mdx" 1

echo
echo "-- SC-12-6: comis init non-interactive rejection (cli.mdx) --"
check_grep_min_count "openai-codex rejection message" 'openai-codex requires interactive login|\-\-non-interactive \-\-provider openai-codex' "$DOCS_DIR/reference/cli.mdx" 1

echo
echo "-- Cross-cut: cli.mdx counters bumped --"
check_grep_exact_count "20 command groups present" '20 command groups' "$DOCS_DIR/reference/cli.mdx" 1
check_no_match        "no '19 command groups' lingering" '19 command groups' "$DOCS_DIR/reference/cli.mdx"
check_grep_min_count  "six categories (doctor)" 'six categories' "$DOCS_DIR/reference/cli.mdx" 1
check_no_match        "no 'five categories' lingering" 'five categories' "$DOCS_DIR/reference/cli.mdx"
check_grep_min_count  "doctor OAuth checks documented" 'doctor.*[Oo]auth|OAuth.*[Ee]xpir|--refresh-test' "$DOCS_DIR/reference/cli.mdx" 1

echo
echo "-- SC-12-2: oauth.storage in config-yaml.mdx --"
check_grep_min_count "oauth section in config-yaml" 'oauth\.storage|^### `oauth`|<Accordion title="oauth"' "$DOCS_DIR/reference/config-yaml.mdx" 1
check_grep_min_count "both file/encrypted options" '"file"|"encrypted"' "$DOCS_DIR/reference/config-yaml.mdx" 2
check_grep_min_count "agents.X.oauthProfiles row" 'oauthProfiles' "$DOCS_DIR/reference/config-yaml.mdx" 1

echo
echo "-- env-var bootstrap (environment-variables.mdx) --"
check_grep_min_count "OAUTH_OPENAI_CODEX entry" 'OAUTH_OPENAI_CODEX' "$DOCS_DIR/reference/environment-variables.mdx" 1
check_grep_min_count "precedence rule documented" 'stored profile wins|one-time seed|WARN.*drift' "$DOCS_DIR/reference/environment-variables.mdx" 1

echo
echo "-- secret-manager port distinction --"
check_grep_min_count "OAuthCredentialStorePort mentioned" 'OAuthCredentialStorePort' "$DOCS_DIR/reference/secret-manager.mdx" 1
check_grep_min_count "cross-link to /security/oauth" '/security/oauth' "$DOCS_DIR/reference/secret-manager.mdx" 1

echo
echo "-- SC-12-4: OAuth credential storage (secrets.mdx) --"
check_grep_min_count "OAuth credential storage section" '^## OAuth credential storage|^### OAuth credential storage|^## OAuth Credential Storage|^### OAuth Credential Storage' "$DOCS_DIR/security/secrets.mdx" 1
check_grep_exact_count "T-OAUTH-DISK-EXFIL ID" 'T-OAUTH-DISK-EXFIL' "$DOCS_DIR/security/secrets.mdx" 1
check_grep_exact_count "T-OAUTH-REFRESH-RACE ID" 'T-OAUTH-REFRESH-RACE' "$DOCS_DIR/security/secrets.mdx" 1
check_grep_exact_count "T-OAUTH-ENV-DRIFT ID" 'T-OAUTH-ENV-DRIFT' "$DOCS_DIR/security/secrets.mdx" 1
check_grep_min_count "0o600 perms documented" '0o600|AES-256-GCM' "$DOCS_DIR/security/secrets.mdx" 2
check_grep_min_count "email semi-redaction documented" 'semi-redact|redact.*email' "$DOCS_DIR/security/secrets.mdx" 1

echo
echo "-- security/index.mdx links to oauth.mdx --"
check_grep_min_count "security index links OAuth card" '/security/oauth' "$DOCS_DIR/security/index.mdx" 1

echo
echo "-- SC-12-5: quickstart wizard 4-option picker --"
check_grep_min_count "Browser (auto-open) label" 'Browser \(auto-open\)' "$DOCS_DIR/get-started/quickstart.mdx" 1
check_grep_min_count "Browser (manual paste) label" 'Browser \(manual paste\)' "$DOCS_DIR/get-started/quickstart.mdx" 1
check_grep_min_count "Device code (phone) label" 'Device code \(phone\)' "$DOCS_DIR/get-started/quickstart.mdx" 1
check_grep_min_count "Skip for now label" 'Skip for now' "$DOCS_DIR/get-started/quickstart.mdx" 1
check_grep_min_count "local desktop vs SSH/VPS guidance" 'local.desktop|SSH|VPS|headless' "$DOCS_DIR/get-started/quickstart.mdx" 2
check_grep_min_count "openai-codex distinction" 'openai-codex' "$DOCS_DIR/get-started/quickstart.mdx" 2

echo
echo "-- install-vps device-code recommendation --"
check_grep_min_count "device-code call-out for headless" 'device.code|--method device-code' "$DOCS_DIR/installation/install-vps.mdx" 1

echo
echo "-- SC-12-3: concepts page (security/oauth.mdx) --"
check_min_word_count "oauth.mdx >= 900 words" "$DOCS_DIR/security/oauth.mdx" 900
check_grep_min_count "oauth.mdx >= 7 H2 sections" '^## ' "$DOCS_DIR/security/oauth.mdx" 7
check_grep_min_count "PKCE flow documented" 'PKCE|verifier|challenge' "$DOCS_DIR/security/oauth.mdx" 3
check_grep_min_count "storage location per setting" 'auth-profiles\.json|oauth_profiles' "$DOCS_DIR/security/oauth.mdx" 2
check_grep_min_count "refresh + 5min buffer + file-locked" '5.?min.?buffer|file.?lock' "$DOCS_DIR/security/oauth.mdx" 1
check_grep_min_count "multi-account profile IDs" 'profile.?ID|<provider>:<identity>|<provider>:<email>' "$DOCS_DIR/security/oauth.mdx" 1
check_grep_min_count "env-var bootstrap precedence" 'OAUTH_OPENAI_CODEX|env.*bootstrap|stored profile wins' "$DOCS_DIR/security/oauth.mdx" 1
check_grep_min_count "ChatGPT-CLI coexistence warning" 'ChatGPT.?CLI|coexistence|Codex CLI' "$DOCS_DIR/security/oauth.mdx" 1
check_grep_min_count "wizard-vs-CLI parity matrix" 'Browser auto-open|Device code|Skip for now|Gateway callback' "$DOCS_DIR/security/oauth.mdx" 4

echo
echo "-- docs.json registers new pages --"
check_grep_min_count "security/oauth registered" '"security/oauth"' "$DOCS_DIR/docs.json" 1

echo
echo "-- OQ-1: forward reference resolved --"
check_oq1_invariant

# --- Result footer --------------------------------------------------------
echo
echo "-- RESULT --"
echo "  PASS: ${GREEN}${PASS}${NC} / ${TOTAL}"
echo "  FAIL: ${RED}${FAIL}${NC}"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
