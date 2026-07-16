<p align="center">
  <img src="assets/comis-social-preview.png" alt="Comis: governed learning, bounded action, recorded evidence" width="100%" />
</p>

<p align="center">
  <strong>Let agents learn and act. Keep authority in the runtime.</strong>
  <br />
  <sub>Open-source runtime for bounded action and governed learning.</sub>
</p>

<p align="center">
  <a href="https://github.com/comisai/comis/actions/workflows/ci.yml"><img src="https://github.com/comisai/comis/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/comisai"><img src="https://img.shields.io/npm/v/comisai?color=06B6D4&style=flat" alt="npm" /></a>
  <a href="https://github.com/comisai/comis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-06B6D4?style=flat" alt="License" /></a>
  <a href="https://github.com/comisai/comis/stargazers"><img src="https://img.shields.io/github/stars/comisai/comis?style=flat&color=06B6D4" alt="GitHub Stars" /></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> |
  <a href="https://docs.comis.ai">Documentation</a> |
  <a href="#security-and-deployment">Security</a> |
  <a href="#contributing-and-open-evidence">Contribute</a>
</p>

---

# Comis

Comis is an open-source, self-hosted, security-first runtime for AI agents that learn and act across sessions.

It can turn qualifying experience into source-linked, correctable guidance for later work. Permissions, credentials, tools, delegation limits, budgets, and audit evidence remain under runtime control outside the model.

**Learned guidance can influence a proposal. It cannot grant itself a tool, credential, approval, lease, capability, or larger budget.**

Use Comis when an agent needs memory, real tools, recurring work, child agents, and a clear boundary between what the model proposes and what the system permits.

