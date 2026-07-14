#!/bin/sh
# Comis container entrypoint.
#
# Responsibilities:
#   1. Optionally start Xvfb (when COMIS_WITH_XVFB=1 baked into the image).
#      Equivalent to comis-xvfb.service from the systemd install path.
#   2. Start the daemon after the display is ready and supervise both processes.
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

# Start the virtual display if requested. An image configured for headed
# browsing must fail closed when its display runtime is unavailable.
XVFB_PID=""
COMMAND_PID=""

stop_xvfb() {
    if [ -n "${XVFB_PID}" ]; then
        kill -TERM "${XVFB_PID}" 2>/dev/null || true
        wait "${XVFB_PID}" 2>/dev/null || true
        XVFB_PID=""
    fi
}

forward_signal() {
    signal="$1"
    if [ -n "${COMMAND_PID}" ]; then
        kill "-${signal}" "${COMMAND_PID}" 2>/dev/null || true
    fi
    if [ -n "${XVFB_PID}" ]; then
        kill "-${signal}" "${XVFB_PID}" 2>/dev/null || true
    fi
}

if [ "${COMIS_WITH_XVFB:-0}" = "1" ]; then
    if ! command -v Xvfb >/dev/null 2>&1; then
        echo "Comis cannot start headed browsing: Xvfb is unavailable." >&2
        exit 1
    fi

    # Use the same display number as the systemd companion unit.
    : "${DISPLAY:=:99}"
    export DISPLAY
    DISPLAY_NUMBER="${DISPLAY#:}"
    DISPLAY_NUMBER="${DISPLAY_NUMBER%%.*}"
    case "${DISPLAY_NUMBER}" in
        ''|*[!0-9]*)
            echo "Comis cannot start headed browsing: DISPLAY must use the local :number form." >&2
            exit 1
            ;;
    esac
    XVFB_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUMBER}"

    # -ac disables host-based access control; -nolisten tcp keeps the X server
    # on a Unix socket only. Both match render_xvfb_unit in install.sh.
    Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -ac -nolisten tcp >/dev/null 2>&1 &
    XVFB_PID=$!

    XVFB_READY=0
    attempt=0
    while [ "${attempt}" -lt 50 ]; do
        if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
            wait "${XVFB_PID}" 2>/dev/null || true
            XVFB_PID=""
            echo "Comis cannot start headed browsing: Xvfb exited before its socket was ready." >&2
            exit 1
        fi
        if [ -S "${XVFB_SOCKET}" ]; then
            XVFB_READY=1
            break
        fi
        attempt=$((attempt + 1))
        sleep 0.1
    done

    if [ "${XVFB_READY}" -ne 1 ]; then
        stop_xvfb
        echo "Comis cannot start headed browsing: Xvfb did not create ${XVFB_SOCKET} within 5 seconds." >&2
        exit 1
    fi
fi

# Default to the daemon. Callers can override by passing their own command.
if [ "$#" -eq 0 ]; then
    set -- node /app/packages/daemon/dist/daemon.js
fi

if [ -z "${XVFB_PID}" ]; then
    exec "$@"
fi

# Keep the entrypoint alive while both child processes run so the same cleanup
# behavior applies in images with and without a separate init process.
trap 'forward_signal TERM' TERM
trap 'forward_signal INT' INT
"$@" &
COMMAND_PID=$!
if wait "${COMMAND_PID}"; then
    COMMAND_STATUS=0
else
    COMMAND_STATUS=$?
fi
COMMAND_PID=""
stop_xvfb
exit "${COMMAND_STATUS}"
