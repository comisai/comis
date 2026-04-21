// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import { IcToast } from "../components/feedback/ic-toast.js";

// Side-effect imports for sub-components
import "../components/display/ic-platform-icon.js";
import "../components/display/ic-icon.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ChannelSetup {
  enabled: boolean;
  credentials: Record<string, string>;
}

interface WizardData {
  // Step 1: Basics
  tenantId: string;
  dataDir: string;
  logLevel: string;
  gatewayHost: string;
  gatewayPort: number;

  // Step 2: Provider
  providerName: string;
  providerType: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;

  // Step 3: Agent
  agentId: string;
  agentName: string;
  agentModel: string;
  agentProvider: string;
  maxSteps: number;
  budgetPerDay: number;
  budgetPerHour: number;

  // Step 4: Channels
  channels: Record<string, ChannelSetup>;
}

interface StepDef {
  label: string;
  icon: string;
}

interface ProviderOption {
  key: string;
  type: string;
  name: string;
  description: string;
  needsApiKey: boolean;
  needsBaseUrl: boolean;
  defaultBaseUrl: string;
  defaultModel: string;
}

interface ChannelFieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
  defaultValue?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STEPS: StepDef[] = [
  { label: "Basics", icon: "settings" },
  { label: "Provider", icon: "server" },
  { label: "Agent", icon: "agent" },
  { label: "Channels", icon: "channel" },
  { label: "Review", icon: "check" },
];

const PROVIDERS: ProviderOption[] = [
  // Recommended
  {
    key: "anthropic",
    type: "anthropic",
    name: "Anthropic",
    description: "Claude models, recommended for agents",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "claude-sonnet-4-5-20250929",
  },
  {
    key: "openai",
    type: "openai",
    name: "OpenAI",
    description: "GPT-4o, o1, o3 models",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "gpt-4o",
  },
  // Other cloud providers
  {
    key: "google",
    type: "google",
    name: "Google",
    description: "Gemini models",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "gemini-2.0-flash",
  },
  {
    key: "groq",
    type: "groq",
    name: "Groq",
    description: "Fast inference (Llama, Mixtral)",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "llama-3.3-70b-versatile",
  },
  {
    key: "mistral",
    type: "mistral",
    name: "Mistral",
    description: "Mistral models",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "mistral-large-latest",
  },
  {
    key: "deepseek",
    type: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek models",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "deepseek-chat",
  },
  {
    key: "xai",
    type: "xai",
    name: "xAI",
    description: "Grok models",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "grok-2",
  },
  {
    key: "together",
    type: "together",
    name: "Together AI",
    description: "Open-source model hosting",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
  },
  {
    key: "cerebras",
    type: "cerebras",
    name: "Cerebras",
    description: "Fast inference",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "llama-3.3-70b",
  },
  {
    key: "openrouter",
    type: "openrouter",
    name: "OpenRouter",
    description: "Multi-provider routing",
    needsApiKey: true,
    needsBaseUrl: false,
    defaultBaseUrl: "",
    defaultModel: "anthropic/claude-sonnet-4-5-20250929",
  },
  // Local
  {
    key: "ollama",
    type: "ollama",
    name: "Ollama",
    description: "Local open-source models, no API key needed",
    needsApiKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "llama3",
  },
  // Custom
  {
    key: "custom",
    type: "openai",
    name: "Custom",
    description: "Any OpenAI-compatible API endpoint",
    needsApiKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: "",
    defaultModel: "",
  },
];

const CHANNEL_PLATFORMS: { key: string; label: string; fields: ChannelFieldDef[] }[] = [
  {
    key: "telegram",
    label: "Telegram",
    fields: [
      { key: "botToken", label: "Bot Token", type: "password" },
      { key: "allowedChatIds", label: "Allowed Chat IDs", type: "text", placeholder: "Comma-separated IDs" },
    ],
  },
  {
    key: "discord",
    label: "Discord",
    fields: [
      { key: "botToken", label: "Bot Token", type: "password" },
      { key: "guildIds", label: "Guild IDs", type: "text", placeholder: "Comma-separated IDs" },
    ],
  },
  {
    key: "slack",
    label: "Slack",
    fields: [
      { key: "botToken", label: "Bot Token", type: "password" },
      { key: "appToken", label: "App Token", type: "password" },
      { key: "signingSecret", label: "Signing Secret", type: "password" },
    ],
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    fields: [
      { key: "phoneNumberId", label: "Phone Number ID", type: "text" },
      { key: "accessToken", label: "Access Token", type: "password" },
      { key: "verifyToken", label: "Verify Token", type: "text" },
    ],
  },
  {
    key: "line",
    label: "LINE",
    fields: [
      { key: "channelAccessToken", label: "Channel Access Token", type: "password" },
      { key: "channelSecret", label: "Channel Secret", type: "password" },
    ],
  },
  {
    key: "signal",
    label: "Signal",
    fields: [
      { key: "phone", label: "Phone Number", type: "text" },
      { key: "signalCliPath", label: "Signal CLI Path", type: "text" },
    ],
  },
  {
    key: "irc",
    label: "IRC",
    fields: [
      { key: "server", label: "Server", type: "text" },
      { key: "port", label: "Port", type: "number", defaultValue: "6667" },
      { key: "nick", label: "Nickname", type: "text" },
      { key: "channels", label: "Channels", type: "text", placeholder: "Comma-separated, e.g. #general,#dev" },
    ],
  },
  {
    key: "imessage",
    label: "iMessage",
    fields: [
      { key: "applescriptPath", label: "AppleScript Path", type: "text", placeholder: "Requires macOS with Messages app" },
    ],
  },
];

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"];

