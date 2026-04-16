/**
 * Media provider configuration panel.
 *
 * Shows provider status and current settings for all five media subsystems
 * (STT, TTS, Vision, Document Extraction, Link Understanding) with links
 * to the config editor for each section.
 *
 * Route: #/media/config
 *
 * @module
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { MediaProvidersInfo } from "../api/types/media-types.js";

// Side-effect imports for sub-components
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-loading.js";

type LoadState = "loading" | "loaded" | "error";

/**
 * Media provider configuration overview panel.
 *
 * Displays 5 config sections with status indicators, current settings,
 * and "Edit in Config Editor" links for each media subsystem.
 */
@customElement("ic-media-config-view")
export class IcMediaConfigView extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--ic-space-md);
      }

      .header-title {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
      }

      .back-link {
        font-size: var(--ic-text-sm);
        color: var(--ic-accent);
        text-decoration: none;
      }

      .back-link:hover {
        text-decoration: underline;
      }

      .cards-grid {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
        max-width: 800px;
      }

      .config-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: 8px;
        padding: 1rem;
      }

      .card-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-sm);
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .dot--active {
        background: var(--ic-success, #22c55e);
      }

      .dot--inactive {
        background: var(--ic-text-dim, #6b7280);
      }

      .card-header h3 {
        margin: 0;
        font-size: var(--ic-text-base);
        font-weight: 600;
        color: var(--ic-text);
        flex: 1;
      }

      .status-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .card-body {
        margin-bottom: var(--ic-space-sm);
      }

      .hint {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-dim);
        margin: 0;
      }

      .hint code {
        background: var(--ic-surface-2);
        padding: 1px 4px;
        border-radius: 3px;
        font-size: var(--ic-text-xs);
      }

      .setting-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: 4px 0;
        font-size: var(--ic-text-sm);
      }

      .setting-key {
        color: var(--ic-text-muted);
        min-width: 120px;
      }

      .setting-value {
        color: var(--ic-text);
        font-family: var(--ic-font-mono, monospace);
        font-size: var(--ic-text-xs);
      }

      .card-footer {
        padding-top: var(--ic-space-sm);
        border-top: 1px solid var(--ic-border);
      }

      .configure-link {
        font-size: var(--ic-text-sm);
        color: var(--ic-accent);
        text-decoration: underline;
      }

      .configure-link:hover {
        color: var(--ic-accent-hover);
      }

      .configure-link code {
        background: var(--ic-surface-2);
        padding: 1px 4px;
        border-radius: 3px;
        font-size: var(--ic-text-xs);
      }

      .error-state {
        text-align: center;
        padding: var(--ic-space-xl);
        color: var(--ic-text-dim);
      }

      .btn-retry {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        margin-top: var(--ic-space-sm);
      }

      .btn-retry:hover {
        background: var(--ic-accent-hover);
      }
    `,
  ];

  @property({ attribute: false }) rpcClient!: RpcClient;

  @state() private _loadState: LoadState = "loading";
  @state() private _providers: MediaProvidersInfo | null = null;
  @state() private _mediaConfig: Record<string, unknown> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this._loadData();
  }

  private async _loadData(): Promise<void> {
    this._loadState = "loading";
    try {
      const [providers, integrations] = await Promise.all([
        this.rpcClient.call("media.providers") as Promise<MediaProvidersInfo>,
        this.rpcClient.call("config.read", { section: "integrations" }) as Promise<Record<string, unknown>>,
      ]);
      this._providers = providers;
      // config.read with section returns the section object directly
      this._mediaConfig = (integrations as Record<string, unknown>).media as Record<string, unknown> ?? null;
      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  // ---------------------------------------------------------------------------
  // Card rendering helpers
  // ---------------------------------------------------------------------------

  private _renderSttCard() {
    const configured = !!this._providers?.stt;
    return html`
      <div class="config-card">
        <div class="card-header">
          <span class="status-dot ${configured ? "dot--active" : "dot--inactive"}"></span>
          <h3>Speech-to-Text (STT)</h3>
          <span class="status-label">${configured ? "Configured" : "Not configured"}</span>
        </div>
        <div class="card-body">
          ${configured ? html`
            <div class="setting-row">
              <span class="setting-key">Provider</span>
              <span class="setting-value">${this._providers!.stt!.provider}</span>
            </div>
            ${this._providers!.stt!.model ? html`
              <div class="setting-row">
                <span class="setting-key">Model</span>
                <span class="setting-value">${this._providers!.stt!.model}</span>
              </div>
            ` : nothing}
            ${this._providers!.stt!.fallback.length > 0 ? html`
              <div class="setting-row">
                <span class="setting-key">Fallback</span>
                <span class="setting-value">${this._providers!.stt!.fallback.join(", ")}</span>
              </div>
            ` : nothing}
          ` : html`<p class="hint">Configure in <code>integrations.media.transcription</code></p>`}
        </div>
        <div class="card-footer">
          <a href="#/config" class="configure-link">Edit <code>integrations.media.transcription</code> in Config Editor</a>
        </div>
      </div>
    `;
  }

  private _renderTtsCard() {
    const configured = !!this._providers?.tts;
    return html`
      <div class="config-card">
        <div class="card-header">
          <span class="status-dot ${configured ? "dot--active" : "dot--inactive"}"></span>
          <h3>Text-to-Speech (TTS)</h3>
          <span class="status-label">${configured ? "Configured" : "Not configured"}</span>
        </div>
        <div class="card-body">
          ${configured ? html`
            <div class="setting-row">
              <span class="setting-key">Provider</span>
              <span class="setting-value">${this._providers!.tts!.provider}</span>
            </div>
            <div class="setting-row">
              <span class="setting-key">Voice</span>
              <span class="setting-value">${this._providers!.tts!.voice}</span>
            </div>
            <div class="setting-row">
              <span class="setting-key">Format</span>
              <span class="setting-value">${this._providers!.tts!.format}</span>
            </div>
            <div class="setting-row">
              <span class="setting-key">Auto Mode</span>
              <span class="setting-value">${this._providers!.tts!.autoMode}</span>
            </div>
          ` : html`<p class="hint">Configure in <code>integrations.media.tts</code></p>`}
        </div>
        <div class="card-footer">
          <a href="#/config" class="configure-link">Edit <code>integrations.media.tts</code> in Config Editor</a>
        </div>
      </div>
    `;
  }

  private _renderVisionCard() {
    const configured = !!this._providers?.vision;
    return html`
      <div class="config-card">
        <div class="card-header">
          <span class="status-dot ${configured ? "dot--active" : "dot--inactive"}"></span>
          <h3>Vision Analysis</h3>
          <span class="status-label">${configured ? "Configured" : "Not configured"}</span>
        </div>
        <div class="card-body">
          ${configured ? html`
            <div class="setting-row">
              <span class="setting-key">Providers</span>
              <span class="setting-value">${this._providers!.vision!.providers.join(", ")}</span>
            </div>
            ${this._providers!.vision!.defaultProvider ? html`
              <div class="setting-row">
                <span class="setting-key">Default</span>
                <span class="setting-value">${this._providers!.vision!.defaultProvider}</span>
              </div>
            ` : nothing}
            ${this._providers!.vision!.videoCapable.length > 0 ? html`
              <div class="setting-row">
                <span class="setting-key">Video capable</span>
                <span class="setting-value">${this._providers!.vision!.videoCapable.join(", ")}</span>
              </div>
            ` : nothing}
          ` : html`<p class="hint">Configure in <code>integrations.media.vision</code></p>`}
        </div>
        <div class="card-footer">
          <a href="#/config" class="configure-link">Edit <code>integrations.media.vision</code> in Config Editor</a>
        </div>
      </div>
    `;
  }

  private _renderDocumentCard() {
    const configured = !!this._providers?.documentExtraction?.enabled;
    return html`
      <div class="config-card">
        <div class="card-header">
          <span class="status-dot ${configured ? "dot--active" : "dot--inactive"}"></span>
          <h3>Document Extraction</h3>
          <span class="status-label">${configured ? "Configured" : "Not configured"}</span>
        </div>
        <div class="card-body">
          ${configured ? html`
            <div class="setting-row">
              <span class="setting-key">MIME types</span>
              <span class="setting-value">${this._providers!.documentExtraction!.supportedMimes.join(", ")}</span>
            </div>
          ` : html`<p class="hint">Configure in <code>integrations.media.documentExtraction</code></p>`}
        </div>
        <div class="card-footer">
          <a href="#/config" class="configure-link">Edit <code>integrations.media.documentExtraction</code> in Config Editor</a>
        </div>
      </div>
    `;
  }

  private _renderLinkCard() {
    const configured = !!this._providers?.linkUnderstanding?.enabled;
    return html`
      <div class="config-card">
        <div class="card-header">
          <span class="status-dot ${configured ? "dot--active" : "dot--inactive"}"></span>
          <h3>Link Understanding</h3>
          <span class="status-label">${configured ? "Configured" : "Not configured"}</span>
        </div>
        <div class="card-body">
          ${configured ? html`
            <div class="setting-row">
              <span class="setting-key">Max links</span>
              <span class="setting-value">${this._providers!.linkUnderstanding!.maxLinks}</span>
            </div>
          ` : html`<p class="hint">Configure in <code>integrations.media.linkUnderstanding</code></p>`}
        </div>
        <div class="card-footer">
          <a href="#/config" class="configure-link">Edit <code>integrations.media.linkUnderstanding</code> in Config Editor</a>
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  override render() {
    return html`
      <div class="header-row">
        <div class="header-title">Media Provider Configuration</div>
        <a href="#/media" class="back-link">Back to Media Tools</a>
      </div>
      ${this._loadState === "loading" ? html`<ic-skeleton-view variant="dashboard"></ic-skeleton-view>` : nothing}
      ${this._loadState === "error" ? html`
        <div class="error-state">
          <p>Failed to load media provider configuration.</p>
          <button class="btn-retry" @click=${this._loadData}>Retry</button>
        </div>
      ` : nothing}
      ${this._loadState === "loaded" ? html`
        <div class="cards-grid">
          ${this._renderSttCard()}
          ${this._renderTtsCard()}
          ${this._renderVisionCard()}
          ${this._renderDocumentCard()}
          ${this._renderLinkCard()}
        </div>
      ` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-media-config-view": IcMediaConfigView;
  }
}
