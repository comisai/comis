// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { SecretRefSchema } from "../domain/secret-ref.js";

/**
 * Brave Search integration configuration.
 */
export const BraveSearchConfigSchema = z.strictObject({
    /** Brave Search API key (optional — search disabled without it; string or SecretRef) */
    apiKey: z.union([z.string().min(1), SecretRefSchema]).optional(),
    /** Default number of results to return (default: 5) */
    maxResultsDefault: z.number().int().positive().default(5),
    /** Cache TTL in milliseconds (default: 3600000 = 1 hour) */
    cacheTtlMs: z.number().int().nonnegative().default(3_600_000),
    /** Rate limit in requests per second (default: 1) */
    rateLimitRps: z.number().positive().default(1),
  });

/**
 * Infer the missing transport from `command` (stdio) or `url` (http).
 * Mirrors the Claude Desktop MCP server config convention where
 * `transport` is implicit for command-based entries.
 *
 * Used as the `z.preprocess` step for `McpServerEntrySchema` so
 * Claude-Desktop-style config blobs like
 * `{name, command, args}` and `{name, url}` parse without
 * requiring an explicit `transport`. Explicit `transport`
 * always wins.
 *
 * REJECTS ambiguous entries that supply BOTH `command` AND `url`
 * without an explicit `transport`. Otherwise the first matching branch
 * (command -> stdio) would win and the unused field would pass through,
 * silently ignored at runtime by createTransport, with no operator
 * warning. Instead this surfaces a structured error key (via `z.NEVER` —
 * which converts the entry into a Zod-detected invalid value, producing
 * a parse error pointing at the ambiguity) so the operator must opt
 * IN explicitly via `transport: "stdio" | "http" | "sse"`.
 */
const inferTransport = (input: unknown, ctx: z.RefinementCtx): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    // Let the strictObject validator surface the type error.
    return input;
  }
  const entry = input as Record<string, unknown>;
  if (typeof entry.transport === "string" && entry.transport.length > 0) {
    // Explicit transport always wins — even if both command and url are
    // present, the operator opted IN to one interpretation.
    return entry;
  }
  const hasCommand = typeof entry.command === "string" && entry.command.length > 0;
  const hasUrl = typeof entry.url === "string" && entry.url.length > 0;
  if (hasCommand && hasUrl) {
    // Ambiguous — operator supplied BOTH command and url with no
    // explicit transport. Reject loudly rather than silently picking one.
    ctx.addIssue({
      code: "custom",
      message:
        'Ambiguous MCP server config: both `command` and `url` are set with no explicit `transport`. ' +
        'Choose one (set `transport: "stdio"` for command-based, or `transport: "http"`/`"sse"` for url-based).',
      path: [],
    });
    return z.NEVER;
  }
  if (hasCommand) {
    return { ...entry, transport: "stdio" };
  }
  if (hasUrl) {
    return { ...entry, transport: "http" };
  }
  return entry;
};

/**
 * MCP (Model Context Protocol) server entry.
 *
 * `transport` is inferred from `command` (-> "stdio") or `url`
 * (-> "http") when omitted, mirroring the Claude Desktop MCP
 * config convention. Explicit `transport` always wins.
 */
