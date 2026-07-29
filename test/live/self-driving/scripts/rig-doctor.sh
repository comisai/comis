#!/usr/bin/env bash
# LOCAL — read-only coherence gate between YOUR kit (.live-env) and THE RIG. phase0-check.sh asks
# "is the rig ready?"; this asks "is my kit pointed at it correctly?" — the drift classes that
# 401/ENOENT mid-run with confusing symptoms: a rotated gateway token, an un-deployed kit, a stale
# emulator wire (config apiRoot ≠ the running emulator's port), a wrong PKG path.
#
#   ./rig-doctor.sh          # exit 0 = coherent; non-zero = named drift
#
# Works against both rigs. RIG_MODE=remote (default) probes the VPS over ssh; RIG_MODE=local probes
# THIS machine — same checks, rig-appropriate probes (a running daemon process instead of a systemd
# unit, `lsof` instead of `ss`, the checkout instead of an installed package).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$HERE/.live-env" ] && . "$HERE/.live-env"
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
rig_load_persisted_env "${RIG_ENV:-}" "$HERE/.rig-env" /root/comis-rig.env
PKG="${PKG:-$COMIS_HOME/.npm-global/lib/node_modules/comisai}"

fails=0
pass() { printf '  \033[32mPASS\033[0m  %-14s %s\n' "$1" "$2"; }
fail() {
  printf '  \033[31mFAIL\033[0m  %-14s %s\n' "$1" "$2"
  fails=$((fails + 1))
}
warn() { printf '  \033[33mWARN\033[0m  %-14s %s\n' "$1" "$2"; }

echo "=== rig-doctor — $(rig_banner) ==="

if rig_is_local; then
  RIG_HELPER="$HERE/_rig.sh"
  KIT_DIR="$HERE"
else
  RIG_HELPER="/root/_rig.sh"
  KIT_DIR="/root"
  VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
  if ! out="$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS" 'echo ok' 2>&1)"; then
    fail "ssh" "$VPS unreachable: $(printf '%s' "$out" | tail -1)"
    echo -e "\n\033[31m❌ rig-doctor: cannot reach the box\033[0m"
    exit 1
  fi
  pass "ssh" "$VPS reachable"
fi

# ONE rig round-trip for the filesystem/service facts. The script travels as a FILE over stdin
# (`bash -s`) — no nested-quote escaping (the escaped-\" cascade corrupted three probes: a literal-'"'
# grep target, +2 on the token length, an empty emulator read). It sources the rig helper so the
# probes are portable: `ss` does not exist on macOS, and the daemon has no systemd unit locally.
FACTS_SCRIPT="$(mktemp)"
trap 'rm -f "$FACTS_SCRIPT"' EXIT
cat >"$FACTS_SCRIPT" <<'FACTS'
. "$RIG_HELPER" 2>/dev/null || true
if [ "${RIG_MODE:-remote}" = local ]; then
  dpid="$(rig_daemon_pid)"
  echo "service=$([ -n "$dpid" ] && echo active || echo inactive)"
  echo "unitexec=$(ps -o command= -p "${dpid:-0}" 2>/dev/null | grep -oE '[^ ]*daemon\.js' | head -1)"
else
  echo "service=$(systemctl is-active "$SERVICE" 2>/dev/null)"
  echo "unitexec=$(systemctl show -p ExecStart "$SERVICE" 2>/dev/null | grep -oE '[^ ]*daemon\.js' | head -1)"
fi
echo "pkg=$([ -f "$PKG/node_modules/@comis/daemon/dist/daemon.js" ] || [ -f "$PKG/packages/daemon/dist/daemon.js" ] && echo ok || echo missing)"
echo "kit=$([ -f "$KIT_DIR/_rig.mjs" ] && [ -f "$KIT_DIR/revoke.mjs" ] && echo ok || echo missing)"
echo "rigenv=$([ -f "$RIG_ENV" ] && echo ok || echo missing)"
echo "boxtoken=$(. "$RIG_ENV" 2>/dev/null; printf %s "${GWTOKEN:-}" | wc -c | tr -d ' ')"
echo "config=$([ -f "$DATA/config.yaml" ] && echo ok || echo missing)"
echo "gwport=$(rig_port_listening "$GW_PORT" && echo 1 || echo 0)"
echo "emuwire=$([ -f "$EMU_JSON" ] && tr -d '\n' < "$EMU_JSON")"
echo "cfgapiroot=$(grep -oE 'apiRoot: .*' "$DATA/config.yaml" 2>/dev/null | head -1 | sed 's/apiRoot: //; s/"//g')"
FACTS
facts="$(remote_root "RIG_MODE='$(rig_mode)' RIG_HELPER='$RIG_HELPER' KIT_DIR='$KIT_DIR' RIG_ENV='$RIG_ENV' SERVICE='$SERVICE' PKG='$PKG' DATA='$DATA' GW_PORT='$GW_PORT' EMU_JSON='$EMU_JSON' bash -s" <"$FACTS_SCRIPT")"
get() { printf '%s\n' "$facts" | sed -n "s/^$1=//p" | head -1; }

