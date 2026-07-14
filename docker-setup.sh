#!/usr/bin/env bash
# =============================================================================
# Comis Docker Setup Script
# Creates directories, generates tokens, builds image, and starts services.
# =============================================================================
set -euo pipefail

# --- Compose settings --------------------------------------------------------
# Initialize without applying defaults so values resolved from the project
# Compose .env can be loaded first. Shell-exported values retain Compose's
# normal precedence because `docker compose config --environment` resolves the
# same interpolation environment used by `docker compose up`.
COMIS_DATA_DIR="${COMIS_DATA_DIR-}"
COMIS_CONFIG_DIR="${COMIS_CONFIG_DIR-}"
COMIS_ENV_FILE="${COMIS_ENV_FILE-}"
COMIS_IMAGE="${COMIS_IMAGE-}"
COMIS_GATEWAY_PORT="${COMIS_GATEWAY_PORT-}"
COMIS_GATEWAY_HOST="${COMIS_GATEWAY_HOST-}"
COMIS_GATEWAY_TOKEN="${COMIS_GATEWAY_TOKEN-}"

# --- Functions ---------------------------------------------------------------
log()  { printf '\033[1;34m[comis]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[comis]\033[0m %s\n' "$*" >&2; exit 1; }

expand_home_path() {
    local value="$1"
    case "$value" in
        "~") printf '%s\n' "$HOME" ;;
        \~/*) printf '%s/%s\n' "$HOME" "${value:2}" ;;
        *) printf '%s\n' "$value" ;;
    esac
}

load_compose_settings() {
    local compose_environment
    if ! compose_environment=$(docker compose config --environment); then
        die "Could not resolve docker-compose.yml settings. Verify Docker Compose and the project .env file."
    fi

    local key value
    while IFS='=' read -r key value; do
        case "$key" in
            COMIS_DATA_DIR|COMIS_CONFIG_DIR|COMIS_ENV_FILE|COMIS_IMAGE|COMIS_GATEWAY_PORT|COMIS_GATEWAY_HOST|COMIS_GATEWAY_TOKEN)
                printf -v "$key" '%s' "$value"
                ;;
        esac
    done <<< "$compose_environment"

    COMIS_DATA_DIR="$(expand_home_path "${COMIS_DATA_DIR:-$HOME/.comis}")"
    COMIS_CONFIG_DIR="$(expand_home_path "${COMIS_CONFIG_DIR:-$COMIS_DATA_DIR}")"
    COMIS_ENV_FILE="$(expand_home_path "${COMIS_ENV_FILE:-$COMIS_DATA_DIR/.env}")"
    COMIS_IMAGE="${COMIS_IMAGE:-comis:local}"
    COMIS_GATEWAY_PORT="${COMIS_GATEWAY_PORT:-4766}"
    COMIS_GATEWAY_HOST="${COMIS_GATEWAY_HOST:-127.0.0.1}"
}

ensure_dirs() {
    log "Creating data directory: $COMIS_DATA_DIR"
    mkdir -p "$COMIS_DATA_DIR/traces"
    chmod 700 "$COMIS_DATA_DIR"

    log "Creating config directory: $COMIS_CONFIG_DIR"
    mkdir -p "$COMIS_CONFIG_DIR"
    chmod 700 "$COMIS_CONFIG_DIR"

    log "Preparing daemon environment file: $COMIS_ENV_FILE"
    mkdir -p "$(dirname "$COMIS_ENV_FILE")"
    if [ -d "$COMIS_ENV_FILE" ]; then
        die "$COMIS_ENV_FILE is a directory. Remove it and run setup again."
    fi
    touch "$COMIS_ENV_FILE"
    chmod 600 "$COMIS_ENV_FILE"
}

generate_token() {
    if [ -n "${COMIS_GATEWAY_TOKEN:-}" ]; then
        log "Using existing COMIS_GATEWAY_TOKEN"
        return
    fi

    # Check .env for existing token
    if [ -f "$COMIS_ENV_FILE" ]; then
        existing=$(sed -n 's/^COMIS_GATEWAY_TOKEN=//p' "$COMIS_ENV_FILE" 2>/dev/null | head -n1 || true)
        if [ -n "$existing" ]; then
            export COMIS_GATEWAY_TOKEN="$existing"
            log "Using token from $COMIS_ENV_FILE"
            return
        fi
    fi

    COMIS_GATEWAY_TOKEN=$(openssl rand -hex 32)
    export COMIS_GATEWAY_TOKEN
    log "Generated new gateway token"
}

write_env() {
    local env_file="$COMIS_ENV_FILE"
    log "Writing $env_file"

    # Upsert key=value pairs
    for kv in \
        "COMIS_GATEWAY_TOKEN=$COMIS_GATEWAY_TOKEN" \
        "COMIS_GATEWAY_PORT=$COMIS_GATEWAY_PORT" \
        "COMIS_GATEWAY_HOST=$COMIS_GATEWAY_HOST"
    do
        local key="${kv%%=*}"
        if [ -f "$env_file" ] && grep -q "^${key}=" "$env_file" 2>/dev/null; then
            sed -i.bak "s|^${key}=.*|${kv}|" "$env_file" && rm -f "${env_file}.bak"
        else
            echo "$kv" >> "$env_file"
        fi
    done

    chmod 600 "$env_file"
}

create_default_config() {
    local config_file="$COMIS_CONFIG_DIR/config.yaml"
    if [ -f "$config_file" ]; then
        log "Config already exists: $config_file"
        return
    fi

    log "Creating default config: $config_file"
    cat > "$config_file" << 'YAML'
# Comis Configuration — Docker
tenantId: "default"
logLevel: info

gateway:
  enabled: true
  host: "0.0.0.0"
  port: 4766
  tokens:
    - id: default
      secret: "${COMIS_GATEWAY_TOKEN}"
      scopes: ["*"]

daemon:
  logging:
    filePath: /home/comis/.comis/logs/daemon.log

memory:
  dbPath: /home/comis/.comis/memory.db
YAML
    chmod 600 "$config_file"
}

build_image() {
    if [ "$COMIS_IMAGE" = "comis:local" ]; then
        log "Building Docker image: comis:local"
        docker build -t comis:local .
    else
        log "Using pre-built image: $COMIS_IMAGE"
    fi
}

fix_permissions() {
    log "Preparing mounted directory ownership (uid 1000)"
    if [ "$COMIS_CONFIG_DIR" = "$COMIS_DATA_DIR" ]; then
        if ! docker run --rm --user root \
            -v "$COMIS_DATA_DIR:/data" \
            -v "$COMIS_ENV_FILE:/env-file" \
            "$COMIS_IMAGE" sh -c 'chown -R 1000:1000 /data && chown 1000:1000 /env-file'; then
            die "Could not set ownership on $COMIS_DATA_DIR and $COMIS_ENV_FILE"
        fi
        return
    fi

    if ! docker run --rm --user root \
        -v "$COMIS_DATA_DIR:/data" \
        -v "$COMIS_CONFIG_DIR:/config" \
        -v "$COMIS_ENV_FILE:/env-file" \
        "$COMIS_IMAGE" sh -c 'chown -R 1000:1000 /data /config && chown 1000:1000 /env-file'; then
        die "Could not set ownership on $COMIS_DATA_DIR, $COMIS_CONFIG_DIR, and $COMIS_ENV_FILE"
    fi
}

start_services() {
    log "Starting Comis daemon"
    docker compose up -d comis-daemon

    log "Waiting for health check..."
    # Covers Compose's 30s start period, first 60s interval, 10s timeout,
    # and additional scheduling margin before declaring startup failed.
    local wait_seconds=120
    local poll_seconds=3
    local elapsed=0
    local health_status
    while [ "$elapsed" -lt "$wait_seconds" ]; do
        health_status=$(docker inspect --format='{{.State.Health.Status}}' comis-daemon 2>/dev/null || true)
        if [ "$health_status" = "healthy" ]; then
            log "Comis daemon is healthy!"
            return
        fi
        if [ "$health_status" = "unhealthy" ]; then
            die "Daemon reported an unhealthy status. Inspect: docker compose logs --tail=200 comis-daemon"
        fi
        sleep "$poll_seconds"
        elapsed=$((elapsed + poll_seconds))
    done

    die "Daemon did not become healthy within ${wait_seconds}s. Inspect: docker compose logs --tail=200 comis-daemon"
}

# --- Main --------------------------------------------------------------------
main() {
    load_compose_settings

    log "Comis Docker Setup"
    log "=================="

    ensure_dirs
    generate_token
    write_env
    create_default_config
    build_image
    fix_permissions
    start_services

    echo ""
    log "Setup complete!"
    log ""
    log "  Gateway:  http://${COMIS_GATEWAY_HOST}:${COMIS_GATEWAY_PORT}"
    log "  Credentials: $COMIS_ENV_FILE"
    log "  Data:     $COMIS_DATA_DIR"
    log "  Logs:     docker compose logs -f comis-daemon"
    log ""
    log "  Start web UI:  docker compose --profile web up -d"
    log "  Run CLI:       docker compose --profile cli run --rm comis-cli status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
