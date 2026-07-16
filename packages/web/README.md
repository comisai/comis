# @comis/web

Web dashboard for the [Comis](https://github.com/comisai/comis) platform. A standalone single-page application built with [Lit](https://lit.dev/) and [Vite](https://vite.dev/).

> This package is private and not published to npm. It's built and served by the daemon or deployed as a static site.

## Views

| View | Description |
|------|-------------|
| **Dashboard** | System overview with agent status, channel health, and recent activity |
| **Chat Console** | Interactive chat interface for messaging agents directly |
| **Sessions** | Browse and inspect agent sessions with message history |
| **Channels** | Channel connection management and status monitoring |
| **Config Editor** | Live configuration editing with validation |
| **Scheduler** | Cron job management and task scheduling |
| **Billing** | Cost analytics and token usage tracking |
| **Models** | LLM model configuration and routing |
| **Skills** | Skill management and manifest browsing |
| **Security** | Security settings and audit log |
| **Context DAG** | Visual graph browser for conversation context (Dagre layout) |
| **Memory Inspector** | Explore agent memory entries and embeddings |
| **MCP Management** | MCP server configuration and tool status |
| **Observability** | System monitoring, metrics, and diagnostics |
| **Subagents** | Sub-agent management and pipeline visualization |

## Development

```bash
cd packages/web
pnpm install
pnpm dev          # Vite dev server with HMR
pnpm build        # Production build to dist/
pnpm test         # Unit tests (Vitest + Happy DOM)
```

## Tech Stack

- **[Lit](https://lit.dev/)** -- Lightweight web components
- **[Vite](https://vite.dev/)** -- Build tool and dev server
- **[Dagre](https://github.com/dagrejs/dagre)** -- DAG graph layout for pipeline visualization
- **Lit CSS** -- Component-scoped styles and shared design tokens
- **Reusable components** -- Forms, charts, data tables, gauges, code blocks, and diff viewers

## Part of Comis

This package is part of [Comis](https://github.com/comisai/comis), an open-source security-first runtime for AI agents that learn and act across sessions.

## License

[Apache-2.0](../../LICENSE)