export const McpServerEntrySchema = z.preprocess(
  inferTransport,
  z.strictObject({
    /** Unique name for this MCP server */
    name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "MCP server name must be alphanumeric with hyphens/underscores only"),
    /** Transport type: "stdio" for local process, "sse" for legacy SSE servers, "http" for Streamable HTTP */
    transport: z.enum(["stdio", "sse", "http"]),
    /** Command to execute for stdio transport */
    command: z.string().min(1).optional(),
    /** Arguments for the stdio command */
    args: z.array(z.string()).optional(),
    /** URL for remote transports (sse, http) */
    url: z.url().optional(),
    /** Environment variables to pass to the stdio process (e.g. API keys) */
    env: z.record(z.string(), z.string()).optional(),
    /** Working directory for stdio transport. Overrides the default workspace CWD. */
    cwd: z.string().min(1).optional(),
    /** Whether this server is enabled (default: true) */
    enabled: z.boolean().default(true),
    /** Custom HTTP headers for remote transports (sse, http). Ignored for stdio. */
    headers: z.record(z.string(), z.string()).optional(),
    /** Maximum concurrent tool calls to this server. Undefined = auto (transport-based default). */
    maxConcurrency: z.number().int().positive().optional(),
    /** Per-server opt-out for the plaintext-secret heuristic. Last-resort escape hatch — WARN logged on connect when true. Default: false (heuristic enforced). */
    disablePlaintextSecretCheck: z.boolean().optional(),
    /** Per-server stdio rlimits override. Partial overrides allowed: { cpu: 600 } leaves as/nofile at module defaults (as=536_870_912, nofile=256, cpu=300). */
    rlimits: z.object({
      /** RLIMIT_AS — virtual-memory ceiling in bytes (module default: 536_870_912 = 512MB). */
      as: z.number().int().positive().optional(),
      /** RLIMIT_NOFILE — max open file descriptors (module default: 256). */
      nofile: z.number().int().positive().optional(),
      /** RLIMIT_CPU — wall CPU seconds before SIGXCPU (module default: 300). */
      cpu: z.number().int().positive().optional(),
    }).optional(),
    /** Per-server keepalive ping interval (ms). 0 disables for this server. Undefined ⇒ transport-aware default (30 000 ms http/sse, 180 000 ms stdio). The global integrations.mcp.keepaliveIntervalMs override is the middle tier: per-server ?? global ?? transport-aware default. */
    keepaliveIntervalMs: z.number().int().nonnegative().optional(),
    /** Per-server override of mcp.circuitBreakerThreshold. */
    circuitBreakerThreshold: z.number().int().positive().optional(),
    /** Per-server override of mcp.circuitBreakerCooldownMs. */
    circuitBreakerCooldownMs: z.number().int().positive().optional(),
    /** Per-server tool allowlist (whitelist). When non-empty,
     *  ONLY listed tool names from this server are surfaced to the agent. The
     *  blocklist is then applied on top — a name on BOTH lists is still
     *  filtered out (the blocklist always wins). Filter applied EXCLUSIVELY at
     *  mcp-tool-bridge.ts. */
    toolAllowlist: z.array(z.string().min(1)).optional(),
    /** Per-server tool blocklist. Listed tool names are
     *  filtered out of the agent's registry regardless of whether they also
     *  appear on the allowlist — the blocklist always wins. Applied after the
     *  allowlist filter at mcp-tool-bridge.ts. */
    toolBlocklist: z.array(z.string().min(1)).optional(),
    /** Per-server idle eviction TTL (ms). Default 0 disables
     *  (opt-in only). When non-zero AND no successful tool call has hit this
     *  server for idleTtlMs, the transport is closed WITHOUT setting
     *  userDisconnectedFlags so the next callTool reconnects transparently. */
    idleTtlMs: z.number().int().nonnegative().default(0),
    /** Opt-out for resources utility tools (list_resources/
     *  read_resource). Default undefined ⇒ auto-register IF server advertises
     *  capabilities.resources. Set false to suppress (mitigates Cursor's 40-tool
     *  ceiling on resources-noisy servers). */
    enableResources: z.boolean().optional(),
    /** Opt-out for prompts utility tools (list_prompts/
     *  get_prompt). Same semantics as enableResources but for capabilities.prompts. */
    enablePrompts: z.boolean().optional(),
    /** Opt-in parallel tool calls. When true AND transport "stdio",
     *  the per-server PQueue concurrency bumps from 1 to maxConcurrency ?? 4. Default
     *  undefined => stdio stays serialized (concurrency 1). Ignored for sse/http
     *  (already default concurrency 4). Read at PQueue construction (mcp-client-connect.ts). */
    supportsParallelToolCalls: z.boolean().optional(),
    /** Per-server authentication scheme. "oauth" opts the
     *  server into the OAuth 2.1 + PKCE flow (mcp.oauth_login / token store).
     *  "bearer" / "none" are explicit no-OAuth markers. Undefined ⇒ no OAuth
     *  (treated as "none"). Threaded schema→runtime→persist
     *  so a reconnect cannot silently strip a server's OAuth requirement. */
    auth: z.enum(["none", "bearer", "oauth"]).optional(),
    /** OAuth provider hints for an `auth:"oauth"` server.
     *  strictObject so unknown keys are rejected (tampering defence). */
    oauth: z
      .strictObject({
        /** Cascade fallback: user-provided authorization endpoint used
         *  when RFC 8414/9728 discovery does not surface one. */
        authorizationEndpoint: z.url().optional(),
        /** Cascade fallback for RFC 8628 device-authorization: user-provided
         *  device-authorization endpoint URL used when the resolved authorization-
         *  server metadata does not surface device_authorization_endpoint (some
         *  real-world OAuth servers return 404 on every RFC 8414 / OIDC well-known
         *  path). Sibling of authorizationEndpoint;
         *  consumed by runDeviceFlow's discovery cascade. */
        deviceAuthorizationEndpoint: z.url().optional(),
        /** Per-server flow override that beats the headless-detection heuristic.
         *  "device_code" forces RFC 8628; "auth_code"
         *  forces PKCE+loopback. Absent => runOauthLogin chooses by the
         *  heuristic (headless ∧ device-code-advertised → device-flow). */
        flow: z.enum(["device_code", "auth_code"]).optional(),
        /** OAuth scope string requested at authorization time. */
        scope: z.string().optional(),
        /** Stripe Connect `Stripe-Account` header value
         *  threaded into token + refresh requests for connected-account servers. */
        stripeAccount: z.string().optional(),
      })
      .optional(),
    // Skill-bundle provenance marker. SYSTEM-MANAGED -- operators
    // inspect via `comis mcp list --show-bundle-overrides`. Set by the bundle resolver
    // when a bundle entry lands; absent on user-authored entries. Optional + min(1) so
    // empty strings cannot accidentally claim a bundle source (spoofing defence).
    _bundleSource: z.string().min(1).optional(),

    // Archived bundle entry when a user override (or a second
    // skill's bundle entry with --force) replaced it. Recursive shape: an
    // _bundleArchive may itself carry _bundleSource (the original skill's marker).
    // z.lazy() defers the self-reference at type-check time; the runtime closure
    // resolves at parse time (TS circular-type error without it). The explicit
    // `z.ZodTypeAny` annotation on the lazy callback matches the Zod 4
    // "Resolve recursive type inference errors" guidance -- without it tsc fires
    // TS7022 (self-reference in initializer). Not modelled past one level: archive
    // of an archive is replaced last-write-wins on the archive slot.
    _bundleArchive: z.lazy((): z.ZodTypeAny => McpServerEntrySchema).optional(),
  }),
);

