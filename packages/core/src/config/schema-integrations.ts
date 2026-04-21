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
 * MCP (Model Context Protocol) server entry.
 */
export const McpServerEntrySchema = z.strictObject({
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
  });

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
  });

/**
 * Transcription service configuration.
 */
export const TranscriptionConfigSchema = z.strictObject({
    /** Primary STT provider (default: "openai") */
    provider: z.enum(["openai", "groq", "deepgram"]).default("openai"),
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
    fallbackProviders: z.array(z.enum(["openai", "groq", "deepgram"])).default([]),
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
 * Text-to-speech service configuration.
 */
export const TtsConfigSchema = z.strictObject({
    /** TTS provider (default: "openai") */
    provider: z.enum(["openai", "elevenlabs", "edge"]).default("openai"),
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
 * from inbound messages. Disabled by default for backward compatibility.
 */
export const LinkUnderstandingConfigSchema = z.strictObject({
    /** Enable automatic link understanding (default: false) */
    enabled: z.boolean().default(false),
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
 * Image generation service configuration.
 */
export const ImageGenerationConfigSchema = z.strictObject({
    /** Image generation provider (default: "fal") */
    provider: z.enum(["fal", "openai"]).default("fal"),
    /** Provider-specific model ID (e.g., "fal-ai/flux/dev", "gpt-image-1") */
    model: z.string().optional(),
    /** Enable safety checker on generated images (default: true) */
    safetyChecker: z.boolean().default(true),
    /** Maximum image generations per hour per agent (default: 10) */
    maxPerHour: z.number().int().positive().default(10),
    /** Default image size/dimensions (default: "1024x1024") */
    defaultSize: z.string().default("1024x1024"),
    /** Generation timeout in milliseconds (default: 60000) */
    timeoutMs: z.number().int().positive().default(60_000),
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
