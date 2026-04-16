<p align="center">
  <img src="https://raw.githubusercontent.com/comisai/comis/main/assets/comis-readme-banner.png" alt="comis - Friendly by nature. Powerful by design." width="100%" />
</p>

<p align="center">
  <strong>Your personal AI team, always by your side.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/comisai"><img src="https://img.shields.io/npm/v/comisai" alt="npm version" /></a>
  <a href="https://github.com/comisai/comis/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-06B6D4?style=flat" alt="License" /></a>
  <a href="https://discord.gg/comis"><img src="https://img.shields.io/badge/discord-join-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/comisai" alt="Node" /></a>
</p>

<p align="center">
  <a href="https://docs.comis.ai">Docs</a> &middot;
  <a href="https://discord.gg/comis">Discord</a> &middot;
  <a href="https://twitter.com/comis_ai">Twitter</a> &middot;
  <a href="#quick-start">Quick Start</a>
</p>

---

Comis is a self-hosted, open-source AI assistant platform that lives inside your messaging apps -- not a browser tab. Deploy a team of specialized agents with persistent memory, 50+ tools, and DAG-based workflows across 9 platforms. Secured by 22 defense layers and optimized to reduce LLM costs by 80%+.

> **comis** _(Latin)_ -- courteous, kind, affable, gracious. That's what an AI assistant should be.

---

## Why Comis?

### Security: the LLM is the attack surface

AI agents have access to your messaging apps, files, shell, and API keys. A single prompt injection can make the LLM leak secrets, execute destructive commands, or exfiltrate private data.

Comis assumes the LLM will be attacked. **22 independent defense layers** intercept threats at every stage: input scanning for injection patterns, output scanning for leaked secrets, kernel-enforced exec sandboxes (Bubblewrap on Linux, sandbox-exec on macOS), per-agent tool restrictions with approval gates, trust-partitioned memory, canary tokens for prompt extraction detection, AES-256-GCM encrypted secrets, SSRF guards, and a 14-point security audit CLI.

### Cost: prompt caching saves 81%

Comis has the most advanced prompt cache management available for Anthropic, with 20 dedicated optimizations including adaptive TTL escalation, cache fence protection, and sub-agent spawn staggering. Gemini gets native CachedContent API integration. OpenAI is supported with completion storage.

| Metric | Value |
|---|---|
| 76-call Opus 4.6 session | **$5.02** vs $26.42 uncached |
| Cache hit rate | 94% of input tokens |
| 8-agent trading pipeline | **$2.11** for 788K tokens |

### Context: scales without degradation

Most assistants silently drop old messages when context fills up. Comis never deletes a message. An **8-layer context engine** handles compaction, rehydration, dead content eviction, and progressive tool disclosure -- keeping 50+ tools available without burning context. Between sessions, a background learning job extracts preferences and facts from past conversations. The agent gets better over time.

### Orchestration: team agents from natural language

> *"Have four analysts research NVDA in parallel, then run a bull vs bear debate, and let the head trader make the final call."*

One sentence creates a 7-node DAG pipeline with parallel fan-out, multi-round debate, and synthesis. No YAML, no scripting. 7 node types (agent, debate, vote, refine, collaborate, map-reduce, approval gate), 3-tier concurrency control, and barrier synchronization.

---

## Quick Start

**One-liner** -- installs Node.js and everything else:

```bash
curl -fsSL https://comis.ai/install.sh | bash
```

**Or with npm** (requires Node.js 22+):

```bash
npm install -g comisai
comis init               # interactive setup wizard
comis daemon start       # start the daemon
```

The wizard walks you through provider selection, API key validation, channel configuration, and daemon startup in under 5 minutes. Message your agent. That's it.

---

## Features

