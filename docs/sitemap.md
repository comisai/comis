# Comis Documentation Sitemap

A navigation index generated from the five documentation sections in docs.json. It complements, rather than replaces, the individual pages.

## Start here

### Understand Comis

- [Welcome to Comis](https://docs.comis.ai/get-started) — Open-source agent runtime for governed execution
- [Quickstart](https://docs.comis.ai/get-started/quickstart) — Install Comis, configure an agent, and verify your first conversation
- [Use Cases](https://docs.comis.ai/get-started/use-cases) — Governed workflows that make Comis's execution, state, authority, cost, and evidence concrete
- [How It Works](https://docs.comis.ai/get-started/how-it-works) — How Comis routes, constrains, records, and recovers multi-agent work
- [Security Boundaries](https://docs.comis.ai/get-started/security) — What Comis protects, what requires configuration, and what remains your responsibility
- [Glossary](https://docs.comis.ai/get-started/glossary) — Definitions for every technical term used in the Comis documentation

### Install

- [Installation](https://docs.comis.ai/installation) — Choose a supported way to install and operate Comis
- [Requirements](https://docs.comis.ai/installation/requirements) — Platform, runtime, and model prerequisites for Comis
- [Install with npm on Linux](https://docs.comis.ai/installation/install-linux) — Install Comis as your current user without changing system services
- [Install on a Linux server](https://docs.comis.ai/installation/install-vps) — Run Comis under a managed systemd service on a Linux host
- [Install with Docker](https://docs.comis.ai/installation/install-docker) — Run Comis in a Docker container with Docker Compose
- [Install on Render](https://docs.comis.ai/installation/install-render) — Deploy Comis to Render.com from Docker Hub — managed Linux host, automatic HTTPS, persistent storage
- [Configuration Guide](https://docs.comis.ai/installation/configuration) — Set up your config.yaml with required settings, channels, and customization
- [Verify Your Installation](https://docs.comis.ai/installation/verify) — Confirm that Comis is installed correctly and running as expected

## Use Comis

### Agents

- [Agents](https://docs.comis.ai/agents) — What agents are and how they work inside Comis
- [Agent Lifecycle](https://docs.comis.ai/agents/lifecycle) — How your agent processes messages from arrival to response
- [Identity](https://docs.comis.ai/agents/identity) — How workspace files shape your agent's personality and behavior
- [Autonomy](https://docs.comis.ai/agents/autonomy) — Named autonomy profiles, the zero-config default, and the honest, legible degrade
- [Routing](https://docs.comis.ai/agents/routing) — How Comis decides which agent handles each message
- [Slash Commands](https://docs.comis.ai/agents/slash-commands) — Verified chat commands for sessions, models, execution, and approvals
- [Sessions](https://docs.comis.ai/agents/sessions) — How Comis manages conversations between you and your agent
- [Subagent Context Lifecycle](https://docs.comis.ai/agents/subagent-lifecycle) — How Comis prepares, runs, and captures results from sub-agent sessions
- [Long-Running Coordinator](https://docs.comis.ai/agents/efficiency) — The run-for-days pattern: a lean coordinator offloads heavy work to fresh-window children that return a summary plus a ResultRef, so the lead stays context-flat
- [Context Management](https://docs.comis.ai/agents/context-management) — How Comis fits long conversations into the model's window without losing what matters
- [Compaction](https://docs.comis.ai/agents/compaction) — How Comis automatically manages conversation length
- [Memory Recall (RAG)](https://docs.comis.ai/agents/rag) — How relevant stored context can be recalled for a new request
- [Message Queue](https://docs.comis.ai/agents/queue) — How Comis handles multiple messages and ensures orderly processing
- [Execution Graphs](https://docs.comis.ai/agents/execution-graphs) — Multi-agent DAG orchestration -- define, execute, and monitor workflows where each node is a sub-agent task
- [Memory](https://docs.comis.ai/agents/memory) — How your agent stores and organizes long-term knowledge
- [Memory configuration](https://docs.comis.ai/agents/memory-config) — Every Comis memory capability and the exact config option that enables it — recall, the recall-time signals, the one learning-reflection engine, and the maintenance jobs
- [Search](https://docs.comis.ai/agents/search) — How your agent finds relevant memories
- [Embeddings](https://docs.comis.ai/agents/embeddings) — Setting up meaning-based memory search
- [Memory benchmarks](https://docs.comis.ai/agents/memory-benchmarks) — How Comis measures recall quality: the datasets, the gated harnesses, and how to reproduce the runs
- [Models](https://docs.comis.ai/agents/models) — Configuring AI providers, model selection, and automatic failover
- [Safety](https://docs.comis.ai/agents/safety) — Configure budgets, circuit breakers, tool policy, and approval controls
- [Resilience](https://docs.comis.ai/agents/resilience) — How Comis detects and reports provider, prompt, and sub-agent failures
- [Context Cache](https://docs.comis.ai/agents/cache) — How Comis keeps prompt costs low across long-running agent sessions

### Channels

- [Channels](https://docs.comis.ai/channels) — Connect Comis to Discord, Telegram, Slack, WhatsApp, Signal, iMessage, LINE, IRC, Email, and Microsoft Teams
- [Multiple users & teams](https://docs.comis.ai/channels/multi-user) — Configure multi-user routing and isolation across supported channels
- [Discord](https://docs.comis.ai/channels/discord) — Connect Comis to Discord with step-by-step setup
- [Telegram](https://docs.comis.ai/channels/telegram) — Connect Comis to Telegram with step-by-step setup
- [Slack](https://docs.comis.ai/channels/slack) — Connect Comis to Slack with step-by-step setup
- [WhatsApp](https://docs.comis.ai/channels/whatsapp) — Connect Comis to WhatsApp with step-by-step setup
- [Signal](https://docs.comis.ai/channels/signal) — Connect Comis to Signal with step-by-step setup
- [iMessage](https://docs.comis.ai/channels/imessage) — Connect Comis to iMessage on macOS
- [LINE](https://docs.comis.ai/channels/line) — Connect Comis to LINE with step-by-step setup
- [IRC](https://docs.comis.ai/channels/irc) — Connect Comis to IRC with step-by-step setup
- [Email](https://docs.comis.ai/channels/email) — Connect Comis to Email with step-by-step IMAP/SMTP setup
- [Microsoft Teams](https://docs.comis.ai/channels/msteams) — Connect Comis to Microsoft Teams with step-by-step setup
- [Delivery Infrastructure](https://docs.comis.ai/channels/delivery) — How Comis delivers messages: streaming, typing indicators, retry logic, delivery hooks, session mirroring, and reply modes

### Skills and integrations

- [Skills Overview](https://docs.comis.ai/skills) — Understand the types of skills and tools your Comis agents can use
- [Built-in Tools](https://docs.comis.ai/skills/built-in-tools) — Reference for built-in file, shell, web, and browser tools
- [Platform Tools](https://docs.comis.ai/skills/platform-tools) — Overview of all Comis-specific tools agents can use for messaging, scheduling, and administration
- [Prompt Skills](https://docs.comis.ai/skills/prompt-skills) — Create discoverable Markdown procedures that agents can select and read
- [Skill Examples](https://docs.comis.ai/skills/examples) — Complete skill walkthroughs you can follow step by step
- [Skill Manifest](https://docs.comis.ai/skills/manifest) — Complete reference for the SKILL.md file format and all available fields
- [Security Scanning](https://docs.comis.ai/skills/security-scanning) — What Comis checks for when loading custom skills
- [Tool Policy](https://docs.comis.ai/skills/tool-policy) — Control which tools your agents can use with profiles, groups, and allow/deny lists
- [MCP Integration](https://docs.comis.ai/skills/mcp) — Connect external tools to your agents using the Model Context Protocol
- [Tool-First Capability Layer](https://docs.comis.ai/skills/tooling-layer) — Operator workflow for the tooling: config block — discover MCPs/skills, generate a capability index, and route the agent away from redundant package installs.

### Agent tools

- [Agent Tools Overview](https://docs.comis.ai/agent-tools) — Guide to the agent-facing tool families
- [Scheduling](https://docs.comis.ai/agent-tools/scheduling) — Create scheduled jobs and manage agent heartbeat timing
- [Messaging](https://docs.comis.ai/agent-tools/messaging) — Send, reply, react, edit, and delete messages across channels
- [Sessions](https://docs.comis.ai/agent-tools/sessions) — Manage conversations, spawn sub-agents, send messages between sessions, and access long-term memory
- [Pipelines](https://docs.comis.ai/agent-tools/pipelines) — The pipeline tool for defining, executing, and managing multi-agent execution graphs
- [Media](https://docs.comis.ai/agent-tools/media) — Image analysis, text-to-speech, audio transcription, video description, and document extraction
- [Infrastructure](https://docs.comis.ai/agent-tools/infrastructure) — Configuration management, gateway control, and supervisor administration tools
- [Browser](https://docs.comis.ai/agent-tools/browser) — Browser automation for navigation, interaction, and screenshots
- [Interactive Terminal Driver](https://docs.comis.ai/agent-tools/terminal-driver) — Drive interactive terminal programs -- shells, REPLs, full-screen TUIs, and AI coding CLIs -- through a real PTY, governed like an MCP server
- [Coding CLIs: Claude Code & Codex](https://docs.comis.ai/agent-tools/coding-clis) — Drive Claude Code and OpenAI Codex as first-class coding agents through the terminal driver — config examples and how it works.
- [Autonomous Builds: spec → GSD → shipped](https://docs.comis.ai/agent-tools/gsd-builder) — Hand the agent a design document and it implements the whole thing — driving Claude Code through the GSD spec-driven workflow, phase by phase, test-first.
- [Web Tools](https://docs.comis.ai/agent-tools/web-tools) — Web search and validated web-page fetching
- [Orchestrate: chain tools in one jailed turn](https://docs.comis.ai/agent-tools/orchestrate) — The orchestrate tool runs a model-written script that chains capability-scoped typed tools in a single jailed child — only stdout re-enters context. The autonomy primitive.
- [Platform Actions](https://docs.comis.ai/agent-tools/platform-actions) — Discord, Telegram, Slack, and WhatsApp moderation and management actions

### Media

- [Media & Voice](https://docs.comis.ai/media) — How your agent handles images, voice messages, documents, links, and interactive messages
- [Vision](https://docs.comis.ai/media/vision) — How your agent sees and understands images and videos
- [Voice](https://docs.comis.ai/media/voice) — Speech-to-text transcription and text-to-speech auto-reply for voice messages
- [Documents](https://docs.comis.ai/media/documents) — How your agent reads PDFs, spreadsheets, code files, and other documents
- [Links](https://docs.comis.ai/media/links) — How your agent understands web pages shared in messages
- [Rich Messages](https://docs.comis.ai/media/rich-messages) — Buttons, cards, and effects across Discord, Telegram, Slack, and more

### Web dashboard

- [Web Dashboard](https://docs.comis.ai/web-dashboard) — Manage your Comis agents, channels, and settings from the browser
- [Chat Console](https://docs.comis.ai/web-dashboard/chat) — Have real-time conversations with your AI agents through the web browser
- [Agents View](https://docs.comis.ai/web-dashboard/agents-view) — View, create, edit, and delete your AI agents from the dashboard
- [Workspace View](https://docs.comis.ai/web-dashboard/workspace-view) — Browse and edit agent workspace files, manage git history from the web dashboard
- [Channels View](https://docs.comis.ai/web-dashboard/channels-view) — Monitor and manage your messaging platform connections from the web dashboard
- [Message Center](https://docs.comis.ai/web-dashboard/message-center) — Browse, send, and manage messages across all connected channels
- [Sessions View](https://docs.comis.ai/web-dashboard/sessions-view) — View and manage conversation sessions across all your agents
- [Sub-Agents](https://docs.comis.ai/web-dashboard/subagents) — Monitor spawned sub-agent tasks, outputs, costs, and lineage
- [Pipelines](https://docs.comis.ai/web-dashboard/pipelines) — Build and monitor multi-agent workflows visually
- [Observability](https://docs.comis.ai/web-dashboard/observability) — Monitor your agents' activity, costs, and message delivery from a single view
- [Skills View](https://docs.comis.ai/web-dashboard/skills) — Browse installed skills and built-in tools per agent
- [MCP Servers](https://docs.comis.ai/web-dashboard/mcp-management) — Manage Model Context Protocol server connections, tools, and health
- [Models View](https://docs.comis.ai/web-dashboard/models) — Configure AI providers, model catalog, aliases, and per-agent defaults
- [Memory View](https://docs.comis.ai/web-dashboard/memory-view) — Browse, search, and manage your agents' stored knowledge
- [Scheduler View](https://docs.comis.ai/web-dashboard/scheduler-view) — Manage automated tasks, cron jobs, and heartbeat monitoring
- [Security](https://docs.comis.ai/web-dashboard/security-view) — Manage security settings, audit logs, approval gates, and gateway tokens
- [Media](https://docs.comis.ai/web-dashboard/media) — Test media processing capabilities and configure media providers
- [Config Editor](https://docs.comis.ai/web-dashboard/config-editor) — Edit your Comis configuration from the browser -- changes save to disk and survive restarts

## Operate Comis

### Operations

- [Operations](https://docs.comis.ai/operations) — Running, monitoring, and maintaining your Comis installation
- [Daemon](https://docs.comis.ai/operations/daemon) — How the Comis daemon starts, runs, and shuts down
- [Logging](https://docs.comis.ai/operations/logging) — Understanding and viewing Comis logs
- [Monitoring](https://docs.comis.ai/operations/monitoring) — Health monitoring and system alerts
- [Observability](https://docs.comis.ai/operations/observability) — Trace correlation, bridge events, lifecycle envelopes, dedup detection, and operator-grade diagnostics
- [Prometheus & Grafana](https://docs.comis.ai/operations/prometheus-grafana) — The opt-in OpenTelemetry/Prometheus export surface — a loopback /metrics endpoint, shipped Grafana dashboards-as-code, recording/alert rules, and a one-command docker-compose stand-up. Off by default and content-free.
- [Scheduler](https://docs.comis.ai/operations/scheduler) — Cron jobs, heartbeat monitoring, and task extraction
- [Web UI](https://docs.comis.ai/operations/web-ui) — Setting up the Comis web dashboard
- [Data Directory](https://docs.comis.ai/operations/data-directory) — A complete reference for everything Comis keeps in ~/.comis/ — what each file is, when it's written, and what's safe to delete.
- [Trace CLI](https://docs.comis.ai/operations/trace-cli) — comis trace subcommands — search by messageId, traceId, chat, time; export bundles
- [Incident Bundle Export](https://docs.comis.ai/operations/incident-bundle) — Export a self-contained diagnostic bundle for a session — CLI + slash command + redaction policy
- [Local Models](https://docs.comis.ai/operations/local-models) — Running Comis on local Ollama models — recommended models with measured receipts, capacity and latency knobs, and what each boot WARN means
- [Multilingual](https://docs.comis.ai/operations/multilingual) — Which scripts Comis serves (Hebrew · Arabic · Russian · CJK · general non-Latin), the search/token/degradation behavior per script, and the knobs + fleet checks that prove a multilingual stack works
- [systemd](https://docs.comis.ai/operations/systemd) — Running Comis as a systemd service on Linux
- [Docker](https://docs.comis.ai/operations/docker) — Running Comis in Docker, including Linux production boundaries
- [Docker Hub Publishing](https://docs.comis.ai/operations/docker-hub) — Publish Comis images to Docker Hub and pull official releases
- [pm2](https://docs.comis.ai/operations/pm2) — Running Comis with the pm2 process manager
- [Reverse Proxy](https://docs.comis.ai/operations/reverse-proxy) — Putting Comis behind Nginx or Caddy for TLS and domain access
- [Troubleshooting](https://docs.comis.ai/operations/troubleshooting) — Solutions to common Comis issues
- [FAQ](https://docs.comis.ai/operations/faq) — Frequently asked questions about Comis
- [HTTPS Proxy](https://docs.comis.ai/operations/proxy) — Routing Comis's outbound traffic (including OAuth) through HTTPS_PROXY

### Security

- [Security](https://docs.comis.ai/security) — Security controls, deployment boundaries, and operator responsibilities
- [Threat Model](https://docs.comis.ai/security/threat-model) — Trust boundaries, defended threats, and residual risks
- [Capability Model](https://docs.comis.ai/security/capability-model) — The single capability gate, deny-by-origin on the control plane, and why no capability implies admin
- [Defense in Depth](https://docs.comis.ai/security/defense-in-depth) — How Comis combines independent controls across the request lifecycle
- [Secrets](https://docs.comis.ai/security/secrets) — How to manage API keys and passwords safely in Comis
- [OAuth](https://docs.comis.ai/security/oauth) — Subscription-based authentication via OpenAI Codex (PKCE OAuth) -- login flows, storage, profiles, and refresh
- [Approvals](https://docs.comis.ai/security/approvals) — How to require human approval before agents perform high-risk actions
- [Audit Logging](https://docs.comis.ai/security/audit) — How Comis records security-relevant events for monitoring and compliance
- [Skill Sandboxing](https://docs.comis.ai/security/sandbox) — Application-level checks for prompt skills and configured integrations
- [Exec Sandbox](https://docs.comis.ai/security/exec-sandbox) — Optional OS-level filesystem isolation for system.exec on supported hosts
- [Credential Broker](https://docs.comis.ai/security/credential-broker) — Drive API-key CLIs from the exec sandbox with the key never inside the namespace — injected at the network boundary by an in-daemon MITM broker
- [Hardening](https://docs.comis.ai/security/hardening) — A practical checklist for reducing deployment risk

## Extend Comis

### Architecture

- [Developer Guide](https://docs.comis.ai/developer-guide) — Extend Comis with custom adapters, plugins, skills, and execution pipelines
- [Architecture](https://docs.comis.ai/developer-guide/architecture) — Hexagonal architecture, ports, adapters, and the composition root
- [Packages](https://docs.comis.ai/developer-guide/packages) — Package roles, key exports, and dependency relationships
- [Event Bus](https://docs.comis.ai/developer-guide/event-bus) — Typed events for cross-module communication
- [Delivery Pipeline](https://docs.comis.ai/developer-guide/architecture/delivery-pipeline) — How outbound messages flow from agent response to channel delivery

### Build extensions

- [Custom Adapters](https://docs.comis.ai/developer-guide/custom-adapters) — Build a channel adapter from the ChannelPort interface to a working platform integration
- [Plugins](https://docs.comis.ai/developer-guide/plugins) — Lifecycle hooks and extension registrations for customizing Comis behavior
- [Custom Skills](https://docs.comis.ai/developer-guide/custom-skills) — Advanced skill development with SkillPort, manifests, content scanning, and MCP integration
- [Pipelines](https://docs.comis.ai/developer-guide/pipelines) — Multi-agent execution graphs with DAG validation, dependency resolution, and parallel coordination
- [Channel-Emulation Harness](https://docs.comis.ai/developer-guide/channel-emulation-harness) — Drive Comis end-to-end through the real channel adapter against an isolated, offline daemon — the test/live framework, the chan/tg CLI, and the dual-oracle workflow.
- [Contributing](https://docs.comis.ai/developer-guide/contributing) — Development setup, coding standards, testing conventions, and PR process
- [Comis as MCP server](https://docs.comis.ai/integrations/mcp-server) — Use Comis as an MCP backend for Claude Desktop, Cursor, and other agent platforms.

## Reference

### CLI

- [Reference](https://docs.comis.ai/reference) — Technical reference for the Comis CLI, configuration schema, security model, and gateway APIs.
- [CLI Reference](https://docs.comis.ai/reference/cli) — Complete reference for all command groups, subcommands, and flags
- [comis-agent CLI](https://docs.comis.ai/reference/comis-agent-cli) — The in-jail, capability-scoped CLI an agent drives over the lease capability socket -- same gate as the typed tools, no admin reach

### Configuration

- [Config YAML Reference](https://docs.comis.ai/reference/config-yaml) — Complete reference for all configuration options with types, defaults, and validation rules
- [Environment Variables](https://docs.comis.ai/reference/environment-variables) — Complete reference for all Comis environment variables
- [Hot Reload](https://docs.comis.ai/reference/hot-reload) — Config and skill hot reload mechanism reference covering SIGUSR1 restart and chokidar file watching
- [Secret Manager](https://docs.comis.ai/reference/secret-manager) — Secret management system technical reference covering SecretManager interface, encryption, scoping, and audit
- [Delivery Queue](https://docs.comis.ai/reference/configuration/delivery-queue) — Crash-safe outbound message persistence and recovery

### Security

- [Security Model](https://docs.comis.ai/reference/security-model) — Complete technical reference for all security mechanisms, thresholds, patterns, and configuration
- [Sandbox](https://docs.comis.ai/reference/sandbox) — Skill sandboxing reference plus exec-tool OS-level sandbox config (bubblewrap / sandbox-exec)
- [Safe Path](https://docs.comis.ai/reference/safe-path) — Path validation and traversal-prevention reference
- [Action Classifier](https://docs.comis.ai/reference/action-classifier) — Complete registry of action classifications for security audit logging and confirmation gates
- [Tool Security](https://docs.comis.ai/reference/tool-security) — SSRF guard, tool policy profiles, content scanning, sanitization pipeline, and audit wrapper reference
- [Node Permissions](https://docs.comis.ai/reference/node-permissions) — Node.js permission model integration reference for child process sandboxing
- [Known Limitations](https://docs.comis.ai/reference/known-limitations) — Candid listing of current platform limitations operators should factor into production deployments

### Gateway and APIs

- [HTTP Gateway Reference](https://docs.comis.ai/reference/http-gateway) — Complete reference for all HTTP endpoints, authentication, and rate limiting
- [JSON-RPC Methods Reference](https://docs.comis.ai/reference/json-rpc) — Reference for the JSON-RPC methods exposed by the daemon
- [WebSocket Protocol Reference](https://docs.comis.ai/reference/websocket) — WebSocket connection protocol, authentication, heartbeat, and error handling
- [Experimental OpenAI-Shaped API](https://docs.comis.ai/reference/openai-api) — Implemented request and response shapes for the experimental /v1/chat/completions, /v1/models, and /v1/embeddings routes
- [Webhooks](https://docs.comis.ai/reference/webhooks) — Path-routed webhook ingestion with HMAC verification, template engine, and configurable presets
- [Rate Limiting](https://docs.comis.ai/reference/rate-limiting) — Multi-layer rate limiting reference covering HTTP, WebSocket, config patch, and injection detection layers
- [ACP Server](https://docs.comis.ai/reference/acp-server) — Experimental Agent Client Protocol building blocks for connecting ACP clients to Comis
