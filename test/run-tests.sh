#!/usr/bin/env bash
#
# Comis Integration Test Runner
#
# Usage: ./test/run-tests.sh
#
# Starts the daemon with test config, runs curl-based tests, and reports results.
# Requires: Node.js 20+, pnpm, built packages (pnpm build)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="$SCRIPT_DIR/config/config.test.yaml"
DAEMON_PID=""
LOG_FILE="$SCRIPT_DIR/.test-daemon.log"
PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Cleanup on exit
cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo -e "\n${YELLOW}Stopping daemon (PID $DAEMON_PID)...${NC}"
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Test assertion helper
assert() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}PASS${NC}: $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC}: $name (expected: $expected, got: $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -q "$expected"; then
    echo -e "  ${GREEN}PASS${NC}: $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${NC}: $name (expected to contain: $expected)"
    FAIL=$((FAIL + 1))
  fi
}

echo "============================================"
echo "  Comis Integration Test Runner"
echo "============================================"
echo ""

# Verify config exists
if [ ! -f "$CONFIG_PATH" ]; then
  echo -e "${RED}ERROR: Test config not found at $CONFIG_PATH${NC}"
  echo "Run: pnpm build first"
  exit 1
fi

# Start daemon
echo -e "${YELLOW}Starting daemon with test config...${NC}"
COMIS_CONFIG_PATHS="$CONFIG_PATH" node "$PROJECT_ROOT/packages/daemon/dist/daemon.js" > "$LOG_FILE" 2>&1 &
DAEMON_PID=$!
echo "Daemon PID: $DAEMON_PID"

# Wait for gateway to be ready (poll /health up to 30 times, 1s each)
echo -e "${YELLOW}Waiting for gateway...${NC}"
GATEWAY_URL="http://127.0.0.1:8443"
TOKEN="test-secret-key-for-integration-tests"
READY=false
for i in $(seq 1 30); do
  if curl -sf "$GATEWAY_URL/health" > /dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done

if [ "$READY" != "true" ]; then
  echo -e "${RED}ERROR: Gateway did not become ready within 30s${NC}"
  echo "Daemon log:"
  cat "$LOG_FILE"
  exit 1
fi
echo -e "${GREEN}Gateway ready${NC}"
echo ""

# --- Test Suite ---

echo "--- Health Endpoint ---"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "$GATEWAY_URL/health")
assert "GET /health returns 200" "200" "$HTTP_CODE"

HEALTH_BODY=$(curl -sf "$GATEWAY_URL/health")
assert_contains "GET /health body contains status" "ok" "$HEALTH_BODY"

echo ""
echo "--- Authentication ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/api/agents")
assert "Unauthenticated REST API returns 401" "401" "$HTTP_CODE"

HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "$GATEWAY_URL/api/agents" \
  -H "Authorization: Bearer $TOKEN")
assert "Authenticated REST API returns 200" "200" "$HTTP_CODE"

echo ""
echo "--- REST API ---"
AGENTS_RESULT=$(curl -sf "$GATEWAY_URL/api/agents" \
  -H "Authorization: Bearer $TOKEN")
assert_contains "GET /api/agents returns agent data" "agents" "$AGENTS_RESULT"

MEMORY_RESULT=$(curl -sf "$GATEWAY_URL/api/memory/stats" \
  -H "Authorization: Bearer $TOKEN")
assert_contains "GET /api/memory/stats returns stats" "totalEntries" "$MEMORY_RESULT"

echo ""
echo "--- Log Output ---"
assert_contains "Daemon log contains startup message" "Comis daemon started" "$(cat "$LOG_FILE")"
assert_contains "Daemon log contains gateway started" "Gateway server started" "$(cat "$LOG_FILE")"

# --- Summary ---
echo ""
echo "============================================"
echo -e "  Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, $TOTAL total"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\n${RED}SOME TESTS FAILED${NC}"
  exit 1
else
  echo -e "\n${GREEN}ALL TESTS PASSED${NC}"
  exit 0
fi
