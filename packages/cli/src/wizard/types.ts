// SPDX-License-Identifier: Apache-2.0
/**
 * Foundational types and constants for the init wizard redesign.
 *
 * Replaces the role of flow-types.ts with a richer type system
 * that supports the full wizard architecture: immutable state
 * accumulation, structured validation, and multi-flow support.
 *
 * @module
 */

import type { WizardPrompter } from "./prompter.js";

// ---------- Flow & Step Identifiers ----------

/** Wizard flow variants. */
export type FlowType = "quickstart" | "advanced" | "remote";

/** All wizard step identifiers, ordered by execution sequence. */
export type WizardStepId =
  | "welcome"
  | "detect-existing"
  | "flow-select"
  | "provider"
  | "credentials"
  | "agent"
  | "channels"
  | "gateway"
  | "workspace"
  | "tool-providers"
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
export type ChannelConfig = {
  type: "telegram" | "discord" | "slack" | "whatsapp" | "signal" | "irc" | "line";
  botToken?: string;
  apiKey?: string;
  appToken?: string;
  channelSecret?: string;
  guildIds?: string[];
  allowFrom?: string[];
  validated?: boolean;
};

/** Per-tool-provider collected credentials. */
export type ToolProviderConfig = {
  id: string;
  apiKey: string;
  validated?: boolean;
};

/** Gateway settings collected during the wizard. */
export type GatewayConfig = {
  port: number;
  bindMode: "loopback" | "lan" | "custom";
  customIp?: string;
  authMethod: "token" | "password";
  token?: string;
  password?: string;
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
  readonly existingConfigAction?: "update" | "fresh" | "cancel";
  readonly resetScope?: "config" | "config+creds" | "full";
  readonly provider?: ProviderConfig;
  readonly agentName?: string;
  readonly model?: string;
  readonly channels?: readonly ChannelConfig[];
  readonly senderTrustEntries?: readonly { senderId: string; level: string }[];
  readonly gateway?: GatewayConfig;
  readonly toolProviders?: readonly ToolProviderConfig[];
  readonly dataDir?: string;
  /** When true, skip post-setup health checks (set by --skip-health in non-interactive mode). */
  readonly skipHealth?: boolean;
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

// ---------- Provider Constants ----------

/** Supported provider entry for selection prompts. */
export type SupportedProvider = {
  id: string;
  label: string;
  hint?: string;
  category: "recommended" | "other" | "local" | "custom";
};

/**
 * All supported LLM providers, grouped by category.
 *
 * Categories: recommended (top picks), other (cloud APIs),
 * local (self-hosted), custom (user-defined endpoints).
 */
export const SUPPORTED_PROVIDERS: readonly SupportedProvider[] = [
  // Recommended
  { id: "anthropic", label: "Anthropic (Claude)", hint: "Recommended for agents", category: "recommended" },
  { id: "openai", label: "OpenAI (GPT)", hint: "GPT-4o, o1, o3 models", category: "recommended" },

  // Other Providers
  { id: "google", label: "Google (Gemini)", hint: "Gemini models", category: "other" },
  { id: "groq", label: "Groq", hint: "Fast inference (Llama, Mixtral)", category: "other" },
  { id: "mistral", label: "Mistral", hint: "Mistral models", category: "other" },
  { id: "deepseek", label: "DeepSeek", hint: "DeepSeek models", category: "other" },
  { id: "xai", label: "xAI (Grok)", hint: "Grok models", category: "other" },
  { id: "together", label: "Together AI", hint: "Open-source model hosting", category: "other" },
  { id: "cerebras", label: "Cerebras", hint: "Fast inference", category: "other" },
  { id: "openrouter", label: "OpenRouter", hint: "Multi-provider routing", category: "other" },

  // Local
  { id: "ollama", label: "Ollama (local)", hint: "No API key needed", category: "local" },

  // Custom
  { id: "custom", label: "Custom endpoint", hint: "OpenAI-compatible API", category: "custom" },
] as const;

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

/** All supported tool providers with credential guidance. */
export const SUPPORTED_TOOL_PROVIDERS: readonly SupportedToolProvider[] = [
  { id: "brave", label: "Brave Search", hint: "Web search capability", envKey: "SEARCH_API_KEY" },
  { id: "elevenlabs", label: "ElevenLabs", hint: "Text-to-speech", envKey: "ELEVENLABS_API_KEY" },
  { id: "openai-tts", label: "OpenAI TTS", hint: "Text-to-speech", envKey: "OPENAI_API_KEY" },
  { id: "perplexity", label: "Perplexity", hint: "AI-powered search", envKey: "PERPLEXITY_API_KEY" },
  { id: "tavily", label: "Tavily", hint: "AI search for agents", envKey: "TAVILY_API_KEY" },
  { id: "exa", label: "Exa", hint: "Neural web search", envKey: "EXA_API_KEY" },
  { id: "jina", label: "Jina", hint: "Reader-friendly search", envKey: "JINA_API_KEY" },
] as const;

/** Map tool provider identifier to environment variable key. */
export const TOOL_PROVIDER_ENV_KEYS: Record<string, string> = {
  brave: "SEARCH_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  "openai-tts": "OPENAI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  jina: "JINA_API_KEY",
};

/** Map channel type to required credential environment variable names. */
export const CHANNEL_ENV_KEYS: Record<string, string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  whatsapp: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN"],
  line: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
};