/**
 * MCP integration configuration.
 */
export const McpConfigSchema = z.strictObject({
    /** List of MCP servers to connect to */
    servers: z.array(McpServerEntrySchema).default([]),
    /** Default timeout for MCP tool calls in milliseconds (default: 120000).
     * Image generation and other slow tools may need 2+ minutes. */
    callToolTimeoutMs: z.number().int().positive().default(120_000),
    /** Default max concurrent tool calls for stdio servers (default: 1). */
    stdioDefaultConcurrency: z.number().int().positive().default(1),
    /** Default max concurrent tool calls for HTTP/SSE servers (default: 4). */
    httpDefaultConcurrency: z.number().int().positive().default(4),
    /** Built-in safe-to-pass-through env keys for stdio MCP children, ADDITIVE to MCP_STDIO_BUILTIN_ENV_ALLOWLIST. Operator-named keys (e.g. CUSTOM_CA_CERT_PATH) — default: []. */
    safetyAllowedEnvKeys: z.array(z.string().min(1)).default([]),
    /** OSV malware check enabled for stdio MCPs (default: true). Set false in air-gapped deployments. */
    osvCheckEnabled: z.boolean().default(true),
    /** OSV cache TTL in milliseconds (default: 24h = 86_400_000). */
    osvCacheTtlMs: z.number().int().positive().default(86_400_000),
    /** Global keepalive ping interval override (ms). When omitted, transport-aware default applies (30 000 ms http/sse, 180 000 ms stdio). 0 disables for chatty servers. */
    keepaliveIntervalMs: z.number().int().nonnegative().optional(),
    /** Consecutive failed tool calls before circuit breaker opens. Default 3. Setting 1 effectively trips the breaker on every failure. */
    circuitBreakerThreshold: z.number().int().positive().default(3),
    /** Circuit breaker cooldown in ms before transitioning open → half-open. Default 60000 (1 min). */
    circuitBreakerCooldownMs: z.number().int().positive().default(60_000),
  });

/**
 * The operator-configurable STT (speech-to-text) provider vocabulary.
 *
 * NOTE: this is a DIFFERENT vocabulary from the MAIN_PROVIDER_AUDIO keys (resolved
 * main-provider ids in `@comis/core/media`). "auto" = keyless-first then follow the
 * agent's main provider (the default); "local" = the keyless local whisper
 * engine. `fallbackProviders` entries validate against this same closed set, so an
 * injected/typo'd provider fails at parse rather than reaching a transport.
 */
const TRANSCRIPTION_PROVIDER_VALUES = ["auto", "local", "openai", "groq", "deepgram"] as const;

/**
 * Local (keyless) STT engine configuration: the in-process engine plus the
 * `baseUrl` local-server escape hatch. `model` defaults to "base".
 */
