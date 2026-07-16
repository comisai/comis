# ============================================================================
# Stage 1: build — Install dependencies and compile TypeScript
# ============================================================================
# Global ARGs — declared before any FROM so they can be used in FROM instructions.
# For reproducible builds, override with pinned digests:
#   docker build --build-arg COMIS_NODE_BOOKWORM_IMAGE=node:22-bookworm@sha256:<digest> ...
ARG COMIS_NODE_BOOKWORM_IMAGE="node:22-bookworm@sha256:c601a46abb4d2ab80a9dc3da208d50d1122642d53f17a101926ace71e5a9bf1c"
ARG COMIS_NODE_BOOKWORM_SLIM_IMAGE="node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4"
ARG COMIS_VARIANT="slim"

FROM ${COMIS_NODE_BOOKWORM_IMAGE} AS build

WORKDIR /build

# Enable corepack for pnpm
# Pin pnpm to a specific version so image rebuilds are deterministic across
# rebuild dates. The unpinned tag resolves to whatever Corepack thinks is
# current at build time, producing non-reproducible builds. The pinned
# version mirrors the host's `pnpm --version` output at the time of this
# change. Bump together with the host pnpm version when upgrading.
RUN corepack enable && corepack prepare pnpm@10.34.4 --activate

# Copy dependency manifests first (layer caching)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/core/package.json        packages/core/
COPY packages/infra/package.json       packages/infra/
COPY packages/observability/package.json packages/observability/
COPY packages/observability-otel/package.json packages/observability-otel/
COPY packages/memory/package.json      packages/memory/
COPY packages/gateway/package.json     packages/gateway/
COPY packages/scheduler/package.json   packages/scheduler/
COPY packages/agent/package.json       packages/agent/
COPY packages/channels/package.json    packages/channels/
COPY packages/skills/package.json      packages/skills/
COPY packages/cli/package.json         packages/cli/
COPY packages/daemon/package.json      packages/daemon/
COPY packages/orchestrator/package.json packages/orchestrator/
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

# Build all packages (TypeScript compilation + native module rebuild).
# pnpm respects the workspace dep graph and builds in topological order,
# so @comis/core finishes before @comis/web's vite build needs it.
RUN pnpm -r run build

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

