/**
 * Runtime log level control sub-editor.
 *
 * Renders: Info banner (runtime-only), global level selector, and per-module
 * level selectors for 9 hardcoded module presets.
 *
 * Emits `log-level-change` CustomEvent with { module?: string, level: string }.
 * Parent shell handles the daemon.setLogLevel RPC call.
 * Does NOT call RPC directly.
 */
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { RpcClient } from "../../../api/rpc-client.js";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

const MODULE_PRESETS = [
  "agent", "gateway", "channels", "memory",
  "scheduler", "daemon", "skills", "queue", "streaming",
] as const;

export interface LogLevelChangeDetail {
  module?: string;
  level: string;
}

@customElement("ic-agent-log-level-editor")
export class IcAgentLogLevelEditor extends LitElement {
  static override styles = css`
    :host { display: block; }

    .info-banner {
      background: color-mix(in srgb, var(--ic-info, #3b82f6) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--ic-info, #3b82f6) 30%, transparent);
      border-radius: var(--ic-radius-md);
      padding: var(--ic-space-sm) var(--ic-space-md);
      font-size: var(--ic-text-xs);
      color: var(--ic-text-muted, var(--ic-text-dim));
      margin-bottom: var(--ic-space-lg);
      line-height: 1.5;
    }

    .global-section {
      display: flex;
      align-items: center;
      gap: var(--ic-space-sm);
      margin-bottom: var(--ic-space-md);
    }

    .global-label {
      font-size: var(--ic-text-sm);
      font-weight: 600;
      color: var(--ic-text);
      min-width: 90px;
    }

    .level-select {
      background: var(--ic-surface-2);
      border: 1px solid var(--ic-border);
      border-radius: var(--ic-radius-md);
      padding: var(--ic-space-xs) var(--ic-space-sm);
      color: var(--ic-text);
      font-family: inherit;
      font-size: var(--ic-text-sm);
      outline: none;
      transition: border-color var(--ic-transition);
    }

    .level-select:focus {
      border-color: var(--ic-accent);
    }

    .btn-set {
      padding: var(--ic-space-xs) var(--ic-space-md);
      background: var(--ic-accent);
      color: white;
      border: none;
      border-radius: var(--ic-radius-md);
      font-size: var(--ic-text-xs);
      cursor: pointer;
      white-space: nowrap;
    }

    .btn-set:hover {
      opacity: 0.9;
    }

    .section-title {
      font-size: var(--ic-text-sm);
      font-weight: 600;
      color: var(--ic-text);
      margin-top: var(--ic-space-lg);
      margin-bottom: var(--ic-space-sm);
    }

    .divider {
      border: none;
      border-top: 1px solid var(--ic-border);
      margin: var(--ic-space-md) 0 var(--ic-space-xs);
    }

    .module-list {
      display: flex;
      flex-direction: column;
      gap: var(--ic-space-xs);
    }

    .module-row {
      display: flex;
      align-items: center;
      gap: var(--ic-space-sm);
      padding: var(--ic-space-xs) 0;
    }

    .module-name {
      font-size: var(--ic-text-sm);
      color: var(--ic-text);
      min-width: 90px;
      font-family: var(--ic-font-mono, monospace);
    }

    .applied-indicator {
      font-size: var(--ic-text-xs);
      color: var(--ic-success, #22c55e);
      margin-left: var(--ic-space-xs);
      opacity: 1;
      transition: opacity 0.3s ease;
    }
  `;

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property() applied = "";

  @state() private _levels: Record<string, string> = {};
  @state() private _globalLevel = "info";
  @state() private _applied: Record<string, boolean> = {};

  override willUpdate(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("applied") && this.applied) {
      this._applied = { ...this._applied, [this.applied]: true };
      setTimeout(() => {
        this._applied = { ...this._applied, [this.applied]: false };
      }, 3000);
    }
  }

  private _emitLogLevel(module: string | undefined, level: string): void {
    const detail: LogLevelChangeDetail = { level };
    if (module) detail.module = module;
    this.dispatchEvent(
      new CustomEvent<LogLevelChangeDetail>("log-level-change", {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _setGlobalLevel(): void {
    this._emitLogLevel(undefined, this._globalLevel);
  }

  private _setModuleLevel(mod: string): void {
    const level = this._levels[mod] ?? "info";
    this._emitLogLevel(mod, level);
  }

  override render() {
    return html`
      <div class="info-banner">
        Log level changes are runtime only and reset on daemon restart.
      </div>

      <div class="global-section">
        <span class="global-label">Global Level</span>
        <select
          class="level-select"
          .value=${this._globalLevel}
          @change=${(e: Event) => { this._globalLevel = (e.target as HTMLSelectElement).value; }}
        >
          ${LOG_LEVELS.map((lvl) => html`
            <option value=${lvl} ?selected=${this._globalLevel === lvl}>${lvl}</option>
          `)}
        </select>
        <button class="btn-set" @click=${() => this._setGlobalLevel()}>Set Global</button>
        ${this._applied["__global__"] ? html`<span class="applied-indicator">Applied</span>` : nothing}
      </div>

      <hr class="divider" />
      <div class="section-title">Per-Module Levels</div>

      <div class="module-list">
        ${MODULE_PRESETS.map((mod) => {
          const level = this._levels[mod] ?? "info";
          return html`
            <div class="module-row">
              <span class="module-name">${mod}</span>
              <select
                class="level-select"
                .value=${level}
                @change=${(e: Event) => {
                  this._levels = { ...this._levels, [mod]: (e.target as HTMLSelectElement).value };
                }}
              >
                ${LOG_LEVELS.map((lvl) => html`
                  <option value=${lvl} ?selected=${level === lvl}>${lvl}</option>
                `)}
              </select>
              <button class="btn-set" @click=${() => this._setModuleLevel(mod)}>Set</button>
              ${this._applied[mod] ? html`<span class="applied-indicator">Applied</span>` : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-agent-log-level-editor": IcAgentLogLevelEditor;
  }
}
