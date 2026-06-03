// SPDX-License-Identifier: Apache-2.0
/**
 * Setup-wizard controller.
 *
 * Owns state + RPC orchestration for the multi-step setup wizard.
 * Lifecycle attaches via `host.addController(controller)`; view consumes
 * the frozen snapshot via `controller.getSnapshot()`.
 *
 * @module
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { RpcClient } from "../api/rpc-client.js";
import { IcToast } from "../components/feedback/ic-toast.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ChannelSetup {
  enabled: boolean;
  credentials: Record<string, string>;
}

export interface WizardData {
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

export interface TestResult {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
}

interface ChannelFieldDef {
  key: string;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
  defaultValue?: string;
}

export interface ChannelPlatform {
  key: string;
  label: string;
  fields: ChannelFieldDef[];
}

interface StepDef {
  label: string;
  icon: string;
}

/**
 * UX-only metadata per provider key. Provider names + model lists come from
 * the live pi-ai catalog via `models.list_providers` / `models.list` RPC.
 */
export interface ProviderUiHint {
  displayName: string;
  description: string;
  signupUrl?: string;
  needsApiKey: boolean;
  needsBaseUrl: boolean;
  defaultBaseUrl?: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const STEPS: StepDef[] = [
  { label: "Basics", icon: "settings" },
  { label: "Provider", icon: "server" },
  { label: "Agent", icon: "agent" },
  { label: "Channels", icon: "channel" },
  { label: "Review", icon: "check" },
];

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

export const CUSTOM_PROVIDER_KEY = "__custom__";

export const CUSTOM_PROVIDER_HINT: ProviderUiHint = {
  displayName: "Custom",
  description: "Any OpenAI-compatible API endpoint",
  needsApiKey: false,
  needsBaseUrl: true,
};

export function getProviderHint(key: string): ProviderUiHint {
  // Object.hasOwn gates the bracket lookup; the only attacker-controllable
  // surface here is a provider key that originated from `models.list_providers`
  // RPC (admin-scoped), and the value is a UX-only hint object with no
  // dangerous fields.
  // eslint-disable-next-line security/detect-object-injection -- gated by Object.hasOwn against literal record
  if (Object.hasOwn(PROVIDER_UI_HINTS, key)) return PROVIDER_UI_HINTS[key]!;
  return {
    displayName: key.charAt(0).toUpperCase() + key.slice(1),
    description: "",
    needsApiKey: true,
    needsBaseUrl: false,
  };
}

export const CHANNEL_PLATFORMS: ChannelPlatform[] = [
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

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"];

/* ------------------------------------------------------------------ */
/*  YAML serializer (lightweight inline)                               */
/* ------------------------------------------------------------------ */

function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return `${pad}~\n`;
  if (typeof obj === "string") {
    // YAML 1.2 plain-scalar safe set: quote if the string contains any
    // YAML indicator character anywhere, or has leading/trailing
    // whitespace. The indicator set is: : # [ ] { } , & * ! | > ' " @ `
    // plus ? % ~. Matches the broader regex in
    // `packages/web/src/utils/to-yaml.ts:50`.
    if (obj === "" || /[:#[\]{},&*!?%~|>'"@`]/.test(obj) || /^\s|\s$/.test(obj)) {
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

export function createDefaultWizardData(): WizardData {
  const channels: Record<string, ChannelSetup> = {};
  for (const p of CHANNEL_PLATFORMS) {
    channels[p.key] = { enabled: false, credentials: {} };
  }
  return {
    tenantId: "default",
    dataDir: "~/.comis",
    logLevel: "debug",
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
/*  Snapshot + Controller interfaces                                   */
/* ------------------------------------------------------------------ */

export interface SetupWizardSnapshot {
  readonly currentStep: number;
  readonly wizardData: WizardData;
  readonly testResult: TestResult;
  readonly expandedChannels: ReadonlySet<string>;
  readonly yamlPreview: string;
  readonly applying: boolean;
  readonly applyStatus: string;
  readonly applyDone: boolean;
  readonly validationErrors: Readonly<Record<string, string>>;
  readonly catalogProviders: ReadonlyArray<string>;
  readonly catalogProvidersLoading: boolean;
  readonly catalogProvidersError: string | undefined;
  readonly modelOptions: ReadonlyArray<{ id: string; cost: number }>;
  readonly modelOptionsLoading: boolean;
  readonly modelOptionsError: string | undefined;
}

export interface SetupWizardController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  getSnapshot(): SetupWizardSnapshot;
  // Async actions
  loadCatalogProviders(): Promise<void>;
  loadModelOptions(provider: string): Promise<void>;
  testConnection(): Promise<void>;
  applyConfig(): Promise<void>;
  // Navigation
  goNext(): void;
  goBack(): void;
  setCurrentStep(step: number): void;
  // Selection / mutation
  selectProvider(key: string): void;
  toggleChannel(platform: string): void;
  toggleExpand(platform: string): void;
  updateChannelCredential(platform: string, key: string, value: string): void;
  updateWizardData(partial: Partial<WizardData>): void;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createSetupWizardController(
  host: ReactiveControllerHost,
  rpcClient: RpcClient,
): SetupWizardController {
  let state: SetupWizardSnapshot = Object.freeze({
    currentStep: 0,
    wizardData: createDefaultWizardData(),
    testResult: { status: "idle" } as TestResult,
    expandedChannels: new Set<string>(),
    yamlPreview: "",
    applying: false,
    applyStatus: "",
    applyDone: false,
    validationErrors: {},
    catalogProviders: [],
    catalogProvidersLoading: false,
    catalogProvidersError: undefined,
    modelOptions: [],
    modelOptionsLoading: false,
    modelOptionsError: undefined,
  });

  function _mutate(partial: Partial<SetupWizardSnapshot>): void {
    state = Object.freeze({ ...state, ...partial });
    host.requestUpdate();
  }

  /* ------------------ Validation ------------------ */

  function _validateStep(step: number): boolean {
    const d = state.wizardData;
    const errors: Record<string, string> = {};

    switch (step) {
      case 0: // Basics
        if (!d.tenantId.trim()) {
          errors["tenantId"] = "Tenant ID is required";
        }
        break;
      case 1: { // Provider
        if (!d.providerName) {
          errors["providerType"] = "Please select a provider";
        }
        const isCustom = d.providerName === CUSTOM_PROVIDER_KEY;
        const hint = isCustom ? CUSTOM_PROVIDER_HINT : getProviderHint(d.providerName);
        if (hint.needsApiKey && !d.apiKey.trim()) {
          errors["apiKey"] = "API key is required for this provider";
        }
        if (hint.needsBaseUrl && !d.baseUrl.trim()) {
          errors["baseUrl"] = "Base URL is required for this provider";
        }
        if (!isCustom && d.providerName && !d.defaultModel.trim()) {
          errors["defaultModel"] = "Please select a model for this provider";
        }
        break;
      }
      case 2: // Agent
        if (!d.agentId.trim()) {
          errors["agentId"] = "Agent ID is required";
        }
        break;
      case 3: // Channels - no validation
        break;
    }

    _mutate({ validationErrors: errors });
    return Object.keys(errors).length === 0;
  }

  /* ------------------ YAML generation ------------------ */

  function _generateYaml(): void {
    const d = state.wizardData;
    const config: Record<string, unknown> = {};

    if (d.tenantId && d.tenantId !== "default") config["tenantId"] = d.tenantId;
    config["logLevel"] = d.logLevel;
    config["dataDir"] = d.dataDir;

    config["gateway"] = {
      enabled: true,
      host: d.gatewayHost,
      port: d.gatewayPort,
    };

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

    const channelEntries: Record<string, unknown> = {};
    for (const [key, ch] of Object.entries(d.channels)) {
      if (!ch.enabled) continue;
      const entry: Record<string, unknown> = { enabled: true };
      for (const [credKey, credVal] of Object.entries(ch.credentials)) {
        if (!credVal) continue;
        if (credKey === "allowedChatIds") {
          entry["allowFrom"] = credVal.split(",").map((s: string) => s.trim()).filter(Boolean);
        } else {
          // eslint-disable-next-line security/detect-object-injection -- credKey iterated from trusted local object
          entry[credKey] = credVal;
        }
      }
      // eslint-disable-next-line security/detect-object-injection -- key iterated from trusted local object
      channelEntries[key] = entry;
    }
    if (Object.keys(channelEntries).length > 0) {
      config["channels"] = channelEntries;
    }

    _mutate({ yamlPreview: toYaml(config) });
  }

  /* ------------------ Public controller ------------------ */

  // Track the rpcClient.onStatusChange unsubscribe handle so we can clean
  // up if the host disconnects before the initial provider load fires.
  let _rpcStatusUnsub: (() => void) | null = null;

  const controller: SetupWizardController = {
    hostConnected(): void {
      // Defer loadCatalogProviders until rpcClient is actually connected --
      // hostConnected fires synchronously when the view mounts, but the
      // WebSocket may still be in CONNECTING state (app-controller
      // _completeInit() calls rpcClient.connect() milliseconds earlier).
      // Calling models.list_providers pre-OPEN surfaces a Retry placeholder
      // on first paint. Matches the skills-controller.tryLoad() pattern.
      if (rpcClient.status === "connected") {
        void controller.loadCatalogProviders();
      } else {
        _rpcStatusUnsub = rpcClient.onStatusChange((status) => {
          if (status === "connected") {
            void controller.loadCatalogProviders();
            _rpcStatusUnsub?.();
            _rpcStatusUnsub = null;
          }
        });
      }
    },

    hostDisconnected(): void {
      _rpcStatusUnsub?.();
      _rpcStatusUnsub = null;
    },

    getSnapshot(): SetupWizardSnapshot {
      return state;
    },

    async loadCatalogProviders(): Promise<void> {
      _mutate({ catalogProvidersLoading: true, catalogProvidersError: undefined });
      try {
        const result = await rpcClient.call("models.list_providers", {}) as
          { providers?: string[]; count?: number };
        _mutate({
          catalogProviders: result.providers ?? [],
          catalogProvidersLoading: false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        _mutate({
          catalogProvidersError: msg,
          catalogProviders: [],
          catalogProvidersLoading: false,
        });
      }
    },

    async loadModelOptions(provider: string): Promise<void> {
      _mutate({
        modelOptionsLoading: true,
        modelOptionsError: undefined,
        modelOptions: [],
      });
      try {
        const result = await rpcClient.call("models.list", { provider }) as {
          models?: Array<{
            modelId?: string;
            id?: string;
            cost?: { input?: number; output?: number };
          }>;
        };
        const raw = result.models ?? [];
        const options = raw.map((m) => ({
          id: (m.modelId ?? m.id ?? "").trim(),
          cost: (m.cost?.input ?? 0) + (m.cost?.output ?? 0),
        })).filter((m) => m.id.length > 0);
        options.sort((a, b) => a.cost - b.cost);
        _mutate({ modelOptions: options, modelOptionsLoading: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        _mutate({ modelOptionsError: msg, modelOptionsLoading: false });
      }
    },

    async testConnection(): Promise<void> {
      _mutate({ testResult: { status: "testing" } });
      try {
        // models.test takes the provider-client type ("anthropic" /
        // "openai" / "google" / etc.) so the daemon knows which SDK to
        // instantiate when probing the credentials. For native providers
        // providerType === providerName; for the Custom path
        // (providerName === CUSTOM_PROVIDER_KEY === "__custom__"),
        // providerType resolves to "openai" because Custom is an
        // OpenAI-compatible endpoint. applyConfig (below) uses
        // providerName instead because models.defaultProvider config
        // wants the user-facing provider key, which IS "__custom__"
        // for the Custom path.
        await rpcClient.call("models.test", { provider: state.wizardData.providerType });
        _mutate({ testResult: { status: "success", message: "Connected" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Connection failed";
        _mutate({ testResult: { status: "error", message: msg } });
      }
    },

    async applyConfig(): Promise<void> {
      if (state.applying) return;

      _mutate({ applying: true, applyDone: false });

      const d = state.wizardData;

      // Sections that can be applied at runtime via config.apply.
      const sections: { label: string; section: string; value: unknown }[] = [];

      if (d.providerName && d.defaultModel) {
        sections.push({
          label: "models",
          section: "models",
          value: { defaultProvider: d.providerName, defaultModel: d.defaultModel },
        });
      }

      // Immutable sections require config file + restart.
      const immutableSections: string[] = [];
      immutableSections.push("agents");
      immutableSections.push("gateway");
      if (d.providerName) immutableSections.push("providers");
      const hasChannels = Object.values(d.channels).some((ch) => ch.enabled);
      if (hasChannels) immutableSections.push("channels");

      let appliedCount = 0;
      for (const s of sections) {
        _mutate({ applyStatus: `Applying ${s.label}...` });
        try {
          await rpcClient.call("config.apply", { section: s.section, value: s.value });
          appliedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to apply configuration";
          IcToast.show(`${s.label}: ${msg}`, "error");
        }
      }

      _mutate({ applying: false, applyStatus: "", applyDone: true });

      if (immutableSections.length > 0) {
        IcToast.show(
          `Applied ${appliedCount} section(s). ${immutableSections.join(", ")} require saving the config file and restarting the daemon. Use Copy or Download to get the full config.`,
          "info",
        );
      } else {
        IcToast.show("Configuration applied! Restart the daemon to activate.", "success");
      }
    },

    goNext(): void {
      if (!_validateStep(state.currentStep)) return;

      if (state.currentStep === 3) {
        _generateYaml();
      }

      // Pre-fill agent fields from provider step when advancing.
      if (state.currentStep === 1) {
        if (!state.wizardData.agentModel) {
          _mutate({
            wizardData: {
              ...state.wizardData,
              agentModel: state.wizardData.defaultModel,
              agentProvider: state.wizardData.providerName,
            },
          });
        }
      }

      _mutate({
        currentStep: Math.min(state.currentStep + 1, STEPS.length - 1),
        validationErrors: {},
      });
    },

    goBack(): void {
      _mutate({
        currentStep: Math.max(state.currentStep - 1, 0),
        validationErrors: {},
      });
    },

    setCurrentStep(step: number): void {
      const clamped = Math.max(0, Math.min(step, STEPS.length - 1));
      _mutate({ currentStep: clamped, validationErrors: {} });
    },

    selectProvider(key: string): void {
      const isCustom = key === CUSTOM_PROVIDER_KEY;
      const hint = isCustom ? CUSTOM_PROVIDER_HINT : getProviderHint(key);
      _mutate({
        wizardData: {
          ...state.wizardData,
          providerName: key,
          // Custom providers stay as `type: "openai"` (passthrough);
          // native providers send `type: <key>`.
          providerType: isCustom ? "openai" : key,
          apiKey: "",
          baseUrl: hint.defaultBaseUrl ?? "",
          defaultModel: "", // user picks from the live model dropdown
        },
        testResult: { status: "idle" },
        validationErrors: {},
        modelOptions: [],
        modelOptionsError: undefined,
      });

      // Native providers fetch their models from the catalog; Custom does not.
      if (!isCustom) {
        void controller.loadModelOptions(key);
      }
    },

    toggleChannel(platform: string): void {
      // Object.hasOwn gates lookup; platform key comes from the trusted
      // CHANNEL_PLATFORMS constant defined above.
      if (!Object.hasOwn(state.wizardData.channels, platform)) return;
      // eslint-disable-next-line security/detect-object-injection -- gated by Object.hasOwn against literal record
      const current = state.wizardData.channels[platform]!;
      const updatedChannels = {
        ...state.wizardData.channels,
        [platform]: { ...current, enabled: !current.enabled },
      };
      // Auto-expand when enabling.
      const nextExpanded: ReadonlySet<string> = current.enabled
        ? state.expandedChannels
        : new Set([...state.expandedChannels, platform]);
      _mutate({
        wizardData: { ...state.wizardData, channels: updatedChannels },
        expandedChannels: nextExpanded,
      });
    },

    toggleExpand(platform: string): void {
      const expanded = new Set(state.expandedChannels);
      if (expanded.has(platform)) {
        expanded.delete(platform);
      } else {
        expanded.add(platform);
      }
      _mutate({ expandedChannels: expanded });
    },

    updateChannelCredential(platform: string, key: string, value: string): void {
      if (!Object.hasOwn(state.wizardData.channels, platform)) return;
      // eslint-disable-next-line security/detect-object-injection -- gated by Object.hasOwn against literal record
      const current = state.wizardData.channels[platform]!;
      const updatedCredentials = { ...current.credentials, [key]: value };
      const updatedChannels = {
        ...state.wizardData.channels,
        [platform]: { ...current, credentials: updatedCredentials },
      };
      _mutate({ wizardData: { ...state.wizardData, channels: updatedChannels } });
    },

    updateWizardData(partial: Partial<WizardData>): void {
      _mutate({ wizardData: { ...state.wizardData, ...partial } });
    },
  };

  host.addController(controller);
  return controller;
}
