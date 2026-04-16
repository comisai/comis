import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { DeliveryQueueStatus, PlatformCapabilities } from "../api/types/index.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import { getHealthVisual } from "../utils/health-status.js";
import { IcToast } from "../components/feedback/ic-toast.js";

// Side-effect registrations for sub-components
import "../components/nav/ic-breadcrumb.js";
import "../components/nav/ic-tabs.js";
import "../components/display/ic-icon.js";
import "../components/display/ic-connection-dot.js";
import "../components/data/ic-relative-time.js";
import "../components/data/ic-tag.js";
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";

/** Field definition for platform-specific config rendering. */
interface FieldDef {
  key: string;
  label: string;
  type: "text" | "secret" | "toggle" | "select" | "list";
  options?: string[];
  placeholder?: string;
}

/** Delivery trace entry from obs.delivery.recent RPC. */
interface DeliveryTraceEntry {
  messageId?: string;
  latencyMs: number;
  timestamp?: number;
  deliveredAt?: number;
  status?: string;
  success?: boolean;
}

/** Media processing toggle definitions. */
const MEDIA_PROCESSING_FIELDS: Array<{ key: string; label: string; description: string }> = [
  { key: "transcribeAudio", label: "Voice Transcription", description: "Transcribe inbound audio/voice attachments to text (STT)" },
  { key: "analyzeImages", label: "Image Analysis", description: "Analyze inbound images using vision AI" },
  { key: "describeVideos", label: "Video Description", description: "Generate text descriptions of inbound video attachments" },
  { key: "extractDocuments", label: "Document Extraction", description: "Extract text from PDF, CSV, and other document attachments" },
  { key: "understandLinks", label: "Link Understanding", description: "Fetch and inject content from URLs in message text" },
];

/** Platform-specific field definitions for all 8 supported platforms. */
const PLATFORM_FIELDS: Record<string, FieldDef[]> = {
  telegram: [
    { key: "botToken", label: "Bot Token", type: "secret" },
    { key: "webhookUrl", label: "Webhook URL", type: "text", placeholder: "https://..." },
    { key: "ackReaction.enabled", label: "Ack Reaction", type: "toggle" },
    { key: "ackReaction.emoji", label: "Ack Emoji", type: "text", placeholder: "\u{1F440}" },
  ],
  discord: [
    { key: "botToken", label: "Bot Token", type: "secret" },
    { key: "guildId", label: "Guild ID", type: "text" },
  ],
  slack: [
    { key: "botToken", label: "Bot Token", type: "secret" },
    { key: "appToken", label: "App Token", type: "secret" },
    { key: "signingSecret", label: "Signing Secret", type: "secret" },
    { key: "mode", label: "Mode", type: "select", options: ["socket", "http"] },
  ],
  whatsapp: [
    { key: "authDir", label: "Auth Directory", type: "text" },
    { key: "printQR", label: "Print QR Code", type: "toggle" },
  ],
  line: [
    { key: "channelSecret", label: "Channel Secret", type: "secret" },
    { key: "webhookPath", label: "Webhook Path", type: "text", placeholder: "/webhooks/line" },
  ],
  signal: [
    { key: "baseUrl", label: "Base URL", type: "text", placeholder: "http://127.0.0.1:8080" },
    { key: "account", label: "Account", type: "text" },
    { key: "cliPath", label: "CLI Path", type: "text" },
  ],
  irc: [
    { key: "host", label: "Host", type: "text" },
    { key: "port", label: "Port", type: "text" },
    { key: "nick", label: "Nick", type: "text" },
    { key: "tls", label: "TLS", type: "toggle" },
    { key: "nickservPassword", label: "NickServ Password", type: "secret" },
    { key: "channels", label: "Channels", type: "list" },
  ],
  imessage: [
    { key: "binaryPath", label: "Binary Path", type: "text" },
    { key: "account", label: "Account", type: "text" },
  ],
};

