// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { SseController } from "../state/sse-controller.js";
import type {
  ChannelDetailInfo,
  ChannelObsResponse,
  ChannelStaleResponse,
} from "../api/types/index.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import { IcToast } from "../components/feedback/ic-toast.js";

// Side-effect registrations for sub-components
import "../components/channel-card.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";
import "../components/shell/ic-skeleton-view.js";

/**
 * Format an uptime value in seconds to a human-readable duration.
 * @param seconds - Total seconds of uptime
 * @returns A string like "14d 3h", "2h 15m", "5m", etc.
 */
export function formatUptime(seconds: number): string {
  if (seconds <= 0) return "0m";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Capitalize first letter of a string. */
function capitalize(str: string): string {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Channel list view for the Comis operator console.
 *
 * Displays a responsive card grid of all configured channels using
 * ic-channel-card components. Cards show connection status, metrics,
 * and action buttons. Connected channels show green dots, disabled
 * channels show gray, and stale channels show yellow warning badges.
 *
 * Summary stats row at the top shows total, connected, disconnected,
 * and stale channel counts.
 *
 * @fires navigate - Dispatched when the Configure button is clicked, with the channel path as detail
 */
@customElement("ic-channel-list")
export class IcChannelList extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .page-title {
        font-size: 1.5rem;
        font-weight: 700;
        margin: 0 0 var(--ic-space-sm) 0;
      }

      /* Summary stats row */
      .stats-row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--ic-space-sm, 0.5rem);
        margin-bottom: var(--ic-space-lg, 1.5rem);
      }

      .stat-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.25rem 0.625rem;
        border-radius: 9999px;
        font-size: 0.75rem;
        font-weight: 500;
        background: var(--ic-surface, #111827);
        border: 1px solid var(--ic-border, #374151);
        color: var(--ic-text-muted, #9ca3af);
      }

      .stat-badge--connected {
        color: var(--ic-success, #22c55e);
        border-color: color-mix(in srgb, var(--ic-success, #22c55e) 30%, var(--ic-border, #374151));
      }

      .stat-badge--disconnected {
        color: var(--ic-text-dim, #6b7280);
      }

      .stat-badge--stale {
        color: var(--ic-warning, #f59e0b);
        border-color: color-mix(in srgb, var(--ic-warning, #f59e0b) 30%, var(--ic-border, #374151));
      }

      .stat-count {
        font-weight: 700;
      }

      /* Card grid */
      .card-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: var(--ic-space-lg, 1.5rem);
      }

      /* Error state */
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

      /* Loading */
      .loading-container {
        display: flex;
        justify-content: center;
        padding: var(--ic-space-2xl, 3rem);
      }
    `,
  ];

  /** API client for REST data (injected from app.ts). */
  @property({ attribute: false }) apiClient: ApiClient | null = null;

  /** RPC client for WebSocket data (injected from app.ts). */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /** Event dispatcher for SSE subscriptions (injected from app.ts). */
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  private _sse: SseController | null = null;
  private _reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  @state() private _loadState: "loading" | "loaded" | "error" = "loading";
  @state() private _error = "";
  @state() private _channels: ChannelDetailInfo[] = [];
  @state() private _staleTypes: Set<string> = new Set();
  @state() private _actionPending: Set<string> = new Set();
  @state() private _confirmDisable: string | null = null;

  private _hasLoaded = false;

  override connectedCallback(): void {
    super.connectedCallback();
    // Note: _loadData() is NOT called here -- apiClient is typically
    // null at this point. The updated() callback handles loading once
    // the client property is set.
    if (this.eventDispatcher && !this._sse) {
      this._sse = new SseController(this, this.eventDispatcher, {
        "channel:registered": () => { this._scheduleReload(); },
        "channel:deregistered": () => { this._scheduleReload(); },
        "diagnostic:channel_health": () => { this._scheduleReload(500); },
      });
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._reloadDebounce !== null) {
      clearTimeout(this._reloadDebounce);
      this._reloadDebounce = null;
    }
  }

  override updated(changedProperties: Map<string, unknown>): void {
    if (
      (changedProperties.has("apiClient") || changedProperties.has("rpcClient")) &&
      this.apiClient &&
      !this._hasLoaded
    ) {
      void this._loadData();
    }
    if (changedProperties.has("eventDispatcher") && this.eventDispatcher && !this._sse) {
      this._sse = new SseController(this, this.eventDispatcher, {
        "channel:registered": () => { this._scheduleReload(); },
        "channel:deregistered": () => { this._scheduleReload(); },
        "diagnostic:channel_health": () => { this._scheduleReload(500); },
      });
    }
  }

  private _scheduleReload(delayMs = 300): void {
    if (this._reloadDebounce !== null) clearTimeout(this._reloadDebounce);
    this._reloadDebounce = setTimeout(() => {
      this._reloadDebounce = null;
      void this._loadData();
    }, delayMs);
  }

  async _loadData(): Promise<void> {
    if (!this.apiClient) return;

    this._loadState = "loading";
    this._error = "";

    try {
      // Show channels immediately from REST data
      const restChannels = await this.apiClient.getChannels();
      this._channels = restChannels.map((ch) => ({
        ...ch,
        uptime: 0,
        messageCount: 0,
        lastActivity: 0,
      }));
      this._loadState = "loaded";
      this._hasLoaded = true;

      // Enrich with RPC observability data in the background
      if (this.rpcClient && this.rpcClient.status === "connected") {
        Promise.allSettled([
          this.rpcClient.call<ChannelObsResponse>("obs.channels.all"),
          this.rpcClient.call<ChannelStaleResponse>("obs.channels.stale"),
        ]).then(([obsResult, staleResult]) => {
          const obsData = obsResult.status === "fulfilled" ? obsResult.value : null;
          const staleData = staleResult.status === "fulfilled" ? staleResult.value : null;

          const obsMap = new Map(
            (obsData?.channels ?? []).map((c) => [c.channelType, c]),
          );

          this._channels = restChannels.map((ch) => {
            const obs = obsMap.get(ch.type);
            return {
              ...ch,
              uptime: 0,
              messageCount: obs ? obs.messagesSent + obs.messagesReceived : 0,
              lastActivity: obs?.lastActiveAt ?? 0,
            };
          });

          this._staleTypes = new Set(
            (staleData?.channels ?? []).map((c) => c.channelType),
          );
        });
      }
    } catch (e) {
      this._error = e instanceof Error ? e.message : "Failed to load channels";
      this._loadState = "error";
    }
  }

  private async _handleRestart(type: string): Promise<void> {
    if (!this.rpcClient) return;

    this._actionPending = new Set([...this._actionPending, type]);
    try {
      await this.rpcClient.call("channels.restart", { channel_type: type });
      IcToast.show(`${capitalize(type)} restarted`, "success");
      await this._loadData();
    } catch {
      IcToast.show(`Failed to restart ${type}`, "error");
    } finally {
      const next = new Set(this._actionPending);
      next.delete(type);
      this._actionPending = next;
    }
  }

  private async _handleEnable(type: string): Promise<void> {
    if (!this.rpcClient) return;

    this._actionPending = new Set([...this._actionPending, type]);
    try {
      await this.rpcClient.call("channels.enable", { channel_type: type });
      IcToast.show(`${capitalize(type)} enabled`, "success");
      await this._loadData();
    } catch {
      IcToast.show(`Failed to enable ${type}`, "error");
    } finally {
      const next = new Set(this._actionPending);
      next.delete(type);
      this._actionPending = next;
    }
  }

  private async _handleDisable(type: string): Promise<void> {
    if (!this.rpcClient) return;

    this._actionPending = new Set([...this._actionPending, type]);
    try {
      await this.rpcClient.call("channels.disable", { channel_type: type });
      IcToast.show(`${capitalize(type)} disabled`, "success");
      await this._loadData();
    } catch {
      IcToast.show(`Failed to disable ${type}`, "error");
    } finally {
      const next = new Set(this._actionPending);
      next.delete(type);
      this._actionPending = next;
    }
  }

  private _handleConfigure(type: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", {
        detail: `channels/${type}`,
        bubbles: false,
        composed: false,
      }),
    );
  }

  private _handleCardAction(e: CustomEvent<{ action: string; channelType: string }>): void {
    const { action, channelType } = e.detail;
    switch (action) {
      case "configure":
        this._handleConfigure(channelType);
        break;
      case "restart":
        void this._handleRestart(channelType);
        break;
      case "enable":
        void this._handleEnable(channelType);
        break;
      case "disable":
        this._confirmDisable = channelType;
        break;
    }
  }

  private _confirmDisableAction(): void {
    if (this._confirmDisable) {
      void this._handleDisable(this._confirmDisable);
      this._confirmDisable = null;
    }
  }

  private _cancelDisable(): void {
    this._confirmDisable = null;
  }

  override render() {
    if (this._loadState === "loading") {
      return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <div class="error-message">${this._error}</div>
          <button class="retry-btn" @click=${() => void this._loadData()}>
            Retry
          </button>
        </div>
      `;
    }

    if (this._channels.length === 0) {
      return html`
        <h1 class="page-title">Channels</h1>
        <ic-empty-state
          icon="radio"
          message="No channels connected"
          description="Connect a chat platform to start receiving messages."
        >
          <button class="retry-btn" @click=${() => { window.location.hash = "#/config"; }}>Open Settings</button>
        </ic-empty-state>
      `;
    }

    const connectedCount = this._channels.filter(
      (ch) => ch.enabled && (ch.status === "healthy" || ch.status === "idle"),
    ).length;
    const disconnectedCount = this._channels.filter((ch) => !ch.enabled).length;
    const staleCount = this._channels.filter(
      (ch) => ch.enabled && this._staleTypes.has(ch.type),
    ).length;

    return html`
      <div role="region" aria-label="Channels">
      <h1 class="page-title">Channels</h1>

      <div class="stats-row">
        <span class="stat-badge">
          <span class="stat-count">${this._channels.length}</span> Total
        </span>
        <span class="stat-badge stat-badge--connected">
          <span class="stat-count">${connectedCount}</span> Connected
        </span>
        <span class="stat-badge stat-badge--disconnected">
          <span class="stat-count">${disconnectedCount}</span> Disabled
        </span>
        ${staleCount > 0
          ? html`<span class="stat-badge stat-badge--stale">
              <span class="stat-count">${staleCount}</span> Stale
            </span>`
          : nothing}
      </div>

      <div class="card-grid">
        ${this._channels.map(
          (ch) => html`
            <ic-channel-card
              .channelType=${ch.type}
              .name=${capitalize(ch.type)}
              .status=${ch.enabled ? ch.status : "disconnected"}
              ?enabled=${ch.enabled}
              ?isStale=${ch.enabled && this._staleTypes.has(ch.type)}
              .messageCount=${ch.messageCount}
              .uptime=${ch.uptime}
              .lastActivity=${ch.lastActivity}
              @channel-action=${(e: CustomEvent) => this._handleCardAction(e)}
            ></ic-channel-card>
          `,
        )}
      </div>

      </div>

      <ic-confirm-dialog
        ?open=${this._confirmDisable !== null}
        title="Disable Channel"
        message="Disable ${this._confirmDisable ? capitalize(this._confirmDisable) : ""}? This will disconnect the channel."
        confirmLabel="Disable"
        variant="danger"
        @confirm=${this._confirmDisableAction}
        @cancel=${this._cancelDisable}
      ></ic-confirm-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-channel-list": IcChannelList;
  }
}
