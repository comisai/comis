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

/**
 * UX-only metadata per provider key. Provider names + model lists come from
 * the live pi-ai catalog via `models.list_providers` / `models.list` RPC.
 * Keys present in the catalog but missing from this map render with sensible
 * defaults (capitalized name, generic description, needsApiKey=true,
 * needsBaseUrl=false). See PROVIDER_UI_HINTS below.
 */
interface ProviderUiHint {
  displayName: string;
  description: string;
  signupUrl?: string;
  needsApiKey: boolean;
  needsBaseUrl: boolean;
  defaultBaseUrl?: string;
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

/**
 * UX-only metadata per provider key. The list of provider keys to render
 * comes from the LIVE pi-ai catalog at runtime via `models.list_providers`.
 * Catalog providers without a hint here render with sensible defaults
 * (capitalized name, generic description, needsApiKey=true, needsBaseUrl=false)
 * computed by `getProviderHint`. The Custom path is a synthetic key
 * (`CUSTOM_PROVIDER_KEY`) appended after catalog providers for OpenAI-
 * compatible custom proxies that aren't in the catalog.
 *
 * Phase 3A (260501-07g): replaced the static `PROVIDERS` array (and its
 * hardcoded `defaultModel` per entry) with this UX-only hints map. Models
 * are populated dynamically from `models.list provider:<name>`.
 */
const PROVIDER_UI_HINTS: Record<string, ProviderUiHint> = {
  anthropic: {
    displayName: "Anthropic",
    description: "Claude models, recommended for agents",
    signupUrl: "https://console.anthropic.com/settings/keys",
    needsApiKey: true,
    needsBaseUrl: false,
  },
  openai: {
    displayName: "OpenAI",
    description: "GPT-4o, o1, o3 models",
    signupUrl: "https://platform.openai.com/api-keys",
    needsApiKey: true,
    needsBaseUrl: false,
  },
  google: {
    displayName: "Google",
    description: "Gemini models",
    signupUrl: "https://aistudio.google.com/app/apikey",
    needsApiKey: true,
    needsBaseUrl: false,
  },
  groq: {
    displayName: "Groq",
    description: "Fast inference",
    signupUrl: "https://console.groq.com/keys",
    needsApiKey: true,
    needsBaseUrl: false,
  },
  mistral: {
    displayName: "Mistral",
    description: "Mistral models",
    signupUrl: "https://console.mistral.ai/api-keys/",
    needsApiKey: true,
    needsBaseUrl: false,
  },
  cerebras: {
    displayName: "Cerebras",
    description: "Fast inference",
    signupUrl: "https://cloud.cerebras.ai/",
    needsApiKey: true,
    needsBaseUrl: false,
  },
  xai: {
    displayName: "xAI",
    description: "Grok models",
    signupUrl: "https://console.x.ai/",
    needsApiKey: true,
    needsBaseUrl: false,
  },
  openrouter: {
    displayName: "OpenRouter",
    description: "Multi-provider routing",
    signupUrl: "https://openrouter.ai/keys",
    needsApiKey: true,
    needsBaseUrl: false,
  },
};

/** Synthetic key the wizard renders separately for OpenAI-compatible custom proxies. */
const CUSTOM_PROVIDER_KEY = "__custom__";

/** UX hint for the synthetic Custom path. */
const CUSTOM_PROVIDER_HINT: ProviderUiHint = {
  displayName: "Custom",
  description: "Any OpenAI-compatible API endpoint",
  needsApiKey: false,
  needsBaseUrl: true,
};

/**
 * Resolve the UX hint for a provider key. Returns the static hint when
 * present, otherwise computes a reasonable default (capitalized display
 * name, generic description, expects an API key). Catalog providers added
 * by future pi-ai upgrades render via this fallback path with no comis
 * code change.
 */
function getProviderHint(key: string): ProviderUiHint {
  // Object.hasOwn gates the bracket lookup; the only attacker-controllable
  // surface here is a provider key that originated from `models.list_providers`
  // RPC (admin-scoped), and the value is a UX-only hint object with no
  // dangerous fields. Suppressed warning is acceptable.
  // eslint-disable-next-line security/detect-object-injection -- gated by Object.hasOwn against literal record
  if (Object.hasOwn(PROVIDER_UI_HINTS, key)) return PROVIDER_UI_HINTS[key]!;
  return {
    displayName: key.charAt(0).toUpperCase() + key.slice(1),
    description: "",
    needsApiKey: true,
    needsBaseUrl: false,
  };
}

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