/* ------------------------------------------------------------------ */
/*  YAML serializer (lightweight inline)                               */
/* ------------------------------------------------------------------ */

function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return `${pad}~\n`;
  if (typeof obj === "string") {
    // Quote strings that contain special characters
    if (obj === "" || /[:#[\]{},&*!|>'"@`]/.test(obj) || /^\s|\s$/.test(obj)) {
      return `"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]\n";
    return obj.map((item) => {
      if (typeof item === "object" && item !== null) {
        const inner = toYaml(item, indent + 1);
        // First key on same line as dash, preserve relative indentation for nested keys
        const lines = inner.split("\n").filter(Boolean);
        if (lines.length > 0) {
          const basePad = "  ".repeat(indent + 1);
          return `${pad}- ${lines[0].substring(basePad.length)}\n${lines.slice(1).map((l) => `${pad}  ${l.substring(basePad.length)}\n`).join("")}`;
        }
        return `${pad}- ${inner.trim()}\n`;
      }
      return `${pad}- ${toYaml(item, 0)}\n`;
    }).join("");
  }
  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    );
    if (entries.length === 0) return "{}\n";
    return entries.map(([k, v]) => {
      if (typeof v === "object" && !Array.isArray(v)) {
        const inner = toYaml(v, indent + 1);
        return `${pad}${k}:\n${inner}`;
      }
      if (Array.isArray(v)) {
        const inner = toYaml(v, indent + 1);
        return `${pad}${k}:\n${inner}`;
      }
      return `${pad}${k}: ${toYaml(v, 0)}\n`;
    }).join("");
  }
  return String(obj);
}

/* ------------------------------------------------------------------ */
/*  Default wizard data                                                */
/* ------------------------------------------------------------------ */

function createDefaultWizardData(): WizardData {
  const channels: Record<string, ChannelSetup> = {};
  for (const p of CHANNEL_PLATFORMS) {
    channels[p.key] = { enabled: false, credentials: {} };
  }
  return {
    tenantId: "default",
    dataDir: "~/.comis",
    logLevel: "info",
    gatewayHost: "127.0.0.1",
    gatewayPort: 4766,
    providerName: "",
    providerType: "",
    apiKey: "",
    baseUrl: "",
    defaultModel: "",
    agentId: "default",
    agentName: "Comis",
    agentModel: "",
    agentProvider: "",
    maxSteps: 50,
    budgetPerDay: 100_000_000,
    budgetPerHour: 10_000_000,
    channels,
  };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * Setup wizard with 5-step guided flow for new operators.
 *
 * Steps: Basics, Provider, Agent, Channels, Review & Launch.
 * Generates YAML configuration with copy, download, and apply actions.
 * Covers all guided flow steps through review and launch.
 */
@customElement("ic-setup-wizard")
export class IcSetupWizard extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .wizard-header {
        margin-bottom: var(--ic-space-lg);
      }

      .wizard-title {
        font-size: 1.125rem;
        font-weight: 600;
      }

      .wizard-subtitle {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-top: var(--ic-space-xs);
      }

      /* Step progress bar */
      .step-bar {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        gap: 0;
        margin-bottom: var(--ic-space-xl, 2rem);
      }

      .step-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        min-width: 80px;
      }

      .step-circle {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--ic-text-sm);
        font-weight: 600;
        border: 2px solid var(--ic-border);
        background: var(--ic-surface-2);
        color: var(--ic-text-dim);
        position: relative;
      }

      .step-circle.completed {
        background: var(--ic-accent);
        border-color: var(--ic-accent);
        color: white;
      }

      .step-circle.current {
        border-color: var(--ic-accent);
        color: var(--ic-accent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--ic-accent) 25%, transparent);
      }

      .step-label {
        font-size: var(--ic-text-xs);
        margin-top: var(--ic-space-xs);
        color: var(--ic-text-dim);
        text-align: center;
      }

      .step-label.current {
        color: var(--ic-text);
        font-weight: 500;
      }

      .step-label.completed {
        color: var(--ic-text-muted);
      }

      .step-line {
        flex: 1;
        height: 2px;
        background: var(--ic-border);
        margin-top: 16px;
        min-width: 40px;
        max-width: 80px;
      }

      .step-line.completed {
        background: var(--ic-accent);
      }

      /* Step content area */
      .step-content {
        max-width: 640px;
        margin: 0 auto;
        min-height: 300px;
      }

      /* Form styling */
      .form-container {
        max-width: 500px;
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-md);
      }

      .form-label {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .form-input {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .form-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .form-input::placeholder {
        color: var(--ic-text-dim);
      }

      .form-hint {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .form-error {
        font-size: var(--ic-text-xs);
        color: var(--ic-error);
      }

      .form-select {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .form-select:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      /* Provider cards */
      .provider-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.75rem;
        margin-bottom: var(--ic-space-lg);
      }

      @media (max-width: 768px) {
        .provider-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      @media (max-width: 480px) {
        .provider-grid {
          grid-template-columns: 1fr;
        }
      }

      .provider-card {
        padding: 1rem;
        background: var(--ic-surface);
        border: 2px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        cursor: pointer;
        transition: border-color var(--ic-transition, 150ms), background var(--ic-transition, 150ms);
      }

      .provider-card:hover {
        border-color: var(--ic-text-dim);
      }

      .provider-card.active {
        border-color: var(--ic-accent);
        background: var(--ic-surface-2);
      }

      .provider-card-name {
        font-weight: 600;
        font-size: var(--ic-text-sm);
        margin-bottom: var(--ic-space-xs);
      }

      .provider-card-desc {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
      }

      /* Provider config section */
      .provider-config {
        margin-top: var(--ic-space-lg);
        max-width: 500px;
      }

      /* Test connection */
      .test-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-sm);
      }

      .test-btn {
        padding: 0.375rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-xs);
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
      }

      .test-btn:hover {
        background: var(--ic-border);
      }

      .test-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .test-success {
        font-size: var(--ic-text-xs);
        color: var(--ic-success);
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }

      .test-error {
        font-size: var(--ic-text-xs);
        color: var(--ic-error);
        display: flex;
        align-items: center;
        gap: 0.25rem;
      }

      .test-spinner {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
      }

      /* Info box */
      .info-box {
        padding: 0.75rem 1rem;
        background: color-mix(in srgb, var(--ic-accent) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--ic-accent) 30%, transparent);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-md);
      }

      /* Channel cards */
      .channel-cards {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }

      .channel-card {
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        overflow: hidden;
      }

      .channel-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: 0.75rem 1rem;
        cursor: pointer;
        background: var(--ic-surface);
        user-select: none;
      }

      .channel-header:hover {
        background: var(--ic-surface-2);
      }

      .channel-name {
        font-weight: 500;
        font-size: var(--ic-text-sm);
        flex: 1;
      }

      .channel-toggle {
        width: 36px;
        height: 20px;
        border-radius: 10px;
        border: none;
        cursor: pointer;
        position: relative;
        background: var(--ic-border);
        transition: background var(--ic-transition, 150ms);
        padding: 0;
      }

      .channel-toggle.enabled {
        background: var(--ic-accent);
      }

      .channel-toggle::after {
        content: "";
        position: absolute;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: white;
        top: 2px;
        left: 2px;
        transition: transform var(--ic-transition, 150ms);
      }

      .channel-toggle.enabled::after {
        transform: translateX(16px);
      }

      .channel-expand {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        transition: transform var(--ic-transition, 150ms);
      }

      .channel-expand.open {
        transform: rotate(180deg);
      }

      .channel-body {
        padding: 0.75rem 1rem 1rem;
        border-top: 1px solid var(--ic-border);
        background: var(--ic-surface-2);
      }

      /* Review YAML preview */
      .yaml-preview {
        background: var(--ic-surface-2);
        color: var(--ic-text);
        padding: 1rem;
        border-radius: var(--ic-radius-md);
        border: 1px solid var(--ic-border);
        max-height: 500px;
        overflow: auto;
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-sm);
        white-space: pre;
        line-height: 1.5;
      }

      .review-actions {
        display: flex;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-md);
        flex-wrap: wrap;
      }

      .btn {
        padding: 0.5rem 1rem;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        border: none;
        white-space: nowrap;
      }

      .btn-primary {
        background: var(--ic-accent);
        color: white;
      }

      .btn-primary:hover {
        opacity: 0.9;
      }

      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
      }

      .btn-secondary:hover {
        background: var(--ic-border);
      }

      .apply-status {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        margin-top: var(--ic-space-sm);
      }

      .dashboard-link {
        margin-top: var(--ic-space-md);
      }

      .dashboard-link a {
        color: var(--ic-accent);
        cursor: pointer;
        text-decoration: underline;
        font-size: var(--ic-text-sm);
      }

      /* Navigation bar */
      .nav-bar {
        display: flex;
        justify-content: space-between;
        margin-top: var(--ic-space-xl, 2rem);
        padding-top: var(--ic-space-md);
        border-top: 1px solid var(--ic-border);
      }

      .nav-spacer {
        flex: 1;
      }
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  @state() private _currentStep = 0;
  @state() private _wizardData: WizardData = createDefaultWizardData();
  @state() private _testResult: { status: "idle" | "testing" | "success" | "error"; message?: string } = { status: "idle" };
  @state() private _expandedChannels: Set<string> = new Set();
  @state() private _yamlPreview = "";
  @state() private _applying = false;
  @state() private _applyStatus = "";
  @state() private _applyDone = false;
  @state() private _validationErrors: Record<string, string> = {};

  /* ---------------------------------------------------------------- */
  /*  Step validation                                                  */
  /* ---------------------------------------------------------------- */

  private _validateStep(step: number): boolean {
    const errors: Record<string, string> = {};

    switch (step) {
      case 0: // Basics
        if (!this._wizardData.tenantId.trim()) {
          errors["tenantId"] = "Tenant ID is required";
        }
        break;
      case 1: { // Provider
        if (!this._wizardData.providerType) {
          errors["providerType"] = "Please select a provider";
        }
        const provider = PROVIDERS.find((p) => p.key === this._wizardData.providerName);
        if (provider?.needsApiKey && !this._wizardData.apiKey.trim()) {
          errors["apiKey"] = "API key is required for this provider";
        }
        if (provider?.needsBaseUrl && !this._wizardData.baseUrl.trim()) {
          errors["baseUrl"] = "Base URL is required for this provider";
        }
        break;
      }
      case 2: // Agent
        if (!this._wizardData.agentId.trim()) {
          errors["agentId"] = "Agent ID is required";
        }
        break;
      case 3: // Channels - no validation
        break;
    }

    this._validationErrors = errors;
    return Object.keys(errors).length === 0;
  }

  /* ---------------------------------------------------------------- */
  /*  Navigation                                                       */
  /* ---------------------------------------------------------------- */

  private _goNext(): void {
    if (!this._validateStep(this._currentStep)) return;

    if (this._currentStep === 3) {
      this._generateYaml();
    }

    // Pre-fill agent fields from provider step when advancing to step 3
    if (this._currentStep === 1) {
      if (!this._wizardData.agentModel) {
        this._wizardData = {
          ...this._wizardData,
          agentModel: this._wizardData.defaultModel,
          agentProvider: this._wizardData.providerName,
        };
      }
    }

    this._currentStep = Math.min(this._currentStep + 1, STEPS.length - 1);
    this._validationErrors = {};
  }

  private _goBack(): void {
    this._currentStep = Math.max(this._currentStep - 1, 0);
    this._validationErrors = {};
  }

  /* ---------------------------------------------------------------- */
  /*  Provider selection                                                */
  /* ---------------------------------------------------------------- */

  private _selectProvider(provider: ProviderOption): void {
    this._wizardData = {
      ...this._wizardData,
      providerName: provider.key,
      providerType: provider.type,
      baseUrl: provider.defaultBaseUrl,
      defaultModel: provider.defaultModel,
    };
    this._testResult = { status: "idle" };
    this._validationErrors = {};
  }

  /* ---------------------------------------------------------------- */
  /*  Test connection                                                   */
  /* ---------------------------------------------------------------- */

  private async _testConnection(): Promise<void> {
    if (!this.rpcClient) return;

    this._testResult = { status: "testing" };

    try {
      await this.rpcClient.call("models.test", { provider: this._wizardData.providerType });
      this._testResult = { status: "success", message: "Connected" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed";
      this._testResult = { status: "error", message: msg };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Channel management                                                */
  /* ---------------------------------------------------------------- */

  private _toggleChannel(platform: string): void {
    const current = this._wizardData.channels[platform];
    const updatedChannels = {
      ...this._wizardData.channels,
      [platform]: { ...current, enabled: !current.enabled },
    };
    this._wizardData = { ...this._wizardData, channels: updatedChannels };

    // Auto-expand when enabling
    if (!current.enabled) {
      const expanded = new Set(this._expandedChannels);
      expanded.add(platform);
      this._expandedChannels = expanded;
    }
  }

  private _toggleExpand(platform: string): void {
    const expanded = new Set(this._expandedChannels);
    if (expanded.has(platform)) {
      expanded.delete(platform);
    } else {
      expanded.add(platform);
    }
    this._expandedChannels = expanded;
  }

  private _updateChannelCredential(platform: string, key: string, value: string): void {
    const current = this._wizardData.channels[platform];
    const updatedCredentials = { ...current.credentials, [key]: value };
    const updatedChannels = {
      ...this._wizardData.channels,
      [platform]: { ...current, credentials: updatedCredentials },
    };
    this._wizardData = { ...this._wizardData, channels: updatedChannels };
  }

  /* ---------------------------------------------------------------- */
  /*  YAML generation                                                   */
  /* ---------------------------------------------------------------- */

  private _generateYaml(): void {
    const d = this._wizardData;
    const config: Record<string, unknown> = {};

    // Top-level fields (not under daemon section)
    if (d.tenantId && d.tenantId !== "default") config["tenantId"] = d.tenantId;
    config["logLevel"] = d.logLevel;
    config["dataDir"] = d.dataDir;

    // Gateway section
    config["gateway"] = {
      enabled: true,
      host: d.gatewayHost,
      port: d.gatewayPort,
    };

    // Providers section (top-level LLM provider config)
    if (d.providerName) {
      const providerEntry: Record<string, unknown> = {};
      if (d.apiKey) providerEntry["apiKeyName"] = "env:" + d.providerName.toUpperCase() + "_API_KEY";
      if (d.baseUrl) providerEntry["baseUrl"] = d.baseUrl;
      config["providers"] = {
        [d.providerName]: providerEntry,
      };
      if (d.defaultModel) {
        config["models"] = {
          defaultProvider: d.providerName,
          defaultModel: d.defaultModel,
        };
      }
    }

    // Agents section (record keyed by agent ID, not array)
    const agentConfig: Record<string, unknown> = {
      name: d.agentName,
      model: d.agentModel || d.defaultModel,
      provider: d.agentProvider || d.providerName,
      maxSteps: d.maxSteps,
      budgets: {
        perExecution: 2_000_000,
        perHour: d.budgetPerHour,
        perDay: d.budgetPerDay,
      },
    };
    config["agents"] = { [d.agentId]: agentConfig };

    // Channels section (record keyed by platform, not array)
    const channelEntries: Record<string, unknown> = {};
    for (const [key, ch] of Object.entries(d.channels)) {
      if (!ch.enabled) continue;
      const entry: Record<string, unknown> = { enabled: true };
      for (const [credKey, credVal] of Object.entries(ch.credentials)) {
        if (!credVal) continue;
        // Map allowedChatIds to allowFrom array
        if (credKey === "allowedChatIds") {
          entry["allowFrom"] = credVal.split(",").map((s: string) => s.trim()).filter(Boolean);
        } else {
          entry[credKey] = credVal;
        }
      }
      channelEntries[key] = entry;
    }
    if (Object.keys(channelEntries).length > 0) {
      config["channels"] = channelEntries;
    }

    this._yamlPreview = toYaml(config);
  }

  /* ---------------------------------------------------------------- */
  /*  Review actions                                                    */
  /* ---------------------------------------------------------------- */

  private async _copyYaml(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this._yamlPreview);
      IcToast.show("Copied to clipboard", "success");
    } catch {
      IcToast.show("Failed to copy", "error");
    }
  }

  private _downloadYaml(): void {
    const blob = new Blob([this._yamlPreview], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "comis-config.yaml";
    a.click();
    URL.revokeObjectURL(url);
  }

  private async _applyConfig(): Promise<void> {
    if (!this.rpcClient || this._applying) return;

    this._applying = true;
    this._applyDone = false;

    const d = this._wizardData;

    // Sections that can be applied at runtime via config.apply.
    // Note: agents, channels, providers, security, integrations, approvals
    // are IMMUTABLE at runtime. gateway.host/port are also immutable.
    // For initial setup, use Copy/Download to get the full config YAML.
    const sections: { label: string; section: string; value: unknown }[] = [];

    // Models (mutable)
    if (d.providerName && d.defaultModel) {
      sections.push({
        label: "models",
        section: "models",
        value: { defaultProvider: d.providerName, defaultModel: d.defaultModel },
      });
    }

    // Immutable sections that require config file + restart
    const immutableSections: string[] = [];
    immutableSections.push("agents");
    immutableSections.push("gateway");
    if (d.providerName) immutableSections.push("providers");
    const hasChannels = Object.values(d.channels).some((ch) => ch.enabled);
    if (hasChannels) immutableSections.push("channels");

    let appliedCount = 0;
    for (const s of sections) {
      this._applyStatus = `Applying ${s.label}...`;
      try {
        await this.rpcClient.call("config.apply", { section: s.section, value: s.value });
        appliedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to apply configuration";
        IcToast.show(`${s.label}: ${msg}`, "error");
      }
    }

    this._applying = false;
    this._applyStatus = "";
    this._applyDone = true;

    if (immutableSections.length > 0) {
      IcToast.show(
        `Applied ${appliedCount} section(s). ${immutableSections.join(", ")} require saving the config file and restarting the daemon. Use Copy or Download to get the full config.`,
        "info",
      );
    } else {
      IcToast.show("Configuration applied! Restart the daemon to activate.", "success");
    }
  }

  private _goToDashboard(): void {
    this.dispatchEvent(new CustomEvent("navigate", { detail: "dashboard", bubbles: true, composed: true }));
  }

  /* ---------------------------------------------------------------- */
  /*  Step renderers                                                    */
  /* ---------------------------------------------------------------- */

  private _renderStep1() {
    const d = this._wizardData;
    const errors = this._validationErrors;

    return html`
      <div class="form-container">
        <div class="form-field">
          <label class="form-label">Tenant ID</label>
          <input
            class="form-input"
            type="text"
            .value=${d.tenantId}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, tenantId: (e.target as HTMLInputElement).value };
            }}
          />
          <span class="form-hint">Unique identifier for this installation</span>
          ${errors["tenantId"] ? html`<span class="form-error">${errors["tenantId"]}</span>` : nothing}
        </div>

        <div class="form-field">
          <label class="form-label">Data Directory</label>
          <input
            class="form-input"
            type="text"
            .value=${d.dataDir}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, dataDir: (e.target as HTMLInputElement).value };
            }}
          />
          <span class="form-hint">Where Comis stores databases and logs</span>
        </div>

        <div class="form-field">
          <label class="form-label">Log Level</label>
          ${this._renderLogLevelSelect()}
        </div>

        <div class="form-field">
          <label class="form-label">Gateway Host</label>
          <input
            class="form-input"
            type="text"
            .value=${d.gatewayHost}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, gatewayHost: (e.target as HTMLInputElement).value };
            }}
          />
        </div>

        <div class="form-field">
          <label class="form-label">Gateway Port</label>
          <input
            class="form-input"
            type="number"
            min="1"
            max="65535"
            .value=${String(d.gatewayPort)}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, gatewayPort: Number((e.target as HTMLInputElement).value) || 4766 };
            }}
          />
        </div>
      </div>
    `;
  }

  /** Separate method for log level select to avoid Lit duplicate attribute binding. */
  private _renderLogLevelSelect() {
    return html`
      <select
        class="form-select"
        @change=${(e: Event) => {
          this._wizardData = { ...this._wizardData, logLevel: (e.target as HTMLSelectElement).value };
        }}
      >
        ${LOG_LEVELS.map(
          (level) => html`<option value=${level} ?selected=${level === this._wizardData.logLevel}>${level}</option>`,
        )}
      </select>
    `;
  }

  private _renderStep2() {
    const d = this._wizardData;
    const errors = this._validationErrors;
    const selectedProvider = PROVIDERS.find((p) => p.key === d.providerName);

    return html`
      <div class="provider-grid">
        ${PROVIDERS.map(
          (p) => html`
            <div
              class="provider-card ${d.providerName === p.key ? "active" : ""}"
              role="button"
              tabindex="0"
              aria-pressed=${d.providerName === p.key ? "true" : "false"}
              @click=${() => this._selectProvider(p)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  this._selectProvider(p);
                }
              }}
            >
              <div class="provider-card-name">${p.name}</div>
              <div class="provider-card-desc">${p.description}</div>
            </div>
          `,
        )}
      </div>
      ${errors["providerType"] ? html`<span class="form-error">${errors["providerType"]}</span>` : nothing}

      ${selectedProvider ? this._renderProviderConfig(selectedProvider) : nothing}
    `;
  }

  private _renderProviderConfig(provider: ProviderOption) {
    const d = this._wizardData;
    const errors = this._validationErrors;

    return html`
      <div class="provider-config">
        ${provider.needsApiKey ? html`
          <div class="form-field">
            <label class="form-label">API Key</label>
            <input
              class="form-input"
              type="password"
              .value=${d.apiKey}
              placeholder="Enter your API key"
              @input=${(e: Event) => {
                this._wizardData = { ...this._wizardData, apiKey: (e.target as HTMLInputElement).value };
              }}
            />
            ${errors["apiKey"] ? html`<span class="form-error">${errors["apiKey"]}</span>` : nothing}
          </div>
        ` : nothing}

        ${provider.needsBaseUrl ? html`
          <div class="form-field">
            <label class="form-label">Base URL</label>
            <input
              class="form-input"
              type="text"
              .value=${d.baseUrl}
              placeholder=${provider.defaultBaseUrl || "https://api.example.com"}
              @input=${(e: Event) => {
                this._wizardData = { ...this._wizardData, baseUrl: (e.target as HTMLInputElement).value };
              }}
            />
            ${errors["baseUrl"] ? html`<span class="form-error">${errors["baseUrl"]}</span>` : nothing}
          </div>
        ` : nothing}

        <div class="form-field">
          <label class="form-label">Default Model</label>
          <input
            class="form-input"
            type="text"
            .value=${d.defaultModel}
            placeholder=${provider.defaultModel || "Model ID"}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, defaultModel: (e.target as HTMLInputElement).value };
            }}
          />
        </div>

        <div class="test-row">
          <button
            class="test-btn"
            ?disabled=${this._testResult.status === "testing"}
            @click=${() => this._testConnection()}
          >
            ${this._testResult.status === "testing" ? "Testing..." : "Test Connection"}
          </button>
          ${this._testResult.status === "success"
            ? html`<span class="test-success">Connected</span>`
            : nothing}
          ${this._testResult.status === "error"
            ? html`<span class="test-error">${this._testResult.message}</span>`
            : nothing}
          ${this._testResult.status === "testing"
            ? html`<span class="test-spinner">Connecting...</span>`
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderStep3() {
    const d = this._wizardData;
    const errors = this._validationErrors;

    return html`
      <div class="form-container">
        <div class="info-box">
          The agent will use the provider configured in Step 2. You can add more agents later from the Agents view.
        </div>

        <div class="form-field">
          <label class="form-label">Agent ID</label>
          <input
            class="form-input"
            type="text"
            .value=${d.agentId}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, agentId: (e.target as HTMLInputElement).value };
            }}
          />
          <span class="form-hint">Unique identifier (letters, numbers, hyphens)</span>
          ${errors["agentId"] ? html`<span class="form-error">${errors["agentId"]}</span>` : nothing}
        </div>

        <div class="form-field">
          <label class="form-label">Agent Name</label>
          <input
            class="form-input"
            type="text"
            .value=${d.agentName}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, agentName: (e.target as HTMLInputElement).value };
            }}
          />
          <span class="form-hint">Display name for the agent</span>
        </div>

        <div class="form-field">
          <label class="form-label">Model</label>
          <input
            class="form-input"
            type="text"
            .value=${d.agentModel}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, agentModel: (e.target as HTMLInputElement).value };
            }}
          />
          <span class="form-hint">LLM model ID to use</span>
        </div>

        <div class="form-field">
          <label class="form-label">Provider</label>
          <input
            class="form-input"
            type="text"
            .value=${d.agentProvider}
            readonly
          />
        </div>

        <div class="form-field">
          <label class="form-label">Max Steps</label>
          <input
            class="form-input"
            type="number"
            min="1"
            max="100"
            .value=${String(d.maxSteps)}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, maxSteps: Number((e.target as HTMLInputElement).value) || 25 };
            }}
          />
        </div>

        <div class="form-field">
          <label class="form-label">Budget Per Day (tokens)</label>
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            .value=${String(d.budgetPerDay)}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, budgetPerDay: Number((e.target as HTMLInputElement).value) || 0 };
            }}
          />
        </div>

        <div class="form-field">
          <label class="form-label">Budget Per Hour (tokens)</label>
          <input
            class="form-input"
            type="number"
            min="0"
            step="0.01"
            .value=${String(d.budgetPerHour)}
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, budgetPerHour: Number((e.target as HTMLInputElement).value) || 0 };
            }}
          />
        </div>
      </div>
    `;
  }

  private _renderStep4() {
    return html`
      <div class="info-box">
        Enable the channels you want to connect. You can configure more channels later.
      </div>
      <div class="channel-cards">
        ${CHANNEL_PLATFORMS.map((platform) => this._renderChannelCard(platform))}
      </div>
    `;
  }

  private _renderChannelCard(platform: { key: string; label: string; fields: ChannelFieldDef[] }) {
    const channel = this._wizardData.channels[platform.key];
    const isExpanded = this._expandedChannels.has(platform.key);

    return html`
      <div class="channel-card">
        <div
          class="channel-header"
          @click=${() => this._toggleExpand(platform.key)}
        >
          <ic-platform-icon platform=${platform.key} size="20px"></ic-platform-icon>
          <span class="channel-name">${platform.label}</span>
          <button
            class="channel-toggle ${channel.enabled ? "enabled" : ""}"
            aria-label="${channel.enabled ? "Disable" : "Enable"} ${platform.label}"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._toggleChannel(platform.key);
            }}
          ></button>
          <span class="channel-expand ${isExpanded ? "open" : ""}">&#9660;</span>
        </div>
        ${isExpanded ? html`
          <div class="channel-body">
            ${this._renderChannelFields(platform)}
          </div>
        ` : nothing}
      </div>
    `;
  }

  private _renderChannelFields(platform: { key: string; fields: ChannelFieldDef[] }) {
    switch (platform.key) {
      case "telegram": return this._renderTelegramFields();
      case "discord": return this._renderDiscordFields();
      case "slack": return this._renderSlackFields();
      case "whatsapp": return this._renderWhatsappFields();
      case "line": return this._renderLineFields();
      case "signal": return this._renderSignalFields();
      case "irc": return this._renderIrcFields();
      case "imessage": return this._renderImessageFields();
      default: return nothing;
    }
  }

  private _renderTelegramFields() {
    const creds = this._wizardData.channels["telegram"].credentials;
    return html`
      <div class="form-field">
        <label class="form-label">Bot Token</label>
        <input class="form-input" type="password" .value=${creds["botToken"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("telegram", "botToken", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Allowed Chat IDs</label>
        <input class="form-input" type="text" placeholder="Comma-separated IDs" .value=${creds["allowedChatIds"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("telegram", "allowedChatIds", (e.target as HTMLInputElement).value)} />
      </div>
    `;
  }

  private _renderDiscordFields() {
    const creds = this._wizardData.channels["discord"].credentials;
    return html`
      <div class="form-field">
        <label class="form-label">Bot Token</label>
        <input class="form-input" type="password" .value=${creds["botToken"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("discord", "botToken", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Guild IDs</label>
        <input class="form-input" type="text" placeholder="Comma-separated IDs" .value=${creds["guildIds"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("discord", "guildIds", (e.target as HTMLInputElement).value)} />
      </div>
    `;
  }

  private _renderSlackFields() {
    const creds = this._wizardData.channels["slack"].credentials;
    return html`
      <div class="form-field">
        <label class="form-label">Bot Token</label>
        <input class="form-input" type="password" .value=${creds["botToken"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("slack", "botToken", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">App Token</label>
        <input class="form-input" type="password" .value=${creds["appToken"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("slack", "appToken", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Signing Secret</label>
        <input class="form-input" type="password" .value=${creds["signingSecret"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("slack", "signingSecret", (e.target as HTMLInputElement).value)} />
      </div>
    `;
  }

  private _renderWhatsappFields() {
    const creds = this._wizardData.channels["whatsapp"].credentials;
    return html`
      <div class="form-field">
        <label class="form-label">Phone Number ID</label>
        <input class="form-input" type="text" .value=${creds["phoneNumberId"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("whatsapp", "phoneNumberId", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Access Token</label>
        <input class="form-input" type="password" .value=${creds["accessToken"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("whatsapp", "accessToken", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Verify Token</label>
        <input class="form-input" type="text" .value=${creds["verifyToken"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("whatsapp", "verifyToken", (e.target as HTMLInputElement).value)} />
      </div>
    `;
  }

  private _renderLineFields() {
    const creds = this._wizardData.channels["line"].credentials;
    return html`
      <div class="form-field">
        <label class="form-label">Channel Access Token</label>
        <input class="form-input" type="password" .value=${creds["channelAccessToken"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("line", "channelAccessToken", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Channel Secret</label>
        <input class="form-input" type="password" .value=${creds["channelSecret"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("line", "channelSecret", (e.target as HTMLInputElement).value)} />
      </div>
    `;
  }

  private _renderSignalFields() {
    const creds = this._wizardData.channels["signal"].credentials;
    return html`
      <div class="form-field">
        <label class="form-label">Phone Number</label>
        <input class="form-input" type="text" .value=${creds["phone"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("signal", "phone", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Signal CLI Path</label>
        <input class="form-input" type="text" .value=${creds["signalCliPath"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("signal", "signalCliPath", (e.target as HTMLInputElement).value)} />
      </div>
    `;
  }

  private _renderIrcFields() {
    const creds = this._wizardData.channels["irc"].credentials;
    return html`
      <div class="form-field">
        <label class="form-label">Server</label>
        <input class="form-input" type="text" .value=${creds["server"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("irc", "server", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Port</label>
        <input class="form-input" type="number" .value=${creds["port"] ?? "6667"}
          @input=${(e: Event) => this._updateChannelCredential("irc", "port", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Nickname</label>
        <input class="form-input" type="text" .value=${creds["nick"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("irc", "nick", (e.target as HTMLInputElement).value)} />
      </div>
      <div class="form-field">
        <label class="form-label">Channels</label>
        <input class="form-input" type="text" placeholder="Comma-separated, e.g. #general,#dev" .value=${creds["channels"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("irc", "channels", (e.target as HTMLInputElement).value)} />
      </div>
    `;
  }

  private _renderImessageFields() {
    const creds = this._wizardData.channels["imessage"].credentials;
    return html`
      <div class="form-field">
        <label class="form-label">AppleScript Path</label>
        <input class="form-input" type="text" placeholder="Requires macOS with Messages app" .value=${creds["applescriptPath"] ?? ""}
          @input=${(e: Event) => this._updateChannelCredential("imessage", "applescriptPath", (e.target as HTMLInputElement).value)} />
      </div>
    `;
  }

  private _renderStep5() {
    return html`
      <div class="yaml-preview">${this._yamlPreview}</div>
      <div class="review-actions">
        <button class="btn btn-secondary" @click=${() => this._copyYaml()}>Copy</button>
        <button class="btn btn-secondary" @click=${() => this._downloadYaml()}>Download</button>
        <button class="btn btn-primary" ?disabled=${this._applying} @click=${() => this._applyConfig()}>
          ${this._applying ? "Applying..." : "Apply"}
        </button>
      </div>
      ${this._applyStatus ? html`<div class="apply-status">${this._applyStatus}</div>` : nothing}
      ${this._applyDone ? html`
        <div class="dashboard-link">
          <a @click=${(e: Event) => { e.preventDefault(); this._goToDashboard(); }}>Go to Dashboard</a>
        </div>
      ` : nothing}
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  Step progress bar                                                */
  /* ---------------------------------------------------------------- */

  private _renderStepBar() {
    return html`
      <div class="step-bar" role="navigation" aria-label="Setup wizard progress">
        ${STEPS.map((step, i) => {
          const isCompleted = i < this._currentStep;
          const isCurrent = i === this._currentStep;
          const circleClass = isCompleted ? "completed" : isCurrent ? "current" : "";
          const labelClass = isCompleted ? "completed" : isCurrent ? "current" : "";

          return html`
            ${i > 0 ? html`<div class="step-line ${i <= this._currentStep ? "completed" : ""}"></div>` : nothing}
            <div class="step-item">
              <div class="step-circle ${circleClass}" aria-label="Step ${i + 1}: ${step.label}">
                ${isCompleted ? html`&#10003;` : html`${i + 1}`}
              </div>
              <span class="step-label ${labelClass}">${step.label}</span>
            </div>
          `;
        })}
      </div>
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  Main render                                                       */
  /* ---------------------------------------------------------------- */

  override render() {
    return html`
      <div class="wizard-header">
        <div class="wizard-title">Setup Wizard</div>
        <div class="wizard-subtitle">Configure your Comis installation step by step</div>
      </div>

      ${this._renderStepBar()}

      <div class="step-content">
        ${this._currentStep === 0 ? this._renderStep1() : nothing}
        ${this._currentStep === 1 ? this._renderStep2() : nothing}
        ${this._currentStep === 2 ? this._renderStep3() : nothing}
        ${this._currentStep === 3 ? this._renderStep4() : nothing}
        ${this._currentStep === 4 ? this._renderStep5() : nothing}
      </div>

      <div class="nav-bar">
        ${this._currentStep > 0
          ? html`<button class="btn btn-secondary" @click=${() => this._goBack()}>Back</button>`
          : html`<div class="nav-spacer"></div>`}
        ${this._currentStep < 4
          ? html`<button class="btn btn-primary" @click=${() => this._goNext()}>
              ${this._currentStep === 3 ? "Review" : "Next"}
            </button>`
          : html`<div class="nav-spacer"></div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-setup-wizard": IcSetupWizard;
  }
}

export type { WizardData, ChannelSetup };
