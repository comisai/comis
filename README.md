<p align="center">
  <img src="assets/comis-social-preview.png" alt="Comis" width="100%" />
</p>

<p align="center">
  <strong>Run AI agents you can constrain, inspect, and recover.</strong>
  <br />
  <sub>Open-source agent runtime for governed execution.</sub>
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

Comis is an Apache-2.0, self-hosted runtime for governed multi-agent workflows, built for AI platform and security teams and for operators moving persistent agents onto real tools and data. It provides scoped authority, bounded spend, recoverable context, provenance-aware memory, and operational evidence.

**Govern execution, memory, security, authority, and cost as one system.** Formal workflows, recoverable context, provenance-aware memory, scoped authority, bounded spend, and operational evidence share one governance model, enforced inside the runtime rather than by a proxy in front of it.

**Every run leaves evidence.** What each agent was allowed to do, what it read, learned, and spent. When something fails, one command explains why.

Comis runs on infrastructure you control. The controls apply to agents executing through Comis-controlled paths, and network access depends on the models, channels, tools, and media services you configure.

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

Comis does not compete on feature count alone. Its strength is one governance model across the agent lifecycle.

| Capability | What it provides |
| --- | --- |
| **Operational evidence** | Traces, trajectories, audit records, fleet and delivery health, and recall/cache diagnostics feed deterministic incident explanation: `comis explain` reports a session's outcome, cost, failures, and likely root cause in one call, with no LLM in the loop. |
| **Bounded spend** | Provider cost accounting connects to graph budgets and configurable spend ceilings that stop a run when it crosses the line, instead of reporting the bill afterward. |
| **Security for adversarial models** | Comis treats model output and external content as untrusted, with scoped stores, capability gates, deny-by-origin controls, encrypted secrets, credential brokering, memory/input/output guards, and audit events. |
| **Per-agent operational control** | Assign each agent its own model, memory/context scopes, tools, budgets, policies, configurable secret allowlist, and routing bindings across channels and APIs. |
| **Formal multi-agent execution** | Typed DAGs coordinate sequential and parallel nodes with barriers, retries, budgets, approval nodes, debate, voting, refinement, and map-reduce; configured durable runs add checkpoints and node-boundary recovery. |
| **Recoverable context by default** | Canonical messages and tool results remain available beneath summaries in the default DAG-backed context engine and can be recovered with `ctx_search`, `ctx_inspect`, and `ctx_expand`. |
| **Provenance-aware memory and learning** | Learning combines source provenance, configurable corroboration, trust ceilings, outcome gates, correction-driven demotion, supersession, and usefulness feedback: a memory architecture you can inspect, evaluate, and trust. |
| **Architecture built to evolve safely** | Hexagonal ports and adapters, a composition root, `Result` discipline, strict schemas, typed events, dependency rules, targeted test-neighbor gates, cycle checks, security linting, and shrink-only architecture gates keep change contained. |

### When something fails, one command explains why

Agent failures are usually reconstructed by hand from scattered logs. Comis records enough evidence at every boundary (model calls, tool calls, policy decisions, memory writes, spend) to answer the question directly:

```bash
comis explain "<sessionKey|traceId>"   # outcome, cost, tool failures, breaker timeline, likely root cause
comis fleet --since 24                 # daemon-wide: degraded rate, top error kinds, cost, config posture
comis security audit-log               # who accessed a secret, what was blocked, scrubbed and durable
```

The reports are deterministic (same input, same verdict), bounded, and content-safe: counts and hints, never message bodies or secrets. They can be shared in an incident review as-is.

## Where Comis Fits

- **Governed research and analysis:** coordinate parallel source gathering, synthesis, criticism, context recovery, provenance-aware memory, and a configured budget while retaining evidence for review.
- **Controlled operational investigation:** collect read-only system evidence, correlate events, and produce an incident report with cost and audit records. Keep privileged remediation behind tested approval and isolation boundaries.
- **Routed support and knowledge operations:** give specialized agents separate context, memory, tools, budgets, and routing while keeping the operator's control model consistent.

## Capabilities

