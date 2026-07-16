<p align="center">
  <img src="https://raw.githubusercontent.com/comisai/comis/main/assets/comis-social-preview.png" alt="Comis" width="100%" />
</p>

<p align="center">
  <strong>Open-source security-first runtime for AI agents that learn and act across sessions.</strong>
  <br />
  <sub>Let agents learn and act. Keep authority in the runtime.</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/comisai"><img src="https://img.shields.io/npm/v/comisai?color=06B6D4&style=flat" alt="npm version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/comisai?style=flat" alt="Node.js version" /></a>
  <a href="https://github.com/comisai/comis/actions/workflows/ci.yml"><img src="https://github.com/comisai/comis/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/comisai/comis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-06B6D4?style=flat" alt="Apache-2.0 license" /></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> |
  <a href="https://docs.comis.ai/get-started">Documentation</a> |
  <a href="https://github.com/comisai/comis">GitHub</a> |
  <a href="https://github.com/comisai/comis/discussions">Discussions</a>
</p>

# Comis

`comisai` is the public npm distribution of Comis. It installs the `comis` CLI and exposes ESM entry points for the platform's public packages.

Comis is an open-source security-first runtime for AI agents that learn and act across sessions. It is self-hosted and built for agents that work on schedules, across long tasks, or with other agents. It stores original messages, tool results, learned guidance, and operational evidence outside the model's active prompt.

Learned guidance can influence what an agent proposes in a later session, but it cannot grant permission. Capabilities, origin checks, credential scope, tool policy, budgets, and other configured controls remain authoritative in the runtime.

> [!NOTE]
> Comis is under active development. APIs and configuration may change. Review the [current limitations](https://docs.comis.ai/reference/known-limitations) and [threat model](https://github.com/comisai/comis/blob/main/THREAT_MODEL.md) before using it for critical work.

## Why Comis

- **Keep authority outside the model.** Capability and origin checks, credential scope, tool policy, and configured limits are enforced by runtime paths rather than prompt text.
- **Govern learning across sessions.** Source records, trust signals, configured corroboration, usefulness, and correction history shape which experience can return as guidance.
- **Recover and explain the work.** Original messages and tool results remain selectively recoverable, while `comis explain` builds a bounded incident report from recorded evidence without making another model call.

## Quick Start

Requires Node.js **22.19 or newer**.

~~~bash
npm install --global comisai
comis --version
comis init
~~~

The setup wizard configures Comis and offers to start the daemon. To start it later:

~~~bash
comis daemon start
~~~

Open `http://127.0.0.1:4766`, or connect a messaging channel during setup. Check the installation with:

~~~bash
comis status
comis health
~~~

The npm package does not install host tools, create a service account, or register a system service. For a managed macOS or Linux host, download and inspect the installer first:

~~~bash
curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh
less comis-install.sh
bash comis-install.sh --dry-run
bash comis-install.sh
~~~

See the [installation guide](https://docs.comis.ai/installation) for supported hosts, containers, services, and isolation requirements.

## Inspect a Failed Run

~~~bash
comis explain "<sessionKey|traceId|rootRunId>"
comis explain "<sessionKey|traceId|rootRunId>" --offline
comis fleet --since 24
comis security audit-log
~~~

`comis explain` reports the recorded outcome, attributed cost, failures, coverage, and suggested next steps. When evidence matches a known rule, it also reports a likely cause. The explanation process makes no model calls. Add `--offline` to read local Comis data without contacting the daemon.

Reports are bounded and designed to exclude raw message bodies and credential values. Some error details may be sanitized, shortened, or replaced with a digest.

## What Comis Includes

- Scheduled work, background jobs, sub-agents, and typed execution graphs.
- Recoverable original messages and tool results, plus trust-aware memory and governed learning with source records.
- Configurable authority, credential scope, tool policy, and spending limits.
- Cloud models, local Ollama and LM Studio models, built-in tools, and MCP integrations.
- Telegram, Discord, Slack, WhatsApp, Signal, iMessage, LINE, IRC, Email, and Microsoft Teams.
- Web dashboard, CLI, JSON-RPC, WebSocket, session reports, fleet health, audit records, cost accounting, optional OpenTelemetry export, and optional Prometheus metrics.

Configured spending limits can refuse later model calls after a limit is crossed; they do not cancel a call already in progress. Configured graph checkpoints recover at node boundaries but do not provide exact replay of every external side effect.

Eligible learned guidance can affect future model proposals and tool selection. It does not create a new capability, reveal a secret, expand a budget, or bypass an origin or tool-policy check. Admission and recall depend on configuration, and the presence of learned guidance is not by itself evidence of a general task-performance improvement.

## Security Boundaries

Comis assumes that model output and external content may be unsafe. It includes encrypted secret storage, capability and origin checks, URL validation, prompt-injection detection, memory-write checks, checks on completed responses, tool policy, and durable security audit records. Streaming clients may receive partial output before the completed response is checked.

Self-hosted does not mean offline. Configured model, messaging, media, MCP, and tool providers may receive data you send to them.

Important defaults and boundaries:

- Linux with Bubblewrap provides the strongest supported command isolation. macOS isolation is best-effort.
- The ordinary `exec` tool can run on the host when its sandbox is disabled or unavailable.
- The default tool-policy profile is `full`.
- An empty per-agent `secrets.allow` list is unrestricted.
- Human approvals are disabled by default and protect only explicitly connected paths.

Narrow tool access and secret rules before accepting untrusted input. Read the [security documentation](https://docs.comis.ai/security) and [known limitations](https://docs.comis.ai/reference/known-limitations) before granting sensitive access.

## Package API

The package exposes namespace and subpath ESM exports:

~~~ts
import { agent, channels, core } from "comisai";
import { safePath } from "comisai/core";
~~~

Public subpaths cover the core runtime, infrastructure, memory, gateway, skills, scheduler, agent, channels, CLI, daemon, orchestration, and observability packages. Programmatic APIs may change during active development.

## Project Links

- [Documentation](https://docs.comis.ai/get-started)
- [GitHub repository](https://github.com/comisai/comis)
- [Open issues](https://github.com/comisai/comis/issues)
- [GitHub Discussions](https://github.com/comisai/comis/discussions)
- [Contribution guide](https://github.com/comisai/comis/blob/main/CONTRIBUTING.md)
- [Private security reports](https://github.com/comisai/comis/security)

## License

Comis is licensed under the [Apache License 2.0](https://github.com/comisai/comis/blob/main/LICENSE).