if [ "$(get service)" = "active" ]; then
  pass "service" "$(rig_is_local && echo "daemon process running" || echo "$SERVICE active")"
else
  fail "service" "$(rig_is_local && echo "no daemon process — ./restart-daemon.sh" || echo "$SERVICE is '$(get service)'")"
fi
case "$(get unitexec)" in
"$PKG"/*) pass "pkg-path" "daemon entry is under \$PKG" ;;
"") warn "pkg-path" "no daemon entry found for $SERVICE" ;;
*) fail "pkg-path" "daemon runs $(get unitexec) — NOT under PKG=$PKG (.live-env points at the wrong install)" ;;
esac
[ "$(get pkg)" = "ok" ] && pass "install" "daemon dist present at \$PKG" || fail "install" "no daemon dist under $PKG — $(rig_is_local && echo 'run pnpm build' || echo 'run install-vps.sh')"
[ "$(get kit)" = "ok" ] && pass "kit" "helpers present ($KIT_DIR/_rig.mjs, revoke.mjs)" || fail "kit" "kit helpers missing at $KIT_DIR — run deploy-scripts.sh"
if [ "$(get rigenv)" = "ok" ]; then
  pass "rig-env" "$RIG_ENV present"
elif rig_is_local; then
  warn "rig-env" "no $RIG_ENV — optional locally (.live-env is sourced directly); deploy-scripts.sh renders it"
else
  fail "rig-env" "no $RIG_ENV — run deploy-scripts.sh"
fi
[ "$(get config)" = "ok" ] && pass "config" "$DATA/config.yaml present" || fail "config" "no config.yaml — $(rig_is_local && echo 'run comis init, or node init-config.mjs' || echo 'fresh box: node /root/init-config.mjs')"
[ "$(get gwport)" -ge 1 ] 2>/dev/null && pass "gateway" ":$GW_PORT listening" || fail "gateway" ":$GW_PORT not listening"

# Kit-vs-rig token coherence (the rendered-stale class): only meaningful when both exist.
boxlen="$(get boxtoken)"
if [ -n "${GWTOKEN:-}" ] && [ "${boxlen:-0}" -ge 32 ] 2>/dev/null; then
  if [ "${#GWTOKEN}" = "$boxlen" ]; then
    pass "token-sync" "kit GWTOKEN and rig env agree on length ($boxlen)"
  else
    warn "token-sync" "kit GWTOKEN (${#GWTOKEN}ch) ≠ rig env (${boxlen}ch) — re-run deploy-scripts.sh (auto-fetch)"
  fi
fi

# THE load-bearing probe: the token the rig helpers actually use must open a live RPC.
rpc="$(remote_root "node '$KIT_DIR/revoke.mjs' capabilities.introspect 2>/dev/null" | head -c 40)"
case "$rpc" in
RESULT:*) pass "rpc-token" "capabilities.introspect answers (rig token live)" ;;
ERROR:*) fail "rpc-token" "RPC rejected — token rotated/wrong? re-run deploy-scripts.sh (auto-fetch), then retry" ;;
*) fail "rpc-token" "no RPC response — daemon down or kit missing" ;;
esac

# Emulator wire freshness: config's apiRoot must match the RUNNING emulator's wiring file. This is
# also what keeps media INPUT working — the daemon trusts the configured apiRoot ORIGIN (host:port)
# for file-byte downloads, and the emulator port is kernel-allocated, so a stale wire silently turns
# every inbound voice note / photo into an SSRF rejection.
emu="$(get emuwire)"
if [ -z "$emu" ]; then
  warn "emu-wire" "no $EMU_JSON — emulator not launched ($(rig_is_local && echo './local-up.sh' || echo 'WIRE=1 ./deploy-emu.sh')) — fine for non-channel tests"
else
  # The emulator writes PRETTY JSON ("apiRoot": "…" with a space) — tolerate optional whitespace.
  emuroot="$(printf '%s' "$emu" | grep -oE '"apiRoot"[[:space:]]*:[[:space:]]*"[^"]+"' | grep -oE 'https?://[^"]+')"
  cfgroot="$(get cfgapiroot)"
  if [ -n "$emuroot" ] && [ "$emuroot" = "$cfgroot" ]; then
    pass "emu-wire" "config apiRoot == running emulator ($emuroot)"
  else
    if rig_is_local; then
      fail "emu-wire" "config apiRoot ($cfgroot) ≠ emulator ($emuroot) — stale wire: node $HERE/wire-emu.mjs && $HERE/restart-daemon.sh"
    else
      fail "emu-wire" "config apiRoot ($cfgroot) ≠ emulator ($emuroot) — stale wire: node /root/wire-emu.mjs && bash /root/restart-daemon.sh"
    fi
  fi
fi

echo
if [ "$fails" -eq 0 ]; then
  echo -e "\033[32m✅ rig coherent — drive away\033[0m"
  exit 0
else
  echo -e "\033[31m❌ rig-doctor: $fails drift(s) — fix before driving\033[0m"
  exit 1
fi
