// SPDX-License-Identifier: Apache-2.0
/**
 * Foundational types and constants for the init wizard.
 *
 * Core type system for the wizard architecture: immutable state
 * accumulation, structured validation, and multi-flow support.
 *
 * @module
 */

import type { CredentialStorageMode } from "@comis/core";
import type { WizardPrompter } from "./prompter.js";

// ---------- Flow & Step Identifiers ----------

/** Wizard flow variants. */
export type FlowType = "quickstart" | "advanced" | "remote";

/** All wizard step identifiers, ordered by execution sequence. */
export type WizardStepId =
  | "welcome"
  | "detect-existing"
  | "flow-select"
  | "storage"
  | "provider"
  | "credentials"
  | "agent"
  | "channels"
  | "gateway"
  | "workspace"
  | "tool-providers"
  | "image-providers"
  | "video-providers"
  | "transcription"
  | "tts"
  | "review"
  | "write-config"
  | "daemon-start"
  | "finish";

// ---------- Validation ----------

/**
 * Structured validator return type.
 *
 * Validators return `ValidationResult | undefined` where
 * undefined means the value is valid.
 */
export type ValidationResult = {
  /** Concise error description. */
  message: string;
  /** Format hint or guidance for the user. */
  hint?: string;
  /** Field name that failed validation. */
  field?: string;
};

// ---------- Error ----------

/**
 * Wizard error with actionable guidance.
 *
 * Every error in the wizard has a recovery path or explanation.
 */
export type WizardError = {
  /** What happened. */
  message: string;
  /** What to do about it. */
  hint: string;
  /** Can the wizard continue past this error? */
  recoverable: boolean;
  /** Should we offer the user a retry? */
  retryable: boolean;
};

// ---------- Configuration Sub-types ----------

/** Per-channel collected credentials. */
// @optional-field-count: per-channel credential accumulator — one flat bag whose
// `type` discriminates every supported channel and whose optional fields are the
// union of all channels' credentials (token/app/secret/allow plus the Teams and
// Matrix config-and-secret fields); each field is present only for its own channel.
export type ChannelConfig = {
  type: "telegram" | "discord" | "slack" | "whatsapp" | "signal" | "irc" | "line" | "msteams" | "matrix";
  botToken?: string;
  apiKey?: string;
  appToken?: string;
  channelSecret?: string;
  guildIds?: string[];
  allowFrom?: string[];
  validated?: boolean;
  // Microsoft Teams: bot app-registration credentials. appId and tenantId are
  // non-secret config; appPassword is the secret (persisted as a ${VAR} ref).
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  authMode?: "secret" | "certificate" | "managedIdentity";
  // Matrix: homeserverUrl and userId are non-secret config; accessToken is the
  // secret (persisted as a ${VAR} ref). e2ee toggles encrypted-room support;
  // allowMode selects the sender allow/deny policy.
  homeserverUrl?: string;
  userId?: string;
  accessToken?: string;
  e2ee?: boolean;
  allowMode?: string;
};

/** Per-tool-provider collected credentials. */
export type ToolProviderConfig = {
  id: string;
  apiKey: string;
  validated?: boolean;
};

/**
 * Video-generation provider selection collected at the `video-providers` step.
 *
 * `provider` is one of the operator-configurable video vocabulary ids
 * (`auto` | `fal` | `google` | `xai`, mirroring core's `VIDEO_PROVIDER_VALUES`)
 * written to `integrations.media.videoGeneration.provider`. `apiKey` is present
 * ONLY when the choice needs a credential the rest of the wizard doesn't already
 * collect: `fal` always (`FAL_KEY`), or `google`/`xai` when the agent's MAIN
 * provider doesn't already supply the matching key. `auto` (follow-main, the
 * recommended default) and a key-reusing `google`/`xai` carry no `apiKey` —
 * video reuses the main provider's secret, no video-specific key.
 */
export type VideoProviderConfig = {
  provider: string;
  apiKey?: string;
};

/**
 * Image-generation provider selection collected at the `image-providers` step.
 *
 * `provider` is one of the operator-configurable image vocabulary ids
 * (`auto` | `fal` | `openai` | `openai-codex` | `google` | `openrouter`,
 * mirroring core's `IMAGE_PROVIDER_VALUES`) written to
 * `integrations.media.imageGeneration.provider`. `apiKey` is present ONLY when
 * the choice needs a STATIC credential the wizard doesn't already collect: `fal`
 * always (`FAL_KEY`), or `openai`/`google`/`openrouter` when the agent's MAIN
 * provider doesn't already supply the matching key. `auto` (follow-main) and
 * `openai-codex` (OAuth bearer, set up via `comis auth login`) carry no `apiKey`
 * — image reuses the main provider's secret, no image-specific key.
 */
