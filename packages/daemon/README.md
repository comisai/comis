# @comis/daemon

Background daemon and service orchestrator for the [Comis](https://github.com/comisai/comis) platform. This is the main entry point that wires all packages together and runs as a long-lived process.

## What's Inside

### Orchestration

The daemon's `main()` function calls 30+ `setupXxx()` factory functions in sequence to wire the full application:

1. **Logging** -- Pino structured logging with rotation
2. **Secrets** -- AES-256-GCM encrypted secret store initialization
3. **Memory** -- SQLite databases, embedding providers, vector search
4. **Agents** -- Executor, session lifecycle, context engine, budget guards
5. **Schedulers** -- Cron engine, heartbeat runners, task extraction
6. **Skills** -- Skill registry, MCP servers, built-in tools, media integrations
7. **Channels** -- Platform adapters (Telegram, Discord, Slack, etc.)
8. **Gateway** -- HTTP server, JSON-RPC, WebSocket, mTLS
9. **Monitoring** -- Health checks, observability, latency tracking
10. **Shutdown** -- Graceful shutdown coordination

### Sub-agent Runner

- **`createSubAgentRunner()`** -- Manages sub-agent spawn lifecycle: enforces concurrency limits, tracks active runs, sweeps result files from disk
- **Dead-letter queue** -- Captures failed announcement deliveries for retry

### RPC Handlers

55+ RPC handler implementations for context management, agent operations, session queries, config updates, and system administration.

### Process Management

- **Graceful shutdown** -- Coordinates shutdown across all subsystems (channels disconnect, gateway closes, schedulers stop, databases flush)
- **Observability** -- Token usage persistence, delivery metrics, latency recording, log-level management

## Running

```bash
# Via PM2 (recommended)
npm install -g pm2
node packages/cli/dist/cli.js pm2 setup
node packages/cli/dist/cli.js pm2 start

# Direct
COMIS_CONFIG_PATHS="$HOME/.comis/config.yaml" node packages/daemon/dist/daemon.js
```

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

```bash
npm install comisai
```

## License

[Apache-2.0](../../LICENSE)
