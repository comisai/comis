/**
 * Template picker modal for the pipeline builder.
 *
 * Displays a grid of 6 pre-built graph templates and a JSON import
 * option. Follows the same modal pattern as ic-confirm-dialog:
 * fixed backdrop, centered dialog, focus trap, Escape to close,
 * backdrop click to close.
 *
 * @fires template-select - User picked a template or imported valid JSON.
 *   Detail: { nodes: PipelineNode[], edges: PipelineEdge[], settings: Partial<GraphSettings> }
 * @fires cancel - User dismissed the modal (Escape, backdrop click, or Cancel button).
 *
 * @example
 * ```html
 * <ic-template-picker
 *   .open=${true}
 *   @template-select=${this._onTemplateSelect}
 *   @cancel=${this._onPickerCancel}
 * ></ic-template-picker>
 * ```
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import { GRAPH_TEMPLATES, type GraphTemplate } from "../../utils/graph-templates.js";
import type {
  PipelineNode,
  PipelineEdge,
  GraphSettings,
  NodePosition,
} from "../../api/types/index.js";

@customElement("ic-template-picker")
export class IcTemplatePicker extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: contents;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .dialog {
        max-width: 40rem;
        width: calc(100% - var(--ic-space-lg) * 2);
        max-height: calc(100vh - var(--ic-space-lg) * 2);
        overflow-y: auto;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-lg);
        padding: var(--ic-space-lg);
        box-shadow: var(--ic-shadow-lg);
      }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--ic-space-md);
      }

      .title {
        font-size: var(--ic-text-lg);
        font-weight: 600;
        color: var(--ic-text);
        margin: 0;
      }

      .toggle-link {
        background: none;
        border: none;
        color: var(--ic-accent);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        padding: 0;
        font-family: inherit;
        text-decoration: underline;
      }

      .toggle-link:hover {
        color: var(--ic-accent-hover);
      }

      /* Template grid */

      .template-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--ic-space-md);
        margin-bottom: var(--ic-space-lg);
      }

      @media (max-width: 480px) {
        .template-grid {
          grid-template-columns: 1fr;
        }
      }

      .template-card {
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        cursor: pointer;
        transition:
          border-color var(--ic-transition),
          background var(--ic-transition);
        text-align: center;
        background: transparent;
        color: inherit;
        font-family: inherit;
        width: 100%;
      }

      .template-card:hover {
        border-color: var(--ic-accent);
        background: var(--ic-surface-2, rgba(255, 255, 255, 0.03));
      }

      .card-icon {
        font-size: 2rem;
        line-height: 1;
        margin-bottom: var(--ic-space-xs);
      }

      .card-name {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-xs);
      }

      .card-desc {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        line-height: 1.4;
        margin-bottom: var(--ic-space-xs);
      }

      .card-meta {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim, var(--ic-text-muted));
      }

      /* JSON import */

      .json-section {
        margin-bottom: var(--ic-space-lg);
      }

      .json-textarea {
        width: 100%;
        min-height: 12rem;
        padding: var(--ic-space-sm);
        background: var(--ic-surface-2, var(--ic-surface));
        color: var(--ic-text);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        font-family: monospace;
        font-size: var(--ic-text-sm);
        resize: vertical;
      }

      .json-textarea::placeholder {
        color: var(--ic-text-muted);
      }

      .json-error {
        color: var(--ic-error);
        font-size: var(--ic-text-xs);
        margin-top: var(--ic-space-xs);
      }

      .import-btn {
        margin-top: var(--ic-space-sm);
        padding: var(--ic-space-sm) var(--ic-space-md);
        background: var(--ic-accent);
        border: 1px solid var(--ic-accent);
        border-radius: var(--ic-radius-md);
        color: #fff;
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition);
      }

      .import-btn:hover {
        background: var(--ic-accent-hover);
      }

      /* Footer */

      .footer {
        display: flex;
        justify-content: flex-end;
      }

      .cancel-btn {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        background: transparent;
        border: 1px solid var(--ic-border);
        color: var(--ic-text-muted);
        transition:
          background var(--ic-transition),
          border-color var(--ic-transition);
      }

      .cancel-btn:hover {
        border-color: var(--ic-text-dim, var(--ic-text-muted));
        color: var(--ic-text);
      }
    `,
  ];

  // -------------------------------------------------------------------------
  // Properties
  // -------------------------------------------------------------------------

  /** Whether the picker modal is visible. */
  @property({ type: Boolean, reflect: true }) open = false;

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  @state() private _showJsonImport = false;
  @state() private _jsonError = "";
  @state() private _jsonText = "";

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      // Reset internal state when opening
      this._showJsonImport = false;
      this._jsonError = "";
      this._jsonText = "";

      // Focus first interactive element after render
      this.updateComplete.then(() => {
        const first = this.shadowRoot?.querySelector<HTMLElement>(
          "button.template-card, button.cancel-btn",
        );
        first?.focus();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private _onBackdropClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains("backdrop")) {
      this._fireCancel();
    }
  }

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this._fireCancel();
      return;
    }

    // Focus trap: Tab/Shift+Tab cycle within dialog
    if (e.key === "Tab") {
      const focusable = this.shadowRoot?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), textarea",
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = this.shadowRoot?.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  private _onTemplateClick(template: GraphTemplate): void {
    const { nodes, edges, settings } = template.create();
    this.dispatchEvent(
      new CustomEvent("template-select", {
        detail: { nodes, edges, settings },
        bubbles: true,
        composed: true,
      }),
    );
    this._fireCancel();
  }

  private _onToggleJsonImport(): void {
    this._showJsonImport = !this._showJsonImport;
    this._jsonError = "";
  }

  private _onJsonInput(e: InputEvent): void {
    this._jsonText = (e.target as HTMLTextAreaElement).value;
    this._jsonError = "";
  }

  private _onJsonImport(): void {
    const text = this._jsonText.trim();
    if (!text) {
      this._jsonError = "Please paste JSON content.";
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this._jsonError = "Invalid JSON. Please check your syntax.";
      return;
    }

    // Validate structure: must have nodes array
    const rawNodes = parsed.nodes;
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
      this._jsonError =
        "JSON must contain a \"nodes\" array with at least one node.";
      return;
    }

    // Validate each node has nodeId and task
    for (let i = 0; i < rawNodes.length; i++) {
      const n = rawNodes[i] as Record<string, unknown>;
      if (!n || typeof n !== "object") {
        this._jsonError = `Node at index ${i} is not a valid object.`;
        return;
      }
      // Accept either nodeId (server format) or id (builder format)
      const nodeId = (n.nodeId ?? n.id) as string | undefined;
      if (typeof nodeId !== "string" || !nodeId) {
        this._jsonError = `Node at index ${i} is missing "nodeId" or "id" (string).`;
        return;
      }
      if (typeof n.task !== "string" || !n.task) {
        this._jsonError = `Node at index ${i} is missing "task" (string).`;
        return;
      }
    }

    // Convert server format to builder format
    const { nodes, edges } = convertImportedGraph(rawNodes);
    const label =
      typeof parsed.label === "string" && parsed.label
        ? parsed.label
        : "Imported Pipeline";
    const onFailure =
      parsed.onFailure === "continue" ? "continue" : "fail-fast";

    const settings: Partial<GraphSettings> = { label, onFailure };
    if (typeof parsed.timeoutMs === "number") {
      (settings as Record<string, unknown>).timeoutMs = parsed.timeoutMs;
    }

    this.dispatchEvent(
      new CustomEvent("template-select", {
        detail: { nodes, edges, settings },
        bubbles: true,
        composed: true,
      }),
    );
    this._fireCancel();
  }

  private _fireCancel(): void {
    this.dispatchEvent(new CustomEvent("cancel"));
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  override render() {
    if (!this.open) return nothing;

    return html`
      <div
        class="backdrop"
        @click=${this._onBackdropClick}
        @keydown=${this._onKeyDown}
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="picker-title"
        >
          <div class="header">
            <h2 class="title" id="picker-title">Choose a Template</h2>
            <button
              class="toggle-link"
              @click=${this._onToggleJsonImport}
            >
              ${this._showJsonImport ? "Back to templates" : "Or import JSON"}
            </button>
          </div>

          ${this._showJsonImport
            ? this._renderJsonImport()
            : this._renderTemplateGrid()}

          <div class="footer">
            <button class="cancel-btn" @click=${this._fireCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private _renderTemplateGrid() {
    return html`
      <div class="template-grid">
        ${GRAPH_TEMPLATES.map(
          (t) => html`
            <button
              class="template-card"
              @click=${() => this._onTemplateClick(t)}
            >
              <div class="card-icon">${t.icon}</div>
              <div class="card-name">${t.name}</div>
              <div class="card-desc">${t.description}</div>
              <div class="card-meta">${t.nodeCount}</div>
            </button>
          `,
        )}
      </div>
    `;
  }

  private _renderJsonImport() {
    return html`
      <div class="json-section">
        <textarea
          class="json-textarea"
          rows="12"
          placeholder="Paste ExecutionGraph JSON..."
          .value=${this._jsonText}
          @input=${this._onJsonInput}
        ></textarea>
        ${this._jsonError
          ? html`<div class="json-error">${this._jsonError}</div>`
          : nothing}
        <button class="import-btn" @click=${this._onJsonImport}>
          Import
        </button>
      </div>
    `;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Y-spacing between auto-laid-out nodes */
const Y_SPACING = 170;

/**
 * Convert imported graph nodes (server format) to builder format with
 * derived edges and auto-assigned positions.
 */
function convertImportedGraph(rawNodes: unknown[]): {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
} {
  const nodes: PipelineNode[] = [];
  const edges: PipelineEdge[] = [];

  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i] as Record<string, unknown>;
    const id = ((raw.nodeId ?? raw.id) as string).trim();
    const task = (raw.task as string).trim();
    const dependsOn = Array.isArray(raw.dependsOn)
      ? (raw.dependsOn as string[]).filter((d) => typeof d === "string")
      : [];

    const position: NodePosition = {
      x: 300,
      y: 50 + i * Y_SPACING,
    };

    // Preserve optional fields if present
    const node: PipelineNode = {
      id,
      task,
      dependsOn,
      position,
      ...(typeof raw.agentId === "string" && raw.agentId
        ? { agentId: raw.agentId }
        : {}),
      ...(typeof raw.maxSteps === "number"
        ? { maxSteps: raw.maxSteps }
        : {}),
      ...(typeof raw.timeoutMs === "number"
        ? { timeoutMs: raw.timeoutMs }
        : {}),
      ...(raw.barrierMode === "all" ||
      raw.barrierMode === "majority" ||
      raw.barrierMode === "best-effort"
        ? { barrierMode: raw.barrierMode }
        : {}),
      ...(typeof raw.model === "string" && raw.model
        ? { modelId: raw.model }
        : typeof raw.modelId === "string" && raw.modelId
          ? { modelId: raw.modelId }
          : {}),
      ...(typeof raw.retries === "number" && raw.retries >= 0 && raw.retries <= 3
        ? { retries: raw.retries }
        : {}),
      ...(raw.contextMode === "full" || raw.contextMode === "summary" || raw.contextMode === "none"
        ? { contextMode: raw.contextMode }
        : raw.context_mode === "full" || raw.context_mode === "summary" || raw.context_mode === "none"
          ? { contextMode: raw.context_mode as PipelineNode["contextMode"] }
          : {}),
      typeId: raw.typeId as PipelineNode["typeId"],
      typeConfig: raw.typeConfig && typeof raw.typeConfig === "object" ? raw.typeConfig as Record<string, unknown> : undefined,
    };

    nodes.push(node);

    // Derive edges from dependsOn
    for (const dep of dependsOn) {
      edges.push({
        id: `${dep}->${id}`,
        source: dep,
        target: id,
      });
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Type augmentation
// ---------------------------------------------------------------------------

declare global {
  interface HTMLElementTagNameMap {
    "ic-template-picker": IcTemplatePicker;
  }
}
