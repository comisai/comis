<p align="center">
  <img src="https://raw.githubusercontent.com/comisai/comis/main/assets/comis-readme-banner.png" alt="Comis: self-hosted AI agents you can audit" width="100%" />
</p>

<p align="center">
  <strong>Self-hosted infrastructure for auditable AI-agent teams.</strong>
  <br />
  <sub>Messaging, multi-agent workflows, recoverable context, scoped secrets, and built-in operations.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/comisai"><img src="https://img.shields.io/npm/v/comisai?color=06B6D4&style=flat" alt="npm version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/comisai?style=flat" alt="Node.js version" /></a>
  <a href="https://github.com/comisai/comis/actions/workflows/ci.yml"><img src="https://github.com/comisai/comis/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/comisai/comis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-06B6D4?style=flat" alt="Apache-2.0 license" /></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="https://docs.comis.ai/get-started">Documentation</a> ·
  <a href="https://github.com/comisai/comis">GitHub</a> ·
  <a href="https://github.com/comisai/comis/discussions">Discussions</a>
</p>

# Comis

`comisai` is the public npm distribution of Comis. It installs the `comis` CLI and exposes ESM entry points for the platform's public package namespaces.

Comis is an Apache-2.0 platform for running multiple AI agents across messaging channels, APIs, scheduled work, and auditable execution graphs. Each agent can have its own model, scoped memory and context, tools, budget, and secret policy; routing bindings direct traffic to agents.

Comis runs on infrastructure you control. Network access depends on the models, channels, tools, and media services you configure.

> [!NOTE]
> **Development status:** Comis is under active development. APIs and configuration may change, and deployments should be evaluated carefully before use in critical environments. Read the [current limitations](#current-limitations) and [threat model](https://github.com/comisai/comis/blob/main/THREAT_MODEL.md).

## Quick Start

Requires Node.js **22.19 or newer**.

```bash
npm install --global comisai
comis --version
comis init
```

The interactive setup wizard configures Comis and offers to start the daemon. If you choose to start it later, run:

```bash
comis daemon start
```

Open `http://127.0.0.1:4766`, or connect a messaging channel during setup. Check the installation with `comis status` and `comis health`.

Direct npm installation provides the CLI and runtime; it does not configure a Comis workspace, install host tools, or register a system service. On macOS or Linux, the installer provisions supported prerequisites where it can and can register the daemon with an available service manager:

```bash
curl -fsSL https://comis.ai/install.sh | bash
```

See the [installation guide](https://docs.comis.ai/installation) for supported hosts, containers, services, and isolation prerequisites.

## What Comis Provides

| Area | Capabilities |
| --- | --- |
| **Agent teams** | Per-agent models, context, memory, tools, budgets, secret policies, routing bindings, and isolated sub-agent work. |
| **Durable workflows** | Persistent execution graphs with dependency-based sequential or parallel work, barriers, retries, budgets, debate, voting, refinement, approval nodes, and map-reduce. |
| **Context and memory** | Recoverable canonical conversation and tool records, bounded prompt assembly, local SQLite, FTS5, and optional vector retrieval. |
| **Messaging** | Telegram, Discord, Slack, WhatsApp, Signal, iMessage, LINE, IRC, Email, and Microsoft Teams. Media and interaction support varies by platform. |
| **Models, tools, and MCP** | Major cloud providers, OpenAI-compatible custom endpoints, local Ollama and LM Studio backends, built-in tools, MCP clients, and a permission-gated MCP server. Comis does not bundle third-party MCP servers. |
| **Automation and media** | Cron, heartbeat work, background tasks, speech transcription and synthesis, image and video analysis, image generation, and document extraction. |
| **Interfaces and operations** | Web dashboard, CLI, JSON-RPC, WebSocket, experimental OpenAI-shaped HTTP endpoints, trace-correlated diagnostics, cost accounting, and optional OpenTelemetry/Prometheus export. |

Provider, model, channel, and media features depend on the credentials, host dependencies, and configuration you supply.

## Security Boundaries

Comis treats external content and model output as untrusted. It includes encrypted-by-default AES-256-GCM secret storage, configurable per-agent secret allowlists, SSRF defenses, external-content wrapping, prompt-injection detection, memory-write validation, completed-response output guards, tool policy, and durable audit records.

These controls have explicit boundaries:

- Linux with Bubblewrap is the recommended target for isolated tool execution. macOS isolation is best-effort and does not provide the same boundary.
- The ordinary `exec` tool can run directly on the host when its sandbox is disabled or unavailable.
- Streaming consumers can receive deltas before the completed response passes its final output scan.
- Approval requests are available on explicitly wired paths when enabled; they are not a universal policy engine.

Review the [threat model](https://github.com/comisai/comis/blob/main/THREAT_MODEL.md) before enabling shell, browser, network, or third-party integrations. Report vulnerabilities through [GitHub private security reporting](https://github.com/comisai/comis/security).

## CLI and Package API

Run `comis --help` for the complete command reference. Common operational commands include:

```bash
comis status
comis doctor
comis security audit
comis configure --section channels
comis channel status
```

The package also exposes namespace and subpath ESM exports:

```ts
import { agent, channels, core } from "comisai";
import { safePath } from "comisai/core";
```

Public subpaths cover the core runtime, infrastructure, memory, gateway, skills, scheduler, agent, channels, CLI, daemon, orchestration, and observability packages. Programmatic APIs may change during active development.

## Current Limitations

- Code extensions currently require source changes through ports, adapters, hooks, and tools. Prompt skills can be uploaded or imported, but Comis does not yet provide a stable third-party code-plugin ecosystem.
- Deterministic tests cover the core runtime extensively, but not every provider, channel, model, or deployment combination is validated live.
- Backward compatibility is not guaranteed during active development.

## Project Links

- [Documentation](https://docs.comis.ai/get-started)
- [Installation](https://docs.comis.ai/installation)
- [GitHub repository](https://github.com/comisai/comis)
- [Open issues](https://github.com/comisai/comis/issues)
- [GitHub Discussions](https://github.com/comisai/comis/discussions)
- [Contribution guide](https://github.com/comisai/comis/blob/main/CONTRIBUTING.md)

If Comis is useful, star the repository to help other contributors discover it.

## License

Comis is licensed under the [Apache License 2.0](https://github.com/comisai/comis/blob/main/LICENSE).
