#!/usr/bin/env bash
# =============================================================================
# Comis Docker Setup Script
# Creates directories, generates tokens, builds image, and starts services.
# =============================================================================
set -euo pipefail

# --- Defaults ----------------------------------------------------------------
COMIS_DATA_DIR="${COMIS_DATA_DIR:-$HOME/.comis}"
COMIS_CONFIG_DIR="${COMIS_CONFIG_DIR:-$COMIS_DATA_DIR}"
COMIS_IMAGE="${COMIS_IMAGE:-comis:local}"
COMIS_GATEWAY_PORT="${COMIS_GATEWAY_PORT:-4766}"
COMIS_GATEWAY_HOST="${COMIS_GATEWAY_HOST:-127.0.0.1}"

# --- Functions ---------------------------------------------------------------
log()  { printf '\033[1;34m[comis]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[comis]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[comis]\033[0m %s\n' "$*" >&2; exit 1; }

ensure_dirs() {
    log "Creating data directory: $COMIS_DATA_DIR"
    mkdir -p "$COMIS_DATA_DIR/traces"
    chmod 700 "$COMIS_DATA_DIR"
}

generate_token() {
    if [ -n "${COMIS_GATEWAY_TOKEN:-}" ]; then
        log "Using existing COMIS_GATEWAY_TOKEN"
        return
    fi

    # Check .env for existing token
    if [ -f "$COMIS_DATA_DIR/.env" ]; then
        existing=$(sed -n 's/^COMIS_GATEWAY_TOKEN=//p' "$COMIS_DATA_DIR/.env" 2>/dev/null | head -n1 || true)
        if [ -n "$existing" ]; then
            export COMIS_GATEWAY_TOKEN="$existing"
            log "Using token from $COMIS_DATA_DIR/.env"
            return
        fi
    fi

    COMIS_GATEWAY_TOKEN=$(openssl rand -hex 32)
    export COMIS_GATEWAY_TOKEN
    log "Generated new gateway token"
}

write_env() {
    local env_file="$COMIS_DATA_DIR/.env"
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

daemon:
  log:
    filePath: /data/daemon.log
    maxSize: "10m"
    maxFiles: 5

memory:
  databasePath: /data/memory.db
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
    log "Fixing data directory ownership (uid 1000)"
    docker run --rm -v "$COMIS_DATA_DIR:/data" "$COMIS_IMAGE" \
        sh -c 'chown -R 1000:1000 /data' 2>/dev/null || true
}

start_services() {
    log "Starting Comis daemon"
    docker compose up -d comis-daemon

    log "Waiting for health check..."
    local retries=10
    while [ $retries -gt 0 ]; do
        if docker inspect --format='{{.State.Health.Status}}' comis-daemon 2>/dev/null | grep -q healthy; then
            log "Comis daemon is healthy!"
            return
        fi
        sleep 3
        retries=$((retries - 1))
    done

    warn "Daemon may not be healthy yet. Check logs:"
    warn "  docker compose logs comis-daemon"
}

# --- Main --------------------------------------------------------------------
main() {
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
    log "  Token:    ${COMIS_GATEWAY_TOKEN:0:8}..."
    log "  Data:     $COMIS_DATA_DIR"
    log "  Logs:     docker compose logs -f comis-daemon"
    log ""
    log "  Start web UI:  docker compose --profile web up -d"
    log "  Run CLI:       docker compose --profile cli run --rm comis-cli status"
}

main "$@"
