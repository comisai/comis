/**
 * Shared types and constants for the init wizard flows.
 *
 * Provides the WizardResult, ChannelSetup, and ProviderChoice types
 * used by both QuickStart and Manual flows, plus constant arrays
 * for providers, channel types, and minimum key lengths.
 *
 * @module
 */

// ---------- Types ----------

/** Result collected from any wizard flow. */
export interface WizardResult {
  provider: string;
  agentName: string;
  apiKey?: string;
  model?: string;
  channels?: ChannelSetup[];
  gatewayEnabled?: boolean;
  gatewayHost?: string;
  gatewayPort?: number;
  gatewayToken?: string;
  dataDir?: string;
}

/** Channel configuration collected during the wizard. */
export interface ChannelSetup {
  type:
    | "telegram"
    | "discord"
    | "slack"
    | "whatsapp"
    | "signal"
    | "irc"
    | "line";
  botToken?: string;
  apiKey?: string;
  appToken?: string;
}

/** A provider option for Clack select prompts. */
export interface ProviderChoice {
  value: string;
  label: string;
  hint?: string;
}

// ---------- Constants ----------

/** Provider options for Clack select prompts. */
export const PROVIDERS: ProviderChoice[] = [
  { value: "anthropic", label: "Anthropic (Claude)", hint: "Recommended" },
  { value: "openai", label: "OpenAI (GPT)" },
  { value: "google", label: "Google (Gemini)" },
  { value: "groq", label: "Groq", hint: "Fast inference" },
  { value: "mistral", label: "Mistral" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "xai", label: "xAI (Grok)" },
  { value: "together", label: "Together AI" },
  { value: "cerebras", label: "Cerebras", hint: "Fast inference" },
  { value: "openrouter", label: "OpenRouter", hint: "Multi-provider gateway" },
  { value: "ollama", label: "Ollama (local)", hint: "No API key needed" },
];

/** Minimum API key lengths per provider (0 = no key needed). */
export const MIN_KEY_LENGTHS: Record<string, number> = {
  anthropic: 20,
  openai: 20,
  google: 20,
  groq: 20,
  mistral: 20,
  deepseek: 20,
  xai: 20,
  together: 20,
  cerebras: 20,
  openrouter: 20,
  ollama: 0,
};

/** Map provider name to the environment variable key for the API key. */
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

/** Map channel type to required credential environment variable names. */
export const CHANNEL_ENV_KEYS: Record<string, string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  whatsapp: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN"],
  line: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"],
};

/** All supported channel types for Clack multiselect. */
export const CHANNEL_TYPES: { value: ChannelSetup["type"]; label: string }[] = [
  { value: "telegram", label: "Telegram" },
  { value: "discord", label: "Discord" },
  { value: "slack", label: "Slack" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "signal", label: "Signal" },
  { value: "irc", label: "IRC" },
  { value: "line", label: "LINE" },
];
