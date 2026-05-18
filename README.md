<p align="center">
  <img src="assets/comis-readme-banner.png?v=1.0.42" alt="Comis — self-hosted AI agents you can audit" width="100%" />
</p>

<p align="center">
  <strong>A self-hosted AI agent platform that deploys into your existing messaging channels.</strong>
  <br />
  <sub>Kernel-enforced sandboxes · sigstore-signed releases · multi-tenant primitives · 81% prompt-cache savings · across 9 chat channels.</sub>
</p>

<p align="center">
  <a href="https://github.com/comisai/comis/actions/workflows/ci.yml"><img src="https://github.com/comisai/comis/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/comisai"><img src="https://img.shields.io/npm/v/comisai?color=06B6D4&style=flat" alt="npm" /></a>
  <a href="https://github.com/comisai/comis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-06B6D4?style=flat" alt="License" /></a>
  <a href="https://github.com/comisai/comis/stargazers"><img src="https://img.shields.io/github/stars/comisai/comis?style=flat&color=06B6D4" alt="GitHub Stars" /></a>
  <a href="https://discord.gg/FsqgJkpp"><img src="https://img.shields.io/badge/discord-join-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<p align="center">
  <a href="#quick-start"><strong>Quick Start</strong></a> &middot;
  <a href="https://docs.comis.ai">Docs</a> &middot;
  <a href="#how-comis-is-different">How it's different</a> &middot;
  <a href="https://comis.ai/#demo">Demo</a> &middot;
  <a href="https://discord.gg/FsqgJkpp">Discord</a>
</p>

---

## Quick Start

**One-liner** — installs Node.js and everything else (macOS & Linux):

```bash
curl -fsSL https://comis.ai/install.sh | bash
```

**Or with npm** (requires Node.js 22+):

```bash
npm install -g comisai
comis init
comis configure              # choose LLM provider, add API keys, connect a channel
comis daemon start
```

**Or with Docker** (no Node.js required):

```bash
docker run -d --name comis -p 4766:4766 \
  -v comis-data:/home/comis/.comis comisai/comis:latest-slim
docker exec -it comis comis init
```

Verify: `curl http://localhost:4766/health` → `{"status":"ok"}`. Message your agent on Telegram, Discord, or any of the other 7 channels — that's it.

