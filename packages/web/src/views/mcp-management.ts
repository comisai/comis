// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../styles/shared.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ApiClient } from "../api/api-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import type {
  McpServerListEntry,
  McpServerDetail,
} from "../api/types/mcp-types.js";

// Side-effect imports for sub-components
import "../components/feedback/ic-loading.js";
import "../components/feedback/ic-empty-state.js";
import "../components/feedback/ic-confirm-dialog.js";
import "../components/data/ic-tag.js";
import "../components/data/ic-relative-time.js";
import "../components/shell/ic-skeleton-view.js";

type LoadState = "loading" | "loaded" | "error";

/** Shape of MCP server entries from config.read */
interface McpServerEntry {
  name: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled: boolean;
}

/**
 * MCP server management view.
 *
 * Unified view for both config-level and runtime MCP server management.
 * Displays config details (command, args, env vars, transport) and runtime
 * status (connection state, tool count, tools list) per server. Provides
 * enable/disable toggle, delete, add-server form, and runtime actions
 * (disconnect, reconnect, test).
 *
 * Uses poll-on-action pattern (reload after connect/disconnect/reconnect)
 * since no MCP-specific SSE events exist.
 */
@customElement("ic-mcp-management")
export class IcMcpManagement extends LitElement {
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

      .connect-btn {
        padding: 6px 14px;
        font-size: var(--ic-text-sm);
        font-weight: 500;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-sm);
        cursor: pointer;
        font-family: inherit;
        transition: background var(--ic-transition);
      }

      .connect-btn:hover {
        background: var(--ic-accent-hover);
      }

      .server-list {
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
      }

      .server-card {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
      }

      .server-header {
        display: flex;
        align-items: center;
        gap: var(--ic-space-sm);
        flex-wrap: wrap;
      }

      .server-name {
        font-weight: 600;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
      }

      .server-tools-count {
        font-size: 0.75rem;
        color: var(--ic-text-dim);
      }

      .server-health {
        font-size: 0.75rem;
        color: var(--ic-text-dim);
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .server-actions {
        display: flex;
        gap: var(--ic-space-sm);
        margin-top: var(--ic-space-sm);
        flex-wrap: wrap;
        align-items: center;
      }

      .action-btn {
        padding: 4px 12px;
        font-size: 0.75rem;
        font-weight: 500;
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        background: transparent;
        color: var(--ic-text-muted);
        cursor: pointer;
        font-family: inherit;
        transition: background var(--ic-transition), color var(--ic-transition), border-color var(--ic-transition);
      }

      .action-btn:hover {
        background: var(--ic-surface-2);
        color: var(--ic-text);
      }

      .action-btn.danger {
        border-color: var(--ic-error);
        color: var(--ic-error);
      }

      .action-btn.danger:hover {
        background: var(--ic-error);
        color: white;
      }

      .action-btn.primary {
        border-color: var(--ic-accent);
        color: var(--ic-accent);
      }

      .action-btn.primary:hover {
        background: var(--ic-accent);
        color: white;
      }

      .action-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      /* Tool list accordion */
      .tool-list {
        margin-top: var(--ic-space-sm);
        padding-top: var(--ic-space-sm);
        border-top: 1px solid var(--ic-border);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-xs);
      }

      .tool-entry {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        background: var(--ic-surface-2);
        border-radius: var(--ic-radius-sm);
      }

      .tool-name {
        font-weight: 600;
        font-size: var(--ic-text-sm);
        color: var(--ic-text);
      }

      .tool-qualified {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: 0.75rem;
        color: var(--ic-text-dim);
      }

      .tool-desc {
        font-size: 0.75rem;
        color: var(--ic-text-muted);
        margin-top: 2px;
      }

      .tool-loading {
        font-size: 0.75rem;
        color: var(--ic-text-dim);
        padding: var(--ic-space-xs);
      }

      /* Add server form */
      .add-server-form {
        background: var(--ic-surface);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        padding: var(--ic-space-md);
        margin-bottom: var(--ic-space-md);
        display: flex;
        flex-direction: column;
        gap: var(--ic-space-sm);
        max-width: 32rem;
      }

      .add-server-title {
        font-size: var(--ic-text-sm);
        font-weight: 600;
        color: var(--ic-text-muted);
      }

      .add-server-row {
        display: flex;
        gap: var(--ic-space-sm);
        flex-wrap: wrap;
      }

      .add-server-input {
        flex: 1;
        min-width: 10rem;
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .add-server-input:focus {
        outline: none;
        border-color: var(--ic-accent);
      }

      .add-server-select {
        padding: 0.5rem 0.75rem;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        color: var(--ic-text);
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .add-server-btn {
        padding: 0.5rem 1rem;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-md);
        font-size: var(--ic-text-sm);
        cursor: pointer;
        white-space: nowrap;
      }

      .add-server-btn:hover {
        opacity: 0.9;
      }

      .cancel-btn {
        padding: 6px 14px;
        font-size: var(--ic-text-sm);
        font-weight: 500;
        background: transparent;
        color: var(--ic-text-muted);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        cursor: pointer;
        font-family: inherit;
        transition: color var(--ic-transition), border-color var(--ic-transition);
      }

      .cancel-btn:hover {
        color: var(--ic-text);
        border-color: var(--ic-text-dim);
      }

      .error-message {
        text-align: center;
        padding: 2rem;
        color: var(--ic-text-dim);
      }

      .retry-btn {
        margin-top: var(--ic-space-sm);
        padding: 6px 16px;
        background: var(--ic-accent);
        color: white;
        border: none;
        border-radius: var(--ic-radius-sm);
        cursor: pointer;
        font-family: inherit;
        font-size: var(--ic-text-sm);
      }

      .retry-btn:hover {
        background: var(--ic-accent-hover);
      }

      /* Config detail elements */
      .server-command {
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: 0.75rem;
        color: var(--ic-text-dim);
        word-break: break-all;
      }

      .server-error {
        display: block;
        color: var(--ic-color-error, #dc2626);
        font-size: 0.8rem;
        padding: 0.25rem 0.5rem;
        margin-top: 0.25rem;
        word-break: break-word;
      }

      .server-env-badge {
        display: inline-block;
        font-family: var(--ic-font-mono, ui-monospace, monospace);
        font-size: 0.75rem;
        color: var(--ic-text-dim);
        background: rgba(147, 130, 220, 0.15);
        padding: 1px 6px;
        border-radius: 4px;
      }

      .toggle-checkbox {
        cursor: pointer;
      }

      .config-only-label {
        font-size: 0.75rem;
        color: var(--ic-text-dim);
        font-style: italic;
      }

      /* Test result display */
      .server-test-result {
        font-size: var(--ic-text-xs);
        padding: 0.25rem 0.5rem;
        border-radius: var(--ic-radius-sm);
        margin-top: 0.125rem;
      }

      .server-test-success {
        color: var(--ic-success, #22c55e);
        background: rgba(34, 197, 94, 0.1);
      }

      .server-test-error {
        color: var(--ic-error, #ef4444);
        background: rgba(239, 68, 68, 0.1);
        word-break: break-word;
      }

      /* Capability badges, version, and instructions */
      .capability-badges {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }

      .server-version {
        font-size: 0.75rem;
        color: var(--ic-text-dim);
        font-family: var(--ic-font-mono, ui-monospace, monospace);
      }

      .instructions-section {
        margin-top: var(--ic-space-sm);
        border-top: 1px solid var(--ic-border);
        padding-top: var(--ic-space-sm);
      }

      .instructions-toggle {
        font-size: 0.75rem;
        color: var(--ic-accent);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        font-family: inherit;
      }

      .instructions-toggle:hover {
        text-decoration: underline;
      }

      .instructions-content {
        margin-top: var(--ic-space-xs);
        padding: var(--ic-space-sm);
        background: var(--ic-surface-2);
        border-radius: var(--ic-radius-sm);
        font-size: 0.75rem;
        color: var(--ic-text-muted);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 12rem;
        overflow-y: auto;
      }
    `,
  ];

  @property({ attribute: false }) rpcClient: RpcClient | null = null;
  @property({ attribute: false }) apiClient: ApiClient | null = null;
  @property({ attribute: false }) eventDispatcher: EventDispatcher | null = null;

  @state() private _loadState: LoadState = "loading";
  @state() private _servers: McpServerListEntry[] = [];
  @state() private _mcpConfig: McpServerEntry[] = [];
  @state() private _expandedServer: string | null = null;
  @state() private _serverDetail: McpServerDetail | null = null;
  @state() private _showAddForm = false;
  @state() private _disconnectTarget: string | null = null;
  @state() private _deleteTarget: string | null = null;
  @state() private _detailLoading = false;
  @state() private _showInstructions = false;

  // Test connection state
  @state() private _testingServer: string | null = null;
  @state() private _testResult: { name: string; success: boolean; toolCount?: number; tools?: string[]; error?: string } | null = null;

  // Add-server form state
  @state() private _newServerName = "";
  @state() private _newServerTransport: "stdio" | "sse" | "http" = "stdio";
  @state() private _newServerCommand = "";
  @state() private _newServerUrl = "";
  @state() private _newServerHeaders = "";
  @state() private _newServerEnv = "";

  private _rpcStatusUnsub: (() => void) | null = null;

  /* ---- Lifecycle ---- */

  override connectedCallback(): void {
    super.connectedCallback();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._rpcStatusUnsub?.();
    this._rpcStatusUnsub = null;
  }

  override willUpdate(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has("rpcClient") && this.rpcClient) {
      this._tryLoad();
    }
  }

  private _tryLoad(): void {
    if (!this.rpcClient) {
      this._loadState = "loaded";
      return;
    }
    this._rpcStatusUnsub?.();
    if (this.rpcClient.status === "connected") {
      void this._loadData();
    } else {
      this._rpcStatusUnsub = this.rpcClient.onStatusChange((status) => {
        if (status === "connected") {
          void this._loadData();
        }
      });
    }
  }

  /* ---- Data loading ---- */

  private async _loadData(): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const [mcpResp, configResp] = await Promise.all([
        this.rpcClient.call("mcp.list") as Promise<{
          servers: McpServerListEntry[];
          total: number;
        }>,
        this.rpcClient.call("config.read") as Promise<{
          config: {
            integrations?: {
              mcp?: {
                servers?: McpServerEntry[];
              };
            };
          };
        }>,
      ]);
      this._servers = mcpResp.servers ?? [];
      this._mcpConfig = configResp.config?.integrations?.mcp?.servers ?? [];
      this._loadState = "loaded";
    } catch {
      this._loadState = "error";
    }
  }

  private async _loadServerDetail(name: string): Promise<void> {
    if (!this.rpcClient) return;
    this._detailLoading = true;
    try {
      const detail = await this.rpcClient.call("mcp.status", { name }) as McpServerDetail;
      this._serverDetail = detail;
      this._expandedServer = name;
    } catch {
      IcToast.show(`Failed to load tools for ${name}`, "error");
      this._expandedServer = null;
      this._serverDetail = null;
    } finally {
      this._detailLoading = false;
    }
  }

  /* ---- Config mutation helpers ---- */

  private async _patchConfig(section: string, key: string, value: unknown): Promise<boolean> {
    if (!this.rpcClient) return false;
    try {
      await this.rpcClient.call("config.patch", { section, key, value });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update configuration";
      IcToast.show(msg, "error");
      return false;
    }
  }

  /** Strip env entries containing "[REDACTED]" before sending to backend.
   *  The backend restores original ${VAR} refs from the existing YAML. */
  private _stripRedactedEnv(servers: McpServerEntry[]): McpServerEntry[] {
    return servers.map((s) => {
      if (!s.env) return s;
      const hasRedacted = Object.values(s.env).some((v) => v === "[REDACTED]");
      if (!hasRedacted) return s;
      const { env: _, ...rest } = s;
      return rest as McpServerEntry;
    });
  }

  /* ---- Runtime actions ---- */

  private _requestDisconnect(name: string): void {
    this._disconnectTarget = name;
  }

  private async _confirmDisconnect(): Promise<void> {
    const name = this._disconnectTarget;
    this._disconnectTarget = null;
    if (!name || !this.rpcClient) return;
    try {
      await this.rpcClient.call("mcp.disconnect", { name });
      IcToast.show(`Disconnected ${name}`, "success");
      if (this._expandedServer === name) {
        this._expandedServer = null;
        this._serverDetail = null;
      }
      void this._loadData();
    } catch {
      IcToast.show(`Failed to disconnect ${name}`, "error");
    }
  }

  private _cancelDisconnect(): void {
    this._disconnectTarget = null;
  }

  private async _handleReconnect(name: string): Promise<void> {
    if (!this.rpcClient) return;
    try {
      await this.rpcClient.call("mcp.reconnect", { name });
      IcToast.show(`Reconnected ${name}`, "success");
      void this._loadData();
    } catch {
      IcToast.show(`Failed to reconnect ${name}`, "error");
    }
  }

  private async _handleTest(name: string): Promise<void> {
    if (!this.rpcClient) return;
    try {
      const result = await this.rpcClient.call("mcp.test", { name }) as {
        success: boolean;
        message?: string;
      };
      if (result.success) {
        IcToast.show(`${name}: test passed`, "success");
      } else {
        IcToast.show(`${name}: test failed${result.message ? " \u2014 " + result.message : ""}`, "error");
      }
    } catch {
      IcToast.show(`Failed to test ${name}`, "error");
    }
  }

  private _toggleTools(name: string): void {
    if (this._expandedServer === name) {
      this._expandedServer = null;
      this._serverDetail = null;
      this._showInstructions = false;
    } else {
      this._showInstructions = false;
      void this._loadServerDetail(name);
    }
  }

  /* ---- Config-level actions ---- */

  private async _toggleServer(name: string, enabled: boolean): Promise<void> {
    const updated = this._mcpConfig.map((s) =>
      s.name === name ? { ...s, enabled } : s,
    );
    const ok = await this._patchConfig("integrations", "mcp.servers", this._stripRedactedEnv(updated));
    if (ok) {
      this._mcpConfig = updated;
    }
  }

  private _removeServer(name: string): void {
    this._deleteTarget = name;
  }

  private async _confirmRemove(): Promise<void> {
    const name = this._deleteTarget;
    this._deleteTarget = null;
    if (!name) return;
    const updated = this._mcpConfig.filter((s) => s.name !== name);
    const ok = await this._patchConfig("integrations", "mcp.servers", this._stripRedactedEnv(updated));
    if (ok) {
      this._mcpConfig = updated;
      IcToast.show(`Removed MCP server "${name}"`, "success");
      void this._loadData();
    }
  }

  private _cancelRemove(): void {
    this._deleteTarget = null;
  }

  private async _addServer(): Promise<void> {
    if (!this._newServerName.trim()) {
      IcToast.show("Server name is required", "error");
      return;
    }

    const name = this._newServerName.trim();
    if (this._mcpConfig.some((s) => s.name === name)) {
      IcToast.show(`MCP server "${name}" already exists`, "error");
      return;
    }

    if (this._newServerTransport === "stdio" && !this._newServerCommand.trim()) {
      IcToast.show("Command is required for stdio transport", "error");
      return;
    }
    if (this._newServerTransport !== "stdio" && !this._newServerUrl.trim()) {
      IcToast.show("URL is required for remote transport", "error");
      return;
    }

    const entry: McpServerEntry = {
      name,
      transport: this._newServerTransport,
      enabled: true,
    };

    if (this._newServerTransport === "stdio") {
      const parts = this._newServerCommand.trim().split(/\s+/);
      entry.command = parts[0] ?? "";
      if (parts.length > 1) {
        entry.args = parts.slice(1);
      }
    } else {
      entry.url = this._newServerUrl.trim();
    }

    // Parse headers from "Header-Name: value" lines
    const headersText = this._newServerHeaders.trim();
    if (headersText) {
      const headers: Record<string, string> = {};
      for (const line of headersText.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (key) headers[key] = value;
        }
      }
      if (Object.keys(headers).length > 0) {
        entry.headers = headers;
      }
    }

    // Parse env vars from "KEY=VALUE" lines
    const envText = this._newServerEnv.trim();
    if (envText) {
      const env: Record<string, string> = {};
      for (const line of envText.split("\n")) {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
      if (Object.keys(env).length > 0) {
        entry.env = env;
      }
    }

    const updated = [...this._mcpConfig, entry];
    const ok = await this._patchConfig("integrations", "mcp.servers", this._stripRedactedEnv(updated));
    if (ok) {
      this._mcpConfig = updated;
      this._newServerName = "";
      this._newServerCommand = "";
      this._newServerUrl = "";
      this._newServerHeaders = "";
      this._newServerEnv = "";
      this._showAddForm = false;
      IcToast.show(`Added MCP server "${name}"`, "success");
      void this._loadData();
    }
  }

  private async _testServerConfig(server: McpServerEntry): Promise<void> {
    if (!this.rpcClient || this._testingServer) return;

    this._testingServer = server.name;
    this._testResult = null;

    try {
      const params: Record<string, unknown> = {
        name: server.name,
        transport: server.transport,
      };
      if (server.transport === "stdio") {
        params.command = server.command;
        params.args = server.args;
      } else {
        params.url = server.url;
      }
      if (server.env && Object.keys(server.env).length > 0) {
        params.env = server.env;
      }
      if (server.headers && Object.keys(server.headers).length > 0) {
        params.headers = server.headers;
      }

      const result = await this.rpcClient.call("mcp.test", params) as {
        success: boolean;
        toolCount?: number;
        tools?: string[];
        error?: string;
      };

      this._testResult = { name: server.name, ...result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Test failed";
      const isTransportError = msg === "Not connected" || msg.includes("WebSocket");
      this._testResult = {
        name: server.name,
        success: false,
        error: isTransportError
          ? "Daemon not connected -- wait for reconnection and try again"
          : msg,
      };
    } finally {
      this._testingServer = null;
    }
  }

  /* ---- Render helpers ---- */

  private _statusColor(status: string): string {
    switch (status) {
      case "connected": return "green";
      case "disconnected": return "default";
      case "connecting": return "yellow";
      case "reconnecting": return "yellow";
      case "error": return "red";
      default: return "default";
    }
  }

  private _renderAddServerForm() {
    return html`
      <div class="add-server-form">
        <div class="add-server-title">Add Server</div>
        <div class="add-server-row">
          <input
            class="add-server-input"
            type="text"
            placeholder="Server name"
            .value=${this._newServerName}
            @input=${(e: Event) => { this._newServerName = (e.target as HTMLInputElement).value; }}
          />
          <select
            class="add-server-select"
            .value=${this._newServerTransport}
            @change=${(e: Event) => {
              this._newServerTransport = (e.target as HTMLSelectElement).value as "stdio" | "sse" | "http";
            }}
          >
            <option value="stdio">stdio</option>
            <option value="sse">sse</option>
            <option value="http">http</option>
          </select>
        </div>
        ${
          this._newServerTransport === "stdio"
            ? html`
                <input
                  class="add-server-input"
                  type="text"
                  placeholder="Command (e.g., npx -y @mcp/server)"
                  .value=${this._newServerCommand}
                  @input=${(e: Event) => { this._newServerCommand = (e.target as HTMLInputElement).value; }}
                />
              `
            : html`
                <input
                  class="add-server-input"
                  type="text"
                  placeholder=${this._newServerTransport === "sse" ? "URL (e.g., http://localhost:3001/sse)" : "URL (e.g., http://localhost:3001/mcp)"}
                  .value=${this._newServerUrl}
                  @input=${(e: Event) => { this._newServerUrl = (e.target as HTMLInputElement).value; }}
                />
              `
        }
        ${this._newServerTransport !== "stdio"
          ? html`
              <textarea
                class="add-server-input"
                rows="2"
                placeholder="Custom headers (one per line: Header-Name: value)"
                .value=${this._newServerHeaders}
                @input=${(e: Event) => {
                  this._newServerHeaders = (e.target as HTMLTextAreaElement).value;
                }}
                style="resize:vertical;font-family:monospace;font-size:0.85rem"
              ></textarea>
            `
          : nothing
        }
        <textarea
          class="add-server-input"
          rows="2"
          placeholder="Environment variables (one per line: KEY=VALUE)"
          .value=${this._newServerEnv}
          @input=${(e: Event) => { this._newServerEnv = (e.target as HTMLTextAreaElement).value; }}
          style="resize:vertical;font-family:monospace;font-size:0.85rem"
        ></textarea>
        <div style="display: flex; gap: var(--ic-space-sm);">
          <button class="add-server-btn" @click=${() => this._addServer()}>Add Server</button>
          <button class="cancel-btn" @click=${() => {
            this._showAddForm = false;
            this._newServerName = "";
            this._newServerCommand = "";
            this._newServerUrl = "";
            this._newServerHeaders = "";
            this._newServerEnv = "";
          }}>Cancel</button>
        </div>
      </div>
    `;
  }

  private _renderCapabilityBadges(capabilities?: Readonly<Record<string, unknown>>) {
    if (!capabilities) return nothing;
    const badges: ReturnType<typeof html>[] = [];
    if (capabilities.tools) badges.push(html`<ic-tag variant="info">tools</ic-tag>`);
    if (capabilities.resources) badges.push(html`<ic-tag variant="accent">resources</ic-tag>`);
    if (capabilities.prompts) badges.push(html`<ic-tag variant="success">prompts</ic-tag>`);
    if (badges.length === 0) return nothing;
    return html`<span class="capability-badges">${badges}</span>`;
  }

  private _renderServerVersion(serverVersion?: { name: string; version: string }) {
    if (!serverVersion) return nothing;
    return html`<span class="server-version">${serverVersion.name} v${serverVersion.version}</span>`;
  }

  private _renderInstructions() {
    if (!this._serverDetail?.instructions) return nothing;
    return html`
      <div class="instructions-section">
        <button
          class="instructions-toggle"
          @click=${() => { this._showInstructions = !this._showInstructions; }}
        >
          ${this._showInstructions ? "Hide Instructions" : "Show Instructions"}
        </button>
        ${this._showInstructions
          ? html`<div class="instructions-content">${this._serverDetail.instructions}</div>`
          : nothing}
      </div>
    `;
  }

  private _renderToolList() {
    if (this._detailLoading) {
      return html`<div class="tool-loading">Loading tools...</div>`;
    }
    if (!this._serverDetail || !this._serverDetail.tools.length) {
      return html`<div class="tool-loading">No tools discovered</div>`;
    }
    return html`
      <div class="tool-list">
        ${this._serverDetail.tools.map(
          (tool) => html`
            <div class="tool-entry">
              <div class="tool-name">${tool.name}</div>
              <div class="tool-qualified">${tool.qualifiedName}</div>
              ${tool.description ? html`<div class="tool-desc">${tool.description}</div>` : nothing}
            </div>
          `,
        )}
      </div>
      ${this._renderInstructions()}
    `;
  }

  private _renderTestResult(serverName: string) {
    const testResult = this._testResult?.name === serverName ? this._testResult : null;
    if (!testResult) return nothing;
    return testResult.success
      ? html`<div class="server-test-result server-test-success">Connected -- ${testResult.toolCount} tool(s): ${testResult.tools?.join(", ") || "none"}</div>`
      : html`<div class="server-test-result server-test-error">${testResult.error}</div>`;
  }

  private _renderServer(server: McpServerListEntry) {
    const isExpanded = this._expandedServer === server.name;
    const isConnected = server.status === "connected";
    const canReconnect = server.status === "disconnected" || server.status === "error" || server.status === "reconnecting";
    const config = this._mcpConfig.find((c) => c.name === server.name);

    return html`
      <div class="server-card">
        <div class="server-header">
          <ic-tag color=${this._statusColor(server.status)}>${server.status === "reconnecting" && server.reconnectAttempt
            ? `reconnecting (${server.reconnectAttempt})`
            : server.status}</ic-tag>
          <span class="server-name">${server.name}</span>
          ${config ? html`
            <ic-tag variant=${config.transport === "stdio" ? "info" : "accent"}>${config.transport}</ic-tag>
          ` : nothing}
          <span class="server-tools-count">${server.toolCount} tool${server.toolCount !== 1 ? "s" : ""}</span>
          ${this._renderCapabilityBadges(server.capabilities)}
          ${this._renderServerVersion(server.serverVersion)}
          ${server.lastHealthCheck ? html`
            <span class="server-health">
              Last check: <ic-relative-time .timestamp=${server.lastHealthCheck}></ic-relative-time>
            </span>
          ` : nothing}
        </div>
        ${server.status === "error" && server.error ? html`
          <span class="server-error">${server.error}</span>
        ` : nothing}
        ${config ? html`
          <span class="server-command">
            ${config.transport === "stdio"
              ? `${config.command ?? ""}${config.args?.length ? " " + config.args.join(" ") : ""}`
              : config.url ?? ""}
          </span>
          ${config.env && Object.keys(config.env).length > 0
            ? html`<span class="server-env-badge" title=${Object.keys(config.env).join(", ")}>env: ${Object.keys(config.env).join(", ")}</span>`
            : nothing}
          ${config.headers && Object.keys(config.headers).length > 0
            ? html`<span class="server-env-badge" title=${Object.keys(config.headers).join(", ")}>headers: ${Object.keys(config.headers).join(", ")}</span>`
            : nothing}
        ` : nothing}
        <div class="server-actions">
          ${isConnected ? html`
            <button class="action-btn danger" @click=${() => this._requestDisconnect(server.name)}>Disconnect</button>
          ` : nothing}
          ${canReconnect ? html`
            <button class="action-btn primary" @click=${() => this._handleReconnect(server.name)}>Reconnect</button>
          ` : nothing}
          <button class="action-btn" @click=${() => this._handleTest(server.name)}>Test</button>
          <button class="action-btn" @click=${() => this._toggleTools(server.name)}>
            ${isExpanded ? "Hide Tools" : "Tools"}
          </button>
          ${config ? html`
            <input
              type="checkbox"
              class="toggle-checkbox"
              .checked=${config.enabled}
              @change=${(e: Event) => {
                this._toggleServer(server.name, (e.target as HTMLInputElement).checked);
              }}
              aria-label="Enable ${server.name}"
            />
            <button class="action-btn danger" @click=${() => this._removeServer(server.name)}>Delete</button>
          ` : nothing}
        </div>
        ${this._renderTestResult(server.name)}
        ${isExpanded ? this._renderToolList() : nothing}
      </div>
    `;
  }

  private _renderConfigOnlyServer(config: McpServerEntry) {
    const isTesting = this._testingServer === config.name;

    return html`
      <div class="server-card">
        <div class="server-header">
          <ic-tag color="default">not running</ic-tag>
          <span class="server-name">${config.name}</span>
          <ic-tag variant=${config.transport === "stdio" ? "info" : "accent"}>${config.transport}</ic-tag>
        </div>
        <span class="server-command">
          ${config.transport === "stdio"
            ? `${config.command ?? ""}${config.args?.length ? " " + config.args.join(" ") : ""}`
            : config.url ?? ""}
        </span>
        ${config.env && Object.keys(config.env).length > 0
          ? html`<span class="server-env-badge" title=${Object.keys(config.env).join(", ")}>env: ${Object.keys(config.env).join(", ")}</span>`
          : nothing}
        ${config.headers && Object.keys(config.headers).length > 0
          ? html`<span class="server-env-badge" title=${Object.keys(config.headers).join(", ")}>headers: ${Object.keys(config.headers).join(", ")}</span>`
          : nothing}
        <div class="server-actions">
          <button
            class="action-btn"
            ?disabled=${isTesting}
            @click=${() => this._testServerConfig(config)}
          >${isTesting ? "Testing..." : "Test"}</button>
          <input
            type="checkbox"
            class="toggle-checkbox"
            .checked=${config.enabled}
            @change=${(e: Event) => {
              this._toggleServer(config.name, (e.target as HTMLInputElement).checked);
            }}
            aria-label="Enable ${config.name}"
          />
          <button class="action-btn danger" @click=${() => this._removeServer(config.name)}>Delete</button>
        </div>
        ${this._renderTestResult(config.name)}
      </div>
    `;
  }

  override render() {
    if (this._loadState === "loading") {
      return html`<ic-skeleton-view variant="list"></ic-skeleton-view>`;
    }

    if (this._loadState === "error") {
      return html`
        <div class="error-message">
          Failed to load MCP server data
          <br />
          <button class="retry-btn" @click=${() => void this._loadData()}>Retry</button>
        </div>
      `;
    }

    // Config-only servers: in config but not in runtime list
    const configOnly = this._mcpConfig.filter(
      (c) => !this._servers.some((s) => s.name === c.name),
    );

    const hasAnyServer = this._servers.length > 0 || configOnly.length > 0;

    return html`
      ${this._showAddForm ? this._renderAddServerForm() : nothing}
      ${!hasAnyServer ? html`
        <ic-empty-state message="No MCP servers configured. Add a server to extend agent capabilities.">
          <button class="connect-btn" @click=${() => { this._showAddForm = true; }}>Add Server</button>
        </ic-empty-state>
      ` : html`
        <div class="header-row">
          <span class="header-title">${this._servers.length + configOnly.length} server${(this._servers.length + configOnly.length) !== 1 ? "s" : ""}</span>
          <button class="connect-btn" @click=${() => { this._showAddForm = true; }}>Add Server</button>
        </div>
        <div class="server-list">
          ${this._servers.map((s) => this._renderServer(s))}
          ${configOnly.map((c) => this._renderConfigOnlyServer(c))}
        </div>
      `}

      <ic-confirm-dialog
        ?open=${this._disconnectTarget !== null}
        title="Disconnect MCP Server"
        message="This will disconnect the server and its tools will become unavailable."
        confirmLabel="Disconnect"
        variant="danger"
        @confirm=${this._confirmDisconnect}
        @cancel=${this._cancelDisconnect}
      ></ic-confirm-dialog>

      <ic-confirm-dialog
        ?open=${this._deleteTarget !== null}
        title="Delete MCP Server"
        message="This will remove the server from configuration. The server will be disconnected if currently running."
        confirmLabel="Delete"
        variant="danger"
        @confirm=${this._confirmRemove}
        @cancel=${this._cancelRemove}
      ></ic-confirm-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-mcp-management": IcMcpManagement;
  }
}