export const LocalTranscriptionConfigSchema = z.strictObject({
    /** Whisper model size to load/download (default "base"; e.g. "tiny"/"small"). */
    model: z.string().default("base"),
    /** OpenAI-compatible local whisper server URL (loopback-default, SSRF-guarded). */
    baseUrl: z.string().optional(),
    /** Engine mechanism override: wasm/native/subprocess/server. */
    engine: z.string().optional(),
  });

/**
 * Transcription service configuration.
 */
export const TranscriptionConfigSchema = z.strictObject({
    /** Primary STT provider (default: "auto" — keyless-first then follows the agent's main provider). */
    provider: z.enum(TRANSCRIPTION_PROVIDER_VALUES).default("auto"),
    /** Provider-specific model ID (e.g., "gpt-4o-mini-transcribe", "whisper-large-v3-turbo", "nova-3") */
    model: z.string().optional(),
    /** Maximum file size in megabytes (default: 25) */
    maxFileSizeMb: z.number().positive().default(25),
    /** API request timeout in milliseconds (default: 60000) */
    timeoutMs: z.number().int().positive().default(60_000),
    /** BCP-47 language hint for transcription (e.g., "en", "es"). Auto-detect if omitted. */
    language: z.string().optional(),
    /** Auto-transcribe voice messages in the inbound pipeline (default: true) */
    autoTranscribe: z.boolean().default(true),
    /** Enable preflight STT for mention detection in voice messages (default: true) */
    preflight: z.boolean().default(true),
    /** Ordered fallback providers to try when primary fails (default: []) */
    fallbackProviders: z.array(z.enum(TRANSCRIPTION_PROVIDER_VALUES)).default([]),
    /** Local (keyless) STT engine settings. */
    local: LocalTranscriptionConfigSchema.default(() => LocalTranscriptionConfigSchema.parse({})),
  });

/**
 * TTS auto mode — determines when to automatically generate speech.
 *
 * - "off": Never auto-generate TTS
 * - "always": Always generate TTS for every response (unless response has media)
 * - "inbound": Generate TTS only when user sent a voice message (reply with voice)
 * - "tagged": Generate TTS only when response contains [[tts]] directive tags
 */
export const TtsAutoModeSchema = z
  .enum(["off", "always", "inbound", "tagged"])
  .default("off");

/**
 * ElevenLabs-specific voice settings for fine-grained control.
 */
export const ElevenLabsVoiceSettingsSchema = z.strictObject({
    /** Voice stability (0-1, higher = more consistent) */
    stability: z.number().min(0).max(1).optional(),
    /** Similarity boost (0-1, higher = more similar to original voice) */
    similarityBoost: z.number().min(0).max(1).optional(),
    /** Style exaggeration (0-1) */
    style: z.number().min(0).max(1).optional(),
    /** Enable speaker boost for clarity */
    useSpeakerBoost: z.boolean().optional(),
    /** Playback speed multiplier */
    speed: z.number().optional(),
    /** Random seed for reproducible output */
    seed: z.number().optional(),
    /** Text normalization mode */
    applyTextNormalization: z.enum(["auto", "on", "off"]).default("auto"),
  });

/**
 * Per-channel TTS output format overrides.
 *
 * Each key maps a channel type to an audio format string.
 * The format string is provider-agnostic — adapters resolve the
 * actual codec (e.g., "opus" -> "opus" for OpenAI, "opus_48000_64" for ElevenLabs).
 */
export const TtsOutputFormatSchema = z.strictObject({
    /** Telegram: Opus for native voice notes */
    telegram: z.string().default("opus"),
    /** Discord: MP3 for broadest compatibility */
    discord: z.string().default("mp3"),
    /** WhatsApp: MP3 default */
    whatsapp: z.string().default("mp3"),
    /** Slack: MP3 default */
    slack: z.string().default("mp3"),
    /** Default format for unknown channels */
    default: z.string().default("mp3"),
  });

/**
 * The operator-configurable TTS (text-to-speech) provider vocabulary.
 *
 * "edge" = the keyless Microsoft Edge TTS default (zero credentials);
 * "openai"/"elevenlabs" are keyed cloud opt-ins; "local" and "piper" are
 * aliases for the SAME offline keyless in-process transformers.js
 * text-to-audio adapter — both auto-download a small single-speaker ONNX
 * voice model into `<dataDir>/models/tts/` and synthesize with no key and
 * no network after the first load (both are members of the resolver's
 * `VOICE_KEYLESS`). Closed enum so an injected/typo'd provider fails at
 * parse, not at a transport.
 */