> **Production = Linux host only.** Docker Desktop (macOS/Windows) auto-disables the exec sandbox — fine for dev, never for production. See [Platform Support →](https://docs.comis.ai/operations/docker#platform-support).

---

## See it in action

<p align="center">
  <em>"Have four analysts research NVDA in parallel, then run a bull vs bear debate, and let the head trader make the final call."</em>
  <br />
  <strong>One sentence. A live 7-node DAG pipeline — with isolated memory, budgets, and audit trail per agent.</strong>
</p>

<p align="center">
  <a href="https://comis.ai/#demo">
    <img src="assets/comis-dag-demo-poster.jpg" alt="Click to watch the DAG pipeline demo on comis.ai" width="100%" />
  </a>
  <br />
  <a href="https://comis.ai/#demo">▶ Watch the demo</a>
</p>

---

## Why Comis

**🛡️ Defense in depth — runtime and compile-time.** The LLM is the attack surface. Comis assumes it will be attacked, then makes the abuse expensive: kernel-enforced exec sandboxes (bubblewrap / sandbox-exec), input + output scanning, trust-partitioned memory, per-agent tool restrictions, canary tokens at runtime — paired with **22 ESLint-enforced architectural rules** that block insecure patterns at commit time. Defects don't reach production because they don't reach `main`. [Deep dive →](https://comis.ai/security)

**📦 Supply-chain integrity by default.** Every release is **sigstore-attested via GitHub OIDC**. Workspace packages are bundled with `bundledDependencies` and exact-pinned — no runtime `npm install` of plugins, no transitive surprises, no peer-dependency outages. Comis owns its domain types end-to-end (no external `pi-coding-agent` you can be held hostage by). The supply chain *is* part of the threat model.

**💰 Cost — prompt caching saves 81%.** Dual-prompt architecture, active cache fences, adaptive TTL escalation, sub-agent spawn staggering. **$5.02 vs $26.42** for a 76-call Opus 4.6 session · **94% cache hit rate** on warm turns · **$2.11** for an 8-agent pipeline (788K tokens). [Deep dive →](https://comis.ai/context-management)

**🧊 Context — scales without degradation.** Most assistants silently drop old messages. Comis never deletes a message. An 8-layer context engine evicts stale content, compacts older history into structured summaries while keeping originals retrievable, and re-hydrates critical context after compression. A background job extracts user preferences between sessions, so your agent gets better over time without being told to remember.

**🏗️ Hexagonal architecture with `Result<T, E>` discipline.** Core defines port interfaces; adapters implement them. Every function returns `Result<T, E>` — zero thrown exceptions, fully testable in isolation. `AsyncLocalStorage`-bound `traceId` flows through every log line, every tool call, every model invocation. When something goes wrong, you can reconstruct exactly what happened.

**🔀 Orchestration — multi-agent fleets from natural language.** One sentence creates a DAG. 7 node types (agent, debate, vote, refine, collaborate, map-reduce, approval gate), 3-tier concurrency control, barrier synchronization, **isolated memory and budgets per agent**. Multi-tenant primitives are first-class, not bolted on. No YAML, no scripting.

---

## How Comis is different

The agent space has split into three camps:

- **Frameworks** (LangChain, CrewAI, AutoGen) hand you primitives — you build the runtime, channel adapters, security model, and cost optimizations yourself.
- **Hosted platforms** (Dify, Letta) ship a runtime but stop at a web UI — your data lives on someone else's cloud.
- **Self-hosted agent platforms** (OpenClaw, Hermes Agent) ship runtime + channels — but optimize for a single user on their personal device.

**Comis ships the runtime, meets your users where they already are, and is built so multiple agents and multiple operators can share the same install without stepping on each other.**

|                                                          |   Comis   | Agent frameworks | Hosted | OpenClaw | Hermes |
| -------------------------------------------------------- | :-------: | :--------------: | :----: | :------: | :----: |
| Self-hosted, Apache-2.0                                  |    ✅    |        ✅        |partial |    ✅    |   ✅   |
| Native messaging fan-in (9+ channels)                    |    ✅    |        ❌        |partial |    ✅    |   ✅   |
| OS-level exec sandbox (kernel-enforced)                  |    ✅    |        ❌        |   ❌   |    ❌    |   ❌   |
| Compile-time security rules (22 ESLint, arch tests)      |    ✅    |        ❌        |   ❌   | limited  |  n/a   |
| `Result<T,E>` typed errors end-to-end                    |    ✅    |        ❌        |   ❌   |    ❌    |   ❌   |
| `AsyncLocalStorage` `traceId` across every log + call    |    ✅    |        ❌        |   ❌   |    ❌    |partial |
| Sigstore-attested releases (GitHub OIDC provenance)      |    ✅    |        ❌        |   ❌   |    ❌    |   ❌   |
| Owns its core domain types (no external SDK dependency)  |    ✅    |        ✅        |partial |    ❌    |   ✅   |
| Multi-tenant primitives (shared install, isolated state) |    ✅    |        ❌        |   ✅   |    ❌    |   ❌   |
| DAG pipelines from natural language                      |    ✅    |     partial      |partial |    ❌    |partial |
| Prompt cache as a target architecture                    |    ✅    |        ❌        |   ❌   |    ✅    |partial |

[Side-by-side: Comis vs OpenClaw →](https://comis.ai/compare/openclaw) · [Comis vs Hermes →](https://comis.ai/compare/hermes)

---

## Features

|                                                                                                                |                                                                                                            |                                                                              |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 💬 **9 messaging channels**                                                                                    | 🤖 **Multi-agent fleet**                                                                                   | 🧠 **Persistent memory**                                                     |
| Telegram, Discord, Slack, WhatsApp, Signal, iMessage, IRC, LINE, Email — text, voice, images, files, threads | Isolated memory, budgets, and tool policies per agent. Sub-agent spawning, sync or fire-and-forget         | SQLite + FTS5 + vector search, trust-partitioned (system/learned/external)   |
| 🔌 **MCP ecosystem**                                                                                           | 🌐 **Any model, any provider**                                                                             | 🔐 **Encrypted at rest**                                                     |
| 50+ tool servers — GitHub, Gmail, Notion, databases, browser, shell                                          | Claude, GPT, Gemini, Groq, Ollama, OpenRouter — tool schemas adapt per model                              | API keys + secrets in AES-256-GCM envelope; Pino auto-redacts logs to 3 levels |

[Full feature list →](https://docs.comis.ai)

---

## Channels

<p align="center">
  <img src="https://cdn.simpleicons.org/telegram/26A5E4" width="24" />&nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/discord/5865F2" width="24" />&nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/slack/4A154B" width="24" />&nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/whatsapp/25D366" width="24" />&nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/signal/3A76F0" width="24" />&nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/apple/999999" width="24" />&nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/line/00C300" width="24" />&nbsp;&nbsp;
  <img src="assets/irc-icon.svg" width="24" />&nbsp;&nbsp;
  <img src="https://cdn.simpleicons.org/gmail/EA4335" width="24" />&nbsp;&nbsp;
</p>

<p align="center">
  <sub>Telegram · Discord · Slack · WhatsApp · Signal · iMessage · LINE · IRC · Email — text, voice, images, files, reactions, threads.</sub>
</p>

---

## Architecture

<p align="center">
  <img src="assets/comis-architecture.png" alt="Comis hexagonal architecture" width="100%" />
</p>

Comis uses **hexagonal architecture** (ports and adapters). Core defines port interfaces; adapters implement them. Swap Discord for Matrix, SQLite for Postgres, or OpenAI for Ollama without touching core logic. Every function returns `Result<T, E>` — zero thrown exceptions, fully testable in isolation. Architecture-level invariants (file-size, raw-throw-bans, untyped-SQLite-bans, end-to-end matrix coverage) are enforced as tests, not conventions.

[Deep dive: Architecture →](https://comis.ai/architecture)

---

## FAQ

<details>
<summary><strong>How is Comis different from LangChain / CrewAI / AutoGen?</strong></summary>

<br>

Those are **frameworks** — you build the runtime, channel adapters, security model, and cost optimizations yourself. Comis is a **runtime** that ships those pieces already wired up: 9 messaging adapters, OS-level exec sandbox, prompt-injection defenses, prompt-cache architecture, persistent memory, DAG executor, and observability. Use a framework when you're embedding agent logic into an app; use Comis when you want a deployable agent platform that talks to humans on the apps they already use.

</details>

<details>
<summary><strong>How is Comis different from OpenClaw or Hermes Agent?</strong></summary>

<br>

OpenClaw and Hermes are both excellent single-user personal agents. Comis is built so multiple agents and multiple operators can share the same install — with isolated memory, budgets, and tool policies per agent, and end-to-end observability (`AsyncLocalStorage` `traceId` flowing through every log line and model call). The other architectural differences — `Result<T,E>` typed errors, 22 compile-time security rules enforced by ESLint + architecture tests, sigstore-attested releases, and owning the core domain types in-tree — are the things that make Comis a stack you can reason about end-to-end rather than a stack you have to trust.

</details>

<details>
<summary><strong>Can I bring my own model?</strong></summary>

<br>

Yes. Claude, GPT, Gemini, Groq, Ollama, and OpenRouter are supported out of the box. Tool presentation adapts to each model's context window — small models get pruned schemas and a focused tool set.

</details>

<details>
<summary><strong>Is the exec sandbox actually enforced, or just policy?</strong></summary>

<br>

Kernel-enforced. Linux uses [Bubblewrap](https://github.com/containers/bubblewrap) with full namespace unsharing (mount, PID, user, cgroup, IPC), a private `/tmp` and `/dev`, and `--die-with-parent` cascade kill. macOS uses `sandbox-exec` with default-deny SBPL profiles per invocation. Production runs on Linux only — Docker Desktop on macOS/Windows auto-disables the sandbox and is dev-only.

</details>

<details>
<summary><strong>How does Comis handle secrets?</strong></summary>

<br>

API keys and channel credentials are wrapped in an AES-256-GCM envelope before they're written to disk. The Pino logger auto-redacts known secret fields (`apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey`, `cookie`, `webhookSecret`) up to 3 levels deep — a safety net, not a substitute for never logging them in the first place. A `SecretStorePort` abstraction lets you swap the at-rest store later without touching call sites.

</details>

<details>
<summary><strong>Is there a hosted / managed version?</strong></summary>

<br>

No. Comis is Apache-2.0 and fully self-hosted by design. See [docs.comis.ai/installation](https://docs.comis.ai) for VPS, Docker, and bare-metal install paths.

</details>

<details>
<summary><strong>What's the license? Can I use it commercially?</strong></summary>

<br>

Apache-2.0 across all 14 packages. Commercial use, modification, redistribution, and private deployment are all permitted under the standard Apache-2.0 terms.

</details>

---

## Developer Setup

Requires **Node.js >= 22** and **pnpm**.

```bash
git clone https://github.com/comisai/comis.git
cd comis
pnpm install
pnpm build
pnpm test              # unit tests
pnpm lint:security     # security lint
```

See [`AGENTS.md`](AGENTS.md) for the engineering protocol before contributing code.

---

## Contributing

Bug reports, skills, channel adapters, docs, and code are all welcome.

1. Fork and branch (`feature/my-change` or `fix/my-fix`)
2. `pnpm build && pnpm test && pnpm lint:security`
3. Open a PR against `main`

**Where to help most:** new skills, channel adapters, and docs. Start with [`good first issue`](https://github.com/comisai/comis/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

[Issues](https://github.com/comisai/comis/issues) · [Pull Requests](https://github.com/comisai/comis/pulls) · [Discussions](https://github.com/comisai/comis/discussions)

---

Builds on prior art from [OpenClaw](https://github.com/openclaw/openclaw), [Hermes Agent](https://github.com/NousResearch/hermes-agent), and [pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://mariozechner.at/).

**License:** [Apache-2.0](LICENSE)
