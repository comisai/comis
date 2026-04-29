# Comis Web Dashboard

Web UI for the [Comis](https://github.com/comisai/comis) AI agent platform — agent management, channel configuration, traces, and live event streams.

This image bundles the compiled SPA served by **Nginx** (`nginx:alpine`), with a built-in reverse proxy to the daemon for `/api/*` and `/ws` traffic.

- **Source:** https://github.com/comisai/comis
- **Docs:** https://docs.comis.ai
- **License:** Apache-2.0

---

## Supported architectures

`linux/amd64` · `linux/arm64`

## Tag strategy

| Pattern | Example | Notes |
|---------|---------|-------|
| `{version}` | `1.0.26` | Immutable — pin in production |
| `{major}.{minor}` | `1.0` | Tracks the latest patch |
| `latest` | `latest` | Latest release |

Versions move in lockstep with [`comisai/comis`](https://hub.docker.com/r/comisai/comis) — match the tag to the daemon you're running.

> **Tip:** Pin to an immutable version tag (e.g. `comisai/comis-web:1.0.26`) rather than `latest`.

---

## Quick start

The dashboard is a thin SPA — it expects a Comis daemon reachable at the hostname `comis-daemon` (the default service name in the Compose file).

### Docker Compose (recommended)

```yaml
services:
  comis-daemon:
    image: comisai/comis:latest-slim
    # ... see comisai/comis README for full config

  comis-web:
    image: comisai/comis-web:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    depends_on:
      comis-daemon:
        condition: service_healthy
```

Open http://127.0.0.1:8080.

### Standalone (advanced)

If running outside Compose, expose the daemon to the web container under the hostname `comis-daemon`:

```bash
docker network create comis-net

docker run -d --name comis-daemon --network comis-net \
  comisai/comis:latest-slim

docker run -d --name comis-web --network comis-net \
  -p 127.0.0.1:8080:8080 \
  comisai/comis-web:latest
```

---

## Configuration

### Ports

| Port | Purpose |
|------|---------|
| `8080` | HTTP — SPA + reverse proxy to daemon |

### Built-in routes

| Path | Behavior |
|------|----------|
| `/` | SPA (HTML5 history fallback to `index.html`) |
| `/api/*` | Reverse-proxied to `http://comis-daemon:4766/` |
| `/ws` | WebSocket reverse-proxied to `http://comis-daemon:4766/ws` |
| `*.{js,css,png,svg,woff2,…}` | Cached 30 days, `Cache-Control: public, immutable` |

The daemon hostname is resolved at request time via Docker's embedded DNS (`127.0.0.11`), so the web container can start before the daemon is ready.

### Health

Built-in `HEALTHCHECK` hits `http://127.0.0.1:8080/` every 30 seconds.

---

## Custom Nginx config

Override the bundled config by mounting your own:

```yaml
services:
  comis-web:
    image: comisai/comis-web:latest
    volumes:
      - ./my-nginx.conf:/etc/nginx/conf.d/default.conf:ro
```

The default config lives at [`docker/nginx.conf`](https://github.com/comisai/comis/blob/main/docker/nginx.conf) in the source repo.

---

## Companion images

- **[`comisai/comis`](https://hub.docker.com/r/comisai/comis)** — daemon + gateway (required)

---

## Links

- **Documentation:** https://docs.comis.ai
- **Install with Docker:** https://docs.comis.ai/installation/install-docker
- **Issues:** https://github.com/comisai/comis/issues
- **Releases:** https://github.com/comisai/comis/releases
