#!/bin/sh
# Comis container entrypoint.
#
# Responsibilities:
#   1. Optionally start Xvfb (when COMIS_WITH_XVFB=1 baked into the image).
#      Equivalent to comis-xvfb.service from the systemd install path.
#   2. Exec the daemon as PID-of-the-container so dumb-init forwards signals.
#
# Browser tool wiring lives in the image: Chrome / CloakBrowser binaries and
# their shared libs are installed at build time. findChrome() in
# chrome-detection.ts picks the right binary at runtime based on what is on
# disk — no env var is needed.

set -e

# Compose's default-empty interpolation defines optional credentials as empty
# process variables. Comis deliberately does not overwrite an existing process
# value when it loads the mounted .env file, so those empty definitions would
# hide persisted credentials. Normalize only the exact optional credentials
# projected by docker-compose.yml; explicit non-empty values keep precedence.
[ -n "${ANTHROPIC_API_KEY:-}" ] || unset ANTHROPIC_API_KEY
[ -n "${OPENAI_API_KEY:-}" ] || unset OPENAI_API_KEY
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || unset TELEGRAM_BOT_TOKEN
[ -n "${DISCORD_BOT_TOKEN:-}" ] || unset DISCORD_BOT_TOKEN
[ -n "${SLACK_BOT_TOKEN:-}" ] || unset SLACK_BOT_TOKEN
[ -n "${COMIS_GATEWAY_TOKEN:-}" ] || unset COMIS_GATEWAY_TOKEN

# Start the virtual display if requested (and Xvfb is on PATH).
if [ "${COMIS_WITH_XVFB:-0}" = "1" ] && command -v Xvfb >/dev/null 2>&1; then
    # Use the same display number as the systemd companion unit so config /
    # docs / muscle memory transfer.
    : "${DISPLAY:=:99}"
    export DISPLAY
    # -ac disables host-based access control; -nolisten tcp keeps the X server
    # on a Unix socket only. Both match render_xvfb_unit in install.sh.
    Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac -nolisten tcp >/dev/null 2>&1 &
    XVFB_PID=$!
    # Brief wait for the socket to materialize so the daemon's first browser
    # tool call doesn't race the X server. 200ms is enough on every Linux
    # we've measured (Ubuntu 22.04, 24.04, Debian bookworm).
    sleep 0.2
    # Forward SIGTERM/SIGINT to Xvfb so it dies with the container.
    # dumb-init (PID 1) handles signal propagation to this script; we handle
    # propagation onward to Xvfb.
    trap 'kill -TERM "${XVFB_PID}" 2>/dev/null || true' TERM INT
fi

# Default to the daemon. Callers can override by passing their own command.
if [ "$#" -eq 0 ]; then
    set -- node /app/packages/daemon/dist/daemon.js
fi

exec "$@"
