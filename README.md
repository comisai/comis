<p align="center">
  <img src="assets/comis-social-preview.png" alt="Comis" width="100%" />
</p>

<p align="center">
  <strong>Govern the execution, memory, security, authority, and cost of every agent.</strong>
  <br />
  <sub>Comis unifies typed execution, recoverable context, trust-aware learning, layered security, scoped authority, cost governance, and operational evidence on your infrastructure.</sub>
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
  <a href="#capabilities">Capabilities</a> ·
  <a href="#contributing">Contribute</a>
</p>

---

# Comis

Comis is an Apache-2.0 platform for governed multi-agent operations across messaging channels, APIs, scheduled work, and auditable execution graphs. Each agent can have its own model, scoped memory and context, tools, budget, and secret policy; routing bindings direct traffic to agents.

**Comis's advantage is coherence.** Execution, memory, security, authority, cost, and operational evidence operate as one governed system, so operators can control how agents execute, what they remember, what they can access, how much they can spend, and how outcomes are reconstructed.

Comis runs on infrastructure you control. Network access depends on the models, channels, tools, and media services you configure.

> [!NOTE]
> **Development status:** Comis is under active development. APIs and configuration may change, and deployments should be evaluated carefully before use in critical environments. See [Current limitations](#current-limitations) and the [threat model](THREAT_MODEL.md).

## Quick Start

### One-line install

For a managed macOS or Linux host:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash
```

This downloads and runs the installer immediately. The managed-host installer can install Node.js and host dependencies, initialize Comis data, and register the daemon with systemd or PM2. On Linux, it also attempts to provision Chromium and Xvfb by default and can create a dedicated `comis` user for a systemd service.

### Additional options

To inspect the installer and preview its changes before running it:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh
less comis-install.sh
bash comis-install.sh --dry-run
bash comis-install.sh
```

If Node.js **22.19+** is already installed, install directly from npm:

```bash
npm install --global comisai
comis init
```

Direct npm installation does not install host tools, create a service account, or register a system service. Use `bash comis-install.sh --help` to review managed-installer opt-outs and service choices.

Complete the setup wizard and start the daemon when prompted. If you choose to start it later, run `comis daemon start`. Then open `http://127.0.0.1:4766`, or connect a messaging channel during setup. Verify the daemon with:

```bash
curl http://127.0.0.1:4766/health
```

For containers and production hosts, see the [installation guides](https://docs.comis.ai/installation). Linux with Bubblewrap is the recommended deployment target for isolated tool execution.

## Why Comis

| Capability | What it provides |
| --- | --- |
| **Formal multi-agent execution** | Typed DAGs coordinate sequential and parallel nodes with barriers, retries, budgets, approval nodes, debate, voting, refinement, and map-reduce; configured durable runs add checkpoints and node-boundary recovery. |
| **Lossless context by default** | Canonical messages and tool results remain recoverable through the default DAG-backed context engine and `ctx_search`, `ctx_inspect`, and `ctx_expand`. |
| **Trust-aware memory and learning** | Learning combines source provenance, configurable corroboration policies, trust ceilings, outcome gates, correction-driven skill demotion, and usefulness feedback; profile and topic revisions preserve prior bodies. |
| **Security and scoped authority** | Comis treats model output and external content as untrusted, with scoped stores, capability gates, deny-by-origin controls, encrypted secrets, credential brokering, memory/input/output guards, and audit events. |
| **Integrated observability and cost governance** | Traces, trajectories, incident explanation, fleet and delivery health, recall/cache diagnostics, audit records, provider cost accounting, and opt-in spend ceilings connect evidence to operations. |
| **Architecture built to evolve safely** | Hexagonal ports and adapters, a composition root, `Result` discipline, strict schemas, typed events, dependency rules, targeted test-neighbor gates, cycle checks, security linting, and shrink-only architecture gates keep change contained. |
| **Per-agent operational control** | Assign each agent its own model, memory/context scopes, tools, budgets, policies, configurable secret allowlist, and routing bindings across channels and APIs. |

## Capabilities

- **Messaging:** Telegram, Discord, Slack, WhatsApp, Signal, iMessage, LINE, IRC, Email, and Microsoft Teams, with platform-specific media and interaction support.
- **Models, tools, and MCP:** Cloud providers, local Ollama and LM Studio models, fallback chains, browser, files, web, media, scheduling, memory, infrastructure, MCP client integrations, and a permission-gated MCP server.
- **Media:** Speech-to-text, text-to-speech, image and video analysis, image generation, and document extraction.
- **Automation:** Cron, heartbeat monitoring, background work, sub-agents, and durable execution graphs.
- **Interfaces:** Web dashboard, CLI, JSON-RPC, WebSocket, ACP bridge primitives, and experimental OpenAI-shaped HTTP endpoints.
- **Storage:** Local SQLite stores with FTS5, optional vectors, session history, delivery queues, and encrypted-by-default secret storage.

Typical workflows include routing support conversations to specialized agents, coordinating parallel research and synthesis, and running scheduled operational checks with a traceable result.

## Security and Deployment

Comis treats model output and external content as untrusted. The platform includes AES-256-GCM encrypted secret storage by default, configurable per-agent secret allowlists, SSRF defenses, external-content wrapping, prompt-injection detection, memory-write validation, completed-response output guards, tool policy, and an audit trail persisted by default. Streaming consumers receive deltas before the final-response scan.

Isolation depends on the host:

- **Linux with Bubblewrap** provides the strongest supported tool isolation.
- **macOS `sandbox-exec`** is best-effort and does not provide the same boundary as Linux.
- By default, the interactive terminal driver refuses to spawn without its jail; an explicit operator-only setting can bypass that jail. The ordinary `exec` tool can run directly on the host when its sandbox is disabled or unavailable. Disable `exec` or deploy with Bubblewrap where this risk is unacceptable.
- Approval requests are available on explicitly wired paths when approvals are enabled; configured rules and default modes are not yet a universal policy engine.

Read [THREAT_MODEL.md](THREAT_MODEL.md) before enabling shell, browser, network, or third-party integrations.

## Current Limitations

- Code extensions currently require source changes through ports, adapters, hooks, and tools. Prompt skills can be uploaded or imported, but Comis does not yet provide a stable third-party code-plugin ecosystem.
- Deterministic tests cover the core runtime extensively, but not every provider, channel, model, or deployment combination is validated live.
- APIs and configuration may change during active development; review release notes before upgrading.

## Architecture

Comis is a pnpm/TypeScript monorepo organized around hexagonal ports and adapters. `core` owns contracts and domain rules; adapters implement them; the daemon composition root wires the running system.

| Layer | Packages |
| --- | --- |
| Foundations | `shared`, `core` |
| Runtime | `infra`, `memory`, `agent`, `orchestrator`, `scheduler` |
| Interfaces | `channels`, `gateway`, `cli`, `web` |
| Capabilities | `skills` |
| Operations and distribution | `observability`, `observability-otel`, `daemon`, `comis` |

Build and validate from source:

```bash
git clone https://github.com/comisai/comis.git
cd comis
pnpm install
pnpm validate
```

Start with the [architecture guide](https://docs.comis.ai/developer-guide/architecture), [package guide](https://docs.comis.ai/developer-guide/packages), and repository [engineering protocol](AGENTS.md).

## Contributing

Contributors can start in any of three tracks:

- **Core runtime:** orchestration, memory, context, security, observability, and reliability.
- **Integrations:** channels, model and media providers, MCP connections, tools, and deployment targets.
- **Documentation and DX:** onboarding, examples, troubleshooting, dashboard workflows, accessibility, and translations.

Browse [open issues](https://github.com/comisai/comis/issues) or discuss a proposal in [GitHub Discussions](https://github.com/comisai/comis/discussions). Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request; behavior changes follow test-first development and the full architecture and security validation gates.

If Comis is useful, star the repository to help other contributors discover it.

## Community

- [Documentation](https://docs.comis.ai)
- [GitHub Discussions](https://github.com/comisai/comis/discussions)
- [Issues](https://github.com/comisai/comis/issues)
- [Private security reports](https://github.com/comisai/comis/security)

Comis builds on prior work from [pi-mono](https://github.com/earendil-works/pi) by [Mario Zechner](https://mariozechner.at/).

## License

Comis is licensed under the [Apache License 2.0](LICENSE). Commercial use, modification, redistribution, and private deployment are permitted under its terms.