# Browser-tool provisioning (mirrors the install.sh flags so the same matrix
# of capabilities is reachable via Docker). All default off — flip on at
# build time:
#   docker build --build-arg COMIS_WITH_BROWSER=1            (stock Chrome)
#   docker build --build-arg COMIS_WITH_XVFB=1               (+ headed via Xvfb)
#   docker build --build-arg COMIS_WITH_CLOAKBROWSER=1       (alternative Chromium runtime)
# Setting XVFB or CLOAKBROWSER implies BROWSER (shared libs are required).
ARG COMIS_WITH_BROWSER=0
ARG COMIS_WITH_XVFB=0
ARG COMIS_WITH_CLOAKBROWSER=0
ARG CLOAKBROWSER_NPM_VERSION="0.4.10"
ARG PLAYWRIGHT_CORE_NPM_VERSION="1.61.1"

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
        wget \
        ca-certificates \
        dumb-init \
        # Archive utils -- needed by language installers (rustup, npm tarballs,
        # pipx venv prep, go module fetches, deno/bun installers)
        unzip \
        xz-utils \
        bzip2 \
        # Git (for config versioning / agent operations)
        git \
        # Python runtime + CLI installer (pipx for Python-based agent tools)
        python3 \
        python3-venv \
        python3-pip \
        pipx \
        # Media processing — TTS, audio/video skills
        ffmpeg \
        # Sandbox for agent-issued exec. Note: inside default Docker the kernel
        # rejects bwrap's userns/mount setup; detect-provider.ts auto-disables
        # the sandbox and exec falls back to /bin/bash -c <cmd> with the
        # container itself as the trust boundary. The binary is still installed
        # for hosts where bwrap CAN run (rootless Docker with userns mapping,
        # privileged containers, etc.).
        bubblewrap \
        # Go toolchain -- agent exec sandbox supports `go install <pkg>` and
        # similar via $GOPATH workspace redirect (wrapEnv).
        golang-go \
        # Optional user-specified packages
        ${COMIS_DOCKER_APT_PACKAGES} \
    && rm -rf /var/cache/apt/archives/*.deb

# Install the DuckDB CLI for the orchestrate `sql`/`jsonpath` ResultRef query
# engine. DuckDB is a single static binary — NOT in the Debian apt
# repos (`apt-get install duckdb` would FAIL) and NOT an npm package, so we fetch
# the pinned, checksummed release-page static binary. `dpkg --print-architecture`
# yields `amd64`/`arm64`, which match DuckDB's release asset names. A failed
# download or checksum fails the image build so published images have the
# runtime capabilities they declare.
ARG COMIS_DUCKDB_VERSION="1.5.4"
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sha256="1f2fa724fb054b3dbe1a9cbd13de5b76997d850e7087ec762ba88db04e0180cf" ;; \
      arm64) sha256="377f03fb9f17ab5a78f28f829cbfcb5333da8ab3c2d0788f27694f81df77ed29" ;; \
      *) echo "No verified DuckDB artifact for $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/duckdb/duckdb/releases/download/v${COMIS_DUCKDB_VERSION}/duckdb_cli-linux-${arch}.zip"; \
    curl -LsSf "$url" -o /tmp/duckdb_cli.zip; \
    printf '%s  %s\n' "$sha256" /tmp/duckdb_cli.zip | sha256sum -c -; \
    unzip -o /tmp/duckdb_cli.zip -d /usr/local/bin duckdb; \
    chmod 755 /usr/local/bin/duckdb; \
    rm -f /tmp/duckdb_cli.zip; \
    /usr/local/bin/duckdb --version

# Install uv/uvx for Python-based MCP servers from a pinned, checksummed release.
ARG COMIS_UV_VERSION="0.11.8"
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target="x86_64-unknown-linux-gnu"; sha256="56dd1b66701ecb62fe896abb919444e4b83c5e8645cca953e6ddd496ff8a0feb" ;; \
      arm64) target="aarch64-unknown-linux-gnu"; sha256="eee8dd658d20e5ac85fec9c2326b6cbc9d83a1eef09ef07433e58698ac849591" ;; \
      *) echo "No verified uv artifact for $arch" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/uv.tar.gz"; \
    url="https://github.com/astral-sh/uv/releases/download/${COMIS_UV_VERSION}/uv-${target}.tar.gz"; \
    curl -LsSf "$url" -o "$archive"; \
    printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c -; \
    tar -xzf "$archive" -C /tmp; \
    install -m 0755 "/tmp/uv-${target}/uv" "/tmp/uv-${target}/uvx" /usr/local/bin/; \
    rm -rf "$archive" "/tmp/uv-${target}"; \
    uv --version

# Install rustup from a pinned, checksummed binary, then install a pinned Rust
# toolchain. Mirrors install_rust() in install.sh. CARGO_HOME and
# RUSTUP_HOME are placed at /usr/local/{cargo,rustup} so they live under the
# image's read-only system tree. Symlinks into /usr/local/bin put cargo/rustc/
# rustup on PATH for any user. /etc/profile.d/rustup.sh exports the env vars
# for login shells (bare-metal install.sh writes the same file). --profile
# minimal keeps the install lean (~150MB instead of ~500MB). Installation and
# checksum failures stop the image build.
ARG COMIS_RUSTUP_VERSION="1.28.2"
ARG COMIS_RUST_TOOLCHAIN_VERSION="1.95.0"
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target="x86_64-unknown-linux-gnu"; sha256="20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c" ;; \
      arm64) target="aarch64-unknown-linux-gnu"; sha256="e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c" ;; \
      *) echo "No verified rustup artifact for $arch" >&2; exit 1 ;; \
    esac; \
    rustup_init=/tmp/rustup-init; \
    url="https://static.rust-lang.org/rustup/archive/${COMIS_RUSTUP_VERSION}/${target}/rustup-init"; \
    curl -LsSf "$url" -o "$rustup_init"; \
    printf '%s  %s\n' "$sha256" "$rustup_init" | sha256sum -c -; \
    chmod 0755 "$rustup_init"; \
    env CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup \
        "$rustup_init" -y --no-modify-path --default-toolchain "$COMIS_RUST_TOOLCHAIN_VERSION" --profile minimal; \
    for bin in cargo rustc rustup; do \
        ln -sf "/usr/local/cargo/bin/$bin" "/usr/local/bin/$bin"; \
    done; \
    printf '%s\n%s\n%s\n' \
        '# Comis-managed: makes the system rustup install discoverable to all login shells.' \
        'export RUSTUP_HOME=/usr/local/rustup' \
        'export CARGO_HOME=/usr/local/cargo' \
        > /etc/profile.d/rustup.sh; \
    chmod 644 /etc/profile.d/rustup.sh; \
    env CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup rustc --version

# Daemon process must see RUSTUP_HOME / CARGO_HOME as well so cargo works for
# any agent flow that goes through the daemon (mirrors the systemd unit's
# Environment= lines on the bare-metal install path).
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo

# Enable corepack (non-root writable location)
# Pin pnpm to match the build stage. MUST stay in lockstep with the
# line-~16 pin so build and runtime use identical pnpm semantics.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN mkdir -p "$COREPACK_HOME" && chmod 777 "$COREPACK_HOME" && \
    corepack enable && corepack prepare pnpm@10.34.4 --activate

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
    mkdir -p /home/comis/.comis && chown comis:comis /home/comis/.comis && \
    mkdir -p /etc/comis && chown comis:comis /etc/comis

# ─── Browser-tool runtime (optional, gated on build args) ───────────────────
# Mirrors install.sh's install_browser_deps_linux. Three layers:
#   1. Shared libs needed by any Chromium-family browser running headless.
#      (Same list as install.sh; Debian bookworm names — no t64 transition
#      to worry about on the base image used here.)
#   2. The browser binary:
#        * --with-browser   → Google Chrome from Google's official apt repo
#        * --with-cloakbrowser → CloakBrowser Chromium via npm (the
#          binary auto-downloads to ~/.cloakbrowser/ on first launch; we
#          pre-pull it at build time so the container's first browser tool
#          call doesn't stall on a 200 MB fetch).
#   3. Xvfb when --with-xvfb is on, so the daemon can run headed against a
#      virtual display for workflows that require a visible display server.
#
# Skipped entirely when all three args are 0 (the default) — keeps the
# baseline image lean.
RUN if [ "${COMIS_WITH_BROWSER}" = "1" ] || [ "${COMIS_WITH_XVFB}" = "1" ] || [ "${COMIS_WITH_CLOAKBROWSER}" = "1" ]; then \
        set -eux; \
        export DEBIAN_FRONTEND=noninteractive; \
        apt-get update; \
        apt-get install -y --no-install-recommends \
            libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
            libcups2 libxkbcommon0 libxcomposite1 libxdamage1 libxext6 \
            libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libdrm2 \
            libasound2 fonts-liberation fonts-noto-color-emoji gnupg; \
        if [ "${COMIS_WITH_XVFB}" = "1" ]; then \
            apt-get install -y --no-install-recommends xvfb; \
        fi; \
        if [ "${COMIS_WITH_CLOAKBROWSER}" != "1" ]; then \
            # Stock Chrome via Google's apt repo. Pinned via signed-by keyring
            # so we don't touch the global trust store.
            install -d -m 0755 /etc/apt/keyrings; \
            curl -fsSL --proto '=https' --tlsv1.2 \
                https://dl.google.com/linux/linux_signing_key.pub \
                | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg; \
            echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
                > /etc/apt/sources.list.d/google-chrome.list; \
            apt-get update; \
            apt-get install -y --no-install-recommends google-chrome-stable; \
            # Pre-create Chrome's out-of-profile write paths and chown to comis
            # so first launch doesn't fail trying to mkdir under a read-only
            # bind-mount (matches register_service_systemd dir setup).
            mkdir -p /home/comis/.config/google-chrome \
                     /home/comis/.local/share/applications \
                     /home/comis/.config/comis/browser; \
        fi; \
        if [ "${COMIS_WITH_CLOAKBROWSER}" = "1" ]; then \
            # Install the npm wrapper system-wide, then run `cloakbrowser
            # install` as the comis user so the binary cache lands at
            # /home/comis/.cloakbrowser/ — where chrome-detection.ts looks
            # for it.
            mkdir -p /opt/cloakbrowser-wrapper; \
            chown -R comis:comis /opt/cloakbrowser-wrapper; \
            printf '%s\n' '{"name":"cloakbrowser-wrapper","version":"0.0.0","private":true}' \
                > /opt/cloakbrowser-wrapper/package.json; \
            chown comis:comis /opt/cloakbrowser-wrapper/package.json; \
            su - comis -c "cd /opt/cloakbrowser-wrapper && npm install --no-audit --no-fund --silent --save-exact cloakbrowser@${CLOAKBROWSER_NPM_VERSION} playwright-core@${PLAYWRIGHT_CORE_NPM_VERSION}"; \
            # Pre-pull the Chromium binary (~140-210 MB depending on
            # release). Filter the per-MB progress chatter so the build log
            # stays readable.
            if ! su - comis -c "/opt/cloakbrowser-wrapper/node_modules/.bin/cloakbrowser install" > /tmp/cloakbrowser-install.log 2>&1; then \
                sed -E '/Download progress:/d' /tmp/cloakbrowser-install.log >&2; \
                exit 1; \
            fi; \
            sed -E '/Download progress:/d' /tmp/cloakbrowser-install.log; \
            rm -f /tmp/cloakbrowser-install.log; \
            mkdir -p /home/comis/.config/comis/browser /home/comis/.config/chromium; \
            chown -R comis:comis /home/comis/.cloakbrowser /home/comis/.config; \
        fi; \
        rm -rf /var/cache/apt/archives/*.deb /var/lib/apt/lists/*; \
    fi

# Propagate the build choice to the runtime entrypoint. The shim at
# /usr/local/bin/comis-entrypoint.sh checks this to decide whether to start
# Xvfb. Defaulting to "0" means zero-arg image builds never start Xvfb.
ENV COMIS_WITH_XVFB="${COMIS_WITH_XVFB}"

# Seed a browser config block when any browser flag is set. Same shape as
# maybe_seed_browser_config in install.sh — headless=false when Xvfb is
# present so the daemon uses the virtual display. The daemon reads its
# config from /home/comis/.comis/config.yaml at startup; if a user mounts
# their own config, theirs wins (we only write if the file doesn't exist).
RUN if [ "${COMIS_WITH_BROWSER}" = "1" ] || [ "${COMIS_WITH_XVFB}" = "1" ] || [ "${COMIS_WITH_CLOAKBROWSER}" = "1" ]; then \
        if [ ! -f /home/comis/.comis/config.yaml ]; then \
            HL="true"; \
            [ "${COMIS_WITH_XVFB}" = "1" ] && HL="false"; \
            SRC="--with-browser"; \
            [ "${COMIS_WITH_CLOAKBROWSER}" = "1" ] && SRC="--with-cloakbrowser"; \
            [ "${COMIS_WITH_XVFB}" = "1" ] && SRC="${SRC} --with-xvfb"; \
            printf '# Browser tool — installed via %s\n# noSandbox: required because the daemon container runs without\n# CAP_SYS_ADMIN; the Chromium setuid sandbox cannot elevate anyway.\nbrowser:\n  enabled: true\n  noSandbox: true\n  headless: %s\n' \
                "${SRC}" "${HL}" > /home/comis/.comis/config.yaml; \
            chown comis:comis /home/comis/.comis/config.yaml; \
        fi; \
    fi

# Copy built application
COPY --from=runtime-assets --chown=comis:comis /app /app

# Copy web SPA dist (for optional serving via gateway)
COPY --from=build --chown=comis:comis /build/packages/web/dist /app/packages/web/dist

# Create CLI symlink
RUN ln -sf /app/packages/cli/dist/cli.js /usr/local/bin/comis && \
    chmod +x /app/packages/cli/dist/cli.js

# Install the entrypoint shim. Responsible for starting Xvfb (when the image
# was built with --with-xvfb) before exec'ing the daemon. Equivalent to the
# comis-xvfb.service companion unit on the systemd install path.
COPY --chown=root:root docker/comis-entrypoint.sh /usr/local/bin/comis-entrypoint.sh
RUN chmod 0755 /usr/local/bin/comis-entrypoint.sh

# Switch to non-root user
USER comis

# Pre-warm the default agent's workspace venv with matplotlib + numpy +
# pandas. Subsequent chart-tool calls reuse the venv -- no 15s pip-install
# in the hot path, no `Fontconfig error` from a non-writable host cache.
# The agent's exec-tool merges `${workspace}/venv/bin` onto PATH and points
# MPLCONFIGDIR / XDG_CACHE_HOME at workspace-internal dirs (see
# packages/skills/src/builtin/exec-tool.ts and
# packages/agent/src/workspace/data-env.ts).
#
# Trade-off: image size goes up ~200-300 MB. Operators on disk-constrained
# hosts can use the slim variant (which still ships the venv pre-warm;
# the saving is in the base layer, not in the agent venv).
#
# Volume-mount nuance: `/home/comis/.comis` is declared as a VOLUME below.
# Anonymous volumes (`docker run` without `-v`) and empty named volumes
# (first-run `docker run -v comis-data:...`) are auto-initialized from the
# image's content -- so the venv IS preserved on first start. Subsequent
# starts reuse the now-persisted venv on the user's volume. Existing
# non-empty volumes shadow this layer; this is acceptable because the
# on-demand `pip install` path still works for pre-existing volumes.
#
# Non-default agents (workspace-${agentId}) pip-install on-demand on first
# use; the pre-warm only covers the default agent's workspace. KISS:
# single RUN, --no-cache-dir, no multi-stage build complications.
RUN mkdir -p /home/comis/.comis/workspace && \
    python3 -m venv /home/comis/.comis/workspace/venv && \
    /home/comis/.comis/workspace/venv/bin/pip install --no-cache-dir --disable-pip-version-check \
        matplotlib==3.9.2 numpy==2.1.0 pandas==2.2.3 requests==2.32.3

# Default environment.
# COMIS_GATEWAY_HOST=0.0.0.0 — the container's network namespace is isolated, so
# binding to all interfaces inside the container is the standard pattern (postgres,
# redis, nginx images do the same). External exposure is still gated by `docker run -p`
# / compose `ports:`. Without this, the daemon would default to 127.0.0.1 and
# `docker run -p 4766:4766` would connection-reset because nothing listens on the
# container's external interface.
#
# COMIS_CONFIG_PATHS is intentionally NOT set here. Without it, the daemon falls
# back to its built-in default search path: ~/.comis/config.yaml (i.e.
# /home/comis/.comis/config.yaml inside this image), which is the standard mount
# point for `docker run -v comis-data:/home/comis/.comis`. Compose deployments
# that prefer /etc/comis/config.yaml set COMIS_CONFIG_PATHS explicitly in the
# compose file. Setting it here would silently override the home-dir default
# and ignore the user's mounted config when /etc/comis isn't mounted.
ENV NODE_ENV=production \
    COMIS_DATA_DIR=/home/comis/.comis \
    COMIS_GATEWAY_HOST=0.0.0.0

# Declare the data volume so `docker image inspect` documents the persistence
# path and anonymous volumes are auto-created when users skip `-v`.
VOLUME ["/home/comis/.comis"]

# Expose gateway port
EXPOSE 4766

# Health check — daemon /health endpoint
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -sf http://127.0.0.1:4766/health || exit 1

# Use dumb-init for proper PID 1 signal handling, then the shim which
# optionally starts Xvfb before exec'ing the daemon (CMD).
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/comis-entrypoint.sh"]

# Start daemon (the shim execs whatever is passed; this is the default).
CMD ["node", "packages/daemon/dist/daemon.js"]

# OCI metadata
LABEL org.opencontainers.image.source="https://github.com/comisai/comis" \
      org.opencontainers.image.title="Comis" \
      org.opencontainers.image.description="Open-source runtime for AI agents you leave running" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Comis"
