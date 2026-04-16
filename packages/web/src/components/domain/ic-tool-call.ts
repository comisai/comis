import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

// Side-effect imports to register child components
import "./ic-code-block.js";
import "../display/ic-icon.js";
import "../feedback/ic-loading.js";

/**
 * Format a value as a JSON string for display.
 * Handles objects, strings, and other types.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Collapsible tool invocation block showing tool name, input parameters,
 * and output with expand/collapse toggle.
 *
 * Displays a header with tool name, status indicator (running/success/error),
 * and a chevron that toggles the expanded body. The body shows input and
 * output as formatted JSON code blocks.
 *
 * @example
 * ```html
 * <ic-tool-call
 *   toolName="memory_search"
 *   .input=${{ query: "hello" }}
 *   .output=${{ results: [] }}
 *   status="success"
 * ></ic-tool-call>
 * ```
 */
@customElement("ic-tool-call")
export class IcToolCall extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .container {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        margin: var(--ic-space-xs) 0;
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-sm) var(--ic-space-md);
        cursor: pointer;
        border: none;
        background: none;
        width: 100%;
        color: inherit;
        font: inherit;
        text-align: left;
        transition: background var(--ic-transition);
      }

      .header:hover {
        background: var(--ic-surface-2);
      }

      .chevron {
        display: inline-flex;
        color: var(--ic-text-dim);
        transition: transform 150ms ease;
        flex-shrink: 0;
      }

      .chevron--expanded {
        transform: rotate(90deg);
      }

      .tool-icon {
        flex-shrink: 0;
      }

      .tool-name {
        font-family: var(--ic-font-mono);
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        font-weight: 500;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .status {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
      }

      .body {
        border-top: 1px solid var(--ic-border);
        padding: var(--ic-space-sm) var(--ic-space-md) var(--ic-space-md);
      }

      .section-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: 500;
        margin-bottom: var(--ic-space-xs);
      }

      .section + .section {
        margin-top: var(--ic-space-sm);
      }

      .show-full {
        background: none;
        border: none;
        color: var(--ic-accent);
        cursor: pointer;
        font-size: var(--ic-text-xs);
        padding: 0;
        margin-top: var(--ic-space-xs);
        font-family: inherit;
      }

      .show-full:hover {
        text-decoration: underline;
      }
    `,
  ];

  /** Tool name (e.g., "memory_search", "bash"). */
  @property() toolName = "";

  /** Tool input parameters (object or string). */
  @property({ attribute: false }) input: unknown = null;

  /** Tool output (object or string). */
  @property({ attribute: false }) output: unknown = null;

  /** Whether the block is expanded. */
  @property({ type: Boolean }) expanded = false;

  /** Execution status. */
  @property() status: "running" | "success" | "error" = "success";

  @state() private _showFullOutput = false;

  private _toggleExpanded(): void {
    this.expanded = !this.expanded;
  }

  private _handleHeaderKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this._toggleExpanded();
    }
  }

  private _renderStatus() {
    switch (this.status) {
      case "running":
        return html`<ic-loading size="sm"></ic-loading>`;
      case "success":
        return html`<ic-icon name="check" size="16px" color="var(--ic-success)"></ic-icon>`;
      case "error":
        return html`<ic-icon name="x" size="16px" color="var(--ic-error)"></ic-icon>`;
    }
  }

  private _renderBody() {
    if (!this.expanded) return nothing;

    return html`
      <div class="body">
        ${this.input != null
          ? html`
              <div class="section">
                <div class="section-label">Input</div>
                <ic-code-block
                  language=${typeof this.input === "string" ? "" : "json"}
                  .code=${formatValue(this.input)}
                ></ic-code-block>
              </div>
            `
          : nothing}
        ${this.output != null ? this._renderOutput() : nothing}
      </div>
    `;
  }

  private _renderOutput() {
    const raw = formatValue(this.output);
    const isTruncated = raw.length > 500 && !this._showFullOutput;
    const displayValue = isTruncated ? raw.slice(0, 500) + "... (truncated)" : raw;

    return html`
      <div class="section">
        <div class="section-label">Output</div>
        <ic-code-block
          language=${typeof this.output === "string" ? "" : "json"}
          .code=${displayValue}
        ></ic-code-block>
        ${isTruncated
          ? html`
              <button class="show-full" @click=${() => { this._showFullOutput = true; }}>
                Show full
              </button>
            `
          : nothing}
      </div>
    `;
  }

  override render() {
    const chevronClass = this.expanded ? "chevron chevron--expanded" : "chevron";

    return html`
      <div
        class="container"
        role="group"
        aria-label="Tool call: ${this.toolName}"
      >
        <button
          class="header"
          @click=${this._toggleExpanded}
          @keydown=${this._handleHeaderKeyDown}
          aria-expanded="${this.expanded}"
        >
          <span class=${chevronClass}>
            <ic-icon name="chevron-right" size="16px"></ic-icon>
          </span>
          <span class="tool-icon">
            <ic-icon name="skills" size="16px" color="var(--ic-text-muted)"></ic-icon>
          </span>
          <span class="tool-name">${this.toolName}</span>
          <span class="status">${this._renderStatus()}</span>
        </button>
        ${this._renderBody()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-tool-call": IcToolCall;
  }
}
