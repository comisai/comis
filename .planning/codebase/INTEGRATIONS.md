# External Integrations

**Analysis Date:** 2026-04-17

## APIs & External Services

**AI & LLM Providers:**
- Google Gemini - `@google/genai` client (`packages/agent`)
  - Auth: API key via SecretManager
  - Features: Extended thinking, embeddings, model support
  - Config: `schema-providers.ts` (named provider entries)
  
- OpenAI - `openai` client (embedding, TTS, transcription, vision, image generation)
  - Auth: API key via SecretManager
  - Used in: `packages/agent`, `packages/memory`, `packages/skills`, `packages/gateway`
  - Models: configurable, with cost tracking (input, output, cache read/write)
  - Config: `schema-providers.ts` (provider entry with model definitions)

- Anthropic - Vision analysis support (optional provider)
  - Auth: API key via SecretManager
  - Config: `schema-integrations.ts` → `VisionConfigSchema` (provider list)

- Ollama - Custom/local LLM support (configurable via provider entry)
  - Config: `schema-providers.ts`

**Search & Information Retrieval:**
- Brave Search - Web search integration
  - SDK: None (HTTP API)
  - Auth: API key via SecretManager (`BraveSearchConfigSchema.apiKey`)
  - Features: Configurable result count, rate limiting, caching (1-hour default TTL)
  - Config: `schema-integrations.ts` → `BraveSearchConfigSchema`
  - Endpoint: `integrations.braveSearch` in YAML

**Chat Platform Integrations:**
- Discord - `discord.js` client (`packages/channels`)
  - Auth: Bot token via SecretRef/string
  - Config: `schema-channel.ts` → `ChannelEntrySchema.botToken`
  - Supported: Voice transcription, image analysis, video description, document extraction

- Telegram - `grammy` client (with auto-retry, file handling, long-polling) (`packages/channels`)
  - Auth: Bot token via SecretRef/string
  - Retry: `@grammyjs/auto-retry` middleware
  - Features: File handling via `@grammyjs/files`, long-polling via `@grammyjs/runner`
  - Config: `schema-channel.ts` → `ChannelEntrySchema.botToken`
  - File guard: `schema-telegram-file-guard.ts` for attachment filtering

- Slack - `@slack/bolt` (Socket Mode or HTTP) (`packages/channels`)
  - Auth modes:
    - Socket Mode: `appToken` (xapp-...)
    - HTTP Events API: `signingSecret` + webhook
  - Config: `schema-channel.ts` → `SlackChannelEntry` extends with `appToken`, `signingSecret`, `mode`
  - Webhook: `webhookUrl` for HTTP mode

- WhatsApp - `@whiskeysockets/baileys` client (multi-device, auth state) (`packages/channels`)
  - Auth: Multi-device auth state files in configurable directory
  - Config: `schema-channel.ts` → `ChannelEntrySchema.authDir`, `printQR`
  - Features: QR code printing support for pairing
  - Native dependency: requires compilation

- Signal - via `signal-cli` REST API (`packages/channels`)
  - Auth: Phone number registration
  - Config: `schema-channel.ts` → `SignalChannelEntry` with `baseUrl`, `account`, `cliPath`
  - Modes: REST API or auto-spawn signal-cli binary
  - Default: `http://127.0.0.1:8080`

- iMessage - via AppleScript / `imsg` binary (`packages/channels`, macOS only)
  - Auth: Apple ID
  - Config: `schema-channel.ts` → `IMessageChannelEntry` with `binaryPath`, `account`

- LINE Messaging API - `@line/bot-sdk` client (`packages/channels`)
  - Auth: Channel secret for webhook signature verification
  - Config: `schema-channel.ts` → `LineChannelEntry` with `botToken`, `channelSecret`, `webhookPath`
  - Webhook: Configurable path (default: `/webhooks/line`)

- IRC - `irc-framework` client (`packages/channels`)
  - Auth: Optional NickServ password for nick identification
  - Config: `schema-channel.ts` → `IrcChannelEntry` with `host`, `port`, `nick`, `tls`, `channels`, `nickservPassword`
  - TLS: Configurable (default: true)

- Email (IMAP/SMTP) - `imapflow` + `nodemailer` (`packages/channels`)
  - Auth modes:
    - Password: Self-hosted IMAP/SMTP
    - OAuth2: Gmail/Outlook
  - Config: `schema-channel.ts` → `EmailChannelEntry`
    - IMAP: `imapHost` (default: 993/TLS), `imapPort`
    - SMTP: `smtpHost` (default: 587/STARTTLS), `smtpPort`
    - OAuth2: `clientId`, `clientSecret`, `refreshToken`
  - Features: IDLE support with polling fallback, allowlist/open mode for senders
  - Polling interval: Configurable (default: 60s)

## Data Storage

