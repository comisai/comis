import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";
import { IcToast } from "../../components/feedback/ic-toast.js";
import type { RpcClient } from "../../api/rpc-client.js";

// Side-effect imports to register custom elements used in template
import "../../components/nav/ic-breadcrumb.js";
import "../../components/data/ic-tag.js";
import "../../components/feedback/ic-toast.js";
import "../../components/feedback/ic-confirm-dialog.js";
import "../../components/feedback/ic-empty-state.js";
import "../../components/shell/ic-skeleton-view.js";
import "../../components/data/ic-relative-time.js";

/** Workspace status returned by workspace.status RPC. */
interface WorkspaceStatusDto {
  dir: string;
  exists: boolean;
  files: Array<{ name: string; present: boolean; sizeBytes?: number }>;
  hasGitRepo: boolean;
  isBootstrapped: boolean;
  state?: { version: number; bootstrapSeededAt?: number; onboardingCompletedAt?: number };
}

/** Single entry in a workspace subdirectory listing. */
interface WorkspaceDirEntry {
  name: string;
  type: "file" | "directory";
  sizeBytes?: number;
  modifiedAt?: number;
}

/** Git status returned by workspace.git.status RPC. */
interface GitStatusDto {
  branch: string;
  clean: boolean;
  entries: Array<{
    path: string;
    status: "modified" | "added" | "deleted" | "untracked" | "renamed" | "copied";
    staged: boolean;
  }>;
}

/** Single commit entry returned by workspace.git.log RPC. */
interface GitCommitDto {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/** Known workspace subdirectories. */
const WORKSPACE_SUBDIRS = ["projects", "scripts", "documents", "media", "data", "output"] as const;

/** Format byte counts for display. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Workspace file manager view.
 *
 * Two-panel layout: file tree sidebar (left) and editor/directory panel (right).
 * Collapses to single column on mobile (< 768px).
 *
 * Provides full CRUD for agent workspace files: browse, read, edit, save,
 * reset to default, and delete. Also supports initializing a new workspace.
 *
 * @fires navigate - Dispatched when breadcrumb clicked, with route path as detail
 */
@customElement("ic-workspace-manager")
export class IcWorkspaceManager extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      /* --- Layout --- */
      .workspace-layout {
        display: grid;
        grid-template-columns: 280px 1fr;
        gap: var(--ic-space-md, 0.75rem);
        min-height: 500px;
      }

      /* --- Status bar --- */
      .status-bar {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
        margin-bottom: var(--ic-space-md, 0.75rem);
        flex-wrap: wrap;
      }