export type ImageProviderConfig = {
  provider: string;
  apiKey?: string;
};

/**
 * Speech-to-text (transcription) provider selection from the `transcription`
 * step. `provider` is one of core's `TranscriptionConfigSchema` enum values
 * (`openai` | `groq` | `deepgram`) written to
 * `integrations.media.transcription.provider`. `apiKey` is present unless the
 * agent's MAIN provider already supplies the matching key —
 * `deepgram` always needs its own `DEEPGRAM_API_KEY`.
 */
export type TranscriptionProviderConfig = {
  provider: string;
  apiKey?: string;
};

/**
 * Text-to-speech provider selection from the `tts` step. `provider` is one of
 * core's `TtsConfigSchema` enum values (`openai` | `elevenlabs` | `edge`)
 * written to `integrations.media.tts.provider`. `apiKey` is present unless the
 * provider needs no key (`edge` is free) or the main provider already supplies
 * it (`openai` → `OPENAI_API_KEY`); `elevenlabs` always needs
 * `ELEVENLABS_API_KEY`.
 */
export type TtsProviderConfig = {
  provider: string;
  apiKey?: string;
};

/** Gateway settings collected during the wizard. Token is the only supported
 *  gateway auth method (the daemon's GatewayConfigSchema is a z.strictObject
 *  whose only auth keys are tokens[]/tls — there is no password field). */
export type GatewayConfig = {
  port: number;
  bindMode: "loopback" | "lan" | "custom";
  customIp?: string;
  token?: string;
  webEnabled: boolean;
};

/** Auth method for providers that support both API keys and OAuth tokens. */
export type AuthMethod = "apikey" | "oauth";

/** Provider configuration and credentials. */
export type ProviderConfig = {
  /** Provider identifier (e.g. "anthropic", "openai"). */
  id: string;
  apiKey?: string;
  /** Auth method when provider supports both API keys and OAuth tokens. */
  authMethod?: AuthMethod;
  customEndpoint?: string;
  compatMode?: "openai" | "anthropic";
  validated?: boolean;
  /**
   * Set when authMethod === "oauth" and the interactive
   * loginOpenAICodexOAuth flow succeeded. Carries the canonical
   * `<provider>:<identity>` profile-store key so downstream consumers
   * (multi-account selection) can locate the persisted profile.
   */
  oauthProfileId?: string;
};

// ---------- State ----------

/**
 * Immutable state accumulator for the wizard.
 *
 * Each step receives the current state and returns a new state
 * with its fields populated. All fields are optional because
 * they get filled as steps execute. Readonly enforces immutability
 * at the type level.
 */
export type WizardState = {
  readonly flow?: FlowType;
  readonly riskAccepted?: boolean;
  /**
   * Credential storage mode chosen at the `storage` step. Drives whether
   * step 04 routes OAuth through the encrypted store and whether step 10
   * persists collected secrets into `secrets.db` (encrypted) vs. a plaintext
   * `.env` (file). Emitted as `security.storage` into config.yaml.
   */
  readonly storageMode?: CredentialStorageMode;
  readonly existingConfigAction?: "update" | "fresh" | "cancel";
  readonly resetScope?: "config" | "config+creds" | "full";
  readonly provider?: ProviderConfig;
  readonly agentName?: string;
  readonly model?: string;
  readonly channels?: readonly ChannelConfig[];
  readonly senderTrustEntries?: readonly { senderId: string; level: string }[];
  readonly gateway?: GatewayConfig;
  readonly toolProviders?: readonly ToolProviderConfig[];
  /** Video-generation provider selection from the `video-providers` step. */
  readonly videoProvider?: VideoProviderConfig;
  /** Image-generation provider selection from the `image-providers` step. */
  readonly imageProvider?: ImageProviderConfig;
  /** Speech-to-text provider selection from the `transcription` step. */
  readonly transcriptionProvider?: TranscriptionProviderConfig;
  /** Text-to-speech provider selection from the `tts` step. */
  readonly ttsProvider?: TtsProviderConfig;
  readonly dataDir?: string;
  /** When true, skip post-setup health checks (set by --skip-health in non-interactive mode). */
  readonly skipHealth?: boolean;
  /**
   * Config `${VAR}` references the write-config step could not satisfy from the
   * `.env` or the encrypted secrets store. When non-empty, the daemon would
   * FATAL-crash-loop on boot, so the daemon-start step refuses to auto-start
   * and surfaces `comis secrets set` remediation instead.
   */
  readonly unresolvedSecretRefs?: readonly string[];
  /** Tracks which steps have completed (for jump-to from review). */
  readonly completedSteps: readonly WizardStepId[];
  /**
   * Transient signal for the state machine runner.
   *
   * When a step sets this field, the runner processes the jump,
   * clears dependent downstream state, then strips the field
   * before continuing. The underscore prefix signals it is not
   * persistent wizard data.
   */
  readonly _jumpTo?: WizardStepId;
};

