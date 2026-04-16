# comisai

Security-first AI agent platform -- connects AI agents to Discord, Telegram, Slack, WhatsApp, Signal, iMessage, IRC, LINE, and Email.

This is the umbrella package that re-exports all Comis modules. Install this to get the complete platform.

## Install

```bash
npm install comisai
```

## Usage

```typescript
// Namespace imports
import { agent, core, channels, skills } from "comisai";

// Sub-path imports (tree-shakeable)
import { AppContainer, bootstrap } from "comisai/core";
import { PiExecutor } from "comisai/agent";
import { createCronScheduler } from "comisai/scheduler";
```

## Sub-path Exports

| Import | Package | Description |
|--------|---------|-------------|
| `comisai/shared` | @comis/shared | Result type, async utilities, TTL cache |
| `comisai/core` | @comis/core | Domain types, ports, event bus, security, config |
| `comisai/infra` | @comis/infra | Structured logging (Pino) |
| `comisai/memory` | @comis/memory | SQLite storage, embeddings, vector search, RAG |
| `comisai/gateway` | @comis/gateway | HTTP, JSON-RPC, WebSocket gateway |
| `comisai/skills` | @comis/skills | Skill system, MCP client, built-in tools, media |
| `comisai/scheduler` | @comis/scheduler | Cron engine, heartbeats, task extraction |
| `comisai/agent` | @comis/agent | Agent executor, context engine, budget, sessions |
| `comisai/channels` | @comis/channels | Platform adapters (9 messaging channels) |
| `comisai/cli` | @comis/cli | CLI commands and RPC client |
| `comisai/daemon` | @comis/daemon | Daemon orchestrator and service wiring |

## CLI

The package includes the `comis` CLI:

```bash
npx comisai init          # Initialize installation
npx comisai configure     # Interactive setup wizard
npx comisai daemon start  # Start the daemon
```

## Documentation

- [GitHub](https://github.com/comisai/comis)
- [Documentation](https://docs.comis.ai)
- [Discord](https://discord.gg/comis)

## License

[Apache-2.0](../../LICENSE)
