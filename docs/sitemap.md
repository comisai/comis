# Comis Documentation Sitemap

## Purpose

This file is a high-level semantic index of the documentation.
It is intended for:

- LLM-assisted navigation (ChatGPT, Claude Code)
- Quick orientation for contributors
- Identifying relevant documentation areas during development

It is not intended to replace individual docs.

---

- [Welcome to Comis](https://docs.comis.ai/get-started) | Type: Conceptual | Summary: Open-source AI agent fleet that lives in your messaging apps | Prerequisites: None | Topics: overview, introduction
    - [Quickstart](https://docs.comis.ai/get-started/quickstart) | Type: Tutorial | Summary: Get your first Comis agent running in under 5 minutes | Prerequisites: None | Topics: quickstart, setup, getting started
    - [Use Cases](https://docs.comis.ai/get-started/use-cases) | Type: Conceptual | Summary: Real-world scenarios showing what you can build with Comis | Prerequisites: None | Topics: use cases, examples
    - [How It Works](https://docs.comis.ai/get-started/how-it-works) | Type: Conceptual | Summary: A plain-language guide to how Comis processes messages and connects your agents | Prerequisites: None | Topics: architecture, concepts, message flow
    - [How Comis Keeps You Safe](https://docs.comis.ai/get-started/security) | Type: Conceptual | Summary: An overview of Comis security protections in plain language | Prerequisites: None | Topics: security, overview
    - [Glossary](https://docs.comis.ai/get-started/glossary) | Type: Reference | Summary: Definitions for every technical term used in the Comis documentation | Prerequisites: None | Topics: glossary, terminology, definitions

---

- [Installation](https://docs.comis.ai/installation) | Type: How-to | Summary: Choose your setup method and install Comis | Prerequisites: None | Topics: installation, setup
    - [Requirements](https://docs.comis.ai/installation/requirements) | Type: Reference | Summary: Hardware, software, and account prerequisites for running Comis | Prerequisites: None | Topics: requirements, prerequisites, node.js
    - [Install on Linux](https://docs.comis.ai/installation/install-linux) | Type: Tutorial | Summary: Step-by-step installation guide for Ubuntu, Fedora, and Arch Linux | Prerequisites: Requirements | Topics: installation, linux, ubuntu, fedora, arch
    - [Install with Docker](https://docs.comis.ai/installation/install-docker) | Type: Tutorial | Summary: Run Comis in a Docker container with Docker Compose | Prerequisites: Requirements | Topics: installation, docker, docker compose
    - [Install on a VPS](https://docs.comis.ai/installation/install-vps) | Type: Tutorial | Summary: Deploy Comis on Hostinger, DigitalOcean, Hetzner, or any Ubuntu VPS in under 10 minutes | Prerequisites: Requirements | Topics: installation, vps, hostinger, digitalocean, hetzner, ubuntu
    - [Configuration Guide](https://docs.comis.ai/installation/configuration) | Type: Tutorial | Summary: Set up your config.yaml with required settings, channels, and customization | Prerequisites: Installation | Topics: configuration, config.yaml, setup
    - [Verify Your Installation](https://docs.comis.ai/installation/verify) | Type: How-to | Summary: Confirm that Comis is installed correctly and running as expected | Prerequisites: Installation | Topics: verification, health check, troubleshooting

---

- [Channels](https://docs.comis.ai/channels) | Type: Conceptual | Summary: Connect Comis to Discord, Telegram, Slack, WhatsApp, Signal, iMessage, LINE, IRC, and Email | Prerequisites: Installation | Topics: channels, messaging platforms, adapters
    - [Discord](https://docs.comis.ai/channels/discord) | Type: Integration | Summary: Connect Comis to Discord with step-by-step setup | Prerequisites: Channels | Topics: discord, bot setup, channel adapter
    - [Telegram](https://docs.comis.ai/channels/telegram) | Type: Integration | Summary: Connect Comis to Telegram with step-by-step setup | Prerequisites: Channels | Topics: telegram, bot setup, channel adapter
    - [Slack](https://docs.comis.ai/channels/slack) | Type: Integration | Summary: Connect Comis to Slack with step-by-step setup | Prerequisites: Channels | Topics: slack, bot setup, channel adapter
    - [WhatsApp](https://docs.comis.ai/channels/whatsapp) | Type: Integration | Summary: Connect Comis to WhatsApp with step-by-step setup | Prerequisites: Channels | Topics: whatsapp, bot setup, channel adapter
    - [Signal](https://docs.comis.ai/channels/signal) | Type: Integration | Summary: Connect Comis to Signal with step-by-step setup | Prerequisites: Channels | Topics: signal, bot setup, channel adapter
    - [iMessage](https://docs.comis.ai/channels/imessage) | Type: Integration | Summary: Connect Comis to iMessage on macOS | Prerequisites: Channels | Topics: imessage, macos, channel adapter
    - [LINE](https://docs.comis.ai/channels/line) | Type: Integration | Summary: Connect Comis to LINE with step-by-step setup | Prerequisites: Channels | Topics: line, bot setup, channel adapter
    - [IRC](https://docs.comis.ai/channels/irc) | Type: Integration | Summary: Connect Comis to IRC with step-by-step setup | Prerequisites: Channels | Topics: irc, bot setup, channel adapter
    - [Email](https://docs.comis.ai/channels/email) | Type: Integration | Summary: Connect Comis to Email with step-by-step IMAP/SMTP setup | Prerequisites: Channels | Topics: email, imap, smtp, channel adapter
    - [Delivery Infrastructure](https://docs.comis.ai/channels/delivery) | Type: Conceptual | Summary: How Comis delivers messages: streaming, typing indicators, retry logic, and block pacing | Prerequisites: Channels | Topics: delivery, streaming, retry, typing indicators

---

- [Agents](https://docs.comis.ai/agents) | Type: Conceptual | Summary: What agents are and how they work inside Comis | Prerequisites: How It Works | Topics: agents, ai agents, core concepts
    - [Agent Lifecycle](https://docs.comis.ai/agents/lifecycle) | Type: Conceptual | Summary: How your agent processes messages from arrival to response | Prerequisites: Agents | Topics: lifecycle, message processing, execution
    - [Identity](https://docs.comis.ai/agents/identity) | Type: How-to | Summary: How workspace files shape your agent's personality and behavior | Prerequisites: Agents | Topics: identity, persona, system prompt, workspace
    - [Routing](https://docs.comis.ai/agents/routing) | Type: Conceptual | Summary: How Comis decides which agent handles each message | Prerequisites: Agents | Topics: routing, message routing, multi-agent
    - [Slash Commands](https://docs.comis.ai/agents/slash-commands) | Type: Reference | Summary: All the commands you can type to control your agent | Prerequisites: Agents | Topics: slash commands, user commands, control
    - [Sessions](https://docs.comis.ai/agents/sessions) | Type: Conceptual | Summary: How Comis manages conversations between you and your agent | Prerequisites: Agents | Topics: sessions, conversations, context
    - [Subagent Context Lifecycle](https://docs.comis.ai/agents/subagent-lifecycle) | Type: Conceptual | Summary: How Comis prepares, runs, and captures results from sub-agent sessions | Prerequisites: Sessions | Topics: subagents, context lifecycle, delegation
    - [Compaction](https://docs.comis.ai/agents/compaction) | Type: Conceptual | Summary: How Comis automatically manages conversation length | Prerequisites: Sessions | Topics: compaction, context window, summarization
    - [Memory Recall (RAG)](https://docs.comis.ai/agents/rag) | Type: Conceptual | Summary: How your agent remembers past conversations when answering new questions | Prerequisites: Memory | Topics: rag, retrieval, memory recall
    - [Message Queue](https://docs.comis.ai/agents/queue) | Type: Conceptual | Summary: How Comis handles multiple messages and ensures orderly processing | Prerequisites: Agents | Topics: queue, concurrency, message ordering
    - [Execution Graphs](https://docs.comis.ai/agents/execution-graphs) | Type: Conceptual | Summary: Multi-agent DAG orchestration -- define, execute, and monitor workflows where each node is a sub-agent task | Prerequisites: Agents | Topics: execution graphs, dag, orchestration, workflows, multi-agent
    - [Memory](https://docs.comis.ai/agents/memory) | Type: Conceptual | Summary: How your agent stores and organizes long-term knowledge | Prerequisites: Agents | Topics: memory, storage, knowledge, sqlite
    - [Search](https://docs.comis.ai/agents/search) | Type: Conceptual | Summary: How your agent finds relevant memories | Prerequisites: Memory | Topics: search, fts5, full-text search, memory search
    - [Embeddings](https://docs.comis.ai/agents/embeddings) | Type: How-to | Summary: Setting up meaning-based memory search | Prerequisites: Memory | Topics: embeddings, vector search, semantic search
    - [Models](https://docs.comis.ai/agents/models) | Type: How-to | Summary: Configuring AI providers, model selection, and automatic failover | Prerequisites: Agents | Topics: models, providers, failover, llm
    - [Safety](https://docs.comis.ai/agents/safety) | Type: Conceptual | Summary: How Comis protects you from unexpected costs and runaway agents | Prerequisites: Agents | Topics: safety, budget, circuit breaker, cost control
    - [Resilience](https://docs.comis.ai/agents/resilience) | Type: Conceptual | Summary: How Comis prevents silent failures from provider outages, hung prompts, and stuck sub-agents | Prerequisites: Agents | Topics: resilience, circuit breaker, overflow recovery, degraded mode

---

- [Skills Overview](https://docs.comis.ai/skills) | Type: Conceptual | Summary: Understand the types of skills and tools your Comis agents can use | Prerequisites: Agents | Topics: skills, tools, capabilities
    - [Built-in Tools](https://docs.comis.ai/skills/built-in-tools) | Type: Reference | Summary: Every built-in tool your Comis agents can use for files, shell commands, web access, and browser automation | Prerequisites: Skills Overview | Topics: built-in tools, file ops, bash, browser, web search
    - [Platform Tools](https://docs.comis.ai/skills/platform-tools) | Type: Reference | Summary: Overview of all Comis-specific tools agents can use for messaging, scheduling, and administration | Prerequisites: Skills Overview | Topics: platform tools, messaging tools, scheduling tools
    - [Prompt Skills](https://docs.comis.ai/skills/prompt-skills) | Type: How-to | Summary: Create custom Markdown instruction files that teach your agents new behaviors | Prerequisites: Skills Overview | Topics: prompt skills, custom skills, markdown
    - [Skill Examples](https://docs.comis.ai/skills/examples) | Type: Tutorial | Summary: Complete skill walkthroughs you can follow step by step | Prerequisites: Prompt Skills | Topics: examples, walkthroughs, tutorials
    - [Skill Manifest](https://docs.comis.ai/skills/manifest) | Type: Reference | Summary: Complete reference for the SKILL.md file format and all available fields | Prerequisites: Prompt Skills | Topics: manifest, skill.md, schema
    - [Security Scanning](https://docs.comis.ai/skills/security-scanning) | Type: Conceptual | Summary: What Comis checks for when loading custom skills | Prerequisites: Skills Overview | Topics: security scanning, content scanning, skill validation
    - [Tool Policy](https://docs.comis.ai/skills/tool-policy) | Type: How-to | Summary: Control which tools your agents can use with profiles, groups, and allow/deny lists | Prerequisites: Skills Overview | Topics: tool policy, permissions, allow list, deny list
    - [MCP Integration](https://docs.comis.ai/skills/mcp) | Type: Integration | Summary: Connect external tools to your agents using the Model Context Protocol | Prerequisites: Skills Overview | Topics: mcp, model context protocol, external tools

---

- [Agent Tools Overview](https://docs.comis.ai/agent-tools) | Type: Reference | Summary: Master reference for every tool your Comis agents can use | Prerequisites: Skills Overview | Topics: agent tools, tool reference
    - [Scheduling](https://docs.comis.ai/agent-tools/scheduling) | Type: Reference | Summary: Create scheduled jobs and manage agent heartbeat timing | Prerequisites: Agent Tools Overview | Topics: scheduling, cron, heartbeat, jobs
    - [Messaging](https://docs.comis.ai/agent-tools/messaging) | Type: Reference | Summary: Send, reply, react, edit, and delete messages across channels | Prerequisites: Agent Tools Overview | Topics: messaging, send, reply, react, edit
    - [Sessions](https://docs.comis.ai/agent-tools/sessions) | Type: Reference | Summary: Manage conversations, spawn sub-agents, run pipelines, and search memory | Prerequisites: Agent Tools Overview | Topics: sessions, subagents, pipelines, memory
    - [Pipelines](https://docs.comis.ai/agent-tools/pipelines) | Type: Reference | Summary: The pipeline tool for defining, executing, and managing multi-agent execution graphs | Prerequisites: Agent Tools Overview | Topics: pipelines, execution graphs, dag, multi-agent
    - [Media](https://docs.comis.ai/agent-tools/media) | Type: Reference | Summary: Image analysis, text-to-speech, audio transcription, video description, and document extraction | Prerequisites: Agent Tools Overview | Topics: media, vision, tts, transcription, documents
    - [Infrastructure](https://docs.comis.ai/agent-tools/infrastructure) | Type: Reference | Summary: Configuration management, gateway control, and supervisor administration tools | Prerequisites: Agent Tools Overview | Topics: infrastructure, config, gateway, supervisor
    - [Browser](https://docs.comis.ai/agent-tools/browser) | Type: Reference | Summary: Headless browser automation with 16 actions for navigation, interaction, and screenshots | Prerequisites: Agent Tools Overview | Topics: browser, automation, headless, puppeteer
    - [Web Tools](https://docs.comis.ai/agent-tools/web-tools) | Type: Reference | Summary: Web search with 8 providers and web page content fetching | Prerequisites: Agent Tools Overview | Topics: web search, web fetch, search providers
    - [Platform Actions](https://docs.comis.ai/agent-tools/platform-actions) | Type: Reference | Summary: Discord, Telegram, Slack, and WhatsApp moderation and management actions | Prerequisites: Agent Tools Overview | Topics: platform actions, moderation, discord, telegram, slack, whatsapp

---

- [Media & Voice](https://docs.comis.ai/media) | Type: Conceptual | Summary: How your agent handles images, voice messages, documents, links, and interactive messages | Prerequisites: Agents | Topics: media, voice, multimodal
    - [Vision](https://docs.comis.ai/media/vision) | Type: Conceptual | Summary: How your agent sees and understands images and videos | Prerequisites: Media & Voice | Topics: vision, image analysis, video description
    - [Voice](https://docs.comis.ai/media/voice) | Type: Conceptual | Summary: Speech-to-text transcription and text-to-speech auto-reply for voice messages | Prerequisites: Media & Voice | Topics: voice, stt, tts, transcription, speech
    - [Documents](https://docs.comis.ai/media/documents) | Type: Conceptual | Summary: How your agent reads PDFs, spreadsheets, code files, and other documents | Prerequisites: Media & Voice | Topics: documents, pdf, spreadsheets, extraction
    - [Links](https://docs.comis.ai/media/links) | Type: Conceptual | Summary: How your agent understands web pages shared in messages | Prerequisites: Media & Voice | Topics: links, web pages, url extraction
    - [Rich Messages](https://docs.comis.ai/media/rich-messages) | Type: How-to | Summary: Buttons, cards, embeds, and polls across Discord, Telegram, Slack, LINE, and more | Prerequisites: Media & Voice | Topics: rich messages, buttons, embeds, polls, cards

---

- [Web Dashboard](https://docs.comis.ai/web-dashboard) | Type: Conceptual | Summary: Manage your Comis agents, channels, and settings from the browser | Prerequisites: Installation | Topics: web dashboard, ui, management
    - [Chat Console](https://docs.comis.ai/web-dashboard/chat) | Type: How-to | Summary: Have real-time conversations with your AI agents through the web browser | Prerequisites: Web Dashboard | Topics: chat, console, web chat
    - [Agents View](https://docs.comis.ai/web-dashboard/agents-view) | Type: How-to | Summary: View and manage your AI agents from the web dashboard | Prerequisites: Web Dashboard | Topics: agents view, management, dashboard
    - [Workspace View](https://docs.comis.ai/web-dashboard/workspace-view) | Type: How-to | Summary: Browse and edit agent workspace files and git history from the web dashboard | Prerequisites: Web Dashboard | Topics: workspace, files, git, editor
    - [Channels View](https://docs.comis.ai/web-dashboard/channels-view) | Type: How-to | Summary: Monitor and manage your messaging platform connections from the web dashboard | Prerequisites: Web Dashboard | Topics: channels view, connections, monitoring
    - [Memory View](https://docs.comis.ai/web-dashboard/memory-view) | Type: How-to | Summary: Browse, search, and manage your agents' stored knowledge | Prerequisites: Web Dashboard | Topics: memory view, search, knowledge
    - [Sessions View](https://docs.comis.ai/web-dashboard/sessions-view) | Type: How-to | Summary: View and manage conversation sessions across all your agents | Prerequisites: Web Dashboard | Topics: sessions view, conversations
    - [Scheduler View](https://docs.comis.ai/web-dashboard/scheduler-view) | Type: How-to | Summary: Manage automated tasks, cron jobs, and heartbeat monitoring | Prerequisites: Web Dashboard | Topics: scheduler view, cron, heartbeat, tasks
    - [Message Center](https://docs.comis.ai/web-dashboard/message-center) | Type: How-to | Summary: Browse, send, and manage messages across all connected channels | Prerequisites: Web Dashboard | Topics: message center, messaging, channels
    - [Sub-Agents](https://docs.comis.ai/web-dashboard/subagents) | Type: How-to | Summary: Monitor spawned sub-agent tasks, outputs, costs, and lineage | Prerequisites: Web Dashboard | Topics: sub-agents, monitoring, spawning
    - [MCP Servers](https://docs.comis.ai/web-dashboard/mcp-management) | Type: How-to | Summary: Manage Model Context Protocol server connections, tools, and health | Prerequisites: Web Dashboard | Topics: mcp, servers, tools, connections
    - [Media](https://docs.comis.ai/web-dashboard/media) | Type: How-to | Summary: Test media processing capabilities and configure media providers | Prerequisites: Web Dashboard | Topics: media, testing, vision, speech, documents
    - [Observability](https://docs.comis.ai/web-dashboard/observability) | Type: How-to | Summary: Monitor your agents' activity, costs, and message delivery from a single view | Prerequisites: Web Dashboard | Topics: observability, monitoring, costs, activity
    - [Security](https://docs.comis.ai/web-dashboard/security-view) | Type: How-to | Summary: Manage security settings, audit logs, and approval gates from the dashboard | Prerequisites: Web Dashboard | Topics: security view, audit logs, approvals
    - [Config Editor](https://docs.comis.ai/web-dashboard/config-editor) | Type: How-to | Summary: View and edit your Comis configuration from the browser | Prerequisites: Web Dashboard | Topics: config editor, configuration, yaml
    - [Pipelines](https://docs.comis.ai/web-dashboard/pipelines) | Type: How-to | Summary: Build and monitor multi-agent workflows visually | Prerequisites: Web Dashboard | Topics: pipelines, workflows, visual editor

---

- [Operations](https://docs.comis.ai/operations) | Type: Conceptual | Summary: Running, monitoring, and maintaining your Comis installation | Prerequisites: Installation | Topics: operations, management, production
    - [Daemon](https://docs.comis.ai/operations/daemon) | Type: Conceptual | Summary: How the Comis daemon starts, runs, and shuts down | Prerequisites: Operations | Topics: daemon, process, startup, shutdown
    - [Logging](https://docs.comis.ai/operations/logging) | Type: How-to | Summary: Understanding and viewing Comis logs | Prerequisites: Operations | Topics: logging, pino, structured logs
    - [Monitoring](https://docs.comis.ai/operations/monitoring) | Type: How-to | Summary: Health monitoring and system alerts | Prerequisites: Operations | Topics: monitoring, health checks, alerts
    - [Observability](https://docs.comis.ai/operations/observability) | Type: Conceptual | Summary: Token tracking, cost estimation, latency, and delivery tracing | Prerequisites: Operations | Topics: observability, tokens, costs, latency, tracing
    - [Scheduler](https://docs.comis.ai/operations/scheduler) | Type: How-to | Summary: Cron jobs, heartbeat monitoring, and task extraction | Prerequisites: Operations | Topics: scheduler, cron, heartbeat, tasks
    - [Web UI](https://docs.comis.ai/operations/web-ui) | Type: How-to | Summary: Setting up the Comis web dashboard | Prerequisites: Operations | Topics: web ui, dashboard, setup
    - [systemd](https://docs.comis.ai/operations/systemd) | Type: How-to | Summary: Running Comis as a systemd service on Linux | Prerequisites: Operations | Topics: systemd, linux, service, deployment
    - [Docker](https://docs.comis.ai/operations/docker) | Type: How-to | Summary: Running Comis in a Docker container for production | Prerequisites: Operations | Topics: docker, container, deployment
    - [pm2](https://docs.comis.ai/operations/pm2) | Type: How-to | Summary: Running Comis with the pm2 process manager | Prerequisites: Operations | Topics: pm2, process manager, deployment
    - [Reverse Proxy](https://docs.comis.ai/operations/reverse-proxy) | Type: How-to | Summary: Putting Comis behind Nginx or Caddy for TLS and domain access | Prerequisites: Operations | Topics: reverse proxy, nginx, caddy, tls, ssl
    - [Troubleshooting](https://docs.comis.ai/operations/troubleshooting) | Type: How-to | Summary: Solutions to common Comis issues | Prerequisites: Operations | Topics: troubleshooting, debugging, common issues
    - [FAQ](https://docs.comis.ai/operations/faq) | Type: Reference | Summary: Frequently asked questions about Comis | Prerequisites: None | Topics: faq, questions, answers

---

- [How Comis Keeps You Safe](https://docs.comis.ai/security) | Type: Conceptual | Summary: An overview of the security protections built into Comis | Prerequisites: None | Topics: security, overview, protections
    - [Defense in Depth](https://docs.comis.ai/security/defense-in-depth) | Type: Conceptual | Summary: How 18+ security layers work together to protect your agents and data | Prerequisites: Security | Topics: defense in depth, security layers, architecture
    - [Secrets](https://docs.comis.ai/security/secrets) | Type: How-to | Summary: How to manage API keys and passwords safely in Comis | Prerequisites: Security | Topics: secrets, api keys, encryption, secret manager
    - [Approvals](https://docs.comis.ai/security/approvals) | Type: How-to | Summary: How to require human approval before agents perform high-risk actions | Prerequisites: Security | Topics: approvals, human-in-the-loop, confirmation gates
    - [Audit Logging](https://docs.comis.ai/security/audit) | Type: Conceptual | Summary: How Comis records security-relevant events for monitoring and compliance | Prerequisites: Security | Topics: audit logging, compliance, security events
    - [Skill Sandboxing](https://docs.comis.ai/security/sandbox) | Type: Conceptual | Summary: How Comis isolates skills to prevent malicious or compromised code from causing harm | Prerequisites: Security | Topics: sandboxing, isolation, skill security
    - [Exec Sandbox](https://docs.comis.ai/security/exec-sandbox) | Type: Conceptual | Summary: OS-level filesystem isolation for the exec tool using bubblewrap (Linux) and sandbox-exec (macOS) | Prerequisites: Security | Topics: exec sandbox, bubblewrap, filesystem isolation
    - [Hardening](https://docs.comis.ai/security/hardening) | Type: How-to | Summary: A step-by-step checklist to maximize the security of your Comis installation | Prerequisites: Security | Topics: hardening, checklist, production security

---

- [Developer Guide](https://docs.comis.ai/developer-guide) | Type: Conceptual | Summary: Extend Comis with custom adapters, plugins, skills, and execution pipelines | Prerequisites: How It Works | Topics: developer guide, extending, customization
    - [Architecture](https://docs.comis.ai/developer-guide/architecture) | Type: Conceptual | Summary: Hexagonal architecture, ports, adapters, and the composition root | Prerequisites: Developer Guide | Topics: architecture, hexagonal, ports, adapters, composition root
    - [Packages](https://docs.comis.ai/developer-guide/packages) | Type: Reference | Summary: All 13 packages with roles, key exports, and dependency relationships | Prerequisites: Developer Guide | Topics: packages, monorepo, dependencies
    - [Event Bus](https://docs.comis.ai/developer-guide/event-bus) | Type: Reference | Summary: 160 typed events across 4 domain subsystems for cross-module communication | Prerequisites: Architecture | Topics: event bus, typed events, pub/sub
    - [Delivery Pipeline](https://docs.comis.ai/architecture/delivery-pipeline) | Type: Conceptual | Summary: How outbound messages flow from agent response through crash-safe persistence to channel delivery | Prerequisites: Architecture | Topics: delivery pipeline, queue, retry, crash recovery
    - [Custom Adapters](https://docs.comis.ai/developer-guide/custom-adapters) | Type: Tutorial | Summary: Build a channel adapter from the ChannelPort interface to a working platform integration | Prerequisites: Architecture | Topics: custom adapters, channel port, platform integration
    - [Plugins](https://docs.comis.ai/developer-guide/plugins) | Type: Reference | Summary: 11 lifecycle hooks and 3 extension registrations for customizing Comis behavior | Prerequisites: Developer Guide | Topics: plugins, hooks, extensions, lifecycle
    - [Custom Skills](https://docs.comis.ai/developer-guide/custom-skills) | Type: Tutorial | Summary: Advanced skill development with SkillPort, manifests, content scanning, and MCP integration | Prerequisites: Skills Overview | Topics: custom skills, skill port, manifests, mcp
    - [Pipelines](https://docs.comis.ai/developer-guide/pipelines) | Type: Reference | Summary: Multi-agent execution graphs with DAG validation, dependency resolution, and parallel coordination | Prerequisites: Developer Guide | Topics: pipelines, dag, execution graphs, orchestration
    - [Contributing](https://docs.comis.ai/developer-guide/contributing) | Type: How-to | Summary: Development setup, coding standards, testing conventions, and PR process | Prerequisites: Developer Guide | Topics: contributing, development, testing, pull requests

---

- [CLI Reference](https://docs.comis.ai/reference/cli) | Type: Reference | Summary: Complete reference for all 17 command groups, subcommands, and flags | Prerequisites: Installation | Topics: cli, commands, flags
- [Config YAML Reference](https://docs.comis.ai/reference/config-yaml) | Type: Reference | Summary: Complete reference for all configuration options with types, defaults, and validation rules | Prerequisites: Configuration Guide | Topics: config, yaml, schema, validation
- [Environment Variables](https://docs.comis.ai/reference/environment-variables) | Type: Reference | Summary: Complete reference for all Comis environment variables | Prerequisites: Configuration Guide | Topics: environment variables, env
- [Hot Reload](https://docs.comis.ai/reference/hot-reload) | Type: Reference | Summary: Config and skill hot reload mechanism reference covering SIGUSR1 restart and chokidar file watching | Prerequisites: Configuration Guide | Topics: hot reload, sigusr1, file watching
- [Secret Manager](https://docs.comis.ai/reference/secret-manager) | Type: Reference | Summary: Secret management system technical reference covering SecretManager interface, encryption, scoping, and audit | Prerequisites: Secrets | Topics: secret manager, encryption, scoping
- [Delivery Queue](https://docs.comis.ai/configuration/delivery-queue) | Type: Reference | Summary: Crash-safe outbound message persistence, recovery, and delivery queue configuration reference | Prerequisites: Configuration Guide | Topics: delivery queue, crash recovery, persistence, retry
- [Security Model](https://docs.comis.ai/reference/security-model) | Type: Reference | Summary: Complete technical reference for all security mechanisms, thresholds, patterns, and configuration | Prerequisites: Security | Topics: security model, mechanisms, thresholds
- [Sandbox](https://docs.comis.ai/reference/sandbox) | Type: Reference | Summary: Skill sandboxing implementation reference covering content scanning, sanitization, tool policy, and execution limits | Prerequisites: Skill Sandboxing | Topics: sandbox, content scanning, sanitization
- [Safe Path](https://docs.comis.ai/reference/safe-path) | Type: Reference | Summary: Path traversal prevention reference with 5 attack vector defenses | Prerequisites: Security Model | Topics: safe path, path traversal, attack vectors
- [Action Classifier](https://docs.comis.ai/reference/action-classifier) | Type: Reference | Summary: Complete registry of action classifications for security audit logging and confirmation gates | Prerequisites: Security Model | Topics: action classifier, audit, classifications
- [Tool Security](https://docs.comis.ai/reference/tool-security) | Type: Reference | Summary: SSRF guard, tool policy profiles, content scanning, sanitization pipeline, and audit wrapper reference | Prerequisites: Security Model | Topics: tool security, ssrf, content scanning, audit
- [Node Permissions](https://docs.comis.ai/reference/node-permissions) | Type: Reference | Summary: Node.js permission model integration reference for child process sandboxing | Prerequisites: Security Model | Topics: node permissions, child process, sandboxing
- [HTTP Gateway Reference](https://docs.comis.ai/reference/http-gateway) | Type: Reference | Summary: Complete reference for all HTTP endpoints, authentication, and rate limiting | Prerequisites: Operations | Topics: http gateway, endpoints, authentication, hono
- [JSON-RPC Methods Reference](https://docs.comis.ai/reference/json-rpc) | Type: Reference | Summary: Complete reference for all JSON-RPC methods across 30 namespaces | Prerequisites: HTTP Gateway Reference | Topics: json-rpc, methods, namespaces
- [WebSocket Protocol Reference](https://docs.comis.ai/reference/websocket) | Type: Reference | Summary: WebSocket connection protocol, authentication, heartbeat, and error handling | Prerequisites: HTTP Gateway Reference | Topics: websocket, protocol, heartbeat
- [OpenAI-Compatible API](https://docs.comis.ai/reference/openai-api) | Type: Reference | Summary: Complete request/response schema reference for /v1/chat/completions, /v1/models, and /v1/embeddings | Prerequisites: HTTP Gateway Reference | Topics: openai api, chat completions, embeddings, compatibility
- [Webhooks](https://docs.comis.ai/reference/webhooks) | Type: Reference | Summary: Path-routed webhook ingestion with HMAC verification, template engine, and configurable presets | Prerequisites: HTTP Gateway Reference | Topics: webhooks, hmac, ingestion
- [Rate Limiting](https://docs.comis.ai/reference/rate-limiting) | Type: Reference | Summary: Multi-layer rate limiting reference covering HTTP, WebSocket, config patch, and injection detection layers | Prerequisites: HTTP Gateway Reference | Topics: rate limiting, throttling, injection detection
