<p align="center">
  <img src="https://raw.githubusercontent.com/comisai/comis/main/assets/comis-social-preview.png" alt="Comis" width="100%" />
</p>

<p align="center">
  <strong>Run AI agents you can constrain, inspect, and recover.</strong>
  <br />
  <sub>Open-source agent runtime for governed execution.</sub>
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

Comis gives AI platform and security teams an Apache-2.0, self-hosted runtime for governed multi-agent workflows, with scoped authority, bounded spend, recoverable context, provenance-aware memory, and operational evidence.

**Govern execution, memory, security, authority, and cost as one system.** Formal workflows, recoverable context, provenance-aware memory, scoped authority, bounded spend, and operational evidence share one governance model.

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

Direct npm installation provides the CLI and runtime; it does not install host tools, create a service account, or register a system service. For a managed macOS or Linux host setup, download and inspect the installer first:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh
less comis-install.sh
bash comis-install.sh --dry-run
bash comis-install.sh
```

The managed-host installer can install Node.js and host dependencies, initialize Comis data, and register the daemon with systemd or PM2. On Linux, it also attempts to provision Chromium and Xvfb by default and can create a dedicated `comis` user for a systemd service. Run `bash comis-install.sh --help` for the available opt-outs.

See the [installation guide](https://docs.comis.ai/installation) for supported hosts, containers, services, and isolation prerequisites.

## What Comis Provides

| Area | Capabilities |
| --- | --- |
| **Per-agent control** | Per-agent models, context, memory, tools, budgets, secret policies, routing bindings, and scoped sub-agent work. |
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
- The default agent tool-policy profile is `full`, and an empty `secrets.allow` list is unrestricted. Narrow both before accepting untrusted input.
- Skill-declared permissions are advisory unless the same limits are enforced through runtime tool policy and deployment controls.
- Streaming consumers can receive deltas before the completed response passes its final output scan.
- Approval requests are available on explicitly wired paths when enabled; they are not a universal policy engine.

Review the [threat model](https://github.com/comisai/comis/blob/main/THREAT_MODEL.md) before enabling shell, browser, network, or third-party integrations. Report vulnerabilities through [GitHub private security reporting](https://github.com/comisai/comis/security).

## CLI and Package API

Run `comis --help` for the complete command reference. Common operational commands include:

```bash
comis status
comis doctor
comis security audit
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
- ACP support is early library-level bridge work. A daemon entrypoint and complete approval round-trip are not yet shipped.
- Durable graphs support configured checkpoint recovery, but general exact replay remains incomplete.
- Deterministic tests cover the core runtime extensively, but not every provider, channel, model, or deployment combination is validated live.
- Comis is an enterprise-oriented foundation under active development. Evaluate identity integration, tenant isolation, availability, backup and restore, upgrades, and support before critical or regulated deployment.
- APIs and configuration may change during active development; review release notes before upgrading.

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