const TTS_PROVIDER_VALUES = ["edge", "openai", "elevenlabs", "local", "piper"] as const;

/**
 * Text-to-speech service configuration.
 */
export const TtsConfigSchema = z.strictObject({
    /** TTS provider (default: "edge" — keyless, zero credentials). */
    provider: z.enum(TTS_PROVIDER_VALUES).default("edge"),
    /** Voice identifier (default: "alloy") */
    voice: z.string().default("alloy"),
    /** Output audio format (default: "opus") */
    format: z.string().default("opus"),
    /** Provider-specific model ID (e.g., "eleven_multilingual_v2" for ElevenLabs) */
    model: z.string().optional(),
    /** Auto mode — when to automatically synthesize speech */
    autoMode: TtsAutoModeSchema.default("off"),
    /** Maximum text length for TTS synthesis (default: 4096) */
    maxTextLength: z.number().int().positive().default(4096),
    /** Regex pattern to detect TTS-tagged responses (default matches [[tts]] or [[tts:...]]) */
    tagPattern: z.string().default("\\[\\[tts(?::.*?)?\\]\\]"),
    /** Per-channel output format overrides */
    outputFormats: TtsOutputFormatSchema.default(() => TtsOutputFormatSchema.parse({})),
    /** ElevenLabs-specific voice settings */
    elevenlabsSettings: ElevenLabsVoiceSettingsSchema.optional(),
  });

/**
 * Image analysis service configuration.
 */
export const ImageAnalysisConfigSchema = z.strictObject({
    /** Maximum image file size in megabytes (default: 20) */
    maxFileSizeMb: z.number().positive().default(20),
  });

/**
 * Vision scope rule: controls which channels/chats trigger vision analysis.
 */
export const VisionScopeRuleSchema = z.strictObject({
    /** Channel type to match (e.g. "telegram", "discord"). */
    channel: z.string().min(1).optional(),
    /** Chat type to match (e.g. "private", "group"). */
    chatType: z.string().min(1).optional(),
    /** Session key prefix to match via startsWith. */
    keyPrefix: z.string().min(1).optional(),
    /** Action to take when this rule matches. */
    action: z.enum(["allow", "deny"]),
  });

/**
 * Vision analysis configuration: multi-provider image/video analysis.
 */
export const VisionConfigSchema = z.strictObject({
    /** Enable vision analysis (default: true). */
    enabled: z.boolean().default(true),
    /** Ordered list of vision providers to consider (default: all three). */
    providers: z
      .array(z.enum(["openai", "anthropic", "google"]))
      .default(["openai", "anthropic", "google"]),
    /** Preferred default provider (overrides auto-selection). */
    defaultProvider: z.string().optional(),
    /** Maximum base64-encoded size for video in bytes (default: 70MB). */
    videoMaxBase64Bytes: z.number().int().positive().default(70_000_000),
    /** Maximum raw video file size in bytes (default: 50MB). */
    videoMaxRawBytes: z.number().int().positive().default(50_000_000),
    /** Timeout in milliseconds for video description API calls (default: 120s). */
    videoTimeoutMs: z.number().int().positive().default(120_000),
    /** Maximum characters for video description output (default: 500). */
    videoMaxDescriptionChars: z.number().int().positive().default(500),
    /** Maximum image file size in megabytes (default: 20). */
    imageMaxFileSizeMb: z.number().positive().default(20),
    /** Scope rules for vision analysis (first match wins). */
    scopeRules: z.array(VisionScopeRuleSchema).default([]),
    /** Default action when no scope rule matches (default: "allow"). */
    defaultScopeAction: z.enum(["allow", "deny"]).default("allow"),
  });

/**
 * Link understanding configuration.
 *
 * Controls automatic URL detection, fetching, and content extraction
 * from inbound messages.
 */
export const LinkUnderstandingConfigSchema = z.strictObject({
    /** Enable automatic link understanding (default: true) */
    enabled: z.boolean().default(true),
    /** Maximum number of links to process per message (default: 3) */
    maxLinks: z.number().int().positive().default(3),
    /** Timeout for fetching each URL in milliseconds (default: 10000) */
    fetchTimeoutMs: z.number().int().positive().default(10_000),
    /** Maximum characters of extracted content per link (default: 5000) */
    maxContentChars: z.number().int().positive().default(5000),
    /** User-Agent string for outbound fetch requests */
    userAgentString: z.string().default("Comis/1.0 (Link Understanding)"),
  });

