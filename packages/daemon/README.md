# @comis/daemon

Background daemon and service orchestrator for the [Comis](https://github.com/comisai/comis) platform. This is the main entry point that wires all packages together and runs as a long-lived process.

## What's Inside

### Orchestration

The daemon's `main()` function coordinates setup factories that wire the full application:

1. **Logging** -- Pino structured logging with rotation
2. **Credential storage** -- Selects encrypted, file-backed, or read-only environment storage from `security.storage`; encrypted storage is the default and uses AES-256-GCM
3. **Memory** -- SQLite databases, embedding providers, vector search
4. **Agents** -- Executor, session lifecycle, context engine, budget guards
5. **Schedulers** -- Cron engine, heartbeat runners, task extraction
6. **Skills** -- Skill registry, MCP servers, built-in tools, media integrations
7. **Channels** -- Platform adapters (Telegram, Discord, Slack, etc.)
8. **Gateway** -- HTTP server, JSON-RPC, WebSocket, mTLS
9. **Monitoring** -- Health checks, observability, latency tracking
10. **Shutdown** -- Graceful shutdown coordination

### RPC Handlers

RPC handlers cover context management, agent operations, session queries, configuration updates, diagnostics, and system administration.

### Process Management

- **Graceful shutdown** -- Coordinates shutdown across all subsystems (channels disconnect, gateway closes, schedulers stop, databases flush)
- **Observability** -- Token usage persistence, delivery metrics, latency recording, log-level management

## Running

```bash
# Installed CLI
comis daemon start
comis daemon status
comis daemon logs

# Direct development run
COMIS_CONFIG_PATHS="$HOME/.comis/config.yaml" node packages/daemon/dist/daemon-entrypoint.js
```

## Part of Comis

This package is part of [Comis](https://github.com/comisai/comis), an open-source, security-first platform for AI agent teams.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
