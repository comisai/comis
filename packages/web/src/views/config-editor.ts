import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import type {
  ConfigHistoryEntry,
  ConfigHistoryResponse,
  ConfigDiffResponse,
  ConfigRollbackResponse,
  ConfigGcResponse,
} from "../api/types/config-types.js";

// Side-effect imports for sub-components
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";
import "../components/shell/ic-skeleton-view.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-relative-time.js";
import "../components/nav/ic-tabs.js";
import "../components/form/ic-toggle.js";
import "../components/form/ic-select.js";
import "../components/form/ic-array-editor.js";
import "../components/domain/ic-diff-viewer.js";

// Sub-component imports
import "./config-editor/schema-form.js";

// Re-export YAML utilities from extracted module for backward compatibility
import { serializeYaml, parseYaml } from "./config-editor/yaml-serializer.js";
export { serializeYaml as serializeToYaml, parseYaml };

import type { TabDef } from "../components/nav/ic-tabs.js";
import type { SchemaProperty } from "./config-editor/schema-form.js";

type LoadState = "loading" | "loaded" | "error";

/** Top-level tab definitions for the Settings view. */
const TABS: TabDef[] = [
  { id: "editor", label: "YAML Editor" },
  { id: "gateway", label: "Gateway" },
  { id: "history", label: "History" },
  { id: "wizard", label: "Setup Wizard" },
];

/** Gateway configuration shape returned by config.read for the gateway section. */
interface GatewayConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  cors?: { origins?: string[] };
  tokens?: Array<{ id: string; scopes?: string[] }>;
}

/** Editing mode for config sections. */
type EditorMode = "form" | "yaml" | "schema";

// SchemaProperty imported from ./config-editor/schema-form.js

/* Internal aliases for coordinator use */
const serializeToYaml = serializeYaml;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Get a nested value from an object by dot-path. */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set a nested value in an object by dot-path. Returns a new object (shallow clones). */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split(".");
  if (parts.length === 1) {
    return { ...obj, [parts[0]]: value };
  }

  const [head, ...rest] = parts;
  const child = (obj[head] ?? {}) as Record<string, unknown>;
  return { ...obj, [head]: setNestedValue(child, rest.join("."), value) };
}

/* ------------------------------------------------------------------ */
/*  Config Editor View                                                 */
/* ------------------------------------------------------------------ */

/**
 * Config editor view with section navigation sidebar, 3 editing modes
 * (Form, YAML, Schema), apply/import/export functionality.
 *
 * Loads configuration via config.read and config.schema RPCs.
 * Applies changes via config.apply RPC.
 *
 * Covers section navigation, form/YAML/schema editing modes, apply, import, and export.
 */