> [!NOTE]
> Comis is under active development. APIs and configuration may change. Review the [known limitations](https://docs.comis.ai/reference/known-limitations) and [threat model](THREAT_MODEL.md) before using it for critical work.

## Why Security Comes First

An agent with a shell, credentials, schedules, memory, or permission to start other agents has more than a prompt-injection problem. Untrusted text can affect a later session, learned guidance can influence tool selection, and delegated work can multiply reach.

Comis puts first-class controls around that path:

1. The model proposes an action.
2. The runtime checks origin, capability, tool policy, credential scope, approvals, budget, and active leases where those controls are wired.
3. The runtime allows or denies the action.
4. Execution and security evidence are recorded for review.

This design is intended for teams that need agent autonomy to fit a real security model. It does not make every deployment safe automatically. Host isolation, tool profiles, secret rules, approvals, provider choices, and deployment configuration still matter.

## How Governed Learning Works

Comis can carry useful experience into a later session without turning learned text into authority.

| Stage | What happens |
| --- | --- |
| **Qualify** | Consider the outcome, source trust, and usefulness of an experience. |
| **Admit** | Validate candidate guidance and apply the configured evidence rule. |
| **Reuse** | Surface source-linked guidance in a later session while runtime permission stays unchanged. |
| **Correct** | Use later outcomes and corrections to promote, demote, retire, supersede, or preserve guidance. |

Important learning boundaries:

- Governed learning is enabled by default. The default `single_owner` evidence rule can admit repeated experience from one explicitly trusted owner. It is not independent corroboration.
- Read-only candidate guidance can surface before active promotion and can influence which already-authorized tool the model chooses.
- Learned Markdown has no direct script or dynamic replay path. Tools still run through the runtime's permission path.
- Critical injection patterns are blocked. Warning-level harmful or jailbreak-like language can pass static validation.
- A session with a failed terminal task can still contain successful tool outcomes that seed guidance.
- Recall scope is tenant plus agent, not an individual end user within that scope.
- A recorded correction is evidence for later learning decisions. It does not by itself guarantee immediate demotion or a durable behavior change.
- Outcome events default to 90-day retention while learned-memory dormancy defaults to 365 days, so learned state can outlive parts of the evidence ledger that helped grade it.

See the [memory and learning stress catalog](test/live/self-driving/targets/MEMORY-LEARNING-STRESS-CATALOG.md) for the adversarial workloads and inspection surfaces used to test these mechanisms.

## What Current Evidence Shows

The internal live catalog covers 14 learning lanes. Evidence should be read by property, not as one broad success claim.

| Property | Current evidence |
| --- | --- |
| Candidate skill admission | Reproduced across the full catalog |
| Fresh-session reuse | Reproduced in selected package-delivery and threat-hunting scenarios |
| Rotated-input transfer | Reproduced in selected scenarios |
| Candidate to active promotion | Reproduced in the package-delivery scenario |
| Learned document direct execution | No direct execution path in the tested design |
| General cold-versus-learned task lift | Not yet measured |
| Profile and topic document behavior | Not established by the all-lanes result |
| Independent reproduction | Not yet |

Long delay, retention, and dormancy cases may use simulated, compressed, or seeded time. A capable model may already solve a selected workload cold, so successful reuse is not the same as measured performance improvement.

These are internal mechanism results, not customer results or a certification.

## Quick Start

### Managed install

For a macOS or Linux host you manage, download and inspect the installer first:

~~~bash
curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh -o comis-install.sh
less comis-install.sh
bash comis-install.sh --dry-run
bash comis-install.sh
~~~

The installer can install Node.js and host tools, initialize Comis, and configure a background service.

After review, the one-line convenience path is:

~~~bash
curl -fsSL --proto '=https' --tlsv1.2 https://comis.ai/install.sh | bash
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

## Four Runtime Pillars

### 1. Govern context, memory, and learning

Keep original messages and tool results in lossless storage while the model works from a bounded prompt view. Recover selected details, rank memory by trust and relevance, and carry qualifying experience forward with source and correction history.

### 2. Keep identity and authority outside the model

Use capabilities, origins, scoped secrets, encrypted storage, approvals, leases, and an optional Credential Broker to keep permission out of prompt text and learned guidance.

### 3. Bound execution and delegation

Coordinate structured dependency graphs and parallel subagents under shared limits for spawning, cost, tokens, time, rates, outward actions, and leases.

### 4. Explain, recover, and improve

Record execution-aware evidence, preserve recoverable context, and assemble a bounded incident report from recorded facts without asking another model to guess.

## Nine Verified Runtime Advantages

These are the strongest codebase-backed advantages. Conditions and limits are part of each claim.

1. **Recoverable same-session context.** `ctx_search`, `ctx_inspect`, and `ctx_expand` recover selected original details from lossless storage while the active prompt stays bounded.

2. **Cache-aware execution.** Cache detection and trace data span Anthropic, OpenAI, Gemini, context transforms, and parallel graph fanout. Actual cache behavior and savings remain provider-specific.

3. **Trust-aware memory and governed learning.** Recall and learned guidance can use provenance, trust, corroboration policy, usefulness, outcomes, and corrections. The default evidence rule is not independent corroboration.

4. **Typed parallel orchestration.** Typed dependency graphs coordinate cache-aware parallel subagents with explicit dependencies, retries, timeouts, and optional node-boundary checkpoints.

5. **Tree-wide autonomy limits.** Configured controls can cover spawning, cost, tokens, time, rates, outward actions, and leases across a parent agent and the children it starts. Not every limit can cancel work already in flight.

6. **Layered security.** Capability gates, deny-by-origin checks, sandbox controls, encrypted secrets, scoped secret access, validation layers, and the optional Credential Broker protect different parts of the path.

7. **Secure CLI-driven autonomy.** On the supported constrained path, jailed execution uses capability-limited Unix sockets, expiring leases, and brokered credentials so the agent can drive approved CLI tools without receiving broad control-plane access.

8. **Persistent interactive terminal automation.** The supported Linux isolation path keeps interactive terminal sessions persistent and fails closed when its jail cannot be established. This claim does not apply to ordinary host exec when sandboxing is disabled or unavailable.

9. **Execution-aware observability.** Instrumented runs support trace, cache, cost, policy, recovery, and security evidence. `comis explain` deterministically assembles an incident report from recorded evidence; a reported likely cause is a rule-based explanation, not proof of root cause.

## Explain a Recorded Failure

~~~bash
comis explain "<sessionKey|traceId|rootRunId>"
~~~

The report includes the recorded outcome, attributed cost, tool and policy failures, coverage information, and suggested next steps. When evidence matches a known rule, it can report a likely cause. When no rule matches, it does not invent one.

The explanation process makes no model calls. It can also run from local data when the daemon is unavailable:

~~~bash
comis explain "<sessionKey|traceId|rootRunId>" --offline
~~~

For a wider operational view:

~~~bash
comis fleet --since 24
comis security audit-log
~~~

Reports are bounded and designed to exclude raw message bodies and credential values. Some error details may be sanitized, shortened, or replaced with a digest.

## A Safe First Workload

Start with a read-only recurring research brief. It can collect and compare sources, preserve useful findings as the prompt changes, and leave evidence for failed branches without granting write access to production systems.

Add credentials, write tools, and outward actions only after testing the controls on your host. See the [use cases](https://docs.comis.ai/get-started/use-cases) and [scheduling guide](https://docs.comis.ai/agent-tools/scheduling).

## Security and Deployment

Comis assumes model output and external content may be unsafe. It includes capability and origin checks, URL validation, prompt-injection detection, memory-write checks, completed-response checks, tool policy, encrypted secret storage, and durable security audit records. Streaming clients may receive partial output before the completed response is checked.

Important defaults and boundaries:

- Linux with Bubblewrap provides the strongest supported command isolation.
- macOS `sandbox-exec` is best-effort and is not the same security boundary.
- The ordinary `exec` tool can run on the host when its sandbox is disabled or unavailable.
- The default tool-policy profile is `full`.
- An empty per-agent `secrets.allow` list is unrestricted.
- Human approvals are disabled by default and protect only paths explicitly connected to an approval gate.
- The Credential Broker is optional.
- Self-hosted does not mean offline. Configured model, messaging, media, MCP, and tool providers may receive data sent to them.
- Graph checkpoints recover at node boundaries; they do not exactly replay model calls, tool calls, network requests, or external side effects.

Narrow tools and secret rules before accepting untrusted input. Read the [threat model](THREAT_MODEL.md), [known limitations](https://docs.comis.ai/reference/known-limitations), and [security documentation](https://docs.comis.ai/security) before granting sensitive access.

Comis does not currently claim complete tenant isolation, high availability, compliance certification, a mature enterprise identity stack, or commercial support.

## Contributing and Open Evidence

**Build it. Break it. Measure it. Improve it.**

Comis Open Evidence is a planned public proof program, not a shipped benchmark runner or certification. Its goal is to make claims inspectable through small workloads, exact configurations, comparison runs, artifacts, and stated residual risk.

Bring a workload, an attack path, a learning failure, or an integration. Leave a reproducible result or a maintained artifact.

Useful contribution paths include:

- Learning and evaluation
- Runtime security and adversarial testing
- Orchestration and operations
- Integrations and recurring workloads
- Documentation and operator experience
- Maintained deployment profiles

Companies can contribute a recurring workload, deployment profile, or adapter with a named owner, tested version, evidence link, and known limitations.

Browse [open issues](https://github.com/comisai/comis/issues), start a proposal in [GitHub Discussions](https://github.com/comisai/comis/discussions), and read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Build from Source

Comis is a pnpm and TypeScript monorepo built around ports and adapters. Core packages define contracts, adapters implement them, and the daemon connects the running system.

~~~bash
git clone https://github.com/comisai/comis.git
cd comis
pnpm install
pnpm validate
~~~

Start with the [architecture guide](https://docs.comis.ai/developer-guide/architecture), [package guide](https://docs.comis.ai/developer-guide/packages), and repository [engineering protocol](AGENTS.md).

## License

Comis is licensed under the [Apache License 2.0](LICENSE). Commercial use, modification, redistribution, and private deployment are permitted under its terms.

Comis builds on prior work from [pi-mono](https://github.com/earendil-works/pi) by [Mario Zechner](https://mariozechner.at/).