/** Starting state for a new wizard run. */
export const INITIAL_STATE: WizardState = { completedSteps: [] };

// ---------- Step & Result ----------

/** Definition of a single wizard step. */
export type WizardStep = {
  id: WizardStepId;
  label: string;
  execute: (state: WizardState, prompter: WizardPrompter) => Promise<WizardState>;
};

/** Final output of a completed wizard run. */
export type WizardResult = {
  success: boolean;
  state: WizardState;
  configPath?: string;
  envPath?: string;
  error?: WizardError;
};

// ---------- Channel Constants ----------

/** Supported channel entry for selection prompts. */
export type SupportedChannel = {
  type: ChannelConfig["type"];
  label: string;
  credentialHint: string;
};

/** All supported chat channels with credential guidance. */
export const SUPPORTED_CHANNELS: readonly SupportedChannel[] = [
  { type: "telegram", label: "Telegram", credentialHint: "Bot token from @BotFather" },
  { type: "discord", label: "Discord", credentialHint: "Bot token from Developer Portal" },
  { type: "slack", label: "Slack", credentialHint: "Bot token + app token required" },
  { type: "whatsapp", label: "WhatsApp", credentialHint: "QR pairing (configured after setup)" },
  { type: "signal", label: "Signal", credentialHint: "Requires signal-cli" },
  { type: "irc", label: "IRC", credentialHint: "No credentials needed" },
  { type: "line", label: "LINE", credentialHint: "Channel token + secret required" },
  { type: "msteams", label: "Microsoft Teams", credentialHint: "App ID + password + tenant ID" },
  { type: "matrix", label: "Matrix", credentialHint: "Homeserver URL + user ID + access token" },
] as const;

// ---------- Environment Key Maps ----------

/** Map provider identifier to the environment variable key for the API key. */
export const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  together: "TOGETHER_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// ---------- Tool Provider Constants ----------

/** Supported tool provider entry for selection prompts. */
export type SupportedToolProvider = {
  id: string;
  label: string;
  hint: string;
  envKey: string;
};

/**
 * All supported web-search tool providers with credential guidance.
 *
 * This list is search-only: TTS providers (ElevenLabs / OpenAI) belong to the
 * dedicated `tts` step so the wizard writes `integrations.media.tts.provider`
 * and never asks for the same key twice.
 */
export const SUPPORTED_TOOL_PROVIDERS: readonly SupportedToolProvider[] = [
  { id: "brave", label: "Brave Search", hint: "Web search capability", envKey: "SEARCH_API_KEY" },
  { id: "perplexity", label: "Perplexity", hint: "AI-powered search", envKey: "PERPLEXITY_API_KEY" },
  { id: "tavily", label: "Tavily", hint: "AI search for agents", envKey: "TAVILY_API_KEY" },
  { id: "exa", label: "Exa", hint: "Neural web search", envKey: "EXA_API_KEY" },
  { id: "jina", label: "Jina", hint: "Reader-friendly search", envKey: "JINA_API_KEY" },
] as const;

/** Map tool provider identifier to environment variable key. */
export const TOOL_PROVIDER_ENV_KEYS: Record<string, string> = {
  brave: "SEARCH_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  jina: "JINA_API_KEY",
};

// ---------- Video Provider Constants ----------

/** Supported video-generation provider entry for the selection prompt. */
export type SupportedVideoProvider = {
  id: string;
  label: string;
  hint: string;
  /**
   * Env-var key for the credential this provider needs. Absent for `auto`
   * (which follows the agent's main provider and reuses its key — no
   * video-specific secret).
   */
  envKey?: string;
};