  // Layer 3A (260501-07g): live provider catalog state.
  // _catalogProviders is fetched via `models.list_providers` on first mount.
  // _modelOptions is fetched per-provider via `models.list provider:<name>`.
  @state() private _catalogProviders: string[] = [];
  @state() private _catalogProvidersLoading = false;
  @state() private _catalogProvidersError: string | undefined;
  @state() private _modelOptions: Array<{ id: string; cost: number }> = [];
  @state() private _modelOptionsLoading = false;
  @state() private _modelOptionsError: string | undefined;

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  override connectedCallback(): void {
    super.connectedCallback();
    // Fire-and-forget; _loadCatalogProviders sets its own loading/error state.
    void this._loadCatalogProviders();
  }

  /* ---------------------------------------------------------------- */
  /*  Catalog fetching                                                 */
  /* ---------------------------------------------------------------- */

  private async _loadCatalogProviders(): Promise<void> {
    if (!this.rpcClient) {
      // No RPC client wired -- treat as a recoverable error so the user
      // can retry once the client connects.
      this._catalogProviders = [];
      this._catalogProvidersError = "RPC client not connected";
      return;
    }
    this._catalogProvidersLoading = true;
    this._catalogProvidersError = undefined;
    try {
      const result = await this.rpcClient.call("models.list_providers", {}) as
        { providers?: string[]; count?: number };
      this._catalogProviders = result.providers ?? [];
    } catch (err) {
      this._catalogProvidersError = err instanceof Error ? err.message : String(err);
      this._catalogProviders = [];
    } finally {
      this._catalogProvidersLoading = false;
    }
  }

  private async _loadModelOptions(provider: string): Promise<void> {
    if (!this.rpcClient) {
      this._modelOptions = [];
      this._modelOptionsError = "RPC client not connected";
      return;
    }
    this._modelOptionsLoading = true;
    this._modelOptionsError = undefined;
    this._modelOptions = [];
    try {
      const result = await this.rpcClient.call("models.list", { provider }) as {
        models?: Array<{
          modelId?: string;
          id?: string;
          cost?: { input?: number; output?: number };
        }>;
      };
      const raw = result.models ?? [];
      // The gateway returns either `id` or `modelId` depending on the path
      // (catalog vs. registered providers); normalize both shapes.
      const options = raw.map((m) => ({
        id: (m.modelId ?? m.id ?? "").trim(),
        cost: (m.cost?.input ?? 0) + (m.cost?.output ?? 0),
      })).filter((m) => m.id.length > 0);
      // Sort by total cost ascending so cheapest options surface first.
      options.sort((a, b) => a.cost - b.cost);
      this._modelOptions = options;
    } catch (err) {
      this._modelOptionsError = err instanceof Error ? err.message : String(err);
    } finally {
      this._modelOptionsLoading = false;
    }
  }

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
        if (!this._wizardData.providerName) {
          errors["providerType"] = "Please select a provider";
        }
        const isCustom = this._wizardData.providerName === CUSTOM_PROVIDER_KEY;
        const hint = isCustom ? CUSTOM_PROVIDER_HINT : getProviderHint(this._wizardData.providerName);
        if (hint.needsApiKey && !this._wizardData.apiKey.trim()) {
          errors["apiKey"] = "API key is required for this provider";
        }
        if (hint.needsBaseUrl && !this._wizardData.baseUrl.trim()) {
          errors["baseUrl"] = "Base URL is required for this provider";
        }
        // Native providers must pick a model from the live dropdown;
        // Custom providers fall back to a free-text input.
        if (!isCustom && this._wizardData.providerName && !this._wizardData.defaultModel.trim()) {
          errors["defaultModel"] = "Please select a model for this provider";
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

  private _selectProvider(key: string): void {
    const isCustom = key === CUSTOM_PROVIDER_KEY;
    const hint = isCustom ? CUSTOM_PROVIDER_HINT : getProviderHint(key);
    this._wizardData = {
      ...this._wizardData,
      providerName: key,
      // Custom providers stay as `type: "openai"` (passthrough);
      // native providers send `type: <key>` and Phase 1's auto-promote
      // handler echoes the native type back -- no special-casing here.
      providerType: isCustom ? "openai" : key,
      apiKey: "",
      baseUrl: hint.defaultBaseUrl ?? "",
      defaultModel: "", // user picks from the live model dropdown
    };
    this._testResult = { status: "idle" };
    this._validationErrors = {};
    this._modelOptions = [];
    this._modelOptionsError = undefined;

    // Native providers fetch their models from the catalog; Custom does not.
    if (!isCustom) {
      void this._loadModelOptions(key);
    }
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

    // Render the catalog grid based on _catalogProviders state.
    // Loading + error states surface inside the .provider-grid slot so the
    // step layout stays stable regardless of fetch outcome.
    let grid;
    if (this._catalogProvidersLoading) {
      grid = html`<div class="provider-grid-loading">Loading providers from catalog...</div>`;
    } else if (this._catalogProvidersError) {
      grid = html`
        <div class="provider-grid-error">
          <span class="form-error">Failed to load provider catalog: ${this._catalogProvidersError}</span>
          <button class="test-btn" @click=${() => { void this._loadCatalogProviders(); }}>Retry</button>
        </div>
      `;
    } else {
      // Live catalog providers + synthetic Custom path appended at the end.
      const providerKeys = [...this._catalogProviders, CUSTOM_PROVIDER_KEY];
      grid = html`
        <div class="provider-grid">
          ${providerKeys.map((key) => {
            const hint = key === CUSTOM_PROVIDER_KEY ? CUSTOM_PROVIDER_HINT : getProviderHint(key);
            return html`
              <div
                class="provider-card ${d.providerName === key ? "active" : ""}"
                role="button"
                tabindex="0"
                aria-pressed=${d.providerName === key ? "true" : "false"}
                @click=${() => this._selectProvider(key)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    this._selectProvider(key);
                  }
                }}
              >
                <div class="provider-card-name">${hint.displayName}</div>
                <div class="provider-card-desc">${hint.description}</div>
              </div>
            `;
          })}
        </div>
      `;
    }