      .status-bar code {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-muted, #9ca3af);
        background: var(--ic-surface-2, #1f2937);
        padding: 2px 6px;
        border-radius: var(--ic-radius-sm, 0.25rem);
      }

      /* --- Tab bar --- */
      .tab-bar {
        display: flex;
        gap: 0;
        border-bottom: 1px solid var(--ic-border, #374151);
        margin-bottom: var(--ic-space-md, 0.75rem);
      }

      .tab-btn {
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--ic-text-muted, #9ca3af);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        cursor: pointer;
        transition: color var(--ic-transition, 150ms ease),
          border-color var(--ic-transition, 150ms ease);
      }

      .tab-btn:hover {
        color: var(--ic-text, #f3f4f6);
      }

      .tab-btn--active {
        color: var(--ic-accent, #3b82f6);
        border-bottom-color: var(--ic-accent, #3b82f6);
      }

      /* --- File tree sidebar --- */
      .file-tree {
        border-right: 1px solid var(--ic-border, #374151);
        padding-right: var(--ic-space-md, 0.75rem);
        overflow-y: auto;
        max-height: 600px;
      }

      .tree-section-label {
        font-size: var(--ic-text-xs, 0.75rem);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ic-text-dim, #858d9d);
        margin: var(--ic-space-md, 0.75rem) 0 var(--ic-space-xs, 0.25rem) 0;
      }

      .tree-separator {
        border: none;
        border-top: 1px solid var(--ic-border, #374151);
        margin: var(--ic-space-sm, 0.5rem) 0;
      }

      .tree-item {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        border-radius: var(--ic-radius-sm, 0.25rem);
        background: transparent;
        border: none;
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        cursor: pointer;
        width: 100%;
        text-align: left;
        transition: background var(--ic-transition, 150ms ease);
      }

      .tree-item:hover {
        background: var(--ic-surface-2, #1f2937);
      }

      .tree-item--active {
        background: color-mix(in srgb, var(--ic-accent, #3b82f6) 15%, transparent);
        color: var(--ic-accent, #3b82f6);
      }

      .presence-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }

      .presence-dot--present {
        background: var(--ic-success, #34d399);
      }

      .presence-dot--absent {
        background: var(--ic-error, #f87171);
      }

      .file-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-size {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-dim, #858d9d);
        flex-shrink: 0;
      }

      .folder-icon {
        flex-shrink: 0;
        font-size: var(--ic-text-sm, 0.875rem);
      }

      /* --- Editor panel --- */
      .editor-panel {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .editor-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--ic-space-sm, 0.5rem);
      }

      .editor-filename {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 600;
      }

      .dirty-indicator {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-warning, #fbbf24);
        font-style: italic;
      }

      .editor-textarea {
        width: 100%;
        min-height: 400px;
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-sm, 0.875rem);
        line-height: 1.5;
        background: var(--ic-surface-2, #1f2937);
        color: var(--ic-text, #f3f4f6);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        padding: var(--ic-space-md, 0.75rem);
        resize: vertical;
        tab-size: 2;
      }

      .editor-textarea:focus {
        outline: 2px solid var(--ic-accent, #3b82f6);
        outline-offset: -1px;
      }

      /* --- Action buttons --- */
      .action-bar {
        display: flex;
        gap: var(--ic-space-sm, 0.5rem);
        margin-top: var(--ic-space-xs, 0.25rem);
      }

      .btn {
        display: inline-flex;
        align-items: center;
        gap: var(--ic-space-xs, 0.25rem);
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background var(--ic-transition, 150ms ease),
          border-color var(--ic-transition, 150ms ease),
          color var(--ic-transition, 150ms ease);
      }

      .btn--primary {
        background: var(--ic-accent, #3b82f6);
        color: #fff;
        border-color: var(--ic-accent, #3b82f6);
      }

      .btn--primary:hover {
        background: var(--ic-accent-hover, #2563eb);
      }

      .btn--secondary {
        background: transparent;
        color: var(--ic-text, #f3f4f6);
      }

      .btn--secondary:hover {
        background: var(--ic-surface-2, #1f2937);
        border-color: var(--ic-accent, #3b82f6);
      }

      .btn--danger {
        background: transparent;
        color: var(--ic-error, #f87171);
        border-color: var(--ic-error, #f87171);
      }

      .btn--danger:hover {
        background: color-mix(in srgb, var(--ic-error, #f87171) 10%, transparent);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* --- Directory table --- */
      .dir-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .dir-table th {
        text-align: left;
        font-weight: 600;
        font-size: var(--ic-text-xs, 0.75rem);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--ic-text-dim, #858d9d);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        border-bottom: 1px solid var(--ic-border, #374151);
      }

      .dir-table td {
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-sm, 0.5rem);
        border-bottom: 1px solid
          color-mix(in srgb, var(--ic-border, #374151) 50%, transparent);
      }

      .dir-table tr:nth-child(even) td {
        background: color-mix(in srgb, var(--ic-surface-2, #1f2937) 50%, transparent);
      }

      .dir-empty {
        color: var(--ic-text-dim, #858d9d);
        font-size: var(--ic-text-sm, 0.875rem);
        font-style: italic;
        padding: var(--ic-space-md, 0.75rem);
        text-align: center;
      }

      /* --- Placeholder panel --- */
      .placeholder-panel {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        min-height: 300px;
        color: var(--ic-text-dim, #858d9d);
        font-size: var(--ic-text-sm, 0.875rem);
        font-style: italic;
      }

      /* --- Git tab --- */
      .git-panel {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-md, 0.75rem);
      }

      .git-section {
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        overflow: hidden;
      }

      .git-section-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: var(--ic-surface-2, #1f2937);
        font-size: var(--ic-text-sm, 0.875rem);
        font-weight: 600;
        color: var(--ic-text, #f3f4f6);
      }

      .git-branch {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-accent, #3b82f6);
      }

      .git-change-count {
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-muted, #9ca3af);
        font-weight: 400;
      }

      .changed-file {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-md, 0.75rem);
        border-top: 1px solid var(--ic-border, #374151);
        font-size: var(--ic-text-sm, 0.875rem);
        cursor: pointer;
        transition: background var(--ic-transition, 150ms ease);
      }

      .changed-file:hover {
        background: var(--ic-surface-2, #1f2937);
      }

      .changed-file--active {
        background: var(--ic-surface-2, #1f2937);
      }

      .status-badge {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs, 0.75rem);
        font-weight: 700;
        min-width: 1.5rem;
        text-align: center;
      }

      .status-badge--M { color: var(--ic-warning, #f59e0b); }
      .status-badge--A { color: var(--ic-success, #22c55e); }
      .status-badge--D { color: var(--ic-error, #f87171); }
      .status-badge--U { color: var(--ic-text-muted, #9ca3af); }

      .changed-file-path {
        flex: 1;
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text, #f3f4f6);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .restore-btn {
        padding: 2px 8px;
        font-size: var(--ic-text-xs, 0.75rem);
        background: transparent;
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-sm, 0.25rem);
        color: var(--ic-text-muted, #9ca3af);
        font-family: inherit;
        cursor: pointer;
        transition: all var(--ic-transition, 150ms ease);
      }

      .restore-btn:hover {
        border-color: var(--ic-warning, #f59e0b);
        color: var(--ic-warning, #f59e0b);
      }

      /* Diff viewer */
      .diff-viewer {
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        overflow: hidden;
      }

      .diff-header {
        display: flex;
        align-items: center;
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: var(--ic-surface-2, #1f2937);
        font-size: var(--ic-text-xs, 0.75rem);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        color: var(--ic-text-muted, #9ca3af);
      }

      .diff-content {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-sm, 0.875rem);
        line-height: 1.5;
        margin: 0;
        padding: var(--ic-space-md, 0.75rem);
        overflow-x: auto;
        max-height: 400px;
        overflow-y: auto;
        background: var(--ic-surface-2, #1f2937);
      }

      .diff-add {
        background: color-mix(in srgb, #22c55e 15%, transparent);
        color: #86efac;
      }

      .diff-del {
        background: color-mix(in srgb, #ef4444 15%, transparent);
        color: #fca5a5;
      }

      .diff-hunk {
        color: var(--ic-info, #06b6d4);
        font-weight: 600;
      }

      .diff-ctx {
        color: var(--ic-text, #f3f4f6);
      }

      .diff-empty {
        padding: var(--ic-space-lg, 1rem);
        text-align: center;
        color: var(--ic-text-dim, #858d9d);
        font-size: var(--ic-text-sm, 0.875rem);
        font-style: italic;
      }

      /* Commit form */
      .commit-form {
        display: flex;
        gap: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-md, 0.75rem);
      }

      .commit-input {
        flex: 1;
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: var(--ic-surface-1, #111827);
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
      }

      .commit-input::placeholder {
        color: var(--ic-text-dim, #858d9d);
      }

      /* Commit log */
      .commit-entry {
        display: flex;
        align-items: baseline;
        gap: var(--ic-space-sm, 0.5rem);
        padding: var(--ic-space-xs, 0.25rem) var(--ic-space-md, 0.75rem);
        border-top: 1px solid var(--ic-border, #374151);
        font-size: var(--ic-text-sm, 0.875rem);
      }

      .commit-sha {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-accent, #3b82f6);
        flex-shrink: 0;
      }

      .commit-message {
        flex: 1;
        color: var(--ic-text, #f3f4f6);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .commit-time {
        flex-shrink: 0;
        font-size: var(--ic-text-xs, 0.75rem);
        color: var(--ic-text-muted, #9ca3af);
      }

      .clean-message {
        padding: var(--ic-space-md, 0.75rem);
        text-align: center;
        color: var(--ic-text-dim, #858d9d);
        font-size: var(--ic-text-sm, 0.875rem);
        font-style: italic;
      }

      /* --- Error state --- */
      .error-container {
        text-align: center;
        padding: var(--ic-space-2xl, 3rem);
        color: var(--ic-text-muted, #9ca3af);
      }

      .error-message {
        margin-bottom: var(--ic-space-md, 0.75rem);
        color: var(--ic-error, #f87171);
      }

      .retry-btn {
        padding: var(--ic-space-sm, 0.5rem) var(--ic-space-md, 0.75rem);
        background: transparent;
        border: 1px solid var(--ic-border, #374151);
        border-radius: var(--ic-radius-md, 0.5rem);
        color: var(--ic-text, #f3f4f6);
        font-size: var(--ic-text-sm, 0.875rem);
        font-family: inherit;
        cursor: pointer;
      }

      .retry-btn:hover {
        border-color: var(--ic-accent, #3b82f6);
        color: var(--ic-accent, #3b82f6);
      }

      /* --- Responsive --- */
      @media (max-width: 767px) {
        .workspace-layout {
          grid-template-columns: 1fr;
        }

        .file-tree {
          border-right: none;
          border-bottom: 1px solid var(--ic-border, #374151);
          padding-right: 0;
          padding-bottom: var(--ic-space-md, 0.75rem);
          max-height: 250px;
        }
      }
    `,
  ];

  /** RPC client for workspace operations (injected from app.ts). */
  @property({ attribute: false }) rpcClient: RpcClient | null = null;

  /** Agent ID from route params. */
  @property() agentId = "";

  @state() private _status: WorkspaceStatusDto | null = null;
  @state() private _loadState: "loading" | "loaded" | "error" = "loading";
  @state() private _error = "";
  @state() private _activeTab: "files" | "git" = "files";
  @state() private _selectedFile: string | null = null;
  @state() private _selectedSubdir: string | null = null;
  @state() private _fileContent = "";
  @state() private _editedContent = "";
  @state() private _dirEntries: WorkspaceDirEntry[] = [];
  @state() private _saving = false;
  @state() private _dirty = false;
  @state() private _confirmAction: "delete" | "reset" | "restore" | null = null;
  @state() private _actionPending = false;

  // --- Git tab state ---
  @state() private _gitStatus: GitStatusDto | null = null;
  @state() private _gitLog: GitCommitDto[] = [];
  @state() private _gitDiff = "";
  @state() private _gitDiffFile: string | null = null;
  @state() private _commitMessage = "";
  @state() private _committing = false;
  @state() private _restoreTarget: string | null = null;

  override updated(changed: Map<string, unknown>): void {
    if ((changed.has("agentId") || changed.has("rpcClient")) && this.agentId && this.rpcClient) {
      this._loadStatus();
    }
  }

  // --- Data loading ---

  private async _loadStatus(): Promise<void> {
    if (!this.rpcClient || !this.agentId) return;

    this._loadState = "loading";
    this._error = "";

    try {
      this._status = await this.rpcClient.call<WorkspaceStatusDto>(
        "workspace.status",
        { agentId: this.agentId },
      );
      this._loadState = "loaded";
    } catch (e) {
      this._error = e instanceof Error ? e.message : "Failed to load workspace status";
      this._loadState = "error";
    }
  }

  private async _selectFile(name: string): Promise<void> {
    if (!this.rpcClient) return;

    // Warn about unsaved changes before switching
    if (this._dirty) {
      if (!window.confirm("Discard unsaved changes?")) return;
    }

    try {
      const result = await this.rpcClient.call<{ content: string }>(
        "workspace.readFile",
        { agentId: this.agentId, filePath: name },
      );
      this._selectedFile = name;
      this._fileContent = result.content;
      this._editedContent = result.content;
      this._dirty = false;
      this._selectedSubdir = null;
      this._dirEntries = [];
    } catch (e) {
      IcToast.show(
        `Failed to read file: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    }
  }

  private async _selectSubdir(name: string): Promise<void> {
    if (!this.rpcClient) return;

    // Warn about unsaved changes before switching
    if (this._dirty) {
      if (!window.confirm("Discard unsaved changes?")) return;
    }

    try {
      const result = await this.rpcClient.call<{ entries: WorkspaceDirEntry[] }>(
        "workspace.listDir",
        { agentId: this.agentId, subdir: name },
      );
      this._selectedSubdir = name;
      this._dirEntries = result.entries;
      this._selectedFile = null;
      this._fileContent = "";
      this._editedContent = "";
      this._dirty = false;
    } catch (e) {
      IcToast.show(
        `Failed to list directory: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    }
  }

  private _onEditorInput(e: Event): void {
    const textarea = e.target as HTMLTextAreaElement;
    this._editedContent = textarea.value;
    this._dirty = this._editedContent !== this._fileContent;
  }

  // --- Git data loading ---

  private async _loadGitData(): Promise<void> {
    if (!this.rpcClient || !this.agentId) return;

    try {
      const [statusResult, logResult] = await Promise.all([
        this.rpcClient.call<GitStatusDto>("workspace.git.status", { agentId: this.agentId }),
        this.rpcClient.call<{ commits: GitCommitDto[] }>("workspace.git.log", {
          agentId: this.agentId,
          limit: 20,
        }),
      ]);
      this._gitStatus = statusResult;
      this._gitLog = logResult.commits;
      this._gitDiff = "";
      this._gitDiffFile = null;
    } catch (e) {
      IcToast.show(
        `Failed to load git data: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    }
  }

  private async _loadFileDiff(filePath: string): Promise<void> {
    if (!this.rpcClient || !this.agentId) return;

    try {
      const result = await this.rpcClient.call<{ diff: string }>(
        "workspace.git.diff",
        { agentId: this.agentId, filePath },
      );
      this._gitDiff = result.diff;
      this._gitDiffFile = filePath;
    } catch (e) {
      IcToast.show(
        `Failed to load diff: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    }
  }

  // --- Action handlers ---

  private async _handleSave(): Promise<void> {
    if (!this.rpcClient || this._saving || !this._selectedFile) return;

    this._saving = true;
    try {
      await this.rpcClient.call(
        "workspace.writeFile",
        { agentId: this.agentId, filePath: this._selectedFile, content: this._editedContent },
      );
      IcToast.show("File saved", "success");
      this._fileContent = this._editedContent;
      this._dirty = false;
    } catch (e) {
      IcToast.show(
        `Failed to save: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._saving = false;
    }
  }

  private async _handleReset(): Promise<void> {
    if (!this.rpcClient || !this._selectedFile) return;

    this._confirmAction = null;
    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "workspace.resetFile",
        { agentId: this.agentId, fileName: this._selectedFile },
      );
      IcToast.show("File reset to default", "success");
      // Reload the file content
      await this._selectFile(this._selectedFile);
    } catch (e) {
      IcToast.show(
        `Failed to reset file: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._actionPending = false;
    }
  }

  private async _handleDelete(): Promise<void> {
    if (!this.rpcClient || !this._selectedFile) return;

    this._confirmAction = null;
    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "workspace.deleteFile",
        { agentId: this.agentId, filePath: this._selectedFile },
      );
      IcToast.show("File deleted", "success");
      this._selectedFile = null;
      this._fileContent = "";
      this._editedContent = "";
      this._dirty = false;
      // Reload workspace status to update file presence
      await this._loadStatus();
    } catch (e) {
      IcToast.show(
        `Failed to delete file: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._actionPending = false;
    }
  }

  private async _handleInit(): Promise<void> {
    if (!this.rpcClient) return;

    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "workspace.init",
        { agentId: this.agentId },
      );
      IcToast.show("Workspace initialized", "success");
      await this._loadStatus();
    } catch (e) {
      IcToast.show(
        `Failed to initialize workspace: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._actionPending = false;
    }
  }

  // --- Git action handlers ---

  private _switchToGitTab(): void {
    this._activeTab = "git";
    this._confirmAction = null;
    this._restoreTarget = null;
    this._loadGitData();
  }

  private _requestRestore(filePath: string): void {
    this._restoreTarget = filePath;
    this._confirmAction = "restore";
  }

  private async _handleRestore(): Promise<void> {
    if (!this.rpcClient || !this._restoreTarget) return;

    this._confirmAction = null;
    this._actionPending = true;
    try {
      await this.rpcClient.call(
        "workspace.git.restore",
        { agentId: this.agentId, filePath: this._restoreTarget },
      );
      IcToast.show("File restored to HEAD", "success");
      this._restoreTarget = null;
      await this._loadGitData();
    } catch (e) {
      IcToast.show(
        `Failed to restore: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._actionPending = false;
    }
  }

  private async _handleCommit(): Promise<void> {
    if (!this.rpcClient || !this.agentId || this._committing) return;

    this._committing = true;
    try {
      await this.rpcClient.call("workspace.git.commit", {
        agentId: this.agentId,
        message: this._commitMessage || undefined,
      });
      IcToast.show("Changes committed", "success");
      this._commitMessage = "";
      await this._loadGitData();
    } catch (e) {
      IcToast.show(
        `Commit failed: ${e instanceof Error ? e.message : "Unknown error"}`,
        "error",
      );
    } finally {
      this._committing = false;
    }
  }

  private _statusBadge(status: string): string {
    switch (status) {
      case "modified": return "M";
      case "added": return "A";
      case "deleted": return "D";
      case "untracked": return "??";
      case "renamed": return "R";
      case "copied": return "C";
      default: return "?";
    }
  }

  private _diffLineClass(line: string): string {
    if (line.startsWith("@@")) return "diff-hunk";
    if (line.startsWith("+")) return "diff-add";
    if (line.startsWith("-")) return "diff-del";
    return "diff-ctx";
  }

  private get _commitDisabled(): boolean {
    return this._committing || this._gitStatus?.clean === true;
  }

  private _navigate(path: string): void {
    this.dispatchEvent(
      new CustomEvent("navigate", { detail: path, bubbles: true, composed: true }),
    );
  }

  // --- Render ---

  override render() {
    switch (this._loadState) {
      case "loading":
        return html`<ic-skeleton-view variant="editor"></ic-skeleton-view>`;
      case "error":
        return html`
          <div class="error-container">
            <div class="error-message">${this._error}</div>
            <button class="retry-btn" @click=${() => this._loadStatus()}>Retry</button>
          </div>
        `;
      case "loaded":
        if (this._status && !this._status.exists) {
          return this._renderNotInitialized();
        }
        return this._renderWorkspace();
    }
  }

  private _renderNotInitialized() {
    return html`
      ${this._renderBreadcrumb()}
      <ic-empty-state
        message="Workspace not initialized"
        icon="folder"
        description="Initialize the workspace to manage agent files and configuration."
      >
        <button
          class="btn btn--primary"
          ?disabled=${this._actionPending}
          @click=${() => this._handleInit()}
        >Init Workspace</button>
      </ic-empty-state>
    `;
  }

  private _renderWorkspace() {
    return html`
      ${this._renderBreadcrumb()}
      ${this._renderStatusBar()}
      ${this._renderTabBar()}
      ${this._activeTab === "files"
        ? html`
            <div class="workspace-layout">
              <div class="file-tree">
                ${this._renderFileTree()}
              </div>
              <div class="editor-panel">
                ${this._renderEditorPanel()}
              </div>
            </div>
          `
        : this._renderGitTab()}
    `;
  }

  private _renderBreadcrumb() {
    return html`
      <ic-breadcrumb
        .items=${[
          { label: "Agents", route: "agents" },
          { label: this.agentId, route: `agents/${this.agentId}` },
          { label: "Workspace" },
        ]}
        @navigate=${(e: CustomEvent<string>) => this._navigate(e.detail)}
      ></ic-breadcrumb>
    `;
  }

  private _renderStatusBar() {
    if (!this._status) return nothing;

    return html`
      <div class="status-bar">
        <code>${this._status.dir}</code>
        <ic-tag variant=${this._status.hasGitRepo ? "success" : "default"}>
          ${this._status.hasGitRepo ? "git repo" : "no git"}
        </ic-tag>
        <ic-tag variant=${this._status.isBootstrapped ? "success" : "warning"}>
          ${this._status.isBootstrapped ? "bootstrapped" : "onboarding"}
        </ic-tag>
      </div>
    `;
  }

  private _renderTabBar() {
    return html`
      <div class="tab-bar">
        <button
          class="tab-btn ${this._activeTab === "files" ? "tab-btn--active" : ""}"
          @click=${() => { this._activeTab = "files"; this._confirmAction = null; this._restoreTarget = null; }}
        >Files</button>
        <button
          class="tab-btn ${this._activeTab === "git" ? "tab-btn--active" : ""}"
          @click=${() => this._switchToGitTab()}
        >Git</button>
      </div>
    `;
  }

  private _renderFileTree() {
    if (!this._status) return nothing;

    return html`
      <div class="tree-section-label">Template Files</div>
      ${this._status.files.map(
        (file) => html`
          <button
            class="tree-item ${this._selectedFile === file.name ? "tree-item--active" : ""}"
            @click=${() => this._selectFile(file.name)}
          >
            <span class="presence-dot ${file.present ? "presence-dot--present" : "presence-dot--absent"}"></span>
            <span class="file-name">${file.name}</span>
            ${file.present && file.sizeBytes !== undefined
              ? html`<span class="file-size">${formatFileSize(file.sizeBytes)}</span>`
              : nothing}
          </button>
        `,
      )}
      <hr class="tree-separator" />
      <div class="tree-section-label">Directories</div>
      ${WORKSPACE_SUBDIRS.map(
        (dir) => html`
          <button
            class="tree-item ${this._selectedSubdir === dir ? "tree-item--active" : ""}"
            @click=${() => this._selectSubdir(dir)}
          >
            <span class="folder-icon">\uD83D\uDCC1</span>
            <span class="file-name">${dir}</span>
          </button>
        `,
      )}
    `;
  }

  private _renderEditorPanel() {
    if (this._selectedFile) {
      return this._renderFileEditor();
    }
    if (this._selectedSubdir) {
      return this._renderDirListing();
    }
    return html`
      <div class="placeholder-panel">Select a file or directory from the sidebar</div>
    `;
  }

  private _renderFileEditor() {
    return html`
      <div class="editor-header">
        <span class="editor-filename">${this._selectedFile}</span>
        ${this._dirty
          ? html`<span class="dirty-indicator">unsaved</span>`
          : nothing}
      </div>
      <textarea
        class="editor-textarea"
        .value=${this._editedContent}
        @input=${this._onEditorInput}
        spellcheck="false"
      ></textarea>
      <div class="action-bar">
        <button
          class="btn btn--primary"
          ?disabled=${!this._dirty || this._saving}
          @click=${() => this._handleSave()}
        >${this._saving ? "Saving..." : "Save"}</button>
        <button
          class="btn btn--secondary"
          ?disabled=${this._actionPending}
          @click=${() => { this._confirmAction = "reset"; }}
        >Reset to Default</button>
        <button
          class="btn btn--danger"
          ?disabled=${this._actionPending}
          @click=${() => { this._confirmAction = "delete"; }}
        >Delete</button>
      </div>

      <ic-confirm-dialog
        ?open=${this._confirmAction === "reset"}
        title="Reset to Default"
        message=${`Reset "${this._selectedFile}" to its default content? Current content will be overwritten.`}
        variant="default"
        confirmLabel="Reset"
        @confirm=${() => this._handleReset()}
        @cancel=${() => { this._confirmAction = null; }}
      ></ic-confirm-dialog>

      <ic-confirm-dialog
        ?open=${this._confirmAction === "delete"}
        title="Delete File"
        message=${`Delete "${this._selectedFile}"? This action cannot be undone.`}
        variant="danger"
        confirmLabel="Delete"
        @confirm=${() => this._handleDelete()}
        @cancel=${() => { this._confirmAction = null; }}
      ></ic-confirm-dialog>
    `;
  }

  private _renderDirListing() {
    if (this._dirEntries.length === 0) {
      return html`<div class="dir-empty">Empty directory</div>`;
    }

    return html`
      <table class="dir-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Size</th>
            <th>Modified</th>
          </tr>
        </thead>
        <tbody>
          ${this._dirEntries.map(
            (entry) => html`
              <tr>
                <td>${entry.name}</td>
                <td>${entry.type}</td>
                <td>${entry.sizeBytes !== undefined ? formatFileSize(entry.sizeBytes) : "-"}</td>
                <td>
                  ${entry.modifiedAt
                    ? html`<ic-relative-time .timestamp=${entry.modifiedAt}></ic-relative-time>`
                    : "-"}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  // --- Git tab render methods ---

  private _renderGitTab() {
    if (!this._status?.hasGitRepo) {
      return html`
        <ic-empty-state
          message="No git repository"
          description="Initialize a git repository to track workspace changes."
          icon="folder"
        ></ic-empty-state>
      `;
    }

    return html`
      <div class="git-panel">
        ${this._renderGitStatus()}
        ${this._renderDiffViewer()}
        ${this._renderCommitForm()}
        ${this._renderCommitLog()}
        <ic-confirm-dialog
          ?open=${this._confirmAction === "restore"}
          title="Restore File"
          message=${`Restore "${this._restoreTarget}" to HEAD? Uncommitted changes will be lost.`}
          variant="danger"
          confirmLabel="Restore"
          @confirm=${() => this._handleRestore()}
          @cancel=${() => { this._confirmAction = null; this._restoreTarget = null; }}
        ></ic-confirm-dialog>
      </div>
    `;
  }

  private _renderGitStatus() {
    if (!this._gitStatus) return nothing;

    return html`
      <div class="git-section">
        <div class="git-section-header">
          <span>Status</span>
          <span class="git-branch">${this._gitStatus.branch}</span>
          <span class="git-change-count">${this._gitStatus.entries.length} changes</span>
        </div>
        ${this._gitStatus.clean
          ? html`<div class="clean-message">Working tree clean</div>`
          : this._gitStatus.entries.map(
              (entry) => {
                const badge = this._statusBadge(entry.status);
                const badgeClass = badge === "??" ? "U" : badge;
                return html`
                  <div
                    class="changed-file ${this._gitDiffFile === entry.path ? "changed-file--active" : ""}"
                    @click=${() => this._loadFileDiff(entry.path)}
                  >
                    <span class="status-badge status-badge--${badgeClass}">${badge}</span>
                    <span class="changed-file-path">${entry.path}</span>
                    ${entry.status !== "untracked" && entry.status !== "added"
                      ? html`<button
                          class="restore-btn"
                          @click=${(e: Event) => { e.stopPropagation(); this._requestRestore(entry.path); }}
                        >Restore</button>`
                      : nothing}
                  </div>
                `;
              },
            )}
      </div>
    `;
  }

  private _renderDiffViewer() {
    if (!this._gitDiff) {
      return html`<div class="diff-empty">Select a changed file to view its diff</div>`;
    }

    const lines = this._gitDiff.split("\n");
    return html`
      <div class="diff-viewer">
        <div class="diff-header">${this._gitDiffFile}</div>
        <pre class="diff-content">${lines.map(
          (line) => html`<span class="${this._diffLineClass(line)}">${line}\n</span>`,
        )}</pre>
      </div>
    `;
  }

  private _renderCommitForm() {
    return html`
      <div class="git-section">
        <div class="git-section-header">Commit</div>
        <div class="commit-form">
          <input
            class="commit-input"
            type="text"
            placeholder="Commit message (optional)"
            .value=${this._commitMessage}
            @input=${(e: Event) => { this._commitMessage = (e.target as HTMLInputElement).value; }}
          />
          <button
            class="btn btn--primary"
            ?disabled=${this._commitDisabled}
            @click=${() => this._handleCommit()}
          >${this._committing ? "Committing..." : "Commit"}</button>
        </div>
      </div>
    `;
  }

  private _renderCommitLog() {
    return html`
      <div class="git-section">
        <div class="git-section-header">Recent Commits</div>
        ${this._gitLog.length === 0
          ? html`<div class="clean-message">No commits yet</div>`
          : this._gitLog.map(
              (commit) => html`
                <div class="commit-entry">
                  <span class="commit-sha">${commit.sha.slice(0, 7)}</span>
                  <span class="commit-message">${commit.message}</span>
                  <span class="commit-time">
                    <ic-relative-time .timestamp=${new Date(commit.date).getTime()}></ic-relative-time>
                  </span>
                </div>
              `,
            )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-workspace-manager": IcWorkspaceManager;
  }
}