/**
 * All operator-selectable video-generation providers, mirroring core's
 * `VIDEO_PROVIDER_VALUES` (`auto` | `fal` | `google` | `xai`). The drift guard
 * in `08c-video-providers.test.ts` parses each id through `VideoGenerationConfigSchema`
 * so this list can never diverge from the config vocabulary the daemon accepts.
 *
 * `auto` is the recommended default (provider-following): video generation
 * follows the agent's main provider and reuses its credentials.
 * `google` → Veo and `xai` → Grok Imagine reuse `GOOGLE_API_KEY`/`XAI_API_KEY`
 * (the same key the completion path uses); only `fal` needs a dedicated `FAL_KEY`.
 */
export const SUPPORTED_VIDEO_PROVIDERS: readonly SupportedVideoProvider[] = [
  { id: "auto", label: "Auto (follow main provider)", hint: "Reuse your agent's provider + key (recommended)" },
  { id: "fal", label: "FAL", hint: "fal.ai queue API — needs a FAL_KEY" },
  { id: "google", label: "Google Veo", hint: "Veo via GOOGLE_API_KEY", envKey: "GOOGLE_API_KEY" },
  { id: "xai", label: "xAI Grok Imagine", hint: "Grok Imagine via XAI_API_KEY", envKey: "XAI_API_KEY" },
] as const;

/**
 * Map a video-generation provider id to the env-var key its credential is
 * stored under. `auto` is absent (follow-main, no dedicated key). `google`/`xai`
 * reuse the SAME env keys as the matching LLM provider (`PROVIDER_ENV_KEYS`), so
 * a `google`/`xai` main agent needs no extra credential.
 */
export const VIDEO_PROVIDER_ENV_KEYS: Record<string, string> = {
  fal: "FAL_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
};

// ---------- Image Provider Constants ----------

/** Supported image-generation provider entry for the selection prompt. */
export type SupportedImageProvider = {
  id: string;
  label: string;
  hint: string;
  /**
   * Env-var key for the STATIC credential this provider needs. Absent for
   * `auto` (follow-main) and `openai-codex` (OAuth bearer — set up via
   * `comis auth login`, not a key the wizard can prompt for).
   */
  envKey?: string;
};

/**
 * All operator-selectable image-generation providers, mirroring core's
 * `IMAGE_PROVIDER_VALUES` (`auto` | `fal` | `openai` | `openai-codex` |
 * `google` | `openrouter`). The drift guard in `08d-image-providers.test.ts`
 * parses each id through `ImageGenerationConfigSchema` so this list can never
 * diverge from the config vocabulary the daemon accepts.
 *
 * `auto` is the recommended default (provider-following): image generation
 * follows the agent's main provider and reuses its credentials.
 * `openai`/`google`/`openrouter` reuse `OPENAI_API_KEY`/`GOOGLE_API_KEY`/
 * `OPENROUTER_API_KEY` (the same key the completion path uses); `fal` needs a
 * dedicated `FAL_KEY`; `openai-codex` uses the Codex OAuth login (no static key).
 */
export const SUPPORTED_IMAGE_PROVIDERS: readonly SupportedImageProvider[] = [
  { id: "auto", label: "Auto (follow main provider)", hint: "Reuse your agent's provider + key (recommended)" },
  { id: "fal", label: "FAL", hint: "fal.ai queue API — needs a FAL_KEY" },
  { id: "openai", label: "OpenAI Images", hint: "gpt-image-1 via OPENAI_API_KEY", envKey: "OPENAI_API_KEY" },
  { id: "openai-codex", label: "OpenAI Codex (OAuth)", hint: "gpt-image-1 via your Codex login", },
  { id: "google", label: "Google Gemini", hint: "Gemini image via GOOGLE_API_KEY", envKey: "GOOGLE_API_KEY" },
  { id: "openrouter", label: "OpenRouter", hint: "FLUX via OPENROUTER_API_KEY", envKey: "OPENROUTER_API_KEY" },
] as const;

/**
 * Map an image-generation provider id to the env-var key its STATIC credential
 * is stored under. `auto` and `openai-codex` are absent (follow-main / OAuth).
 * `openai`/`google`/`openrouter` reuse the SAME env keys as the matching LLM
 * provider (`PROVIDER_ENV_KEYS`), so a matching main agent needs no extra
 * credential.
 */
