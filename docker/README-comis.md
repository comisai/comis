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
| `{version}` | `1.0.45` | Immutable — pin this in production |
| `{major}.{minor}` | `1.0` | Tracks the latest patch |
| `latest` | `latest` | Default variant, latest release |
| `{version}-slim` | `1.0.45-slim` | Slim variant, immutable |
| `{major}.{minor}-slim` | `1.0-slim` | Slim variant, latest patch |
| `latest-slim` | `latest-slim` | Slim variant, latest release |

> **Tip:** Pin to an immutable version tag in production (e.g. `comisai/comis:1.0.45`) rather than `latest`.

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
      # Auto-generated on first boot. Back up ~/.comis/.env (contains SECRETS_MASTER_KEY).
      # To opt out: set COMIS_DISABLE_ENCRYPTED_SECRETS=1
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
| `COMIS_GATEWAY_HOST` | Bind address **inside the container** (separate from the host-side `-p` mapping). Defaults to `0.0.0.0` in the image so Docker port-forwarding can reach the daemon. |
| `COMIS_GATEWAY_PORT` | Gateway port (default `4766`) |
| `COMIS_GATEWAY_TOKEN` | Optional bearer token for gateway auth |
| `SECRETS_MASTER_KEY` | Auto-generated on first boot and written to `~/.comis/.env` (mode 0600). Back up this file — losing the key makes `secrets.db` permanently unreadable. Providing this variable explicitly overrides the auto-generated value. See [Secrets management](https://docs.comis.ai/operations/docker#secrets-management). |
| `COMIS_DISABLE_ENCRYPTED_SECRETS` | **Optional.** Set to `1` to skip auto-init and run in envfile-only mode. Emits a startup WARN. Use only if you need to manage secrets manually in `.env`. |

Secrets are auto-redacted in Comis logs (3 levels deep) — but never log them yourself.

---

## Browser tool (optional)

Off by default. Three build args mirror the bare-VPS `install.sh` flags:

| Build arg | What it adds |
|---|---|
| `COMIS_WITH_BROWSER=1` | Google Chrome + Chromium shared libs. Headless by default. |
| `COMIS_WITH_XVFB=1` | Implies `COMIS_WITH_BROWSER`. Adds Xvfb so the daemon can run headed against a virtual display (needed for sites that detect headless mode). Entrypoint starts Xvfb on `:99` before the daemon. Seeds `headless: false` in the default config. |
| `COMIS_WITH_CLOAKBROWSER=1` | Implies `COMIS_WITH_BROWSER`. Installs CloakBrowser (stealth Chromium with source-level fingerprint patches) instead of Google Chrome. `findChrome()` auto-picks the cloak binary. |

Build a stealth-capable image:

```bash
# Stock Chrome — works for most sites
docker build \
  --build-arg COMIS_WITH_BROWSER=1 \
  -t comisai/comis:browser .

# Headed via Xvfb — pass BrowserScan/bot.incolumitas
docker build \
  --build-arg COMIS_WITH_XVFB=1 \
  -t comisai/comis:xvfb .

# Stealth Chromium — bypass Cloudflare Turnstile, FingerprintJS,
# Reddit's secondary fingerprint check on non-datacenter IPs
docker build \
  --build-arg COMIS_WITH_CLOAKBROWSER=1 \
  -t comisai/comis:cloak .

# Full stack — stealth Chromium + headed for the hardest tier
docker build \
  --build-arg COMIS_WITH_CLOAKBROWSER=1 \
  --build-arg COMIS_WITH_XVFB=1 \
  -t comisai/comis:cloak-xvfb .
```

Run identically to the no-browser image; the daemon detects the binary at startup and uses it via CDP. No env vars needed.

```bash
docker run -d \
  --name comis \
  --restart unless-stopped \
  -p 127.0.0.1:4766:4766 \
  -v comis-data:/home/comis/.comis \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  comisai/comis:cloak-xvfb
```

**Image-size impact:**

| Image | Approx size |
|---|---|
| Base (no browser) | 700 MB (slim) / 1 GB (default) |
| `+browser`  (Google Chrome) | +400 MB |
| `+xvfb` | +15 MB on top of `+browser` |
| `+cloakbrowser` | +500 MB (CloakBrowser binary cache, two versions kept for auto-rollback) |

**Caveats:**

- **Datacenter IPs (AWS, DigitalOcean, Hetzner, Hostinger, …)** are pre-blocked by Reddit and many social sites regardless of browser fingerprint. CloakBrowser does not provide a proxy. If your container runs on a datacenter ASN, you'll also need a residential proxy.
- **CloakBrowser license:** free for self-hosted use. Bundling into a hosted service distributed to third-party customers requires an OEM license from CloakHQ. See [BINARY-LICENSE.md](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md).
- **Xvfb** runs as the same `comis` user, inside the container's own namespace — no host-level X server is involved.

### Installer-built image (alternative path)

The repo also ships `Dockerfile.install` — a fresh Ubuntu 24.04 image that runs `install.sh` end-to-end inside the container. Same flags, same end state, but exercises the bare-VPS install path verbatim. Useful for CI testing the installer or for operators who want strict parity with their VPS deploy:

```bash
docker build -f Dockerfile.install \
  --build-arg COMIS_WITH_CLOAKBROWSER=1 \
  --build-arg COMIS_WITH_XVFB=1 \
  -t comis-installed:cloak-xvfb .
```

The main `Dockerfile` is the production-grade path (multi-stage, smaller). `Dockerfile.install` is the validation path.

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
