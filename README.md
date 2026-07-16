<p align="center">
  <img src="assets/comis-social-preview.png" alt="Comis" width="100%" />
</p>

<p align="center">
  <strong>Run AI agents you can constrain, inspect, and recover.</strong>
  <br />
  <sub>For the agent you leave running.</sub>
</p>

<p align="center">
  <a href="https://github.com/comisai/comis/actions/workflows/ci.yml"><img src="https://github.com/comisai/comis/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/comisai"><img src="https://img.shields.io/npm/v/comisai?color=06B6D4&style=flat" alt="npm" /></a>
  <a href="https://github.com/comisai/comis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-06B6D4?style=flat" alt="License" /></a>
  <a href="https://github.com/comisai/comis/stargazers"><img src="https://img.shields.io/github/stars/comisai/comis?style=flat&color=06B6D4" alt="GitHub Stars" /></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="https://docs.comis.ai">Documentation</a> ·
  <a href="#security-and-deployment">Security</a> ·
  <a href="#contributing">Contribute</a>
</p>

---

# Comis

Comis is an open-source, self-hosted runtime for AI agents that work over time: on a schedule, across long tasks, or with other agents.

Comis stores original messages and tool results outside the model's active prompt, while configured controls remain in the runtime. The model can work from shorter summaries without making those summaries the only record of what happened.

Use Comis when an agent needs real tools, credentials, memory, budgets, and a clear record of its actions.

