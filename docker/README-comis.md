# Comis — Daemon + Gateway

Security-first AI agent platform connecting agents to chat channels (Discord, Telegram, Slack, WhatsApp, iMessage, Signal, IRC, LINE, Email).

This image runs the **Comis daemon** — gateway, channels, agents, scheduler, and memory — as a single container.

- **Source:** https://github.com/comisai/comis
- **Docs:** https://docs.comis.ai
- **License:** Apache-2.0

---

## Supported architectures

`linux/amd64` · `linux/arm64`

## Variants

| Variant | Base image | When to use |
|---------|------------|-------------|
| `latest` (default) | `node:22-bookworm` | Includes extra debugging tools. |
| `latest-slim` | `node:22-bookworm-slim` | Smaller image, reduced attack surface. **Recommended for production.** |

## Tag strategy

Every release pushes the following tags automatically:

| Pattern | Example | Notes |
|---------|---------|-------|
| `{version}` | `1.0.27` | Immutable — pin this in production |
| `{major}.{minor}` | `1.0` | Tracks the latest patch |
| `latest` | `latest` | Default variant, latest release |
| `{version}-slim` | `1.0.27-slim` | Slim variant, immutable |
| `{major}.{minor}-slim` | `1.0-slim` | Slim variant, latest patch |
| `latest-slim` | `latest-slim` | Slim variant, latest release |

> **Tip:** Pin to an immutable version tag in production (e.g. `comisai/comis:1.0.27`) rather than `latest`.

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

The `--restart unless-stopped` flag is required — the wizard and any agent-initiated config change (`gateway.restart`, `gateway.env_set`, `gateway.patch`) signal the daemon to reload, and Docker's restart policy is what brings the container back with the new config.

Verify:

```bash
curl http://127.0.0.1:4766/health
```

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
      # Optional — set to enable the encrypted secrets.db (opt-in).
      # Without it the daemon runs in legacy .env mode (default).
      - SECRETS_MASTER_KEY=${SECRETS_MASTER_KEY:-}

volumes:
  comis-data:
```

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
| `COMIS_GATEWAY_HOST` | Bind address **inside the container** (separate from the host-side `-p` mapping). Defaults to `0.0.0.0` since 1.0.25. On older images, set this explicitly so Docker port-forwarding can reach the daemon. |
| `COMIS_GATEWAY_PORT` | Gateway port (default `4766`) |
| `COMIS_GATEWAY_TOKEN` | Optional bearer token for gateway auth |
| `SECRETS_MASTER_KEY` | **Optional.** 32-byte hex key (generate with `openssl rand -hex 32`). When set, the daemon stores credentials in an encrypted `secrets.db`. Without it, the daemon runs in legacy `.env` mode (default). Recommended for production multi-tenant deployments — see [Secrets management](https://docs.comis.ai/operations/docker#secrets-management). |

Secrets are auto-redacted in Comis logs (3 levels deep) — but never log them yourself.

---

## Security

- Runs as non-root user `comis` (UID/GID 1000)
- `dumb-init` as PID 1 for proper signal handling
- Built-in `HEALTHCHECK` against `/health`
- Multi-stage build — no build tools or source in the runtime image
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
