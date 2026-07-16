# Comis

Comis is an open-source security-first runtime for AI agents that learn and act
across sessions.

This image runs the Comis daemon, gateway, agents, scheduler, memory, and
messaging adapters in one container. Learned guidance can influence what an
agent proposes, but it cannot grant permission. Capabilities, credential scope,
tool policy, and configured limits remain in the runtime.

> **Development status:** Comis is under active development and does not support backward compatibility. Evaluate the exact provider, channel, tool, storage, and isolation configuration you need before using it for critical workloads.

- **Source:** https://github.com/comisai/comis
- **Docs:** https://docs.comis.ai
- **License:** Apache-2.0

---

## Supported architectures

`linux/amd64` · `linux/arm64`

## Variants

| Variant | Base image | When to use |
|---------|------------|-------------|
| `latest` (default) | `node:22-bookworm` | Full Debian runtime base. |
| `latest-slim` | `node:22-bookworm-slim` | Smaller Debian runtime base. |

## Tag strategy

Every release pushes the following tags automatically:

| Pattern | Example | Notes |
|---------|---------|-------|
| `{version}` | `X.Y.Z` | Immutable release tag |
| `{major}.{minor}` | `X.Y` | Tracks the latest patch |
| `latest` | `latest` | Default variant, latest release |
| `{version}-slim` | `X.Y.Z-slim` | Slim variant, immutable |
| `{major}.{minor}-slim` | `X.Y-slim` | Slim variant, latest patch |
| `latest-slim` | `latest-slim` | Slim variant, latest release |

For repeatable deployments, replace the moving `latest` tag with an immutable release tag such as `comisai/comis:X.Y.Z-slim`.

---

## Quick start

```bash
docker pull comisai/comis:latest-slim

docker run -d \
  --name comis \
  --restart unless-stopped \
  -p 127.0.0.1:4766:4766 \
  -v comis-data:/home/comis/.comis \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  comisai/comis:latest-slim
```

The `--restart unless-stopped` policy lets Docker relaunch the daemon after `gateway.restart` or a configuration write triggers a graceful restart. Secret writes through `env_set` are live-applied and do not trigger a restart.

Verify:

```bash
curl http://127.0.0.1:4766/health
```

