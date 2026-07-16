# @comis/cli

Command-line interface for the [Comis](https://github.com/comisai/comis) governed agent runtime.

## Install

```bash
npm install --global comisai
```

## Common Commands

| Command | Description |
|---------|-------------|
| `comis init` | Initialize a new Comis installation |
| `comis configure` | Interactively manage supported configuration sections |
| `comis daemon start\|stop\|status\|logs` | Manage the background daemon |
| `comis pm2 setup\|start\|stop` | PM2 process management integration |
| `comis status` | Show daemon and channel status |
| `comis health` | Show current system health issues |
| `comis doctor` | Diagnose configuration, runtime, channel, credential, and storage issues |
| `comis agent list\|create\|configure\|delete` | Manage agents |
| `comis auth login\|list\|...` | Manage OAuth provider credentials |
| `comis channel status` | Show channel connection status |
| `comis sessions list\|inspect\|...` | Browse and manage sessions |
| `comis memory search\|inspect\|stats\|...` | Query and manage agent memory |
| `comis config validate\|show\|set\|...` | Validate, view, and modify configuration |
| `comis models list\|set` | List models or set an agent model |
| `comis providers list` | List provider profiles |
| `comis secrets init\|set\|list\|...` | Manage encrypted credentials |
| `comis security audit\|fix\|audit-log` | Audit security controls and review decisions |
| `comis reset` | Reset agent state |
| `comis signal-setup` | Signal messenger setup helper |
| `comis uninstall` | Remove the Comis installation |

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

# Start the daemon
comis daemon start

# Check status
comis status
comis health

# Manage agents
comis agent list
comis agent configure my-agent
```

## Part of Comis

Run `comis --help` or `comis <command> --help` for the authoritative command surface.

This package is part of [Comis](https://github.com/comisai/comis), an open-source agent runtime for governed execution.

## License

[Apache-2.0](../../LICENSE)