    return html`
      ${grid}
      ${errors["providerType"] ? html`<span class="form-error">${errors["providerType"]}</span>` : nothing}

      ${d.providerName ? this._renderProviderConfig(d.providerName) : nothing}
    `;
  }

  private _renderProviderConfig(providerKey: string) {
    const d = this._wizardData;
    const errors = this._validationErrors;
    const isCustom = providerKey === CUSTOM_PROVIDER_KEY;
    const hint = isCustom ? CUSTOM_PROVIDER_HINT : getProviderHint(providerKey);

    return html`
      <div class="provider-config">
        ${hint.needsApiKey ? html`
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

        ${hint.needsBaseUrl ? html`
          <div class="form-field">
            <label class="form-label">Base URL</label>
            <input
              class="form-input"
              type="text"
              .value=${d.baseUrl}
              placeholder=${hint.defaultBaseUrl || "https://api.example.com"}
              @input=${(e: Event) => {
                this._wizardData = { ...this._wizardData, baseUrl: (e.target as HTMLInputElement).value };
              }}
            />
            ${errors["baseUrl"] ? html`<span class="form-error">${errors["baseUrl"]}</span>` : nothing}
          </div>
        ` : nothing}

        ${this._renderModelField(isCustom)}

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

  /**
   * Render the model selector. Custom providers fall back to a free-text
   * input (their model IDs aren't in pi-ai's catalog). Native providers
   * render a dropdown populated from `_modelOptions` (already sorted by
   * total cost ascending). Loading + error states render their own slots.
   */
  private _renderModelField(isCustom: boolean) {
    const d = this._wizardData;
    const errors = this._validationErrors;

    if (isCustom) {
      return html`
        <div class="form-field">
          <label class="form-label">Model ID</label>
          <input
            class="form-input"
            type="text"
            .value=${d.defaultModel}
            placeholder="e.g., qwen/qwen3-coder"
            @input=${(e: Event) => {
              this._wizardData = { ...this._wizardData, defaultModel: (e.target as HTMLInputElement).value };
            }}
          />
        </div>
      `;
    }

    if (this._modelOptionsLoading) {
      return html`
        <div class="form-field">
          <label class="form-label">Model</label>
          <span class="test-spinner">Loading models from ${d.providerName}...</span>
        </div>
      `;
    }

    if (this._modelOptionsError) {
      return html`
        <div class="form-field">
          <label class="form-label">Model</label>
          <span class="form-error">Failed to load models: ${this._modelOptionsError}</span>
          <button class="test-btn" @click=${() => { void this._loadModelOptions(d.providerName); }}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="form-field">
        <label class="form-label">Model</label>
        <select
          class="form-select"
          @change=${(e: Event) => {
            this._wizardData = { ...this._wizardData, defaultModel: (e.target as HTMLSelectElement).value };
          }}
        >
          <option value="" ?selected=${!d.defaultModel}>— select a model —</option>
          ${this._modelOptions.map((m) => html`
            <option value=${m.id} ?selected=${m.id === d.defaultModel}>
              ${m.id}${m.cost > 0 ? ` ($${m.cost.toFixed(2)}/1M)` : " (free)"}
            </option>
          `)}
        </select>
        ${errors["defaultModel"] ? html`<span class="form-error">${errors["defaultModel"]}</span>` : nothing}
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