> [!NOTE]
> Comis is under active development. APIs and configuration may change. Review the [current limitations](https://docs.comis.ai/reference/known-limitations) and [threat model](THREAT_MODEL.md) before using it for critical work.

## Why Comis

- **Keep the work.** Original messages and tool results remain stored even when the model uses shorter summaries. The agent can search, inspect, and recover selected details when it needs them.

- **Hold configured boundaries.** Authority checks, origin rules, credential scope, memory admission, and spending limits live outside prompt text. When configured, these controls can change what the runtime allows next.

- **See what happened.** Instrumented runs produce bounded evidence about outcomes, cost, tool failures, policy decisions, and recovery. `comis explain` turns that evidence into an incident report without asking another model to guess.

## Explain a Failed Run

~~~bash
comis explain "<sessionKey|traceId|rootRunId>"
~~~

The report includes the recorded outcome, attributed cost, tool and policy failures, coverage information, and suggested next steps. When the evidence matches a known rule, it also reports a likely cause. When no rule matches, it does not invent one.

The explanation process makes no model calls. It can also run from local data when the daemon is unavailable:

~~~bash
comis explain "<sessionKey|traceId|rootRunId>" --offline
~~~

For a wider view:

~~~bash
comis fleet --since 24
comis security audit-log
~~~

These reports are bounded and designed to exclude raw message bodies and credential values. Some error details may be sanitized, shortened, or replaced with a digest.

## Quick Start

### Managed install

For a macOS or Linux host you manage:

~~~bash
curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash
~~~

The installer can install Node.js and host tools, initialize Comis, and configure a background service.

To inspect the installer and preview its changes first:

~~~bash
curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh
less comis-install.sh
bash comis-install.sh --dry-run
bash comis-install.sh
~~~

### npm install

If Node.js **22.19 or newer** is already installed:

~~~bash
npm install --global comisai
comis init
~~~

The npm package does not install host tools, create a service account, or register a system service.

Complete the setup wizard and start the daemon when prompted. To start it later:

~~~bash
comis daemon start
~~~

Open `http://127.0.0.1:4766`, or connect a messaging channel during setup. Check the daemon with:

~~~bash
curl http://127.0.0.1:4766/health
~~~

See the [installation guides](https://docs.comis.ai/installation) for containers and production hosts. Linux with Bubblewrap is the recommended deployment target for isolated command execution.

## A Good First Workload

A scheduled research brief is a practical first project.

Comis can collect and compare sources in parallel, keep important findings available as older details are summarized, track cost when pricing is available, and retain evidence for a failed branch. Configure this first workload with read-only tools before connecting it to production systems.

See the [use cases](https://docs.comis.ai/get-started/use-cases) and [scheduling guide](https://docs.comis.ai/agent-tools/scheduling) for more ideas.

## What Comis Includes

- **Work that continues:** cron jobs, heartbeats, background work, sub-agents, and typed execution graphs with dependencies, retries, timeouts, budgets, and optional checkpoints.
- **Context and memory:** recoverable original messages and tool results, plus ranked recall, source records, trust labels, supporting evidence, outcome signals, and correction history. Governed learning is available when enabled.
- **Models and tools:** cloud model providers, local Ollama and LM Studio models, browser, web, files, media, scheduling, memory, infrastructure tools, and MCP integrations.
- **Messaging:** Telegram, Discord, Slack, WhatsApp, Signal, iMessage, LINE, IRC, Email, and Microsoft Teams.
- **Operator interfaces:** web dashboard, CLI, JSON-RPC, and WebSocket.
- **Operations:** session and fleet reports, durable security audit records, provider cost accounting, optional OpenTelemetry export, and an optional Prometheus endpoint.

Configured spending limits can warn or refuse later model calls after a limit is crossed. They do not cancel a provider call that is already running.

Configured graph checkpoints support recovery at node boundaries. They do not provide exact replay of every model response, tool call, network request, or external side effect.

## Security and Deployment

Comis assumes that model output and external content may be unsafe. It includes encrypted secret storage, configurable per-agent secret rules, capability and origin checks, URL validation, prompt-injection detection, memory-write checks, checks on completed responses, tool policy, and durable security audit records. Streaming clients may receive partial output before the completed response is checked.

These controls apply only to paths handled by Comis. Model, messaging, media, MCP, and tool providers may receive data that you deliberately send to them.

Important defaults and boundaries:

- Linux with Bubblewrap provides the strongest supported command isolation.
- macOS `sandbox-exec` is best-effort and is not the same security boundary.
- The ordinary `exec` tool can run on the host when its sandbox is disabled or unavailable.
- The default tool-policy profile is `full`.
- An empty per-agent `secrets.allow` list is unrestricted.
- Human approvals are disabled by default and protect only paths explicitly connected to an approval gate.

Narrow tool access and secret rules before accepting untrusted input. Read the [threat model](THREAT_MODEL.md), [known limitations](https://docs.comis.ai/reference/known-limitations), and [security documentation](https://docs.comis.ai/security) before granting sensitive access.

Comis does not currently claim complete tenant isolation, high availability, compliance certification, a mature enterprise identity stack, or commercial support.

## Build from Source

Comis is a pnpm and TypeScript monorepo built around ports and adapters. Core packages define contracts; adapters implement them; the daemon connects the running system.

~~~bash
git clone https://github.com/comisai/comis.git
cd comis
pnpm install
pnpm validate
~~~

Start with the [architecture guide](https://docs.comis.ai/developer-guide/architecture), [package guide](https://docs.comis.ai/developer-guide/packages), and repository [engineering protocol](AGENTS.md).

## Contributing

Current project work focuses on making persistent-agent failures repeatable, visible, and easier to fix.

Useful contributions include:

- Reproducing a failure and turning it into a focused test.
- Adding a reliability scenario for boundaries, context recovery, cost, memory, delivery, or restart behavior.
- Improving an incident report, validator, integration, deployment guide, or accessibility issue.
- Adding support for a model, channel, tool, or hardened deployment profile.

The planned **Comis Reliability Trials** will package small, repeatable scenarios that show whether a configured boundary held, required state remained recoverable, and the recorded evidence was sufficient.

Browse [open issues](https://github.com/comisai/comis/issues), start a proposal in [GitHub Discussions](https://github.com/comisai/comis/discussions), and read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

If Comis is useful, star the repository to help other users and contributors find it.

## License

Comis is licensed under the [Apache License 2.0](LICENSE). Commercial use, modification, redistribution, and private deployment are permitted under its terms.

Comis builds on prior work from [pi-mono](https://github.com/earendil-works/pi) by [Mario Zechner](https://mariozechner.at/).