/** Capitalize first letter of a string. */
function capitalize(str: string): string {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Resolve a nested config value using a dot-separated key path.
 * e.g., resolveConfigValue(config, "ackReaction.enabled") -> config.ackReaction?.enabled
 */
function resolveConfigValue(config: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split(".").reduce<unknown>(
    (obj, k) => (obj != null && typeof obj === "object" ? (obj as Record<string, unknown>)[k] : undefined),
    config,
  );
}

/**
 * Channel detail view for the Comis operator console.
 *
 * Displays platform-specific configuration fields for all 8 supported
 * platforms, shared configuration sections (enable/disable, allow-from,
 * streaming, auto-reply, send policy, delivery trace, activity sparkline),
 * and lifecycle action buttons (Restart, Enable/Disable).
 *
 * All fields are read-only display. Config changes are made via YAML files.
 * SecretRef values are displayed as masked dots, never as raw values.
 *
 * @fires navigate - Dispatched when breadcrumb navigation is clicked
 */
@customElement("ic-channel-detail")
export class IcChannelDetail extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .channel-detail {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md, 1rem);
      }

      /* Header */
      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-md, 1rem);
        flex-wrap: wrap;
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .page-title {
        font-size: 1.5rem;
        font-weight: 700;
        margin: 0;
      }

      .header-actions {
        display: flex;
        gap: var(--ic-space-sm, 0.5rem);
      }

      /* Buttons */
      .btn {
        padding: 0.5rem 1rem;
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 500;
        border-radius: var(--ic-radius-md, 0.5rem);
        border: 1px solid transparent;
        cursor: pointer;
        transition: background var(--ic-transition, 150ms), border-color var(--ic-transition, 150ms);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-primary {
        background: var(--ic-accent, #3b82f6);
        color: white;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--ic-accent-hover, #2563eb);
      }

      .btn-warning {
        background: var(--ic-warning, #f59e0b);
        color: #000;
      }

      .btn-warning:hover:not(:disabled) {
        background: #d97706;
      }

      .btn-danger {
        background: var(--ic-error, #f87171);
        color: #000;
      }

      .btn-danger:hover:not(:disabled) {
        background: #ef4444;
      }

      /* Section cards */
      .section {
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        padding: var(--ic-space-md, 1rem);
      }

      .section-title {
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 600;
        color: var(--ic-text-muted, #9ca3af);
        margin: 0 0 var(--ic-space-sm, 0.5rem) 0;
      }

      .section-hint {
        color: var(--ic-text-dim, #6b7280);
        font-size: var(--ic-text-sm, 0.875rem);
        margin: 0;
      }

      /* Config grid */
      .config-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .config-item {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-2xs, 0.125rem);
      }

      .config-label {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
      }

      .config-value {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
      }

      /* Field layout */
      .fields-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-2xs, 0.125rem);
      }

      .field label {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
      }

      .field-value {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
        background: var(--ic-surface-2, #1f2937);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        border-radius: var(--ic-radius-sm, 0.25rem);
        min-height: 1.75rem;
        display: flex;
        align-items: center;
      }

      .field-value.secret {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        color: var(--ic-text-dim, #6b7280);
      }

      .field-value.list {
        flex-wrap: wrap;
        gap: var(--ic-space-xs, 0.25rem);
      }

      /* Allow-from list */
      .allow-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs, 0.25rem);
      }

      .allow-item {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs, 0.25rem);
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        background: var(--ic-surface-2, #1f2937);
        border-radius: var(--ic-radius-sm, 0.25rem);
      }

      /* Delivery trace grid (CSS grid + ARIA roles for happy-dom compat) */
      .trace-grid {
        display: grid;
        grid-template-columns: 1fr auto auto;
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .trace-grid [role="columnheader"] {
        text-align: left;
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        color: var(--ic-text-dim, #6b7280);
        font-weight: 500;
        font-size: var(--ic-text-xs, 0.75rem);
        border-bottom: 1px solid var(--ic-border, #374151);
      }

      .trace-grid [role="cell"] {
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        border-bottom: 1px solid var(--ic-border, #374151);
      }

      .trace-row-even [role="cell"] {
        background: color-mix(in srgb, var(--ic-surface-2, #1f2937) 30%, transparent);
      }

      /* Sparkline */
      .sparkline {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 60px;
        padding: var(--ic-space-xs, 0.25rem) 0;
      }

      .spark-bar {
        width: 4px;
        min-height: 1px;
        background: var(--ic-accent, #3b82f6);
        border-radius: 1px 1px 0 0;
        transition: opacity var(--ic-transition, 150ms);
        flex-shrink: 0;
      }

      .spark-bar:hover {
        opacity: 0.7;
      }

      /* Capability rows */
      .capability-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        border-bottom: 1px solid var(--ic-border, #374151);
      }

      .capability-row:last-child {
        border-bottom: none;
      }

      /* Send policy list */
      .policy-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs, 0.25rem);
      }

      .policy-item {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        background: var(--ic-surface-2, #1f2937);
        border-radius: var(--ic-radius-sm, 0.25rem);
      }

      /* Error / loading */
      .error-container {
        padding: var(--ic-space-xl, 2rem);
        text-align: center;
      }

      .error-message {
        color: var(--ic-error, #f87171);
        margin-bottom: var(--ic-space-md, 1rem);
      }

      .retry-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-accent, #3b82f6);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md, 0.5rem);
        cursor: pointer;
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .retry-btn:hover {
        background: var(--ic-accent-hover, #2563eb);
      }

      /* Error banner */
      .error-banner {
        display: flex;
        align-items: flex-start;
        gap: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 1rem);
        background: color-mix(in srgb, var(--ic-error, #f87171) 10%, transparent);
        border-left: 3px solid var(--ic-error, #f87171);
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-error, #f87171);
        font-size: var(--ic-text-sm, 0.875rem);
        line-height: 1.4;
      }

      .error-banner ic-icon {
        flex-shrink: 0;
        margin-top: 2px;
      }

      /* Connection mode badge */
      .connection-mode-badge {
        display: inline-flex;
        align-items: center;
        padding: 0.125rem 0.5rem;
        background: var(--ic-surface-2, #1f2937);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
        text-transform: lowercase;
      }

      /* Last message time in stats section */
      .last-message-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs, 0.25rem);
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text-muted, #9ca3af);
      }

      .last-message-time {
        color: var(--ic-text, #f3f4f6);
      }

      .loading-container {
        display: flex;
        justify-content: center;
        padding: var(--ic-space-2xl, 3rem);
      }

      /* Media processing toggles */
      .media-toggle-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs, 0.25rem);
      }

      .media-toggle-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        background: var(--ic-surface-2, #1f2937);
        border-radius: var(--ic-radius-sm, 0.25rem);
      }

      .media-toggle-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .media-toggle-label {
        font-size: var(--ic-text-sm, 0.875rem);
        color: var(--ic-text, #f3f4f6);
        font-weight: 500;
      }

      .media-toggle-desc {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #6b7280);
      }

      .toggle-switch {
        position: relative;
        width: 36px;
        height: 20px;
        flex-shrink: 0;
      }

      .toggle-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }

      .toggle-slider {
        position: absolute;
        cursor: pointer;
        inset: 0;
        background: var(--ic-border, #374151);
        border-radius: 10px;
        transition: background var(--ic-transition, 150ms);
      }

      .toggle-slider::before {
        content: "";
        position: absolute;
        width: 16px;
        height: 16px;
        left: 2px;
        bottom: 2px;
        background: white;
        border-radius: 50%;
        transition: transform var(--ic-transition, 150ms);
      }

      .toggle-switch input:checked + .toggle-slider {
        background: var(--ic-accent, #3b82f6);
      }

      .toggle-switch input:checked + .toggle-slider::before {
        transform: translateX(16px);
      }

      .toggle-switch input:disabled + .toggle-slider {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  /** API client for REST data (injected from app.ts). */
  @property({ attribute: false }) apiClient: ApiClient | null = null;

  /** RPC client for WebSocket data (injected from app.ts). */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /** Event dispatcher for SSE subscriptions (injected from app.ts). */
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  /** Platform type from route params (e.g., "telegram", "discord"). */
  @property() channelType = "";

  @state() private _loadState: "loading" | "loaded" | "error" = "loading";
  @state() private _error = "";
  @state() private _config: Record<string, unknown> = {};
  @state() private _enabled = false;
  @state() private _status = "disconnected";
  @state() private _deliveryTrace: DeliveryTraceEntry[] = [];
  @state() private _activityData: number[] = [];
  @state() private _channelLastActiveAt = 0;
  @state() private _channelMessagesSent = 0;
  @state() private _channelMessagesReceived = 0;
  @state() private _connectionMode = "";
  @state() private _lastError = "";
  @state() private _actionPending = false;
  @state() private _queueStatus: { pending: number; inFlight: number; failed: number; delivered: number; expired: number } | null = null;
  @state() private _capabilities: { reactions: boolean; editMessages: boolean; deleteMessages: boolean; fetchHistory: boolean; attachments: boolean; threads: boolean; mentions: boolean; formatting: string[]; buttons: boolean; cards: boolean; effects: boolean } | null = null;
  @state() private _mediaProcessing: Record<string, boolean> = {
    transcribeAudio: true,
    analyzeImages: true,
    describeVideos: true,
    extractDocuments: true,
    understandLinks: true,
  };

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  private _hasLoaded = false;
  private _previousChannelType = "";

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadData() is NOT called here -- rpcClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
    this._initSse();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._reloadDebounce !== null) {
      clearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
  }

  override updated(changedProperties: Map<string, unknown>): void {
    // Reload data when channelType changes or clients become available
    if (changedProperties.has("channelType") && this.channelType && this.channelType !== this._previousChannelType) {
      this._previousChannelType = this.channelType;
      this._hasLoaded = false;
      void this._loadData();
    } else if (
      (changedProperties.has("rpcClient") || changedProperties.has("apiClient")) &&
      this.rpcClient &&
      this.channelType &&
      !this._hasLoaded
    ) {
      void this._loadData();
    }
    if (changedProperties.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._initSse();
    }
  }

  private _initSse(): void {
    if (!this.eventDispatcher || this._sse) return;
    this._sse = new SseController(this, this.eventDispatcher, {
      "diagnostic:channel_health": () => { this._scheduleReload(500); },
    });
  }

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) clearTimeout(this._reloadDebounce);
    this._reloadDebounce = setTimeout(() => {
      this._reloadDebounce = null;
      void this._loadData();
    }, delayMs);
  }

  async _loadData(): Promise<void> {
    if (!this.rpcClient || !this.channelType) return;

    this._loadState = "loading";
    this._error = "";

    try {
      // Config is required
      const config = await this.rpcClient.call<Record<string, unknown>>(
        "channels.get",
        { channel_type: this.channelType },
      );

      this._config = config ?? {};
      // Determine enabled: explicit `enabled` field, or infer from status (running/connected = enabled)
      const status = (this._config.status as string) ?? "";
      this._enabled = (this._config.enabled as boolean) ?? (status === "running" || status === "connected");
      this._status = (this._config.status as string) ?? "disconnected";
      this._connectionMode = (this._config.connectionMode as string) ?? "";
      this._lastError = (this._config.lastError as string) ?? "";

      // Fire all optional data loads in parallel
      const [mediaResult, deliveryResult, activityResult, queueResult, capabilitiesResult] = await Promise.allSettled([
        this.rpcClient.call<Record<string, Record<string, unknown>>>(
          "config.read",
          { section: "channels" },
        ),
        this.rpcClient.call<{ entries: DeliveryTraceEntry[] }>(
          "obs.delivery.recent",
          { type: this.channelType, limit: 10 },
        ),
        this.rpcClient.call<{ channel: { channelId: string; channelType: string; lastActiveAt: number; messagesSent: number; messagesReceived: number } | null }>(
          "obs.channels.get",
          { channelId: this.channelType },
        ),
        this.rpcClient.call<DeliveryQueueStatus>(
          "delivery.queue.status",
          { channel_type: this.channelType },
        ),
        this.rpcClient.call<{ channelType: string; features: PlatformCapabilities }>(
          "channels.capabilities",
          { channel_type: this.channelType },
        ),
      ]);

      // Media processing config
      if (mediaResult.status === "fulfilled") {
        const channelCfg = mediaResult.value?.[this.channelType];
        const mp = channelCfg?.mediaProcessing as Record<string, boolean> | undefined;
        if (mp) {
          this._mediaProcessing = {
            transcribeAudio: mp.transcribeAudio !== false,
            analyzeImages: mp.analyzeImages !== false,
            describeVideos: mp.describeVideos !== false,
            extractDocuments: mp.extractDocuments !== false,
            understandLinks: mp.understandLinks !== false,
          };
        }
      }

      // Delivery trace - RPC returns { deliveries: [...] } or { entries: [...] }
      if (deliveryResult.status === "fulfilled") {
        const raw = deliveryResult.value as Record<string, unknown>;
        this._deliveryTrace = (raw?.deliveries ?? raw?.entries ?? []) as DeliveryTraceEntry[];
      } else {
        this._deliveryTrace = [];
      }

      // Channel obs stats from obs.channels.get
      if (activityResult.status === "fulfilled" && activityResult.value?.channel) {
        const ch = activityResult.value.channel;
        this._channelLastActiveAt = ch.lastActiveAt ?? 0;
        this._channelMessagesSent = ch.messagesSent ?? 0;
        this._channelMessagesReceived = ch.messagesReceived ?? 0;
      }

      // Delivery queue status
      if (queueResult.status === "fulfilled" && queueResult.value) {
        this._queueStatus = queueResult.value;
      } else {
        this._queueStatus = null;
      }

      // Platform capabilities
      if (capabilitiesResult.status === "fulfilled" && capabilitiesResult.value?.features) {
        this._capabilities = capabilitiesResult.value.features;
      } else {
        this._capabilities = null;
      }

      // Activity sparkline - derive from delivery trace timestamps
      this._activityData = this._deriveActivityFromTraces(this._deliveryTrace);

      this._loadState = "loaded";
      this._hasLoaded = true;
    } catch (e) {
      this._error = e instanceof Error ? e.message : "Failed to load channel configuration";
      this._loadState = "error";
    }
  }

  private async _handleRestart(): Promise<void> {
    if (!this.rpcClient) return;

    this._actionPending = true;
    try {
      await this.rpcClient.call("channels.restart", { channel_type: this.channelType });
      IcToast.show(`${capitalize(this.channelType)} restarted`, "success");
      await this._loadData();
    } catch {
      IcToast.show(`Failed to restart ${this.channelType}`, "error");
    } finally {
      this._actionPending = false;
    }
  }

  private async _handleToggleEnabled(): Promise<void> {
    if (!this.rpcClient) return;

    this._actionPending = true;
    try {
      if (this._enabled) {
        await this.rpcClient.call("channels.disable", { channel_type: this.channelType });
        this._enabled = false;
        IcToast.show(`${capitalize(this.channelType)} disabled`, "success");
      } else {
        await this.rpcClient.call("channels.enable", { channel_type: this.channelType });
        this._enabled = true;
        IcToast.show(`${capitalize(this.channelType)} enabled`, "success");
      }
      await this._loadData();
    } catch {
      IcToast.show(`Failed to ${this._enabled ? "disable" : "enable"} ${this.channelType}`, "error");
    } finally {
      this._actionPending = false;
    }
  }

  private async _handleMediaToggle(field: string, enabled: boolean): Promise<void> {
    if (!this.rpcClient) return;

    // Optimistic update
    this._mediaProcessing = { ...this._mediaProcessing, [field]: enabled };

    try {
      await this.rpcClient.call("config.patch", {
        section: "channels",
        key: `${this.channelType}.mediaProcessing.${field}`,
        value: enabled,
      });
      const label = MEDIA_PROCESSING_FIELDS.find((f) => f.key === field)?.label ?? field;
      IcToast.show(`${label} ${enabled ? "enabled" : "disabled"}`, "success");
    } catch {
      // Rollback
      this._mediaProcessing = { ...this._mediaProcessing, [field]: !enabled };
      IcToast.show("Failed to update media processing", "error");
    }
  }

  private _renderMediaProcessing() {
    return html`
      <div class="section">
        <h3 class="section-title">Media Processing</h3>
        <div class="media-toggle-list">
          ${MEDIA_PROCESSING_FIELDS.map(
            (f) => html`
              <div class="media-toggle-item">
                <div class="media-toggle-info">
                  <span class="media-toggle-label">${f.label}</span>
                  <span class="media-toggle-desc">${f.description}</span>
                </div>
                <label class="toggle-switch">
                  <input
                    type="checkbox"
                    .checked=${this._mediaProcessing[f.key] ?? true}
                    ?disabled=${this._actionPending}
                    @change=${(e: Event) => {
                      const checked = (e.target as HTMLInputElement).checked;
                      void this._handleMediaToggle(f.key, checked);
                    }}
                  />
                  <span class="toggle-slider"></span>
                </label>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private _renderField(field: FieldDef) {
    const value = resolveConfigValue(this._config, field.key);

    switch (field.type) {
      case "secret":
        return html`
          <div class="field">
            <label>${field.label}</label>
            <div class="field-value secret">${value ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "Not set"}</div>
          </div>
        `;

      case "toggle":
        return html`
          <div class="field">
            <label>${field.label}</label>
            <div class="field-value">${value ? "Enabled" : "Disabled"}</div>
          </div>
        `;

      case "list": {
        const items = Array.isArray(value) ? value : [];
        return html`
          <div class="field">
            <label>${field.label}</label>
            <div class="field-value list">${items.length > 0 ? (items as string[]).join(", ") : "None"}</div>
          </div>
        `;
      }

      case "select":
      case "text":
      default:
        return html`
          <div class="field">
            <label>${field.label}</label>
            <div class="field-value">${value != null && value !== "" ? String(value) : "\u2014"}</div>
          </div>
        `;
    }
  }

  private _renderPlatformFields() {
    const fields = PLATFORM_FIELDS[this.channelType];
    if (!fields || fields.length === 0) {
      return html`
        <div class="section">
          <h3 class="section-title">Platform Configuration</h3>
          <p class="section-hint">No platform-specific fields defined for ${capitalize(this.channelType)}</p>
        </div>
      `;
    }

    return html`
      <div class="section">
        <h3 class="section-title">${capitalize(this.channelType)} Configuration</h3>
        <div class="fields-grid">
          ${fields.map((f) => this._renderField(f))}
        </div>
      </div>
    `;
  }

  private _renderAllowFrom() {
    const allowFrom = Array.isArray(this._config.allowFrom)
      ? (this._config.allowFrom as string[])
      : [];

    return html`
      <div class="section">
        <h3 class="section-title">Allow From</h3>
        ${allowFrom.length === 0
          ? html`<p class="section-hint">No restrictions \u2014 all senders allowed</p>`
          : html`
              <ul class="allow-list">
                ${allowFrom.map(
                  (id) => html`
                    <li class="allow-item">
                      <ic-icon name="user" size="14px"></ic-icon>
                      ${id}
                    </li>
                  `,
                )}
              </ul>
            `}
      </div>
    `;
  }

  private _renderStreamingConfig() {
    const streaming = this._config.streaming as Record<string, unknown> | undefined;

    return html`
      <div class="section">
        <h3 class="section-title">Streaming</h3>
        ${streaming
          ? html`
              <div class="config-grid">
                <div class="config-item">
                  <span class="config-label">Chunk Mode</span>
                  <span class="config-value">${(streaming.chunkMode as string) || "\u2014"}</span>
                </div>
                <div class="config-item">
                  <span class="config-label">Pacing</span>
                  <span class="config-value">${streaming.pacingMs ? `${streaming.pacingMs}ms` : "\u2014"}</span>
                </div>
                <div class="config-item">
                  <span class="config-label">Typing Indicator</span>
                  <span class="config-value">${(streaming.typingMode as string) || "\u2014"}</span>
                </div>
              </div>
            `
          : html`<p class="section-hint">Default settings</p>`}
      </div>
    `;
  }

  private _renderAutoReply() {
    const autoReply = this._config.autoReply as Record<string, unknown> | undefined;

    return html`
      <div class="section">
        <h3 class="section-title">Auto-Reply</h3>
        ${autoReply
          ? html`
              <div class="config-grid">
                <div class="config-item">
                  <span class="config-label">Group Activation</span>
                  <span class="config-value">${(autoReply.groupActivation as string) || "\u2014"}</span>
                </div>
                <div class="config-item">
                  <span class="config-label">Cooldown</span>
                  <span class="config-value">${autoReply.cooldownMs ? `${autoReply.cooldownMs}ms` : "\u2014"}</span>
                </div>
              </div>
            `
          : html`<p class="section-hint">Not configured</p>`}
      </div>
    `;
  }

  private _renderSendPolicy() {
    const sendPolicy = this._config.sendPolicy as Record<string, unknown> | undefined;
    const rules = Array.isArray(sendPolicy?.rules) ? (sendPolicy!.rules as string[]) : [];

    return html`
      <div class="section">
        <h3 class="section-title">Send Policy</h3>
        ${rules.length === 0
          ? html`<p class="section-hint">No send policy rules</p>`
          : html`
              <ul class="policy-list">
                ${rules.map((rule) => html`<li class="policy-item">${String(rule)}</li>`)}
              </ul>
            `}
      </div>
    `;
  }

  /** Format epoch ms to relative time string: "5m ago", "2h ago", etc. */
  private _formatTimeAgo(epochMs: number): string {
    if (epochMs <= 0) return "unknown";
    const diffMs = Date.now() - epochMs;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  }

  /** Derive per-hour message counts from delivery trace timestamps (24 buckets). */
  private _deriveActivityFromTraces(traces: DeliveryTraceEntry[]): number[] {
    if (traces.length === 0) return [];
    const now = Date.now();
    const buckets = new Array<number>(24).fill(0);
    for (const t of traces) {
      const ts = t.timestamp ?? t.deliveredAt ?? 0;
      const hoursAgo = Math.floor((now - ts) / 3_600_000);
      if (hoursAgo >= 0 && hoursAgo < 24) {
        buckets[23 - hoursAgo]++;
      }
    }
    return buckets;
  }

  private _renderDeliveryQueuePanel() {
    if (!this._queueStatus) return nothing;

    const qs = this._queueStatus;
    return html`
      <div class="section">
        <h3 class="section-title">Delivery Queue</h3>
        <div class="config-grid">
          <div class="config-item">
            <span class="config-label">Pending</span>
            <span class="config-value" style="${qs.pending > 0 ? "color: var(--ic-warning)" : ""}">${qs.pending}</span>
          </div>
          <div class="config-item">
            <span class="config-label">In Flight</span>
            <span class="config-value">${qs.inFlight}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Failed</span>
            <span class="config-value" style="${qs.failed > 0 ? "color: var(--ic-error)" : ""}">${qs.failed}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Delivered</span>
            <span class="config-value">${qs.delivered}</span>
          </div>
        </div>
      </div>
    `;
  }

  private _renderCapabilitiesMatrix() {
    if (!this._capabilities) return nothing;

    const cap = this._capabilities;
    const rows: Array<{ label: string; supported: boolean }> = [
      { label: "Reactions", supported: cap.reactions },
      { label: "Edit Messages", supported: cap.editMessages },
      { label: "Delete Messages", supported: cap.deleteMessages },
      { label: "Fetch History", supported: cap.fetchHistory },
      { label: "Attachments", supported: cap.attachments },
      { label: "Threads", supported: cap.threads },
      { label: "Mentions", supported: cap.mentions },
      { label: "Buttons", supported: cap.buttons },
      { label: "Cards", supported: cap.cards },
      { label: "Effects", supported: cap.effects },
    ];

    return html`
      <div class="section">
        <h3 class="section-title">Platform Capabilities</h3>
        <div class="config-grid">
          ${rows.map(
            (r) => html`
              <div class="capability-row">
                <span class="config-label">${r.label}</span>
                <ic-icon
                  name=${r.supported ? "check" : "x"}
                  size="16px"
                  color=${r.supported ? "var(--ic-success)" : "var(--ic-text-dim)"}
                ></ic-icon>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private _renderDeliveryTrace() {
    return html`
      <div class="section">
        <h3 class="section-title">Recent Deliveries</h3>
        ${this._deliveryTrace.length === 0
          ? html`<p class="section-hint">No recent deliveries</p>`
          : html`
              <div class="trace-grid" role="table" aria-label="Recent deliveries">
                <div role="row" style="display:contents">
                  <div role="columnheader">Time</div>
                  <div role="columnheader">Status</div>
                  <div role="columnheader">Latency</div>
                </div>
                ${this._deliveryTrace.map(
                  (d, i) => html`
                    <div role="row" class="${i % 2 === 1 ? "trace-row-even" : ""}" style="display:contents">
                      <div role="cell"><ic-relative-time .timestamp=${d.timestamp ?? d.deliveredAt ?? 0}></ic-relative-time></div>
                      <div role="cell"><ic-tag variant=${(d.success ?? d.status === "delivered") ? "success" : "error"}>${d.success !== undefined ? (d.success ? "delivered" : "failed") : (d.status ?? "unknown")}</ic-tag></div>
                      <div role="cell">${d.latencyMs}ms</div>
                    </div>
                  `,
                )}
              </div>
            `}
      </div>
    `;
  }

  private _renderActivitySparkline() {
    const maxCount = Math.max(...this._activityData, 1);

    return html`
      <div class="section">
        <h3 class="section-title">Message Activity (24h)</h3>
        ${this._activityData.length === 0
          ? html`<p class="section-hint">No activity data available</p>`
          : html`
              <div class="sparkline">
                ${this._activityData.map(
                  (count) => html`
                    <div
                      class="spark-bar"
                      style="height: ${(count / maxCount) * 100}%"
                      title="${count} messages"
                    ></div>
                  `,
                )}
              </div>
            `}
      </div>
    `;
  }

  override render() {
    if (this._loadState === "loading") {
      return html`
        <div class="loading-container">
          <ic-loading size="lg"></ic-loading>
        </div>
      `;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <div class="error-message">${this._error}</div>
          <button class="retry-btn" @click=${() => void this._loadData()}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="channel-detail">
        <ic-breadcrumb
          .items=${[
            { label: "Channels", route: "channels" },
            { label: capitalize(this.channelType) },
          ]}
          @navigate=${(e: CustomEvent<string>) => {
            this.dispatchEvent(new CustomEvent("navigate", { detail: e.detail, bubbles: false, composed: false }));
          }}
        ></ic-breadcrumb>

        <div class="header-row">
          <div class="header-left">
            <ic-icon name=${this.channelType} size="32px"></ic-icon>
            <h1 class="page-title">${capitalize(this.channelType)}</h1>
            <ic-connection-dot status=${this._status} size="10px" showLabel></ic-connection-dot>
            ${this._connectionMode
              ? html`<span class="connection-mode-badge">${this._connectionMode}</span>`
              : nothing}
          </div>
          <div class="header-actions">
            <button class="btn btn-warning" @click=${() => void this._handleRestart()} ?disabled=${this._actionPending}>
              Restart
            </button>
            <button
              class="btn ${this._enabled ? "btn-danger" : "btn-primary"}"
              @click=${() => void this._handleToggleEnabled()}
              ?disabled=${this._actionPending}
            >
              ${this._enabled ? "Disable" : "Enable"}
            </button>
          </div>
        </div>

        ${this._lastError
          ? html`
              <div class="error-banner">
                <ic-icon name="alert-circle" size="16px" color="var(--ic-error)"></ic-icon>
                <span>${this._lastError}</span>
              </div>
            `
          : nothing}

        ${this._channelLastActiveAt > 0
          ? html`
              <div class="last-message-row">
                <ic-icon name="message-circle" size="14px"></ic-icon>
                <span>Last message:</span>
                <span
                  class="last-message-time"
                  title=${new Date(this._channelLastActiveAt).toISOString()}
                >${this._formatTimeAgo(this._channelLastActiveAt)}</span>
              </div>
            `
          : nothing}

        <ic-tabs
          .tabs=${[
            { id: "config", label: "Configuration" },
            { id: "streaming", label: "Streaming" },
            { id: "activity", label: "Activity" },
          ]}
        >
          <div data-tab="config">
            ${this._renderPlatformFields()}
            ${this._renderAllowFrom()}
            ${this._renderMediaProcessing()}
          </div>
          <div data-tab="streaming">
            ${this._renderStreamingConfig()}
            ${this._renderAutoReply()}
            ${this._renderSendPolicy()}
          </div>
          <div data-tab="activity">
            ${this._renderDeliveryQueuePanel()}
            ${this._renderCapabilitiesMatrix()}
            ${this._renderDeliveryTrace()}
            ${this._renderActivitySparkline()}
          </div>
        </ic-tabs>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-channel-detail": IcChannelDetail;
  }
}
