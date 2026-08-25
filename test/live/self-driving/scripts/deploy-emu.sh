#!/usr/bin/env bash
# LOCAL — get the Telegram emulator running against the rig, and optionally wire the daemon to it.
# Formalizes the 01-SETUP §4 hand-steps into one command.
#
# RIG_MODE=remote (default): rsync test/live → $EMU_DIR + ESM marker + restart-emu.sh
#   [+ wire-emu.mjs + daemon restart]. Prereqs: install-vps.sh (daemon installed), deploy-scripts.sh
#   (helpers + rig env on the box), setup-vps.sh (tsx installed).
# RIG_MODE=local: there is NOTHING to ship — the emulator runs straight out of this checkout (which
#   is already ESM), so this is just the (re)launch [+ wire]. `local-up.sh` wraps it with the build
#   and the readiness gate.
#
#   ./deploy-emu.sh          # (re)launch the emulator; prints the new wiring
#   WIRE=1 ./deploy-emu.sh   # …then also point config.yaml at it and restart the daemon
# Re-run any time test/live/ changes; the port is kernel-allocated, so every relaunch needs a
# re-wire (WIRE=1 does both) — a stale wire also silently breaks inbound media (the daemon trusts
# the configured apiRoot origin for file downloads).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_remote-root.sh
. "$HERE/_remote-root.sh"
rig_load_env "$HERE/.live-env" "$HERE/.rig-env" /root/comis-rig.env
REPO="${REPO:-$(git rev-parse --show-toplevel)}"

if rig_is_local; then
  echo "1) local rig — no deploy needed (the emulator runs from $EMU_DIR)"
else
  VPS="${VPS:?set VPS=user@host in scripts/.live-env (see .live-env.example) or the env}"
  echo "1) stream the emulator subtree → $VPS:$EMU_DIR (self-driving/ + logs excluded — the emulator"
  echo "   needs bin/ + emulators/ + harness/; runs/ can be hundreds of MB)…"
  (cd "$REPO/test/live" && tar --no-xattrs -cf - --exclude=node_modules --exclude=self-driving --exclude='*.log' .) |
    remote_root "rm -rf '$EMU_DIR/test/live' && mkdir -p '$EMU_DIR/test/live' && tar -xf - -C '$EMU_DIR/test/live'"
  # ESM marker so tsx treats the .ts files as ESM (same trick as the original hand-step).
  remote_root "printf '%s' '{\"type\":\"module\"}' > '$EMU_DIR/package.json'"
fi

echo "2) (Re)launch the emulator (anchored pkill + tmux)…"
if rig_is_local; then
  EMU_DIR="$EMU_DIR" bash "$HERE/restart-emu.sh"
else
  # Ship the launcher WITH the emulator subtree. It used to arrive only via deploy-scripts.sh, so a
  # box that had never run that script (or had been cleaned) failed here with a bare
  # `bash: /root/restart-emu.sh: No such file or directory` — a launcher-not-found error that reads
  # like an emulator fault. The launcher belongs to the thing it launches.
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$HERE" -cf - restart-emu.sh |
    remote_root "mkdir -p '$KIT_DIR' && tar -xf - -C '$KIT_DIR'"
  # EMU_GROUPS must cross the ssh boundary WITH the launch. restart-emu.sh reads it from its own
  # environment, and only EMU_DIR used to be forwarded — so every remote launch came up with
  # `groups:[]` and EVERY group arc was silently undrivable, which is exactly the failure the
  # target's kit-prerequisite #1 warns about ("an empty array means every group arc is silently
  # undrivable"). The kit was causing the condition it tells you to check for.
  # Single quotes are escaped so the JSON array survives the remote shell intact.
  emu_groups_q=$(printf "%s" "${EMU_GROUPS:-}" | sed "s/'/'\\\\''/g")
  remote_root "RIG_ENV='$RIG_ENV' EMU_DIR='$EMU_DIR' EMU_GROUPS='$emu_groups_q' bash '$KIT_DIR/restart-emu.sh'"
fi

if [ "${WIRE:-0}" = 1 ]; then
  echo "3) Wire the daemon to the new emulator port + restart it…"
  if rig_is_local; then
    node "$HERE/wire-emu.mjs" && bash "$HERE/restart-daemon.sh"
  else
    remote_root "RIG_ENV='$RIG_ENV' node '$KIT_DIR/wire-emu.mjs' && RIG_ENV='$RIG_ENV' bash '$KIT_DIR/restart-daemon.sh'"
  fi
elif rig_is_local; then
  echo "NEXT: node $HERE/wire-emu.mjs && $HERE/restart-daemon.sh   # or re-run with WIRE=1"
else
  echo "NEXT: ssh \$VPS 'node $KIT_DIR/wire-emu.mjs && bash $KIT_DIR/restart-daemon.sh'   # or re-run with WIRE=1"
fi