| | Feature | Description |
|---|---|---|
| | **9 messaging channels** | Telegram, Discord, Slack, WhatsApp, Signal, iMessage, IRC, LINE, Email -- text, voice, images, files, reactions, threads |
| | **Multi-agent fleet** | Specialized agents with isolated memory, budgets, and tool policies. Per-agent model selection. Sub-agent spawning. |
| | **Persistent memory** | SQLite + FTS5 + vector search with trust-partitioned storage. RAG retrieval keeps context relevant weeks later. |
| | **DAG pipelines** | 7 node types built from natural language. Parallel fan-out, debate, vote, refine, map-reduce, approval gates. |
| | **MCP ecosystem** | 50+ tool servers -- GitHub, Gmail, Notion, databases, browser automation, shell. Add any MCP server with one config line. |
| | **Skills system** | Modular prompt packages for domain expertise, workflows, and persona traits. Runtime eligibility filtering, live reload. |
| | **8-layer context engine** | Dead content eviction, LLM compaction, rehydration, progressive tool disclosure -- 80%+ cost reduction. |
| | **22 security layers** | Exec sandbox, injection detection (40+ patterns), AES-256 encrypted secrets, SSRF guard, canary tokens, approval gates. |
| | **Any model, any provider** | Claude, GPT, Gemini, Groq, Ollama, OpenRouter, and more. Tool presentation adapts to each model's context window. |
| | **Media processing** | Vision, STT (Whisper/Groq/Deepgram), TTS (OpenAI/ElevenLabs/Edge), image generation (FAL/Gemini/DALL-E), PDF extraction. |
| | **Headless browser** | Web automation, screenshots, form filling, JavaScript execution via Playwright. |
| | **Scheduling & cron** | Recurring tasks, heartbeat health checks, cron triggers for pipeline automation. |
| | **Gateway & API** | OpenAI-compatible API, JSON-RPC, WebSocket, mTLS, bearer auth. |
| | **Observability** | Structured Pino logging, circuit breakers, per-agent cost tracking, trace IDs. |

---

## Supported Channels

| Platform | Text | Media | Voice | Threads | Reactions | Groups |
|----------|:----:|:-----:|:-----:|:-------:|:---------:|:------:|
| Telegram | x | x | x | x | x | x |
| Discord  | x | x | x | x | x | x |
| Slack    | x | x | - | x | x | x |
| WhatsApp | x | x | - | - | x | x |
| Signal   | x | x | - | - | - | x |
| LINE     | x | x | - | - | - | x |
| iMessage | x | x | - | - | - | x |
| IRC      | x | - | - | - | - | x |
| Email    | x | x | - | x | - | - |

---

## CLI

```bash
comis init               # Interactive setup wizard
comis configure          # Update configuration
comis daemon start|stop  # Manage the background daemon
comis pm2 setup|start    # PM2 process management
comis status             # Show current state
comis health             # Verify setup
comis doctor             # Diagnose and repair issues
comis security audit     # Run 14-point security audit
comis secrets            # Manage encrypted credentials
comis channel            # Add or remove messaging platforms
comis models             # List and switch LLM providers
comis agent              # Manage agent identity and behavior
comis memory             # Search and manage persistent memory
comis sessions           # List and manage conversations
```

---

## Architecture

Hexagonal (ports and adapters). Core defines port interfaces -- adapters implement them. Swap Discord for Matrix, SQLite for Postgres, or OpenAI for Ollama without touching core logic. **19 ports, 30+ adapters, 13 packages.** Every function returns `Result<T, E>` -- zero thrown exceptions.

```
shared (Result type, utilities)
 └── core (domain types, ports, event bus, security, config)
      ├── memory (SQLite + FTS5 + vector search)
      ├── gateway (HTTP, JSON-RPC, WebSocket, mTLS)
      ├── skills (tools, MCP, media processing)
      ├── scheduler (cron, heartbeats)
      ├── agent (executor, budget, RAG, sessions)
      ├── channels (9 platform adapters)
      ├── cli (commands, RPC client)
      └── daemon (orchestrator, observability)
```

---

## Requirements

- **Node.js >= 22**
- **Linux** (primary target; macOS for development)
- Native build tools for SQLite and Sharp

---

## Links

<p align="center">
  <a href="https://github.com/comisai/comis"><strong>GitHub</strong></a> &middot;
  <a href="https://docs.comis.ai"><strong>Docs</strong></a> &middot;
  <a href="https://discord.gg/comis"><strong>Discord</strong></a> &middot;
  <a href="https://twitter.com/comis_ai"><strong>Twitter</strong></a> &middot;
  <a href="https://github.com/comisai/comis/issues"><strong>Issues</strong></a>
</p>

---

## License

[Apache-2.0](https://github.com/comisai/comis/blob/main/LICENSE)

---

<p align="center">
  <em>Friendly by nature. Powerful by design.</em>
</p>