/**
 * Media infrastructure configuration for fetch limits, concurrency, and temp file management.
 */
export const MediaInfraConfigSchema = z.strictObject({
    /** Max file size for remote media fetches in bytes (default: 25MB) */
    maxRemoteFetchBytes: z.number().int().positive().default(25 * 1024 * 1024),
    /** Max concurrent media operations (default: 3) */
    concurrencyLimit: z.number().int().positive().default(3),
    /** Temp file TTL in milliseconds (default: 30 min) */
    tempFileTtlMs: z.number().int().positive().default(1_800_000),
    /** Cleanup interval in milliseconds (default: 5 min) */
    tempCleanupIntervalMs: z.number().int().positive().default(300_000),
  });

/**
 * MIME types considered extractable document formats.
 *
 * This whitelist defines which MIME types are classified as "document" (text-extractable)
 * by the file extraction pipeline. Binary formats (images, audio, video, archives)
 * are excluded.
 */
export const DOCUMENT_MIME_WHITELIST = [
    "text/plain",
    "text/csv",
    "text/markdown",
    "text/html",
    "text/xml",
    "application/json",
    "application/xml",
    "application/pdf",
    "text/yaml",
    "application/x-yaml",
    "text/javascript",
    "text/x-python",
    "text/x-typescript",
    "application/x-sh",
  ] as const;

/**
 * Document extraction configuration, nested under MediaConfigSchema.
 *
 * Controls file-to-text extraction for document attachments (PDF, plain text, CSV, etc.).
 * All fields have sensible defaults so an empty object produces a valid configuration.
 */
export const FileExtractionConfigSchema = z.strictObject({
    /** Enable document extraction (default: true) */
    enabled: z.boolean().default(true),
    /** Allowed MIME types for extraction (default: DOCUMENT_MIME_WHITELIST) */
    allowedMimes: z.array(z.string()).default([...DOCUMENT_MIME_WHITELIST]),
    /** Maximum file size in bytes (default: 10MB) */
    maxBytes: z.number().int().positive().default(10_485_760),
    /** Maximum characters in extracted text (default: 200000) */
    maxChars: z.number().int().positive().default(200_000),
    /** Maximum total characters across all attachments per message (default: 500000) */
    maxTotalChars: z.number().int().positive().default(500_000),
    /** Maximum pages to extract from paginated documents (default: 20) */
    maxPages: z.number().int().positive().default(20),
    /** Extraction timeout in milliseconds (default: 30000) */
    timeoutMs: z.number().int().positive().default(30_000),
    /** Use OCR/image fallback for PDF pages with little text (default: false) */
    pdfImageFallback: z.boolean().default(false),
    /** Minimum character threshold per page to trigger image fallback (default: 50, 0 = always fallback) */
    pdfImageFallbackThreshold: z.number().int().nonnegative().default(50),
  });

/**
 * Media file persistence configuration.
 *
 * Controls automatic saving of incoming media files (photos, videos, documents)
 * to organized workspace subdirectories.
 */
export const MediaPersistenceConfigSchema = z.strictObject({
    /** Enable automatic media file persistence to workspace (default: true) */
    enabled: z.boolean().default(true),
    /** Soft limit for total workspace media storage in MB (default: 1024 = 1GB). Logs WARN when exceeded. */
    maxStorageMb: z.number().int().positive().default(1024),
    /** Maximum individual file size in bytes (default: 52428800 = 50MB) */
    maxFileBytes: z.number().int().positive().default(52_428_800),
  });

/**
 * The operator-configurable image-generation provider vocabulary.
 *
 * NOTE: this is a DIFFERENT vocabulary from the IMAGE_CAPABILITY keys (resolved-provider ids
 * in `@comis/core/media`). "auto" = follow the agent's main provider (the default);
 * "fal" = explicit FAL backend. `fallbackChain` entries validate against this same closed
 * set, so an injected/typo'd provider fails at parse rather than reaching a transport.
 */
const IMAGE_PROVIDER_VALUES = ["auto", "fal", "openai", "openai-codex", "google", "openrouter"] as const;

/**
 * Image generation service configuration.
 */
