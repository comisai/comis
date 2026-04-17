# Technology Stack

**Analysis Date:** 2026-04-17

## Languages

**Primary:**
- TypeScript 5.9.3 - Entire codebase (backend, frontend, CLI, daemon)
- JavaScript (configuration, build scripts, GitHub Actions)
- Shell (docker-setup.sh, deployment scripts)

**Target:**
- ES2023 with strict mode enabled
- Node.js >= 22 (ES modules only, `"type": "module"`)

## Runtime

**Environment:**
- Node.js >= 22 (required)
- Linux (primary target; Windows/macOS for development only)
- Data directory: `~/.comis` (configurable, contains config, DB, models, logs)

**Package Manager:**
- pnpm (latest, via corepack)
- Lockfile: `pnpm-lock.yaml` (present, frozen in CI)
- Workspace: 13 packages defined in `pnpm-workspace.yaml`
- Override: `tar >= 7.5.7`, `@sinclair/typebox 0.34.49`

## Frameworks

**Build & TypeScript:**
- TypeScript 5.9.3 - Compiler with strict mode, composite projects, isolatedModules
  - Config: `tsconfig.base.json` (shared, strict, ES2023, NodeNext)
  - Per-package configs with project references in `packages/*/tsconfig.json`
- Vite 7.0.0 - Web SPA bundler (`packages/web/vite.config.ts`)
- esbuild (via TypeScript) - Package builds

**HTTP & Networking:**
- Hono 4.12.5 - Lightweight HTTP server/router (gateway, daemon)
- @hono/node-server 1.19.11 - Node.js adapter for Hono
- @hono/node-ws 1.3.0 - WebSocket support for Hono
- hono-rate-limiter 0.5.3 - Rate limiting middleware
- json-rpc-2.0 1.7.1 - JSON-RPC 2.0 protocol implementation
- ws 8.19.0 - WebSocket client (CLI)
- undici 7.22.0 - HTTP client (fetch polyfill, skills)

**Validation & Configuration:**
- Zod 4.3.6 - Schema validation and runtime type safety (88 schema definition files in `packages/core/src/config/`)
- yaml 2.8.2 - Config file parsing and generation
- Layered config: defaults → YAML files → env overrides (no file watcher)
- Config paths via `COMIS_CONFIG_PATHS` env var (comma-separated)
- Runtime updates via RPC only (in-memory, no file write)

**Database & Storage:**
- better-sqlite3 12.6.2 - Synchronous SQLite with native bindings (required: native compilation)
- sqlite-vec 0.1.7-alpha.2 - Vector search extension for SQLite
- lru-cache 11.2.6 - LRU cache for embeddings
- pdfjs-dist 5.5.207 - PDF text extraction

**Logging:**
- Pino 10.3.1 - Structured JSON logging (all packages)
- pino-pretty 13.1.3 - Pretty-print formatter (dev only)
- pino-roll 4.0.0 - Log rotation (daemon)

**CLI & Interactive:**
- Commander 14.0.0 - Command-line interface parser
- @clack/prompts 1.1.0 - Interactive CLI prompts
- @clack/core 1.1.0 - Core prompt components
- chalk 5.6.2 - Terminal color formatting
- cli-table3 0.6.5 - ASCII table formatting
- ora 9.0.0 - Spinner/progress indicators

**Testing:**
- Vitest 4.0.0 - Workspace test runner
  - Config: `vitest.config.ts` (workspace projects) + per-package `vitest.config.ts`
  - Unit tests: co-located with source (`src/**/*.test.ts`)
  - Integration tests: `test/vitest.config.ts` with `maxConcurrency: 1`
- happy-dom 20.8.3 - Lightweight DOM for web tests
- @playwright/test 1.58.2 - E2E testing (web package)

**Linting & Code Quality:**
- ESLint 10.0.3 - Linting with flat config (`eslint.config.js`)
- @eslint/js 10.0.1 - ESLint JavaScript config
- typescript-eslint 8.56.1 - TypeScript linting rules
- eslint-plugin-security 4.0.0 - Security-focused lint rules
  - Bans: eval(), raw path.join(), direct process.env, Function() constructor
  - Requires: suppressError() for ignored promises, safePath() for file paths, SecretManager for env access

**Frontend:**
- Lit 3.3.2 - Lightweight web components (`packages/web`)
- Tailwind CSS 4.2.1 - Utility CSS framework (web)
- @tailwindcss/vite 4.2.1 - Tailwind CSS bundler integration
- @dagrejs/dagre 2.0.4 - Graph/DAG layout (web visualization)

**Service Discovery:**
- @homebridge/ciao 1.3.5 - mDNS for service discovery

## Key Dependencies