**Databases:**
- SQLite (better-sqlite3 12.6.2)
  - Location: `~/.comis/` (configurable)
  - Extensions: `sqlite-vec` for vector search
  - Schemas: Defined in `packages/memory`
  - Features: FTS5 (full-text search), vector embeddings, RAG storage, delivery queue, message history
  - Config: `schema-memory.ts`

**File Storage:**
- Local filesystem only
  - Media persistence: `~/.comis/` with workspace subdirectories
  - Config: `schema-integrations.ts` → `MediaPersistenceConfigSchema`
  - Storage limit: Soft cap (default: 1GB), logs warning when exceeded
  - Max file: 50MB per file (configurable)

**Embeddings & Vector Search:**
- OpenAI embeddings - `openai` client
  - Model: Configurable (e.g., "text-embedding-3-small")
  - Config: `packages/memory` embedding provider factory
  - Storage: sqlite-vec (vector extension)

- Local LLM embeddings (optional) - `node-llama-cpp`
  - Uses GGUF format models
  - Optional dependency (embedding-provider-openai.ts as fallback)

- Caching: LRU cache (lru-cache 11.2.6) for embeddings

**Caching:**
- LRU cache (lru-cache 11.2.6) - In-memory caching for embeddings
- SQLite-backed caching - Query result caching in memory adapter
- Brave Search: HTTP cache TTL (default: 1 hour)

## Authentication & Identity

**Auth Providers:**

- Custom per-channel - Each platform uses its own credential scheme:
  - Tokens/Keys: Discord, Telegram, Slack, WhatsApp, Signal, iMessage, LINE bots
  - OAuth2: Gmail/Outlook (Email channel)
  - API Keys: Google Gemini, OpenAI, ElevenLabs, FAL, Brave Search
  
- Secret Management:
  - SecretManager: Encrypted storage (AES-256-GCM) in `packages/core`
  - Master key: `SECRETS_MASTER_KEY` env var (required at startup)
  - Config references: SecretRef (object) or string type in Zod schemas
  - Pino auto-redaction: `apiKey`, `token`, `password`, `secret`, `authorization`, `botToken`, `privateKey` (3 levels deep)
  - No plaintext in config files (all credentials via SecretManager key names)

## Monitoring & Observability

**Error Tracking:**
- None detected (structured logging via Pino as primary)

**Logs:**
- Pino 10.3.1 - Structured JSON logging
  - Location: `~/.comis/logs/` (rotated via pino-roll)
  - Log rotation: pino-roll (configurable intervals)
  - Pretty-print (dev): pino-pretty 13.1.3
  - Canonical fields: `agentId`, `traceId`, `channelType`, `durationMs`, `toolName`, `method`, `err`, `hint`, `errorKind`, `module`
  - Auto-redaction: Secrets redacted from logs (apiKey, token, password, secret, authorization, botToken, privateKey, cookie, webhookSecret)

**Observability:**
- OutputGuardPort: Secret-leak scanning on LLM output
- DeviceIdentityPort: Cryptographic device identity (Ed25519)
- Channel health checks: Configurable monitoring + auto-restart on stale
  - Poll interval: Configurable (default: 60s)
  - Stale threshold: 30 minutes (configurable)
  - Idle threshold: 10 minutes (configurable)
  - Error threshold: 3 consecutive errors
  - Stuck send threshold: 25 minutes (configurable)

## CI/CD & Deployment

**Hosting:**
- Linux (primary target)
- Docker/Dockerfile support (multi-platform amd64, arm64)
- systemd integration (optional, daemon supports sd-notify)

**CI Pipeline:**
- GitHub Actions (inferred from repo URL)
- Commands: `pnpm build && pnpm test && pnpm lint:security`

**Daemon Management:**
- pm2 (recommended for production)
  - Ecosystem config: `~/.comis/ecosystem.config.js` (auto-generated)
  - Env propagation: `COMIS_CONFIG_PATHS` via ecosystem config
- Direct execution (alternative): `COMIS_CONFIG_PATHS=...` env var on same command line as daemon process

## Environment Configuration

**Required env vars:**
- `COMIS_CONFIG_PATHS` - Comma-separated list of YAML config file paths (loaded at startup)
- `SECRETS_MASTER_KEY` - AES-256-GCM master key for secret database encryption (base64 encoded)

**Environment file:**
- `.env` exists but is loaded once at startup (never watched)
- One-time load only; no hot reload

**Config loading order:**
1. Defaults (in Zod schemas)
2. YAML files (specified via `COMIS_CONFIG_PATHS`)
3. Environment variable overrides (via `${VAR}` substitution in YAML, marked with warnings)

**Secrets location:**
- SecretManager: Encrypted database in `~/.comis/` (master key via env var)
- Config file references: Use SecretRef (`{ key: "name" }`) or string, never inline values
- Redaction: Pino automatically redacts credential fields from logs

## Webhooks & Callbacks

