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
| `{version}` | `1.0.21` | Immutable — pin this in production |
| `{major}.{minor}` | `1.0` | Tracks the latest patch |
| `latest` | `latest` | Default variant, latest release |
| `{version}-slim` | `1.0.21-slim` | Slim variant, immutable |
| `{major}.{minor}-slim` | `1.0-slim` | Slim variant, latest patch |
| `latest-slim` | `latest-slim` | Slim variant, latest release |

> **Tip:** Pin to an immutable version tag in production (e.g. `comisai/comis:1.0.21`) rather than `latest`.

---

## Quick start

```bash
docker pull comisai/comis:latest-slim

docker run -d \
  --name comis \
  -p 127.0.0.1:4766:4766 \
  -v "$HOME/.comis:/data" \
  -v "$HOME/.comis:/etc/comis:ro" \
  -e SECRETS_MASTER_KEY="$(openssl rand -hex 32)" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  comisai/comis:latest-slim
```

Verify:

```bash
curl http://127.0.0.1:4766/health
```

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
      - ~/.comis:/data
      - ~/.comis:/etc/comis:ro
    environment:
      - SECRETS_MASTER_KEY=${SECRETS_MASTER_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN:-}
      - SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}
      - COMIS_GATEWAY_HOST=0.0.0.0
      - COMIS_GATEWAY_PORT=4766
```

A full `docker-compose.yml` (with the optional `comis-web` dashboard and `comis-cli` profiles) ships in the [GitHub repo](https://github.com/comisai/comis/blob/main/docker-compose.yml).

---

## Configuration

### Ports

| Port | Purpose |
|------|---------|
| `4766` | HTTP gateway (REST + WebSocket) |

### Volumes

| Path | Purpose |
|------|---------|
| `/data` | Persistent state — SQLite DBs, logs, traces, secrets |
| `/etc/comis` | Config directory — mount your `config.yaml` here (read-only recommended) |

### Required environment variables

| Variable | Description |
|----------|-------------|
| `SECRETS_MASTER_KEY` | 32-byte hex key for encrypting secrets at rest. Generate with `openssl rand -hex 32`. |

### Common environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `COMIS_GATEWAY_HOST` | Bind address — must be `0.0.0.0` inside the container |
| `COMIS_GATEWAY_PORT` | Gateway port (default `4766`) |
| `COMIS_GATEWAY_TOKEN` | Optional bearer token for gateway auth |

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