**AI & LLM Execution:**
- @mariozechner/pi-agent-core 0.65.0 - Agent execution engine
- @mariozechner/pi-ai 0.65.0 - AI model integration
- @mariozechner/pi-coding-agent 0.65.0 - Code generation agent
- @google/genai 1.47.0 - Google Gemini API client (agent)
- openai 6.27.0 - OpenAI API (embedding, TTS, transcription, vision, image generation)
- @agentclientprotocol/sdk 0.15.0 - Agent Client Protocol (gateway)

**MCP (Model Context Protocol):**
- @modelcontextprotocol/sdk 1.27.1 - MCP client (skills package)

**Image & Media Processing:**
- sharp 0.34.5 - Image processing and resizing (native dependency)
- @napi-rs/canvas 0.1.96 - Canvas drawing for image generation (native dependency)
- pdfjs-dist 5.5.207 - PDF text extraction
- music-metadata 11.12.1 - Audio metadata parsing
- file-type 21.3.0 - MIME type detection
- chardet 2.1.1 - Character encoding detection
- iconv-lite 0.7.2 - Character encoding conversion
- @mozilla/readability 0.6.0 - Article content extraction
- linkedom 0.18.12 - Lightweight DOM implementation
- playwright-core 1.58.2 - Headless browser automation

**Text Processing & Utilities:**
- diff 8.0.4 - Text diffing
- proper-lockfile 4.1.2 - File-based locking (agent, scheduler)
- p-queue 9.1.0 - Async task queue (agent, memory, skills)
- impit 0.8.2 - Runtime code injection for proxies (skills)
- chokidar 5.0.0 - File system watcher (skills)
- ignore 7.0.5 - .gitignore-pattern matching (skills)
- @sinclair/typebox 0.34.48 - Type-based schema validation (skills)
- ipaddr.js 2.3.0 - IP address utilities
- safe-regex2 5.0.0 - Regular expression safety checking

**Chat Platform SDKs:**
- discord.js 14.25.1 - Discord API client
- grammy 1.41.1 - Telegram Bot API client
- @grammyjs/auto-retry 2.0.2 - Retry middleware for grammy
- @grammyjs/runner 2.0.3 - Long-polling runner for grammy
- @grammyjs/files 1.2.0 - File handling for grammy
- @slack/bolt 4.6.0 - Slack bot framework
- @slack/web-api 7.14.1 - Slack REST API client
- @whiskeysockets/baileys 7.0.0-rc.9 - WhatsApp client (native dependency)
- @line/bot-sdk 10.6.0 - LINE Messaging API SDK
- irc-framework 4.14.0 - IRC protocol client

**Audio & Voice:**
- @elevenlabs/elevenlabs-js 2.38.1 - ElevenLabs TTS API client
- edge-tts-universal 1.4.0 - Microsoft Edge TTS (fallback)

**Email:**
- imapflow 1.2.18 - IMAP client for email
- mailparser 3.9.6 - Email message parsing
- nodemailer 8.0.5 - SMTP client for sending email

**Image Generation:**
- @fal-ai/client 1.9.5 - FAL image generation API client

**Local Embeddings (Optional):**
- node-llama-cpp 3.17.1 - Local LLM inference via GGUF (optional for embeddings)

**Error Handling:**
- @hapi/boom 10.0.1 - HTTP error generation

**Miscellaneous:**
- croner 10.0.1 - Cron scheduler (scheduler package)

## Configuration

**Environment:**
- Layered config system via Zod schemas in `packages/core/src/config/`
  - Defaults (hardcoded in schema files)
  - YAML files (paths via `COMIS_CONFIG_PATHS` env var, comma-separated)
  - Environment variable overrides (via `${VAR}` substitution in YAML)
- 88 config schema files covering 100+ Zod validators
- Config load: once at startup, never watched
- Runtime config updates: via `config.write` RPC only (in-memory)
- Secret storage: `SECRETS_MASTER_KEY` env var (AES-256-GCM encryption)
- SecretManager handles credential access (no plaintext in config files)

**Build:**
- `tsconfig.base.json` - Shared TypeScript config (strict, ES2023, NodeNext)
- `packages/*/tsconfig.json` - Per-package configs with project references
- `packages/web/vite.config.ts` - Web SPA Vite build
- `eslint.config.js` - Centralized ESLint flat config
- `pnpm-workspace.yaml` - Monorepo workspace definition
- Packages built with `tsc` (per-package), outputs to `packages/*/dist/`
- Test files: `*.test.ts` co-located with source or in `test/` root directory

## Platform Requirements

**Development:**
- Node.js >= 22
- pnpm (latest)
- Native build tools (for better-sqlite3, sharp, @whiskeysockets/baileys, @napi-rs/canvas):
  - build-essential (Linux)
  - python3 (for node-gyp)
  - C++ compiler (g++ or clang)

**Production:**
- Node.js >= 22
- Linux (primary target)
- Docker/Dockerfile support for multi-platform builds (amd64, arm64)
- Data directory: `~/.comis` (configurable)
- systemd support (optional, for daemon integration)

---

*Stack analysis: 2026-04-17*