export const ImageGenerationConfigSchema = z.strictObject({
    /** Image generation provider (default: "auto" — follows the agent's main provider). */
    provider: z.enum(IMAGE_PROVIDER_VALUES).default("auto"),
    /** Provider-specific model ID (e.g., "fal-ai/flux/dev", "gpt-image-1"); overrides the per-provider default. */
    model: z.string().optional(),
    /** Enable safety checker on generated images (default: true) */
    safetyChecker: z.boolean().default(true),
    /** Maximum image generations per hour per agent (default: 10) */
    maxPerHour: z.number().int().positive().default(10),
    /** Default image size/dimensions (default: "1024x1024") */
    defaultSize: z.string().default("1024x1024"),
    /**
     * Generation timeout in milliseconds (default: 120000 = 120s). The Codex
     * hosted `image_generation` tool (the follow-main path for a ChatGPT-login
     * agent) takes ~20-60s to generate in practice, so a 60s cap would clip the
     * slow generations as a `timeout`. 120s gives headroom; the fast key-auth
     * providers (openai / google / openrouter) finish well under it. Operators
     * on fast-only providers may lower it.
     */
    timeoutMs: z.number().int().positive().default(120_000),
    /** Providers consulted in order ONLY after the follow-main path fails. Default empty. */
    fallbackChain: z.array(z.enum(IMAGE_PROVIDER_VALUES)).default([]),
    /** Optional per-agent/hour USD cost ceiling, enforced before generation. */
    maxCostPerHourUsd: z.number().positive().optional(),
  });

/**
 * The operator-configurable video-generation provider vocabulary.
 *
 * NOTE: this is a DIFFERENT vocabulary from the VIDEO_CAPABILITY keys (resolved
 * main-provider ids in `@comis/core/media`). "auto" = follow the agent's main
 * provider when it has a video API; "fal" = explicit FAL backend;
 * "google"/"xai" select the Veo/Grok backends. `fallbackChain` entries
 * validate against this same closed set, so an injected/typo'd provider fails
 * at parse rather than reaching a transport.
 */
const VIDEO_PROVIDER_VALUES = ["auto", "fal", "google", "xai"] as const;

/**
 * Video generation service configuration — sibling of `imageGeneration`.
 * The cost ceiling is enforced PRE-submit against a worst-case estimate;
 * the rate limit + poll cadence bound a dollars-per-clip async backend.
 */
export const VideoGenerationConfigSchema = z.strictObject({
    /** Video generation provider (default: "auto" — follows the agent's main provider). */
    provider: z.enum(VIDEO_PROVIDER_VALUES).default("auto"),
    /** Provider-specific model/endpoint ID (e.g., "fal-ai/veo3.1/fast"); overrides the per-provider default. */
    model: z.string().optional(),
    /** Default clip length in seconds (provider-validated; default: 8). */
    defaultDurationSecs: z.number().int().positive().default(8),
    /** Default aspect ratio (default: "16:9"). */
    defaultAspectRatio: z.string().default("16:9"),
    /** Default resolution (default: "720p"). */
    defaultResolution: z.string().default("720p"),
    /** Generate audio when the backend supports it (provider-dependent; omit for provider default). */
    generateAudio: z.boolean().optional(),
    /** Maximum video generations per hour per agent (default: 5). */
    maxPerHour: z.number().int().positive().default(5),
    /** Inline execute() poll-loop timeout in milliseconds (default: 300000). */
    timeoutMs: z.number().int().positive().default(300_000),
    /** Poll cadence in milliseconds while awaiting a terminal job state (default: 10000). */
    pollIntervalMs: z.number().int().positive().default(10_000),
    /** Optional cap on concurrent in-flight jobs (consumed by the background poller). */
    maxConcurrentJobs: z.number().int().positive().optional(),
    /** Max delivery/completion attempts before the background poller dead-letters a
     *  job to `failed`. Bounds the redelivery loop so a persistent channel
     *  delivery failure (or a stuck job) converges instead of re-polling +
     *  re-downloading every pollIntervalMs forever (default: 5). */
    maxDeliveryAttempts: z.number().int().positive().default(5),
    /** Providers consulted in order ONLY after the follow-main path fails. Default empty. */
    fallbackChain: z.array(z.enum(VIDEO_PROVIDER_VALUES)).default([]),
    /** Optional per-agent/hour USD cost ceiling, gated PRE-submit. */
    maxCostPerHourUsd: z.number().positive().optional(),
  });

/**
 * Media processing configuration (transcription, TTS, image analysis, vision, link understanding, infrastructure, persistence).
 */