- **Messaging:** Telegram, Discord, Slack, WhatsApp, Signal, iMessage, LINE, IRC, Email, and Microsoft Teams, with platform-specific media and interaction support.
- **Models, tools, and MCP:** Cloud providers, local Ollama and LM Studio models, fallback chains, browser, files, web, media, scheduling, memory, infrastructure, MCP client integrations, and a permission-gated MCP server.
- **Media:** Speech-to-text, text-to-speech, image and video analysis, image generation, and document extraction.
- **Automation:** Cron, heartbeat monitoring, background work, sub-agents, and durable execution graphs.
- **Interfaces:** Web dashboard, CLI, JSON-RPC, WebSocket, early Agent Client Protocol (ACP) bridge work, and experimental OpenAI-shaped HTTP endpoints.
- **Observability:** Native traces and trajectories, deterministic incident explanation (`comis explain`), fleet health, a scrubbed security audit log, provider cost accounting, optional OpenTelemetry export aligned with the stable GenAI model-call conventions, and a loopback-default Prometheus endpoint.
- **Storage:** Local SQLite stores with FTS5, optional vectors, session history, delivery queues, and encrypted-by-default secret storage.

## Security and Deployment

Comis treats model output and external content as untrusted. The runtime includes AES-256-GCM encrypted secret storage by default, configurable per-agent secret allowlists, SSRF defenses, external-content wrapping, prompt-injection detection, memory-write validation, completed-response output guards, tool policy, and an audit trail persisted by default. Streaming consumers receive deltas before the final-response scan.

Isolation depends on the host:

- **Linux with Bubblewrap** provides the strongest supported tool isolation.
- **macOS `sandbox-exec`** is best-effort and does not provide the same boundary as Linux.
- By default, the interactive terminal driver refuses to spawn without its jail; an explicit operator-only setting can bypass that jail. The ordinary `exec` tool can run directly on the host when its sandbox is disabled or unavailable. Disable `exec` or deploy with Bubblewrap where this risk is unacceptable.
- The default agent tool-policy profile is `full`, and an empty `secrets.allow` list is unrestricted. Narrow both before accepting untrusted input.
- Skill-declared permissions are advisory unless the same limits are enforced through runtime tool policy and deployment controls.
- Approval requests are available on explicitly wired paths when approvals are enabled; configured rules and default modes are not yet a universal policy engine.

**Supply chain.** Every dependency across the monorepo is exact-pinned, with no floating version ranges anywhere. Workspace packages are private and bundled into the published tarball, npm releases publish with sigstore provenance through GitHub OIDC, and per-package coverage floors, security linting, and shrink-only architecture gates run on every change.

Read [THREAT_MODEL.md](THREAT_MODEL.md) before enabling shell, browser, network, or third-party integrations.

## Current Limitations

- Code extensions currently require source changes through ports, adapters, hooks, and tools. Prompt skills can be uploaded or imported, but Comis does not yet provide a stable third-party code-plugin ecosystem.
- ACP support is early library-level bridge work. A daemon entrypoint and complete approval round-trip are not yet shipped.
- Durable graphs support configured checkpoint recovery, but general exact replay remains incomplete.
- Deterministic tests cover the core runtime extensively, but not every provider, channel, model, or deployment combination is validated live.
- Comis is an enterprise-oriented foundation under active development. Evaluate identity integration, tenant isolation, availability, backup and restore, upgrades, and support before critical or regulated deployment.
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

Contributors can start in any of these tracks:

- **Governance and security:** threat scenarios, policy, secret brokering, approval behavior, memory validation, and adversarial tests.
- **Standards and interoperability:** MCP authorization, ACP, A2A, OpenTelemetry semantics, and conformance fixtures.
- **Runtime reliability:** graphs, recovery, context, memory, delivery, incident reconstruction, and cost enforcement.
- **Integrations and deployments:** channels, providers, tools, hardened Linux profiles, containers, backup, and restore.
- **Operator experience and documentation:** evidence views, provenance, budgets, approvals, failure explanation, tutorials, and accessibility.

Browse [open issues](https://github.com/comisai/comis/issues) or discuss a proposal in [GitHub Discussions](https://github.com/comisai/comis/discussions). Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request; behavior changes follow test-first development and the full architecture and security validation gates.

If Comis is useful, star the repository to help other contributors discover it.

## Community

- [Documentation](https://docs.comis.ai)
- [GitHub Discussions](https://github.com/comisai/comis/discussions)
- [Issues](https://github.com/comisai/comis/issues)
- [Private security reports](https://github.com/comisai/comis/security)

If your organization is evaluating governed agent operations (identity, isolation, audit, or spend-control requirements), open a [Discussion](https://github.com/comisai/comis/discussions); design feedback from real deployments directly shapes the roadmap.

Comis builds on prior work from [pi-mono](https://github.com/earendil-works/pi) by [Mario Zechner](https://mariozechner.at/).

## License

Comis is licensed under the [Apache License 2.0](LICENSE). Commercial use, modification, redistribution, and private deployment are permitted under its terms.
