#!/usr/bin/env bash
# LOCAL — read-only coherence gate between YOUR kit (.live-env) and THE BOX. phase0-check.sh asks
# "is the box ready?"; this asks "is my local rig pointed at it correctly?" — the drift classes that
# 401/ENOENT mid-run with confusing symptoms: a rotated gateway token, an un-deployed kit, a stale
# emulator wire (config apiRoot ≠ the running emulator's port), a wrong PKG path.
#
#   ./rig-doctor.sh          # exit 0 = coherent; non-zero = named drift
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
COMIS_USER="${COMIS_USER:-comis}"
COMIS_HOME="${COMIS_HOME:-/home/$COMIS_USER}"
DATA="${DATA:-$COMIS_HOME/.comis}"
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"
SERVICE="${SERVICE:-comis}"
GW_PORT="${GW_PORT:-4766}"

fails=0
pass() { printf '  \033[32mPASS\033[0m  %-14s %s\n' "$1" "$2"; }
fail() { printf '  \033[31mFAIL\033[0m  %-14s %s\n' "$1" "$2"; fails=$((fails + 1)); }
warn() { printf '  \033[33mWARN\033[0m  %-14s %s\n' "$1" "$2"; }

echo "=== rig-doctor ($VPS) ==="

if ! out="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS" 'echo ok' 2>&1)"; then
  fail "ssh" "$VPS unreachable: $(printf '%s' "$out" | tail -1)"
  echo -e "\n\033[31m❌ rig-doctor: cannot reach the box\033[0m"
  exit 1
fi
pass "ssh" "$VPS reachable"

# One box round-trip for the filesystem/service facts. The remote script travels as a FILE over
# stdin (`bash -s`) — no nested-quote escaping (the escaped-\" cascade corrupted three probes:
# a literal-'"' grep target, +2 on the token length, an empty emulator read).
FACTS_SCRIPT="$(mktemp)"
trap 'rm -f "$FACTS_SCRIPT"' EXIT
cat > "$FACTS_SCRIPT" <<'FACTS'
echo "service=$(systemctl is-active "$SERVICE" 2>/dev/null)"
echo "unitexec=$(systemctl show -p ExecStart "$SERVICE" 2>/dev/null | grep -oE '[^ ]*daemon\.js' | head -1)"
echo "pkg=$([ -f "$PKG/node_modules/@comis/daemon/dist/daemon.js" ] && echo ok || echo missing)"
echo "kit=$([ -f /root/_rig.mjs ] && [ -f /root/revoke.mjs ] && echo ok || echo missing)"
echo "rigenv=$([ -f /root/comis-rig.env ] && echo ok || echo missing)"
echo "boxtoken=$(. /root/comis-rig.env 2>/dev/null; printf %s "${GWTOKEN:-}" | wc -c | tr -d ' ')"
echo "config=$([ -f "$DATA/config.yaml" ] && echo ok || echo missing)"
echo "gwport=$(ss -ltn 2>/dev/null | grep -c ":$GW_PORT ")"
echo "emuwire=$(tr -d '\n' < /tmp/comis-emu.json 2>/dev/null)"
echo "cfgapiroot=$(grep -oE 'apiRoot: .*' "$DATA/config.yaml" 2>/dev/null | head -1 | sed 's/apiRoot: //; s/"//g')"
FACTS
facts="$(ssh -o ConnectTimeout=15 "$VPS" "SERVICE='$SERVICE' PKG='$PKG' DATA='$DATA' GW_PORT='$GW_PORT' bash -s" < "$FACTS_SCRIPT")"
get() { printf '%s\n' "$facts" | sed -n "s/^$1=//p" | head -1; }

[ "$(get service)" = "active" ] && pass "service" "$SERVICE active" || fail "service" "$SERVICE is '$(get service)'"
case "$(get unitexec)" in
"$PKG"/*) pass "pkg-path" "unit exec is under \$PKG" ;;
"") warn "pkg-path" "no $SERVICE unit ExecStart found" ;;
*) fail "pkg-path" "unit runs $(get unitexec) — NOT under PKG=$PKG (.live-env points at the wrong install)" ;;
esac
[ "$(get pkg)" = "ok" ] && pass "install" "daemon dist present at \$PKG" || fail "install" "no daemon dist under $PKG — run install-vps.sh"
[ "$(get kit)" = "ok" ] && pass "kit" "helpers deployed (/root/_rig.mjs, revoke.mjs)" || fail "kit" "kit not on the box — run deploy-scripts.sh"
[ "$(get rigenv)" = "ok" ] && pass "rig-env" "/root/comis-rig.env present" || fail "rig-env" "no /root/comis-rig.env — run deploy-scripts.sh"
[ "$(get config)" = "ok" ] && pass "config" "$DATA/config.yaml present" || fail "config" "no config.yaml — fresh box: node /root/init-config.mjs"
[ "$(get gwport)" -ge 1 ] 2>/dev/null && pass "gateway" ":$GW_PORT listening" || fail "gateway" ":$GW_PORT not listening"

# Local-vs-box token coherence (the rendered-stale class): only meaningful when both exist.
boxlen="$(get boxtoken)"
if [ -n "${GWTOKEN:-}" ] && [ "${boxlen:-0}" -ge 32 ] 2>/dev/null; then
  if [ "${#GWTOKEN}" = "$boxlen" ]; then
    pass "token-sync" "local GWTOKEN and box rig env agree on length ($boxlen)"
  else
    warn "token-sync" "local GWTOKEN (${#GWTOKEN}ch) ≠ box rig env (${boxlen}ch) — re-run deploy-scripts.sh (auto-fetch)"
  fi
fi

# THE load-bearing probe: the token the box helpers actually use must open a live RPC.
rpc="$(ssh -o ConnectTimeout=15 "$VPS" 'node /root/revoke.mjs capabilities.introspect 2>/dev/null' | head -c 40)"
case "$rpc" in
RESULT:*) pass "rpc-token" "capabilities.introspect answers (box token live)" ;;
ERROR:*) fail "rpc-token" "RPC rejected — token rotated/wrong? re-run deploy-scripts.sh (auto-fetch), then retry" ;;
*) fail "rpc-token" "no RPC response — daemon down or kit missing" ;;
esac

# Emulator wire freshness: config's apiRoot must match the RUNNING emulator's wiring file.
emu="$(get emuwire)"
if [ -z "$emu" ]; then
  warn "emu-wire" "no /tmp/comis-emu.json — emulator not launched (WIRE=1 ./deploy-emu.sh) — fine for non-channel tests"
else
  # The emulator writes PRETTY JSON ("apiRoot": "…" with a space) — tolerate optional whitespace.
  emuroot="$(printf '%s' "$emu" | grep -oE '"apiRoot"[[:space:]]*:[[:space:]]*"[^"]+"' | grep -oE 'https?://[^"]+')"
  cfgroot="$(get cfgapiroot)"
  if [ -n "$emuroot" ] && [ "$emuroot" = "$cfgroot" ]; then
    pass "emu-wire" "config apiRoot == running emulator ($emuroot)"
  else
    fail "emu-wire" "config apiRoot ($cfgroot) ≠ emulator ($emuroot) — stale wire: node /root/wire-emu.mjs && bash /root/restart-daemon.sh"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then echo -e "\033[32m✅ rig coherent — drive away\033[0m"; exit 0
else echo -e "\033[31m❌ rig-doctor: $fails drift(s) — fix before driving\033[0m"; exit 1; fi