export const MediaConfigSchema = z.strictObject({
    /** Transcription (voice-to-text) settings */
    transcription: TranscriptionConfigSchema.default(() => TranscriptionConfigSchema.parse({})),
    /** Text-to-speech settings */
    tts: TtsConfigSchema.default(() => TtsConfigSchema.parse({})),
    /** Image analysis settings */
    imageAnalysis: ImageAnalysisConfigSchema.default(() => ImageAnalysisConfigSchema.parse({})),
    /** Multi-provider vision analysis settings */
    vision: VisionConfigSchema.default(() => VisionConfigSchema.parse({})),
    /** Link understanding settings */
    linkUnderstanding: LinkUnderstandingConfigSchema.default(() => LinkUnderstandingConfigSchema.parse({})),
    /** Infrastructure settings (fetch limits, concurrency, temp files) */
    infrastructure: MediaInfraConfigSchema.default(() => MediaInfraConfigSchema.parse({})),
    /** Document extraction settings */
    documentExtraction: FileExtractionConfigSchema.default(
      () => FileExtractionConfigSchema.parse({}),
    ),
    /** Media file persistence settings */
    persistence: MediaPersistenceConfigSchema.default(
      () => MediaPersistenceConfigSchema.parse({}),
    ),
    /** Image generation settings */
    imageGeneration: ImageGenerationConfigSchema.default(
      () => ImageGenerationConfigSchema.parse({}),
    ),
    /** Video generation settings */
    videoGeneration: VideoGenerationConfigSchema.default(
      () => VideoGenerationConfigSchema.parse({}),
    ),
  });

/**
 * Auto-reply rule entry.
 */
export const AutoReplyRuleSchema = z.strictObject({
    /** Unique identifier for this rule */
    id: z.string().min(1),
    /** Regex pattern to match incoming messages */
    pattern: z.string().min(1),
    /** Response template (supports {{match}} placeholders) */
    template: z.string().min(1),
    /** Optional channel filter (rule applies only to listed channels) */
    channels: z.array(z.string().min(1)).optional(),
    /** Priority for rule ordering (higher = first, default: 0) */
    priority: z.number().int().default(0),
  });

/**
 * Auto-reply configuration.
 */
export const AutoReplyConfigSchema = z.strictObject({
    /** Enable auto-reply rules (default: false) */
    enabled: z.boolean().default(false),
    /** List of auto-reply rules */
    rules: z.array(AutoReplyRuleSchema).default([]),
  });

/**
 * Integrations configuration schema.
 *
 * Controls external service integrations: Brave Search, MCP servers,
 * media processing (transcription, TTS, image analysis), and auto-reply rules.
 */
export const IntegrationsConfigSchema = z.strictObject({
    /** Brave Search API integration */
    braveSearch: BraveSearchConfigSchema.default(() => BraveSearchConfigSchema.parse({})),
    /** MCP (Model Context Protocol) server connections */
    mcp: McpConfigSchema.default(() => McpConfigSchema.parse({})),
    /** Media processing services */
    media: MediaConfigSchema.default(() => MediaConfigSchema.parse({})),
    /** Auto-reply rule engine */
    autoReply: AutoReplyConfigSchema.default(() => AutoReplyConfigSchema.parse({})),
  });

export type IntegrationsConfig = z.infer<typeof IntegrationsConfigSchema>;
export type BraveSearchConfig = z.infer<typeof BraveSearchConfigSchema>;
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type TranscriptionConfig = z.infer<typeof TranscriptionConfigSchema>;
export type TtsConfig = z.infer<typeof TtsConfigSchema>;
export type TtsAutoMode = z.infer<typeof TtsAutoModeSchema>;
export type ElevenLabsVoiceSettings = z.infer<typeof ElevenLabsVoiceSettingsSchema>;
export type TtsOutputFormat = z.infer<typeof TtsOutputFormatSchema>;
export type ImageAnalysisConfig = z.infer<typeof ImageAnalysisConfigSchema>;
export type VisionScopeRule = z.infer<typeof VisionScopeRuleSchema>;
export type VisionConfig = z.infer<typeof VisionConfigSchema>;
export type LinkUnderstandingConfig = z.infer<typeof LinkUnderstandingConfigSchema>;
export type MediaInfraConfig = z.infer<typeof MediaInfraConfigSchema>;
export type MediaConfig = z.infer<typeof MediaConfigSchema>;
export type AutoReplyRule = z.infer<typeof AutoReplyRuleSchema>;
export type AutoReplyConfig = z.infer<typeof AutoReplyConfigSchema>;
export type FileExtractionConfig = z.infer<typeof FileExtractionConfigSchema>;
export type MediaPersistenceConfig = z.infer<typeof MediaPersistenceConfigSchema>;
export type ImageGenerationConfig = z.infer<typeof ImageGenerationConfigSchema>;
export type VideoGenerationConfig = z.infer<typeof VideoGenerationConfigSchema>;