**Incoming:**
- Slack: Events API webhook (configurable `webhookUrl`)
- LINE: Webhook (configurable path, default: `/webhooks/line`)
- Email: Outbound only (no incoming webhook, IMAP polling)
- Discord, Telegram, WhatsApp, Signal, iMessage, IRC: No webhook (native client protocols)

**Outgoing:**
- Delivery queue: SQLite-backed message delivery queue (DeliveryQueuePort)
- Delivery mirror: Deduplication and mirroring (DeliveryMirrorPort)
- Auto-reply: Configurable rules with template interpolation
  - Config: `schema-integrations.ts` → `AutoReplyConfigSchema`
  - Rules: Pattern matching, template substitution, channel filtering, priority ordering

**MCP (Model Context Protocol):**
- Transport types: "stdio" (local), "sse" (legacy), "http" (Streamable HTTP)
- Config: `schema-integrations.ts` → `McpServerEntrySchema`
  - Name, command/args for stdio, URL for remote
  - Environment variables per server
  - Custom HTTP headers for remote transports
  - Concurrency limits (per-server or auto)
  - Default timeouts: 120 seconds for tool calls

## Media Processing APIs

**Transcription (Speech-to-Text):**
- OpenAI Whisper - `openai` client (default provider)
  - Models: gpt-4o-mini-transcribe, whisper-large-v3-turbo, etc.
  - Max file: 25MB (configurable)
  - Language hint: BCP-47 format (auto-detect if omitted)
  - Preflight: STT for mention detection (default: true)
  - Config: `schema-integrations.ts` → `TranscriptionConfigSchema`

- Groq - Groq SDK (fallback)
  - Model: whisper-large-v3-turbo
  - Config: via provider list

- Deepgram - Deepgram SDK (fallback)
  - Model: nova-3
  - Config: via provider list

**Text-to-Speech:**
- OpenAI - `openai` client (default provider)
  - Voices: alloy, echo, fable, onyx, nova, shimmer
  - Formats: opus (Telegram), mp3 (Discord/WhatsApp/Slack)
  - Auto mode: off, always, inbound, tagged
  - Config: `schema-integrations.ts` → `TtsConfigSchema`

- ElevenLabs - `@elevenlabs/elevenlabs-js` client
  - Model: eleven_multilingual_v2
  - Voice settings: stability, similarityBoost, style, useSpeakerBoost, speed, seed, applyTextNormalization
  - Config: `TtsConfigSchema.elevenlabsSettings`

- Edge TTS - `edge-tts-universal` (fallback)
  - Provider: Microsoft Edge TTS

- Auto modes:
  - "off" - Disabled (default)
  - "always" - Every response (unless has media)
  - "inbound" - Only if user sent voice
  - "tagged" - Only with [[tts]] directive
  - Per-channel format overrides (Telegram opus, Discord mp3, etc.)

**Image Analysis (Vision):**
- OpenAI GPT-4 Vision - `openai` client (default)
- Anthropic Claude Vision - Optional provider
- Google Gemini Vision - Optional provider
- Scope rules: Channel/chat/key prefix matching with allow/deny actions (first match wins)
- Video support: Base64 encoding + special handling, 70MB max base64, 50MB raw max, 120s timeout
- Config: `schema-integrations.ts` → `VisionConfigSchema`

**Image Generation:**
- FAL (Flux) - `@fal-ai/client` (default provider)
  - Model: fal-ai/flux/dev
  - Features: Safety checker, configurable size, rate limiting
  - Config: `schema-integrations.ts` → `ImageGenerationConfigSchema`

- OpenAI DALL-E - `openai` client (alternative)
  - Model: gpt-image-1 (configurable)

**Document Extraction:**
- PDF: pdfjs-dist (text extraction, optional OCR fallback)
- Plain text: chardet + iconv-lite (encoding detection/conversion)
- CSV: native parsing
- HTML: linkedom DOM extraction
- MIME whitelist: text/plain, text/csv, text/markdown, text/html, text/xml, application/json, application/pdf, text/yaml, text/javascript, text/x-python, text/x-typescript, application/x-sh
- Config: `schema-integrations.ts` → `FileExtractionConfigSchema`
  - Max file: 10MB (configurable)
  - Max chars per file: 200KB (configurable)
  - Max total per message: 500KB (configurable)
  - Max pages: 20 (configurable)
  - PDF OCR fallback: Optional (default: false)

**Link Understanding:**
- Fetch URLs from messages automatically (optional)
- Content extraction: @mozilla/readability (article parsing)
- Max links per message: 3 (configurable)
- Fetch timeout: 10 seconds (configurable)
- Max content chars: 5000 per link (configurable)
- User-Agent: "Comis/1.0 (Link Understanding)"
- Config: `schema-integrations.ts` → `LinkUnderstandingConfigSchema`

---

*Integration audit: 2026-04-17*