export const IMAGE_PROVIDER_ENV_KEYS: Record<string, string> = {
  fal: "FAL_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// ---------- Transcription (STT) Provider Constants ----------

/** Supported speech-to-text provider entry for the selection prompt. */
export type SupportedTranscriptionProvider = {
  id: string;
  label: string;
  hint: string;
  /**
   * Env-var key for the STATIC credential this provider needs. Absent for
   * `auto` (keyless-first / follow-main) and `local` (in-process whisper —
   * downloads a small model, no key); present for the keyed cloud providers
   * (`openai`/`groq`/`deepgram`).
   */
  envKey?: string;
};

/**
 * All operator-selectable speech-to-text providers, mirroring core's
 * `TranscriptionConfigSchema` enum (`auto` | `local` | `openai` | `groq` |
 * `deepgram`, default `auto`). Drift-guarded in `08e-transcription.test.ts`
 * against `TranscriptionConfigSchema`. Voice auto-transcription is ON by
 * default, so the provider choice is meaningful even for a non-OpenAI main.
 *
 * Keyless-first ordering: `auto` (the recommended default — keyless-first /
 * follow-main) and `local` (in-process whisper) come before the keyed cloud
 * providers and OMIT `envKey` (their absence from `TRANSCRIPTION_PROVIDER_ENV_KEYS`
 * drives the no-prompt branch). `openai`/`groq` reuse the matching LLM key;
 * `deepgram` always needs its own `DEEPGRAM_API_KEY`.
 */
export const SUPPORTED_TRANSCRIPTION_PROVIDERS: readonly SupportedTranscriptionProvider[] = [
  { id: "auto", label: "Auto (keyless-first)", hint: "Local whisper, or reuse your agent's audio key (recommended)" },
  { id: "local", label: "Local whisper", hint: "in-process, no key (downloads a small model)" },
  { id: "openai", label: "OpenAI Whisper", hint: "whisper via OPENAI_API_KEY", envKey: "OPENAI_API_KEY" },
  { id: "groq", label: "Groq Whisper", hint: "fast whisper via GROQ_API_KEY", envKey: "GROQ_API_KEY" },
  { id: "deepgram", label: "Deepgram", hint: "Nova-3 via DEEPGRAM_API_KEY", envKey: "DEEPGRAM_API_KEY" },
] as const;

/** Map a transcription provider id to the env-var key its credential is stored under. */
export const TRANSCRIPTION_PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
};

// ---------- TTS Provider Constants ----------

/** Supported text-to-speech provider entry for the selection prompt. */
export type SupportedTtsProvider = {
  id: string;
  label: string;
  hint: string;
  /** Env-var key for the credential; absent for `edge` (free, no key). */
  envKey?: string;
};

/**
 * All operator-selectable text-to-speech providers, mirroring core's
 * `TtsConfigSchema` enum (`edge` | `openai` | `elevenlabs` | `local`, default
 * `edge`). Drift-guarded in `08f-tts.test.ts` against `TtsConfigSchema`.
 *
 * Keyless-first ordering: `edge` (Microsoft Edge — the recommended keyless
 * default) leads, and `local` (offline Piper — arrives in a later release)
 * trails; both OMIT `envKey` (absent from `TTS_PROVIDER_ENV_KEYS` → no prompt).
 * `openai` reuses `OPENAI_API_KEY`; `elevenlabs` needs
 * `ELEVENLABS_API_KEY`.
 */
export const SUPPORTED_TTS_PROVIDERS: readonly SupportedTtsProvider[] = [
  { id: "edge", label: "Edge TTS", hint: "Microsoft Edge — free, no key (recommended)" },
  { id: "openai", label: "OpenAI TTS", hint: "via OPENAI_API_KEY", envKey: "OPENAI_API_KEY" },
  { id: "elevenlabs", label: "ElevenLabs", hint: "via ELEVENLABS_API_KEY", envKey: "ELEVENLABS_API_KEY" },
  { id: "local", label: "Local (offline Piper)", hint: "offline voice — arrives in a later release; requires setup" },
] as const;

/**
 * Map a TTS provider id to the env-var key its credential is stored under.
 * `edge` is absent (free, no credential).
 */
export const TTS_PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
};

/** Map channel type to required credential environment variable names. */
export const CHANNEL_ENV_KEYS: Record<string, string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  whatsapp: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN"],
  line: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
  msteams: ["MSTEAMS_APP_PASSWORD"],
  matrix: ["MATRIX_ACCESS_TOKEN"],
};
