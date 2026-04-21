# @comis/cli

Command-line interface for the [Comis](https://github.com/comisai/comis) AI agent platform.

## Install

```bash
npm install -g comisai
```

## Commands

| Command | Description |
|---------|-------------|
| `comis init` | Initialize a new Comis installation |
| `comis configure` | Interactive setup wizard for channels, providers, and agents |
| `comis daemon start\|stop\|restart` | Manage the background daemon |
| `comis pm2 setup\|start\|stop` | PM2 process management integration |
| `comis status` | Show daemon and channel status |
| `comis health` | Run health checks |
| `comis doctor` | Diagnose configuration and connectivity issues |
| `comis agent list\|info\|...` | Manage agents |
| `comis channel list\|info\|...` | Manage channel connections |
| `comis session list\|info\|...` | Browse and manage sessions |
| `comis memory search\|info\|...` | Query agent memory |
| `comis config get\|set\|...` | View and modify configuration |
| `comis models` | List available LLM models |
| `comis secrets` | Manage encrypted credentials |
| `comis security` | Run security checks |
| `comis reset` | Reset agent state |
| `comis signal-setup` | Signal messenger setup helper |

## Features

- **Interactive wizard** -- Guided setup via [@clack/prompts](https://github.com/natemoo-re/clack) with validation
- **RPC client** -- WebSocket-based communication with the running daemon
- **Doctor diagnostics** -- Checks config, connectivity, credentials, and channel health
- **Formatted output** -- Tables, spinners, colored status indicators
- **PM2 integration** -- Generate ecosystem config, manage daemon lifecycle

## Usage

```bash
# First-time setup
comis init
comis configure

# Start the daemon
comis pm2 setup    # one-time
comis pm2 start

# Check status
comis status
comis health

# Manage agents
comis agent list
comis agent info my-agent
```

## Part of Comis

This package is part of the [Comis](https://github.com/comisai/comis) monorepo -- a security-first AI agent platform connecting agents to Discord, Telegram, Slack, WhatsApp, and more.

## License

[Apache-2.0](../../LICENSE)
