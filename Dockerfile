# ============================================================================
# Stage 1: build — Install dependencies and compile TypeScript
# ============================================================================
# Global ARGs — declared before any FROM so they can be used in FROM instructions.
# For reproducible builds, override with pinned digests:
#   docker build --build-arg COMIS_NODE_BOOKWORM_IMAGE=node:22-bookworm@sha256:<digest> ...
ARG COMIS_NODE_BOOKWORM_IMAGE="node:22-bookworm"
ARG COMIS_NODE_BOOKWORM_SLIM_IMAGE="node:22-bookworm-slim"
ARG COMIS_VARIANT="slim"

FROM ${COMIS_NODE_BOOKWORM_IMAGE} AS build

WORKDIR /build

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependency manifests first (layer caching)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/core/package.json        packages/core/
COPY packages/infra/package.json       packages/infra/
COPY packages/memory/package.json      packages/memory/
COPY packages/gateway/package.json     packages/gateway/
COPY packages/scheduler/package.json   packages/scheduler/
COPY packages/agent/package.json       packages/agent/
COPY packages/channels/package.json    packages/channels/
COPY packages/skills/package.json      packages/skills/
COPY packages/cli/package.json         packages/cli/
COPY packages/daemon/package.json      packages/daemon/
COPY packages/comis/package.json       packages/comis/
COPY packages/web/package.json         packages/web/

# Install ALL dependencies (including devDependencies for build)
# BuildKit cache mount for pnpm store
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    NODE_OPTIONS="--max-old-space-size=2048" \
    pnpm install --frozen-lockfile

# Copy source code
COPY packages/ packages/
COPY tsconfig.base.json ./

# Build all packages (TypeScript compilation + native module rebuild)
RUN pnpm build

# Build web SPA separately
RUN cd packages/web && pnpm build

# Prune devDependencies for production
# CI=true prevents pnpm from prompting for TTY confirmation when purging node_modules
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod && \
    find packages -name '*.d.ts' -delete && \
    find packages -name '*.map' -delete && \
    find packages -name '*.tsbuildinfo' -delete

# ============================================================================
# Stage 2: runtime-assets — Clean build artifacts
# ============================================================================
FROM ${COMIS_NODE_BOOKWORM_IMAGE} AS runtime-assets

WORKDIR /app

COPY --from=build /build/package.json          ./
COPY --from=build /build/pnpm-workspace.yaml   ./
COPY --from=build /build/pnpm-lock.yaml        ./
COPY --from=build /build/node_modules/         ./node_modules/
COPY --from=build /build/packages/             ./packages/

# Remove source files, keep only dist/ and node_modules
RUN find packages -name 'src' -type d -exec rm -rf {} + 2>/dev/null || true && \
    find packages -name 'test' -type d -exec rm -rf {} + 2>/dev/null || true && \
    find packages -name 'tsconfig*.json' -delete 2>/dev/null || true && \
    find packages -name 'vitest.config.*' -delete 2>/dev/null || true

# ============================================================================
# Stage 3a: base-default — Full Debian runtime
# ============================================================================
FROM ${COMIS_NODE_BOOKWORM_IMAGE} AS base-default

# ============================================================================
# Stage 3b: base-slim — Minimal Debian runtime
# ============================================================================
FROM ${COMIS_NODE_BOOKWORM_SLIM_IMAGE} AS base-slim

# ============================================================================
# Stage 4: final — Production runtime
# ============================================================================
# hadolint ignore=DL3006
FROM base-${COMIS_VARIANT} AS final

# Build args for optional packages
ARG COMIS_DOCKER_APT_PACKAGES=""

WORKDIR /app

# Install runtime system dependencies.
# Mirrors `install_build_tools_linux` in website/public/install.sh so the same
# config.yaml works identically under systemd and Docker. Build-only tools
# (build-essential, make, g++, cmake) and systemd-only bits (libsystemd-dev)
# are intentionally excluded — not needed at runtime inside a container.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        # Core runtime
        procps \
        curl \
        ca-certificates \
        dumb-init \
        # Git (for config versioning / agent operations)
        git \
        # Python runtime — agent exec tool creates venvs for pip installs
        python3 \
        python3-venv \
        python3-pip \
        # Media processing — TTS, audio/video skills
        ffmpeg \
        # Sandbox for agent-issued exec
        bubblewrap \
        # Optional user-specified packages
        ${COMIS_DOCKER_APT_PACKAGES} \
    && rm -rf /var/cache/apt/archives/*.deb

# Install uv/uvx for Python-based MCP servers (e.g. nanobanana). Mirrors
# install_uv() in install.sh. UV_UNMANAGED_INSTALL=/usr/local/bin puts the
# binaries on PATH system-wide and disables the self-updater (image is
# immutable; updates arrive via rebuild). Non-fatal: if the Astral CDN is
# unreachable during build, the image still works for non-Python MCP servers.
RUN curl -LsSf https://astral.sh/uv/install.sh \
        | env UV_UNMANAGED_INSTALL=/usr/local/bin sh \
    || echo "uv install failed — Python-based MCP servers will be unavailable"

# Enable corepack (non-root writable location)
ENV COREPACK_HOME=/usr/local/share/corepack
RUN mkdir -p "$COREPACK_HOME" && chmod 777 "$COREPACK_HOME" && \
    corepack enable && corepack prepare pnpm@latest --activate

# Create non-root user and data directory
# Node base images ship a "node" user at UID/GID 1000 — rename it to "comis"
# and create the required directories. If the user doesn't exist, create fresh.
RUN if getent passwd 1000 >/dev/null 2>&1; then \
        usermod -l comis -d /home/comis -m node && \
        groupmod -n comis node; \
    else \
        groupadd --gid 1000 comis && \
        useradd --uid 1000 --gid comis --shell /bin/bash --create-home comis; \
    fi && \
    mkdir -p /data && chown comis:comis /data && \
    mkdir -p /etc/comis && chown comis:comis /etc/comis

# Copy built application
COPY --from=runtime-assets --chown=comis:comis /app /app

# Copy web SPA dist (for optional serving via gateway)
COPY --from=build --chown=comis:comis /build/packages/web/dist /app/packages/web/dist

# Create CLI symlink
RUN ln -sf /app/packages/cli/dist/cli.js /usr/local/bin/comis && \
    chmod +x /app/packages/cli/dist/cli.js

# Switch to non-root user
USER comis

# Default environment
ENV NODE_ENV=production \
    COMIS_DATA_DIR=/data \
    COMIS_CONFIG_PATHS=/etc/comis/config.yaml

# Expose gateway port
EXPOSE 4766

# Health check — daemon /health endpoint
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -sf http://127.0.0.1:4766/health || exit 1

# Use dumb-init for proper PID 1 signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start daemon
CMD ["node", "packages/daemon/dist/daemon.js"]

# OCI metadata
LABEL org.opencontainers.image.source="https://github.com/comisai/comis" \
      org.opencontainers.image.title="Comis" \
      org.opencontainers.image.description="Security-first AI agent assistant platform" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Comis"