@customElement("ic-config-editor")
export class IcConfigEditor extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .view-header {
        margin-bottom: var(--ic-space-lg);
      }

      .view-title {
        font-size: 1.125rem;
        font-weight: 600;
      }

      /* Loading & error states */
      .state-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 3rem;
      }

      .error-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.75rem;
        padding: 3rem;
      }

      .error-message {
        color: var(--ic-error);
        font-size: var(--ic-text-sm);
      }

      .retry-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        font-family: inherit;
      }

      .retry-btn:hover {
        background: var(--ic-border);
      }

      /* Main layout: sidebar + content */
      .editor-layout {
        display: grid;
        grid-template-columns: 220px 1fr;
        gap: var(--ic-space-lg);
        min-height: 500px;
      }

      /* Section sidebar */
      .section-sidebar {
        display: flex;
        flex-direction: column;
        gap: 2px;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-xs);
        overflow-y: auto;
        max-height: 80vh;
      }

      .section-item {
        padding: 0.5rem 1rem;
        cursor: pointer;
        border-left: 3px solid transparent;
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        transition: background var(--ic-transition, 0.15s), color var(--ic-transition, 0.15s);
      }

      .section-item:hover {
        background: var(--ic-surface-2);
        color: var(--ic-text);
      }

      .section-item[data-selected] {
        border-left-color: var(--ic-accent);
        background: var(--ic-surface-2);
        color: var(--ic-text);
        font-weight: 500;
      }

      /* Content area */
      .content-area {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md);
        min-width: 0;
      }

      /* Toolbar: mode tabs + action buttons */
      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-md);
        flex-wrap: wrap;
      }

      .mode-tabs {
        display: inline-flex;
        gap: 2px;
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: 2px;
      }

      .mode-btn {
        padding: 0.375rem 0.75rem;
        border: none;
        border-radius: var(--ic-radius-sm);
        background: transparent;
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition, 0.15s), color var(--ic-transition, 0.15s);
      }

      .mode-btn:hover {
        color: var(--ic-text);
      }

      .mode-btn[data-active] {
        background: var(--ic-accent);
        color: white;
      }

      .action-buttons {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .apply-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs);
      }

      .apply-btn:hover {
        opacity: 0.9;
      }

      .apply-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .secondary-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .secondary-btn:hover {
        background: var(--ic-border);
      }

      /* Form mode CSS extracted to ic-schema-form sub-component */

      /* YAML mode */
      .yaml-editor {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .yaml-textarea {
        width: 100%;
        min-height: 400px;
        padding: 1rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-sm);
        line-height: 1.5;
        tab-size: 2;
        white-space: pre;
        resize: vertical;
      }

      .yaml-textarea:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .yaml-validation {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
      }

      .yaml-validation--valid {
        background: color-mix(in srgb, var(--ic-success) 10%, transparent);
        color: var(--ic-success);
        border: 1px solid color-mix(in srgb, var(--ic-success) 30%, transparent);
      }

      .yaml-validation--error {
        background: color-mix(in srgb, var(--ic-error) 10%, transparent);
        color: var(--ic-error);
        border: 1px solid color-mix(in srgb, var(--ic-error) 30%, transparent);
      }

      /* Schema mode */
      .schema-tree {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .schema-row {
        display: flex;
        align-items: baseline;
        gap: var(--ic-space-sm);
        padding: var(--ic-space-xs) 0;
      }

      .schema-key {
        font-weight: 600;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: var(--ic-space-xs);
        user-select: none;
      }

      .schema-key .arrow {
        font-size: var(--ic-text-xs);
        transition: transform var(--ic-transition, 0.15s);
        display: inline-block;
      }

      .schema-key .arrow[data-expanded] {
        transform: rotate(90deg);
      }

      .schema-desc {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .schema-constraints {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-muted);
        font-style: italic;
      }

      .schema-children {
        padding-left: 1.5rem;
      }

      .required-marker {
        color: var(--ic-error);
        font-weight: 600;
      }

      /* Hidden file input for import */
      .hidden-input {
        display: none;
      }

      /* Spinner */
      .spinner {
        display: inline-block;
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      /* Diff preview toggle */
      .diff-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .diff-btn:hover {
        background: var(--ic-border);
      }

      .diff-btn[data-active] {
        background: var(--ic-accent);
        color: #fff;
        border-color: var(--ic-accent);
      }

      /* Rollback button */
      .rollback-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text-muted);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      .rollback-btn:hover {
        border-color: var(--ic-error);
        color: var(--ic-error);
      }

      /* Diff viewer container */
      .diff-preview {
        margin-top: var(--ic-space-md);
      }

      /* Gateway tab */
      .gateway-form {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-lg);
        max-width: 36rem;
        padding: var(--ic-space-md) 0;
      }

      .gateway-field {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .gateway-label {
        font-size: var(--ic-text-sm);
        font-weight: 500;
        color: var(--ic-text-muted);
      }

      .gateway-input {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .gateway-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .gateway-tokens {
        padding: var(--ic-space-md);
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
      }

      .gateway-tokens-label {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text);
        margin-bottom: var(--ic-space-sm);
      }

      .gateway-tokens-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
      }

      .gateway-token-entry {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
      }

      .gateway-token-id {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs);
      }

      .gateway-tokens-link {
        color: var(--ic-accent);
        font-size: var(--ic-text-sm);
        text-decoration: none;
        margin-top: var(--ic-space-sm);
        display: inline-block;
        cursor: pointer;
      }

      .gateway-tokens-link:hover {
        text-decoration: underline;
      }

      /* Setup wizard tab */
      .wizard-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--ic-space-lg);
        padding: 3rem var(--ic-space-lg);
        text-align: center;
      }

      .wizard-description {
        font-size: var(--ic-text-sm);
        color: var(--ic-text-muted);
        max-width: 32rem;
        line-height: 1.6;
      }

      .wizard-btn {
        padding: 0.75rem 2rem;
        background: var(--ic-accent);
        color: #fff;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        font-family: inherit;
        font-weight: 500;
        cursor: pointer;
      }

      .wizard-btn:hover {
        filter: brightness(1.1);
      }

      /* History tab */
      .history-layout {
        display: grid;
        grid-template-columns: 350px 1fr;
        gap: var(--ic-space-md);
        min-height: 400px;
      }

      @media (max-width: 768px) {
        .history-layout {
          grid-template-columns: 1fr;
        }
      }

      .history-timeline {
        overflow-y: auto;
        max-height: 70vh;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        background: var(--ic-surface);
      }

      .history-entry {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
        cursor: pointer;
        transition: background var(--ic-transition, 0.15s);
        border-left: 3px solid transparent;
        position: relative;
      }

      .history-entry:hover {
        background: var(--ic-surface-2);
      }

      .history-entry--selected {
        border-left: 3px solid var(--ic-accent);
        background: var(--ic-surface-2);
      }

      .history-entry-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 2px;
      }

      .history-sha {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .history-entry-summary {
        font-size: var(--ic-text-sm);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--ic-text);
        margin-bottom: 4px;
      }

      .history-entry-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .history-author {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
      }

      .history-diff-panel {
        display: flex;
        flex-direction: column;
        overflow: auto;
      }

      .diff-unified {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-sm);
        overflow-x: auto;
        white-space: pre;
        padding: var(--ic-space-md);
        background: var(--ic-surface);
        border-radius: var(--ic-radius-md);
        border: 1px solid var(--ic-border);
        margin: 0;
        line-height: 1.5;
      }

      .diff-line--add {
        background: rgba(34, 197, 94, 0.15);
        display: block;
      }

      .diff-line--remove {
        background: rgba(239, 68, 68, 0.15);
        display: block;
      }

      .diff-line--hunk {
        color: var(--ic-text-dim);
        font-style: italic;
        display: block;
      }

      .diff-line--context {
        display: block;
      }

      .history-actions {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        padding-top: var(--ic-space-md);
      }

      .history-rollback-link {
        font-size: var(--ic-text-xs);
        color: var(--ic-accent);
        cursor: pointer;
        background: none;
        border: none;
        font-family: inherit;
        padding: 0;
      }

      .history-rollback-link:hover {
        text-decoration: underline;
      }
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /* ---- Top-level tab state ---- */
  @state() private _activeTab = "editor";

  /* ---- Editor tab state ---- */
  @state() private _loadState: LoadState = "loading";
  @state() private _error = "";
  @state() private _sections: string[] = [];
  @state() private _selectedSection = "";
  @state() private _mode: EditorMode = "form";
  @state() private _configData: Record<string, unknown> = {};
  @state() private _schemaData: Record<string, SchemaProperty> = {};
  @state() private _yamlText = "";
  @state() private _yamlErrors: string[] = [];
  @state() private _formState: Record<string, unknown> = {};
  @state() private _formErrors: Record<string, string> = {};
  @state() private _dirty = false;
  @state() private _applying = false;
  @state() private _expandedPaths = new Set<string>();
  // _expandedFormPaths moved to ic-schema-form sub-component

  /* ---- Diff preview state ---- */
  @state() private _showDiff = false;
  @state() private _savedYaml = "";

  /* ---- Rollback state ---- */
  @state() private _rollbackSnapshot: Record<string, unknown> | null = null;
  @state() private _confirmRollback = false;

  /* ---- Gateway tab state ---- */
  @state() private _gatewayConfig: GatewayConfig | null = null;
  @state() private _gatewayLoading = false;
  @state() private _gatewayError = "";

  /* ---- History tab state ---- */
  @state() private _historyEntries: ConfigHistoryEntry[] = [];
  @state() private _historyLoading = false;
  @state() private _historyError = "";
  @state() private _selectedSha: string | null = null;
  @state() private _diffText = "";
  @state() private _diffLoading = false;
  @state() private _confirmRollbackSha: string | null = null;
  @state() private _gcRunning = false;

  private _historyReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private _yamlDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _rpcStatusUnsub: (() => void) | null = null;
  private _dataLoaded = false;
  private _configPatchedHandler: ((e: Event) => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Listen for external config changes via SSE
    this._configPatchedHandler = () => {
      if (this._dataLoaded && !this._dirty) this._tryLoad();
      if (this._activeTab === "history") this._scheduleHistoryReload();
    };
    document.addEventListener("config:patched", this._configPatchedHandler);
  }

  /** Trailing-edge debounce for history reload on SSE events. */
  private _scheduleHistoryReload(): void {
    if (this._historyReloadTimer !== null) clearTimeout(this._historyReloadTimer);
    this._historyReloadTimer = setTimeout(() => {
      this._historyReloadTimer = null;
      this._loadHistory();
    }, 300);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._yamlDebounceTimer !== null) {
      clearTimeout(this._yamlDebounceTimer);
    }
    if (this._historyReloadTimer !== null) {
      clearTimeout(this._historyReloadTimer);
    }
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
    if (this._configPatchedHandler) {
      document.removeEventListener("config:patched", this._configPatchedHandler);
      this._configPatchedHandler = null;
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has("rpcClient") && this.rpcClient) {
      this._tryLoad();
    }
  }

  /** Wait for RPC connection before loading data. */
  private _tryLoad(): void {
    if (!this.rpcClient) return;
    this._rpcStatusUnsub?.();
    if (this.rpcClient.status === "connected") {
      this._loadData();
    } else {
      this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
        if (status === "connected" && !this._dataLoaded) {
          this._loadData();
        }
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Data loading                                                     */
  /* ---------------------------------------------------------------- */

  private async _loadData(): Promise<void> {
    if (!this.rpcClient) return;

    this._loadState = "loading";
    this._error = "";

    try {
      // Load config first (primary data for the editor)
      const configResult = await this.rpcClient.call<{ config: Record<string, unknown>; sections: string[] }>("config.read");

      this._sections = configResult.sections;
      this._configData = configResult.config;

      if (this._sections.length > 0 && !this._selectedSection) {
        this._selectedSection = this._sections[0];
        this._loadSectionState();
      }

      this._loadState = "loaded";
      this._dataLoaded = true;

      // Load schema in the background (enables validation/hints)
      this.rpcClient.call<{ schema: Record<string, SchemaProperty>; sections: string[] }>("config.schema")
        .then((schemaResult) => {
          const rootSchema = schemaResult.schema as Record<string, unknown>;
          this._schemaData = (rootSchema.properties ?? rootSchema) as Record<string, SchemaProperty>;
        })
        // eslint-disable-next-line no-restricted-syntax -- Fire-and-forget UI action
        .catch(() => { /* schema is supplementary */ });
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to load configuration";
      this._loadState = "error";
    }
  }

  /** Load form/YAML state for the currently selected section. */
  private _loadSectionState(): void {
    const sectionData = this._configData[this._selectedSection] ?? {};
    this._formState = structuredClone(sectionData) as Record<string, unknown>;
    this._yamlText = serializeToYaml(sectionData);
    this._savedYaml = this._yamlText;
    this._yamlErrors = [];
    this._formErrors = {};
    this._dirty = false;
    this._showDiff = false;

    // Start all tree nodes collapsed by default
    this._expandedPaths = new Set<string>();
  }

  /* ---------------------------------------------------------------- */
  /*  Section navigation                                               */
  /* ---------------------------------------------------------------- */

  private _onSectionClick(section: string): void {
    if (section === this._selectedSection) return;
    this._selectedSection = section;
    this._loadSectionState();
  }

  /* ---------------------------------------------------------------- */
  /*  Mode switching                                                   */
  /* ---------------------------------------------------------------- */

  private _onModeChange(mode: EditorMode): void {
    if (mode === this._mode) return;

    // Sync data between modes
    if (this._mode === "form" && mode === "yaml") {
      this._yamlText = serializeToYaml(this._formState);
    } else if (this._mode === "yaml" && mode === "form") {
      if (this._yamlErrors.length === 0) {
        const parsed = parseYaml(this._yamlText);
        if (!parsed.error && parsed.data && typeof parsed.data === "object") {
          this._formState = parsed.data as Record<string, unknown>;
        }
      }
    }

    this._mode = mode;
  }

  /* ---------------------------------------------------------------- */
  /*  Form mode                                                        */
  /* ---------------------------------------------------------------- */

  /* Form field rendering extracted to ./config-editor/schema-form.ts */


  private _renderFormMode() {
    const schema = this._schemaData[this._selectedSection] ?? {};
    return html`
      <ic-schema-form
        .schema=${schema}
        .config=${this._formState}
        .sectionKey=${this._selectedSection}
        @field-change=${(e: CustomEvent<{ path: string; value: unknown; formState: Record<string, unknown> }>) => {
          const { path, value, formState } = e.detail;
          this._formState = formState ?? setNestedValue(this._formState, path, value);
          this._dirty = true;
          const newErrors = { ...this._formErrors };
          delete newErrors[path];
          this._formErrors = newErrors;
        }}
      ></ic-schema-form>
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  YAML mode                                                        */
  /* ---------------------------------------------------------------- */

  private _onYamlInput(e: Event): void {
    this._yamlText = (e.target as HTMLTextAreaElement).value;
    this._dirty = true;

    // Debounced validation
    if (this._yamlDebounceTimer !== null) {
      clearTimeout(this._yamlDebounceTimer);
    }
    this._yamlDebounceTimer = setTimeout(() => {
      this._validateYaml();
    }, 500);
  }

  private _validateYaml(): void {
    const result = parseYaml(this._yamlText);
    if (result.error) {
      this._yamlErrors = [result.error];
    } else {
      this._yamlErrors = [];
    }
  }

  private _renderYamlMode() {
    return html`
      <div class="yaml-editor">
        <textarea
          class="yaml-textarea"
          .value=${this._yamlText}
          @input=${(e: Event) => this._onYamlInput(e)}
          spellcheck="false"
          aria-label="YAML editor"
        ></textarea>
        ${this._yamlErrors.length > 0
          ? html`
              <div class="yaml-validation yaml-validation--error">
                ${this._yamlErrors.map((err) => html`<div>${err}</div>`)}
              </div>
            `
          : html`
              <div class="yaml-validation yaml-validation--valid">
                Valid configuration
              </div>
            `}
      </div>
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  Schema mode                                                      */
  /* ---------------------------------------------------------------- */

  private _toggleSchemaPath(path: string): void {
    const newExpanded = new Set(this._expandedPaths);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
    }
    this._expandedPaths = newExpanded;
  }

  private _renderSchemaTreeNode(key: string, schema: SchemaProperty, path: string, depth: number, isRequired: boolean): unknown {
    const hasChildren = schema.type === "object" && schema.properties && Object.keys(schema.properties).length > 0;
    const isExpanded = this._expandedPaths.has(path);

    const constraints: string[] = [];
    if (isRequired) constraints.push("required");
    if (schema.minimum !== undefined) constraints.push(`min: ${schema.minimum}`);
    if (schema.maximum !== undefined) constraints.push(`max: ${schema.maximum}`);
    if (schema.minLength !== undefined) constraints.push(`minLen: ${schema.minLength}`);
    if (schema.maxLength !== undefined) constraints.push(`maxLen: ${schema.maxLength}`);
    if (schema.enum) constraints.push(`enum: [${schema.enum.join(", ")}]`);
    if (schema.pattern) constraints.push(`pattern: ${schema.pattern}`);
    if (schema.default !== undefined) constraints.push(`default: ${JSON.stringify(schema.default)}`);

    return html`
      <div style="padding-left: ${depth * 1.5}rem">
        <div class="schema-row">
          <span
            class="schema-key"
            @click=${hasChildren ? () => this._toggleSchemaPath(path) : nothing}
          >
            ${hasChildren
              ? html`<span class="arrow" ?data-expanded=${isExpanded}>\u25B6</span>`
              : nothing}
            ${key}${isRequired ? html`<span class="required-marker">*</span>` : nothing}
          </span>
          <ic-tag variant="info">${schema.type ?? "any"}</ic-tag>
          ${schema.description ? html`<span class="schema-desc">${schema.description}</span>` : nothing}
          ${constraints.length > 0 ? html`<span class="schema-constraints">${constraints.join(", ")}</span>` : nothing}
        </div>
        ${hasChildren && isExpanded
          ? html`
              <div class="schema-children">
                ${Object.entries(schema.properties!).map(([childKey, childSchema]) =>
                  this._renderSchemaTreeNode(
                    childKey,
                    childSchema,
                    `${path}.${childKey}`,
                    depth + 1,
                    (schema.required ?? []).includes(childKey),
                  ),
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _renderSchemaMode() {
    const schema = this._schemaData[this._selectedSection];

    // Handle record/map types - show the entry value schema
    if (schema && !schema.properties && schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const entrySchema = schema.additionalProperties as SchemaProperty;
      if (!entrySchema.properties) {
        return html`<ic-empty-state icon="config" message="No schema available" description="Schema definition not found for this section."></ic-empty-state>`;
      }
      const requiredFields = entrySchema.required ?? [];
      return html`
        <div class="schema-tree">
          <div class="schema-note" style="padding:8px 0;opacity:0.7;font-style:italic">Record&lt;string, entry&gt; - each entry has:</div>
          ${Object.entries(entrySchema.properties).map(([key, propSchema]) =>
            this._renderSchemaTreeNode(key, propSchema, key, 0, requiredFields.includes(key)),
          )}
        </div>
      `;
    }

    if (!schema?.properties) {
      return html`<ic-empty-state icon="config" message="No schema available" description="Schema definition not found for this section."></ic-empty-state>`;
    }

    const requiredFields = schema.required ?? [];

    return html`
      <div class="schema-tree">
        ${Object.entries(schema.properties).map(([key, propSchema]) =>
          this._renderSchemaTreeNode(key, propSchema, key, 0, requiredFields.includes(key)),
        )}
      </div>
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  Apply                                                            */
  /* ---------------------------------------------------------------- */

  private async _onApply(): Promise<void> {
    if (!this.rpcClient || !this._dirty) return;

    this._applying = true;
    let value: unknown;

    if (this._mode === "yaml") {
      const parsed = parseYaml(this._yamlText);
      if (parsed.error) {
        IcToast.show(parsed.error, "error");
        this._applying = false;
        return;
      }
      value = parsed.data;
    } else {
      value = this._formState;
    }

    // Snapshot current config before applying for rollback
    this._rollbackSnapshot = structuredClone(this._configData) as Record<string, unknown>;

    try {
      await this.rpcClient.call("config.apply", {
        section: this._selectedSection,
        value,
      });
      IcToast.show("Configuration applied", "success");
      this._dirty = false;

      // Reload config data
      const configResult = await this.rpcClient.call<{ config: Record<string, unknown>; sections: string[] }>("config.read");
      this._configData = configResult.config;
      this._loadSectionState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to apply configuration";
      IcToast.show(msg, "error");
      // Clear rollback snapshot on failure (nothing was applied)
      this._rollbackSnapshot = null;
    } finally {
      this._applying = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Rollback                                                         */
  /* ---------------------------------------------------------------- */

  private async _onRollback(): Promise<void> {
    if (!this.rpcClient || !this._rollbackSnapshot) return;

    try {
      await this.rpcClient.call("config.apply", {
        config: this._rollbackSnapshot,
      });
      IcToast.show("Configuration rolled back", "success");

      // Reload config data from server
      const configResult = await this.rpcClient.call<{ config: Record<string, unknown>; sections: string[] }>("config.read");
      this._configData = configResult.config;
      this._rollbackSnapshot = null;
      this._confirmRollback = false;
      this._loadSectionState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to rollback configuration";
      IcToast.show(msg, "error");
      this._confirmRollback = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Gateway tab                                                      */
  /* ---------------------------------------------------------------- */

  private async _loadGatewayConfig(): Promise<void> {
    if (!this.rpcClient) return;
    this._gatewayLoading = true;
    this._gatewayError = "";

    try {
      const result = await this.rpcClient.call<Record<string, unknown>>("config.read", { section: "gateway" });
      this._gatewayConfig = (result ?? {}) as GatewayConfig;
    } catch (err) {
      this._gatewayError = err instanceof Error ? err.message : "Failed to load gateway config";
    } finally {
      this._gatewayLoading = false;
    }
  }

  private async _patchGateway(key: string, value: unknown): Promise<void> {
    if (!this.rpcClient) return;

    try {
      await this.rpcClient.call("config.patch", { section: "gateway", key, value });
      // Optimistically update local state
      if (this._gatewayConfig) {
        this._gatewayConfig = { ...this._gatewayConfig, [key]: value } as GatewayConfig;
      }
      IcToast.show("Gateway updated", "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update gateway";
      IcToast.show(msg, "error");
    }
  }

  private _onTabChange(e: CustomEvent<string>): void {
    this._activeTab = e.detail;
    // Lazy-load gateway config on first visit
    if (e.detail === "gateway" && this._gatewayConfig === null) {
      this._loadGatewayConfig();
    }
    // Lazy-load history on first visit
    if (e.detail === "history" && this._historyEntries.length === 0 && !this._historyLoading) {
      this._loadHistory();
    }
  }

  /* ---------------------------------------------------------------- */
  /*  History tab                                                      */
  /* ---------------------------------------------------------------- */

  private async _loadHistory(): Promise<void> {
    if (!this.rpcClient) return;
    this._historyLoading = true;
    this._historyError = "";

    try {
      const result = await this.rpcClient.call<ConfigHistoryResponse>("config.history", { limit: 50 });
      if (result.error) {
        // Git unavailable -- informational, not an error toast
        this._historyEntries = [];
        this._historyError = result.error;
      } else {
        this._historyEntries = result.entries;
      }
    } catch (err) {
      this._historyError = err instanceof Error ? err.message : "Failed to load history";
    } finally {
      this._historyLoading = false;
    }
  }

  private async _loadDiff(sha: string): Promise<void> {
    if (!this.rpcClient) return;
    this._diffLoading = true;

    try {
      const result = await this.rpcClient.call<ConfigDiffResponse>("config.diff", { sha });
      this._diffText = result.diff;
    } catch (err) {
      this._diffText = "";
      const msg = err instanceof Error ? err.message : "Failed to load diff";
      IcToast.show(msg, "error");
    } finally {
      this._diffLoading = false;
    }
  }

  private _onSelectVersion(sha: string): void {
    if (sha === this._selectedSha) {
      // Deselect
      this._selectedSha = null;
      this._diffText = "";
      return;
    }
    this._selectedSha = sha;
    this._loadDiff(sha);
  }

  private async _onHistoryRollback(): Promise<void> {
    if (!this.rpcClient || !this._confirmRollbackSha) return;

    try {
      await this.rpcClient.call<ConfigRollbackResponse>("config.rollback", { sha: this._confirmRollbackSha });
      IcToast.show("Config rolled back. Daemon restarting...", "success");
      this._confirmRollbackSha = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Rollback failed";
      IcToast.show(msg, "error");
      this._confirmRollbackSha = null;
    }
  }

  private async _onGc(): Promise<void> {
    if (!this.rpcClient || this._gcRunning) return;
    this._gcRunning = true;

    try {
      const result = await this.rpcClient.call<ConfigGcResponse>("config.gc");
      const squashed = result.squashed;
      IcToast.show(
        squashed != null ? `GC complete: ${squashed} versions squashed` : "GC complete",
        "success",
      );
      this._loadHistory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "GC failed";
      IcToast.show(msg, "error");
    } finally {
      this._gcRunning = false;
    }
  }

  private _renderDiffLine(line: string, _idx: number) {
    let cls = "diff-line--context";
    if (line.startsWith("+")) cls = "diff-line--add";
    else if (line.startsWith("-")) cls = "diff-line--remove";
    else if (line.startsWith("@@")) cls = "diff-line--hunk";

    return html`<span class=${cls}>${line}\n</span>`;
  }

  private _renderHistoryEntry(entry: ConfigHistoryEntry, index: number) {
    const isSelected = entry.sha === this._selectedSha;
    const isNewest = index === 0;
    const author = entry.metadata.user || entry.metadata.agent || "system";
    const fullDate = new Date(entry.timestamp).toLocaleString();

    return html`
      <div
        class="history-entry ${isSelected ? "history-entry--selected" : ""}"
        @click=${() => this._onSelectVersion(entry.sha)}
      >
        <div class="history-entry-header">
          <ic-relative-time
            .timestamp=${new Date(entry.timestamp).getTime()}
            title=${fullDate}
          ></ic-relative-time>
          <code class="history-sha">${entry.sha.slice(0, 7)}</code>
        </div>
        <div class="history-entry-summary" title=${entry.metadata.summary}>
          ${entry.metadata.summary}
        </div>
        <div class="history-entry-meta">
          <ic-tag variant="default">${entry.metadata.section}</ic-tag>
          <span class="history-author">${author}</span>
          ${!isNewest
            ? html`<button
                class="history-rollback-link"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this._confirmRollbackSha = entry.sha;
                }}
              >Rollback</button>`
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderHistoryTab() {
    if (this._historyLoading) {
      return html`<div class="state-container"><ic-loading size="lg"></ic-loading></div>`;
    }

    if (this._historyError) {
      return html`
        <ic-empty-state
          icon="config"
          message="Version history unavailable"
          description=${this._historyError}
        ></ic-empty-state>
      `;
    }

    if (this._historyEntries.length === 0) {
      return html`
        <ic-empty-state
          icon="config"
          message="No version history"
          description="Config changes will appear here after the first edit."
        ></ic-empty-state>
      `;
    }

    return html`
      <div class="history-layout">
        <div class="history-timeline">
          ${this._historyEntries.map((entry, i) => this._renderHistoryEntry(entry, i))}
        </div>

        <div class="history-diff-panel">
          ${this._diffLoading
            ? html`<div class="state-container"><ic-loading size="lg"></ic-loading></div>`
            : this._selectedSha && this._diffText
              ? html`<pre class="diff-unified">${this._diffText.split("\n").map((line, i) => this._renderDiffLine(line, i))}</pre>`
              : this._selectedSha && !this._diffText
                ? html`<ic-empty-state icon="config" message="No changes" description="No changes between this version and current."></ic-empty-state>`
                : html`<ic-empty-state icon="config" message="Select a version" description="Select a version to view changes."></ic-empty-state>`}
        </div>
      </div>

      <div class="history-actions">
        <button
          class="secondary-btn"
          ?disabled=${this._gcRunning}
          @click=${() => this._onGc()}
        >
          ${this._gcRunning ? html`<span class="spinner"></span> Running GC...` : "Run GC"}
        </button>
      </div>
    `;
  }

  /* ---------------------------------------------------------------- */
  /*  Import / Export                                                  */
  /* ---------------------------------------------------------------- */

  private _onExport(): void {
    const yamlContent = serializeToYaml(this._configData);
    const blob = new Blob([yamlContent], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "comis-config.yaml";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private _onImportClick(): void {
    const input = this.shadowRoot?.querySelector<HTMLInputElement>(".hidden-input");
    input?.click();
  }

  private _onImportFile(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const parsed = parseYaml(text);
      if (parsed.error) {
        IcToast.show(`Import failed: ${parsed.error}`, "error");
        return;
      }

      if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
        this._configData = parsed.data as Record<string, unknown>;
        this._loadSectionState();
        this._dirty = true;
        IcToast.show("Configuration imported", "info");
      } else {
        IcToast.show("Import failed: expected a YAML object", "error");
      }
    };
    reader.readAsText(file);

    // Reset the input so the same file can be re-imported
    input.value = "";
  }

  /* ---------------------------------------------------------------- */
  /*  Main render                                                      */
  /* ---------------------------------------------------------------- */

  private _renderModeContent() {
    switch (this._mode) {
      case "form":
        return this._renderFormMode();
      case "yaml":
        return this._renderYamlMode();
      case "schema":
        return this._renderSchemaMode();
      default:
        return nothing;
    }
  }

  private _renderEditorTab() {
    if (this._loadState === "loading") {
      return html`<ic-skeleton-view variant="editor"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-container">
          <span class="error-message">${this._error}</span>
          <button class="retry-btn" @click=${() => this._tryLoad()}>Retry</button>
        </div>
      `;
    }

    return html`
      <div class="editor-layout">
        <nav class="section-sidebar" role="navigation" aria-label="Config sections">
          ${this._sections.map(
            (section) => html`
              <div
                class="section-item"
                ?data-selected=${section === this._selectedSection}
                @click=${() => this._onSectionClick(section)}
              >
                ${section.charAt(0).toUpperCase() + section.slice(1)}
              </div>
            `,
          )}
        </nav>

        <div class="content-area" role="main">
          <div class="toolbar">
            <div class="mode-tabs">
              <button
                class="mode-btn"
                ?data-active=${this._mode === "form"}
                @click=${() => this._onModeChange("form")}
              >Form</button>
              <button
                class="mode-btn"
                ?data-active=${this._mode === "yaml"}
                @click=${() => this._onModeChange("yaml")}
              >YAML</button>
              <button
                class="mode-btn"
                ?data-active=${this._mode === "schema"}
                @click=${() => this._onModeChange("schema")}
              >Schema</button>
            </div>

            <div class="action-buttons">
              <button
                class="diff-btn"
                ?data-active=${this._showDiff}
                @click=${() => { this._showDiff = !this._showDiff; }}
              >Show Diff</button>
              ${this._rollbackSnapshot !== null
                ? html`<button
                    class="rollback-btn"
                    @click=${() => { this._confirmRollback = true; }}
                  >Rollback</button>`
                : nothing}
              <button
                class="secondary-btn"
                @click=${() => this._onImportClick()}
              >Import</button>
              <button
                class="secondary-btn"
                @click=${() => this._onExport()}
              >Export</button>
              <button
                class="apply-btn"
                ?disabled=${!this._dirty || this._applying}
                @click=${() => this._onApply()}
              >
                ${this._applying ? html`<span class="spinner"></span>` : nothing}
                Apply Changes
              </button>
            </div>
          </div>

          ${this._renderModeContent()}

          ${this._showDiff
            ? html`
                <div class="diff-preview">
                  <ic-diff-viewer
                    .oldText=${this._savedYaml}
                    .newText=${this._mode === "yaml" ? this._yamlText : serializeToYaml(this._formState)}
                    oldLabel="Current"
                    newLabel="Pending Changes"
                  ></ic-diff-viewer>
                </div>
              `
            : nothing}
        </div>
      </div>

      <input
        class="hidden-input"
        type="file"
        accept=".yaml,.yml"
        @change=${(e: Event) => this._onImportFile(e)}
      />

      <ic-confirm-dialog
        .open=${this._confirmRollback}
        title="Rollback Configuration"
        message="Restore previous configuration? This will revert all sections to the state before your last apply."
        confirmLabel="Rollback"
        @confirm=${() => this._onRollback()}
        @cancel=${() => { this._confirmRollback = false; }}
      ></ic-confirm-dialog>
    `;
  }

  private _renderGatewayTab() {
    if (this._gatewayLoading) {
      return html`<div class="state-container"><ic-loading size="lg"></ic-loading></div>`;
    }

    if (this._gatewayError) {
      return html`
        <div class="error-container">
          <span class="error-message">${this._gatewayError}</span>
          <button class="retry-btn" @click=${() => this._loadGatewayConfig()}>Retry</button>
        </div>
      `;
    }

    if (!this._gatewayConfig) {
      return html`<ic-empty-state icon="config" message="No gateway configuration" description="Gateway config not available."></ic-empty-state>`;
    }

    const gw = this._gatewayConfig;
    const corsOrigins = gw.cors?.origins ?? [];
    const tokens = gw.tokens ?? [];

    return html`
      <div class="gateway-form">
        <div class="gateway-field">
          <ic-toggle
            label="Gateway Enabled"
            .checked=${gw.enabled ?? false}
            @change=${(e: CustomEvent<boolean>) => this._patchGateway("enabled", e.detail)}
          ></ic-toggle>
        </div>

        <div class="gateway-field">
          <label class="gateway-label">Host</label>
          <input
            class="gateway-input"
            type="text"
            .value=${gw.host ?? "0.0.0.0"}
            @change=${(e: Event) => this._patchGateway("host", (e.target as HTMLInputElement).value)}
          />
        </div>

        <div class="gateway-field">
          <label class="gateway-label">Port</label>
          <input
            class="gateway-input"
            type="number"
            .value=${String(gw.port ?? 3000)}
            @change=${(e: Event) => {
              const val = parseInt((e.target as HTMLInputElement).value, 10);
              if (!isNaN(val)) this._patchGateway("port", val);
            }}
          />
        </div>

        <div class="gateway-field">
          <ic-array-editor
            label="CORS Origins"
            .items=${corsOrigins.map(String)}
            placeholder="https://example.com"
            @change=${(e: CustomEvent<string[]>) => this._patchGateway("cors", { ...gw.cors, origins: e.detail })}
          ></ic-array-editor>
        </div>

        <div class="gateway-tokens">
          <div class="gateway-tokens-label">API Tokens (${tokens.length})</div>
          ${tokens.length > 0
            ? html`
                <div class="gateway-tokens-list">
                  ${tokens.map(
                    (t) => html`
                      <div class="gateway-token-entry">
                        <span class="gateway-token-id">${t.id}</span>
                        ${t.scopes && t.scopes.length > 0
                          ? t.scopes.map(s => html`<ic-tag variant="info">${s}</ic-tag>`)
                          : html`<ic-tag variant="default">no scopes</ic-tag>`}
                      </div>
                    `,
                  )}
                </div>
              `
            : html`<div style="font-size:var(--ic-text-sm);color:var(--ic-text-dim)">No tokens configured</div>`}
          <a class="gateway-tokens-link" href="#security">Manage tokens in Security &rarr;</a>
        </div>
      </div>
    `;
  }

  private _renderWizardTab() {
    return html`
      <div class="wizard-content">
        <div class="wizard-description">
          The setup wizard guides you through initial Comis configuration
          including provider keys, agent creation, channel setup, and
          security settings.
        </div>
        <button
          class="wizard-btn"
          @click=${() => { window.location.hash = "#setup"; }}
        >Launch Setup Wizard</button>
      </div>
    `;
  }

  override render() {
    return html`
      <div class="view-header">
        <div class="view-title">Settings</div>
      </div>

      <ic-tabs
        .tabs=${TABS}
        .activeTab=${this._activeTab}
        @tab-change=${this._onTabChange}
      >
        <div slot="editor">${this._renderEditorTab()}</div>
        <div slot="gateway">${this._renderGatewayTab()}</div>
        <div slot="history">${this._renderHistoryTab()}</div>
        <div slot="wizard">${this._renderWizardTab()}</div>
      </ic-tabs>

      <ic-confirm-dialog
        .open=${this._confirmRollbackSha !== null}
        title="Rollback Configuration"
        message="Restore config to this version? The daemon will restart to apply changes."
        variant="danger"
        confirmLabel="Rollback"
        @confirm=${() => this._onHistoryRollback()}
        @cancel=${() => { this._confirmRollbackSha = null; }}
      ></ic-confirm-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-config-editor": IcConfigEditor;
  }
}
