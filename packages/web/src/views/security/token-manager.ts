// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import type { RpcClient } from "../../api/rpc-client.js";
import { IcToast } from "../../components/feedback/ic-toast.js";

// Side-effect imports for sub-components used in template
import "../../components/data/ic-tag.js";

/** Token entry shape returned by tokens.list RPC. */
export interface TokenEntry {
  id: string;
  secret?: string;
  scopes: string[];
  createdAt?: number;
}

/**
 * Token CRUD and scope management sub-component.
 * Renders the token table, create form, and new-secret banner.
 * Communicates token changes back to parent via CustomEvent.
 *
 * @fires tokens-changed - Dispatched after token create/revoke/rotate
 */
@customElement("ic-token-manager")
export class IcTokenManager extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .grid-table {
        display: grid;
        width: 100%;
      }

      .grid-table--tokens {
        grid-template-columns: 1fr 1fr 10rem;
      }

      .grid-table .header-cell {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 2px solid var(--ic-border);
        background: var(--ic-surface);
      }

      .grid-table .data-cell {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        display: flex;
        align-items: center;
        border-bottom: 1px solid var(--ic-border);
        min-height: 2.25rem;
      }

      .scopes-cell {
        display: flex;
        gap: var(--ic-space-xs);
        flex-wrap: wrap;
      }

      .create-form {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        margin-top: var(--ic-space-lg);
        max-width: 32rem;
      }

      .create-form-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
        margin-bottom: var(--ic-space-sm);
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        margin-bottom: var(--ic-space-sm);
      }

      .form-label {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .checkbox-row {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        margin-bottom: var(--ic-space-xs);
      }

      .checkbox-row input[type="checkbox"] {
        accent-color: var(--ic-accent);
      }

      .checkbox-row label {
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        cursor: pointer;
      }

      .generate-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
      }

      .generate-btn:hover {
        opacity: 0.9;
      }

      .revoke-btn {
        padding: 0.25rem 0.5rem;
        background: none;
        border: 1px solid var(--ic-error);
        border-radius: var(--ic-radius-md);
        color: var(--ic-error);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        font-family: inherit;
      }

      .revoke-btn:hover {
        background: color-mix(in srgb, var(--ic-error) 10%, transparent);
      }

      .rotate-btn {
        padding: 0.25rem 0.5rem;
        background: none;
        border: 1px solid var(--ic-accent);
        border-radius: var(--ic-radius-md);
        color: var(--ic-accent);
        font-size: var(--ic-text-xs);
        cursor: pointer;
        font-family: inherit;
      }

      .rotate-btn:hover {
        background: color-mix(in srgb, var(--ic-accent) 10%, transparent);
      }

      .token-actions {
        display: flex;
        gap: var(--ic-space-xs);
      }

      .new-secret-banner {
        background: color-mix(in srgb, var(--ic-success) 10%, transparent);
        border: 1px solid var(--ic-success);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-sm) var(--ic-space-md);
        margin-top: var(--ic-space-md);
        max-width: 32rem;
      }

      .new-secret-banner .secret-label {
        font-size: var(--ic-text-xs);
        font-weight: 600;
        color: var(--ic-success);
        margin-bottom: var(--ic-space-xs);
      }

      .new-secret-banner .secret-value {
        font-family: ui-monospace, monospace;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        word-break: break-all;
      }

      .new-secret-banner .secret-warning {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: var(--ic-space-xs);
      }
    `,
  ];

  @property({ attribute: false }) rpc!: RpcClient;

  @state() private _tokens: TokenEntry[] = [];
  @state() private _newTokenScopes: string[] = [];
  @state() private _newSecretDisplay: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Defer loading until rpc is available (may arrive via property binding)
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpc") && this.rpc) {
      void this._loadTokens();
    }
  }

  private async _loadTokens(): Promise<void> {
    if (!this.rpc) return;
    try {
      const result = await this.rpc.call<{ tokens: TokenEntry[] }>("tokens.list");
      this._tokens = result.tokens ?? [];
    } catch {
      // Silently ignore -- parent handles top-level error state
    }
  }

  private async _revokeToken(tokenId: string): Promise<void> {
    if (!this.rpc) return;
    try {
      await this.rpc.call("tokens.revoke", { id: tokenId });
      this._tokens = this._tokens.filter((t) => t.id !== tokenId);
      IcToast.show(`Token "${tokenId}" revoked`, "success");
      this.dispatchEvent(new CustomEvent("tokens-changed", { bubbles: true, composed: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to revoke token";
      IcToast.show(msg, "error");
    }
  }

  private async _rotateToken(tokenId: string): Promise<void> {
    if (!this.rpc) return;
    try {
      const result = await this.rpc.call<{ id: string; secret: string }>("tokens.rotate", { id: tokenId });
      this._newSecretDisplay = result.secret;
      IcToast.show(`Token "${tokenId}" rotated -- new secret shown below`, "success");
      this.dispatchEvent(new CustomEvent("tokens-changed", { bubbles: true, composed: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to rotate token";
      IcToast.show(msg, "error");
    }
  }

  private _onScopeToggle(scope: string, checked: boolean): void {
    if (checked) {
      this._newTokenScopes = [...this._newTokenScopes, scope];
    } else {
      this._newTokenScopes = this._newTokenScopes.filter((s) => s !== scope);
    }
  }

  private async _generateToken(): Promise<void> {
    if (!this.rpc) return;
    try {
      const result = await this.rpc.call<{ id: string; secret: string; scopes: string[] }>(
        "tokens.create",
        { scopes: [...this._newTokenScopes] },
      );
      this._tokens = [...this._tokens, { id: result.id, scopes: result.scopes }];
      this._newSecretDisplay = result.secret;
      this._newTokenScopes = [];
      IcToast.show("Token created -- secret shown below", "success");
      this.dispatchEvent(new CustomEvent("tokens-changed", { bubbles: true, composed: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create token";
      IcToast.show(msg, "error");
    }
  }

  private _renderTokenRow(token: TokenEntry) {
    return html`
      <div class="data-cell" role="cell">${token.id}</div>
      <div class="data-cell scopes-cell" role="cell">
        ${token.scopes.map((s) => html`<ic-tag variant="info">${s}</ic-tag>`)}
      </div>
      <div class="data-cell" role="cell">
        <div class="token-actions">
          <button class="rotate-btn" @click=${() => this._rotateToken(token.id)}>Rotate</button>
          <button class="revoke-btn" @click=${() => this._revokeToken(token.id)}>Revoke</button>
        </div>
      </div>
    `;
  }

  override render() {
    return html`
      <div class="grid-table grid-table--tokens" role="table" aria-label="API tokens">
        <div class="header-cell" role="columnheader">Token ID</div>
        <div class="header-cell" role="columnheader">Scopes</div>
        <div class="header-cell" role="columnheader">Actions</div>
        ${this._tokens.map((t) => this._renderTokenRow(t))}
      </div>

      ${this._newSecretDisplay
        ? html`
            <div class="new-secret-banner">
              <div class="secret-label">New Token Secret</div>
              <div class="secret-value">${this._newSecretDisplay}</div>
              <div class="secret-warning">Copy this secret now. It will not be shown again.</div>
            </div>
          `
        : nothing}

      <div class="create-form">
        <div class="create-form-title">Create Token</div>
        <div class="form-field">
          <label class="form-label">Scopes</label>
          <div class="checkbox-row">
            <input type="checkbox" id="scope-rpc"
              .checked=${this._newTokenScopes.includes("rpc")}
              @change=${(e: Event) => this._onScopeToggle("rpc", (e.target as HTMLInputElement).checked)}
            /><label for="scope-rpc">rpc</label>
          </div>
          <div class="checkbox-row">
            <input type="checkbox" id="scope-ws"
              .checked=${this._newTokenScopes.includes("ws")}
              @change=${(e: Event) => this._onScopeToggle("ws", (e.target as HTMLInputElement).checked)}
            /><label for="scope-ws">ws</label>
          </div>
          <div class="checkbox-row">
            <input type="checkbox" id="scope-admin"
              .checked=${this._newTokenScopes.includes("admin")}
              @change=${(e: Event) => this._onScopeToggle("admin", (e.target as HTMLInputElement).checked)}
            /><label for="scope-admin">admin</label>
          </div>
          <div class="checkbox-row">
            <input type="checkbox" id="scope-api"
              .checked=${this._newTokenScopes.includes("api")}
              @change=${(e: Event) => this._onScopeToggle("api", (e.target as HTMLInputElement).checked)}
            /><label for="scope-api">api</label>
          </div>
          <div class="checkbox-row">
            <input type="checkbox" id="scope-all"
              .checked=${this._newTokenScopes.includes("*")}
              @change=${(e: Event) => this._onScopeToggle("*", (e.target as HTMLInputElement).checked)}
            /><label for="scope-all">* (all)</label>
          </div>
        </div>
        <button class="generate-btn" @click=${() => this._generateToken()}>Generate</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-token-manager": IcTokenManager;
  }
}