This example is for initial evaluation. Pin an immutable release tag, configure gateway authentication, and review the [threat model](https://github.com/comisai/comis/blob/main/THREAT_MODEL.md) before exposing the service beyond localhost.

> **Already running Comis on the host?** Don't bind-mount your existing `~/.comis` into the container — the host's `config.yaml` may reference env vars that aren't set in the container, and both daemons would race on the SQLite databases. Use a Docker named volume (as above) or a separate host directory (e.g. `~/.comis-docker`).

## Docker Compose

```yaml
services:
  comis-daemon:
    image: comisai/comis:latest-slim
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:4766:4766"
    volumes:
      - comis-data:/home/comis/.comis
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}
      - SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}
      - COMIS_GATEWAY_HOST=0.0.0.0
      - COMIS_GATEWAY_PORT=4766

volumes:
  comis-data:
```

With the default encrypted storage mode, the daemon generates `SECRETS_MASTER_KEY` in the mounted data directory's `.env` on first boot. Back up that file, and do not add an empty `SECRETS_MASTER_KEY` entry to the container environment: it would override the generated value and prevent the encrypted store from opening.

A full `docker-compose.yml` (with the optional `comis-web` dashboard and `comis-cli` profiles, plus a host-bind variant) ships in the [GitHub repo](https://github.com/comisai/comis/blob/main/docker-compose.yml).

---

## Configuration

### Ports

| Port | Purpose |
|------|---------|
| `4766` | HTTP gateway (REST + WebSocket) |

### Volumes

| Path | Purpose |
|------|---------|
| `/home/comis/.comis` | All persistent state — SQLite DBs, logs, traces, secrets, `config.yaml`, `.env`. The daemon's data dir and config dir resolve to the same path inside the container. |

> **Note:** if you bind-mount `config.yaml` from a separate read-only path (e.g. `/etc/comis:ro`), the daemon cannot write its `config.last-good.yaml` snapshot to that directory. Either keep the config writable or edit `config.yaml` from the host when recovering from a bad config.

### Common environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `COMIS_GATEWAY_HOST` | Bind address **inside the container** (separate from the host-side `-p` mapping). Defaults to `0.0.0.0` in the image so Docker port-forwarding can reach the daemon. |
| `COMIS_GATEWAY_PORT` | Gateway port (default `4766`) |
| `COMIS_GATEWAY_TOKEN` | Optional bearer token for gateway auth |
| `SECRETS_MASTER_KEY` | Auto-generated on first boot and written to `~/.comis/.env` (mode 0600). Back up this file — losing the key makes `secrets.db` permanently unreadable. To provide your own key, write a non-empty value to the mounted `.env` before first boot. A blank mounted-file entry suppresses generation; an empty container value overrides the generated value. See [Secrets management](https://docs.comis.ai/operations/docker#secrets-management). |

Secrets are auto-redacted in Comis logs (3 levels deep) — but never log them yourself.

---

## Browser runtime (optional)

Browser dependencies are disabled in the standard image. Build arguments enable the runtime needed by browser tools:

| Build arg | What it adds |
|---|---|
| `COMIS_WITH_BROWSER=1` | Google Chrome and its shared libraries; headless by default. |
| `COMIS_WITH_XVFB=1` | Implies browser support and adds Xvfb for a headed browser on a virtual display. |
| `COMIS_WITH_CLOAKBROWSER=1` | Implies browser support and uses CloakBrowser instead of Google Chrome. Review its separate license before redistribution. |

Build an image with the browser runtime you require:

```bash
# Headless Chrome
docker build \
  --build-arg COMIS_WITH_BROWSER=1 \
  -t comisai/comis:browser .

# Headed Chrome through Xvfb
docker build \
  --build-arg COMIS_WITH_XVFB=1 \
  -t comisai/comis:xvfb .

# Alternative Chromium distribution
docker build \
  --build-arg COMIS_WITH_CLOAKBROWSER=1 \
  -t comisai/comis:cloakbrowser .
```

When `browser.start` runs, Comis discovers the installed browser, launches it with a local CDP endpoint, and connects Playwright. Xvfb starts before the daemon when the image was built with `COMIS_WITH_XVFB=1`; the entrypoint verifies its local X11 socket and stops the container if the display cannot start. Xvfb runs as the container's `comis` user and does not use a host X server. Browser automation remains subject to each site's terms and access controls.

### Installer-built image (alternative path)

The repo also ships `Dockerfile.install`. It packs the local workspace and runs the non-interactive, non-root package-install path of `install.sh` inside Ubuntu 24.04. It exercises package installation and selected browser-provisioning branches, but deliberately skips interactive setup, initialization, service registration, service start, dedicated-user creation, and the public-registry download path. It is an installer validation image, not a host-parity deployment image:

```bash
docker build -f Dockerfile.install \
  --build-arg COMIS_WITH_CLOAKBROWSER=1 \
  --build-arg COMIS_WITH_XVFB=1 \
  -t comis-installed:cloak-xvfb .
```

The main `Dockerfile` is the primary multi-stage image path. `Dockerfile.install` exists to validate the managed-host installer in a container.

---

## Security

- Runs as non-root user `comis` (UID/GID 1000)
- `dumb-init` as PID 1 for proper signal handling
- Built-in `HEALTHCHECK` against `/health`
- Multi-stage build — Comis TypeScript source and development dependencies are removed from the runtime image
- Pino auto-redacts credentials (`apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey`, `cookie`, `webhookSecret`)

---

## Companion images

- **[`comisai/comis-web`](https://hub.docker.com/r/comisai/comis-web)** — web dashboard SPA (served by Nginx, optional)

---

## Links

- **Documentation:** https://docs.comis.ai
- **Install with Docker:** https://docs.comis.ai/installation/install-docker
- **Docker operations guide:** https://docs.comis.ai/operations/docker
- **Issues:** https://github.com/comisai/comis/issues
- **Releases:** https://github.com/comisai/comis/releases
