// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { createApiClient, type ApiClient } from "./api/api-client.js";
import { createRouter, type Router, type RouteMatch } from "./router.js";
import { createRpcClient, type RpcClient } from "./api/rpc-client.js";
import { createGlobalState, type GlobalState } from "./state/global-state.js";
import { createEventDispatcher, type EventDispatcher } from "./state/event-dispatcher.js";
import { PollingController } from "./state/polling-controller.js";
import type { ConnectionStatus } from "./api/types/index.js";
// Import shell components (always needed) and dashboard (default landing view)
import "./components/shell/ic-sidebar.js";
import "./components/shell/ic-topbar.js";
import "./components/shell/ic-command-palette.js";
import "./components/shell/ic-skeleton-view.js";
import "./components/feedback/ic-toast.js";
import "./views/dashboard.js";

/** Lazy view loaders -- each view is loaded on first navigation via dynamic import(). */
const VIEW_LOADERS: Record<string, () => Promise<unknown>> = {
  "ic-chat-console": () => import("./views/chat-console.js"),
  "ic-memory-inspector": () => import("./views/memory-inspector.js"),
  "ic-agent-list": () => import("./views/agents/agent-list.js"),
  "ic-agent-detail": () => import("./views/agents/agent-detail.js"),
  "ic-agent-editor": () => import("./views/agents/agent-editor.js"),
  "ic-workspace-manager": () => import("./views/agents/workspace-manager.js"),
  "ic-skills-view": () => import("./views/skills.js"),
  "ic-mcp-management": () => import("./views/mcp-management.js"),
  "ic-models-view": () => import("./views/models.js"),
  "ic-channel-list": () => import("./views/channel-list.js"),
  "ic-channel-detail": () => import("./views/channel-detail.js"),
  "ic-message-center": () => import("./views/message-center.js"),
  "ic-scheduler-view": () => import("./views/scheduler.js"),
  "ic-session-list-view": () => import("./views/session-list.js"),
  "ic-session-detail": () => import("./views/session-detail.js"),
  "ic-observe-dashboard": () => import("./views/observe-view.js"),
  "ic-context-engine-view": () => import("./views/context-engine.js"),
  "ic-billing-view": () => import("./views/billing-view.js"),
  "ic-delivery-view": () => import("./views/delivery-view.js"),
  "ic-diagnostics-view": () => import("./views/diagnostics-view.js"),
  "ic-subagents-view": () => import("./views/subagents.js"),
  "ic-security-view": () => import("./views/security.js"),
  "ic-approvals-view": () => import("./views/approvals.js"),
  "ic-config-editor": () => import("./views/config-editor.js"),
  "ic-setup-wizard": () => import("./views/setup-wizard.js"),
  "ic-pipeline-list": () => import("./views/pipelines/pipeline-list.js"),
  "ic-pipeline-builder": () => import("./views/pipelines/pipeline-builder.js"),
  "ic-pipeline-monitor": () => import("./views/pipelines/pipeline-monitor.js"),
  "ic-pipeline-history": () => import("./views/pipelines/pipeline-history.js"),
  "ic-pipeline-history-detail": () => import("./views/pipelines/pipeline-history-detail.js"),
  "ic-context-dag-browser": () => import("./views/context-dag-browser.js"),
  "ic-media-test-view": () => import("./views/media-test.js"),
  "ic-media-config-view": () => import("./views/media-config.js"),
};

/**
 * Session storage key for the auth token.
 * Stored in sessionStorage so it clears on tab close.
 */
const TOKEN_KEY = "comis_token";

/**
 * Root application component for the Comis operator console.
 *
 * Handles authentication, routing, and provides the API client
 * to child views via property passing. Uses sidebar + topbar shell
 * layout with 14 navigation items and 27 parameterized routes.
 *
 * Wires RPC client, global state, and SSE event dispatcher on auth.
 * SSE events for approval:requested, approval:resolved, and system:error
 * drive sidebar badge counts via globalState updates.
 */
@customElement("ic-app")
export class IcApp extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--ic-bg, #030712);
      color: var(--ic-text, #f3f4f6);
      font-family: var(--ic-font-sans, ui-sans-serif, system-ui, sans-serif);
    }

    .auth-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }

    .auth-card {
      background: var(--ic-surface, #111827);
      border: 1px solid var(--ic-border, #374151);
      border-radius: var(--ic-radius-lg, 0.75rem);
      padding: 2rem;
      max-width: 24rem;
      width: 100%;
    }

    .auth-title {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }

    .auth-subtitle {
      color: var(--ic-text-muted, #9ca3af);
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
    }

    .auth-input {
      width: 100%;
      padding: 0.625rem 0.75rem;
      background: var(--ic-surface-2, #1f2937);
      border: 1px solid #4b5563;
      border-radius: var(--ic-radius-md, 0.5rem);
      color: var(--ic-text, #f3f4f6);
      font-size: 0.875rem;
      outline: none;
      box-sizing: border-box;
    }

    .auth-input:focus {
      border-color: var(--ic-accent, #3b82f6);
    }

    .auth-input::placeholder {
      color: var(--ic-text-dim, #6b7280);
    }

    .auth-btn {
      width: 100%;
      padding: 0.625rem;
      margin-top: 1rem;
      background: var(--ic-accent, #3b82f6);
      color: white;
      border: none;
      border-radius: var(--ic-radius-md, 0.5rem);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
    }

    .auth-btn:hover {
      background: var(--ic-accent-hover, #2563eb);
    }

    .auth-error {
      color: var(--ic-error, #f87171);
      font-size: 0.75rem;
      margin-top: 0.5rem;
    }

    /* Shell layout: sidebar + main area */
    .shell {
      display: flex;
      min-height: 100vh;
    }

    .shell-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .content {
      flex: 1;
      padding: var(--ic-space-lg, 1.5rem);
      max-width: 1440px;
      width: 100%;
      margin: 0 auto;
      box-sizing: border-box;
      overflow-y: auto;
    }

    /* Placeholder for unimplemented views */
    .placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 300px;
      color: var(--ic-text-dim, #6b7280);
      font-size: 1rem;
    }

    .placeholder-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--ic-text-muted, #9ca3af);
    }

    /* Keyboard shortcuts help overlay */
    .shortcuts-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 99;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .shortcuts-panel {
      background: var(--ic-surface, #111827);
      border: 1px solid var(--ic-border, #374151);
      border-radius: var(--ic-radius-lg, 0.75rem);
      padding: 1.5rem;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
    }

    .shortcuts-title {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }

    .shortcuts-table {
      width: 100%;
      border-collapse: collapse;
    }

    .shortcuts-table td {
      padding: 0.375rem 0;
      font-size: 0.875rem;
    }

    .shortcuts-table td:first-child {
      color: var(--ic-text-dim, #6b7280);
      padding-right: 1rem;
      white-space: nowrap;
    }

    .shortcuts-table kbd {
      background: var(--ic-surface-2, #1f2937);
      border: 1px solid var(--ic-border, #374151);
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 0.75rem;
      font-family: inherit;
    }
  `;

  @state() private _authenticated = false;
  @state() private _authError = "";
  @state() private _currentView = "ic-dashboard";
  @state() private _currentRoute = "dashboard";
  @state() private _routeParams: Record<string, string> = {};
  @state() private _connectionStatus: ConnectionStatus = "disconnected";
  @state() private _pendingApprovals = 0;
  @state() private _errorCount = 0;
  @state() private _agentCount = 0;
  @state() private _channelCount = 0;
  @state() private _sessionCount = 0;
  @state() private _sidebarOpen = false;
  @state() private _viewLoading = false;
  @state() private _commandPaletteOpen = false;
  @state() private _shortcutsHelpOpen = false;
  @state() private _agentList: Array<{ id: string; name?: string }> = [];
  @state() private _sessionList: Array<{ key: string; agentId: string }> = [];

  private _loadedViews = new Set<string>();
  private _pendingGotoKey: ReturnType<typeof setTimeout> | null = null;

  private _apiClient: ApiClient | null = null;
  private _router: Router | null = null;
  private _rpcClient: RpcClient | null = null;
  private _globalState: GlobalState | null = null;
  private _eventDispatcher: EventDispatcher | null = null;
  private _stateUnsubscribe: (() => void) | null = null;
  private _approvalUnsub: (() => void) | null = null;
  private _approvalResolvedUnsub: (() => void) | null = null;
  private _errorUnsub: (() => void) | null = null;
  private _pollingController: PollingController | null = null;
  @state() private _token = "";

  private _boundKeyHandler = this._handleGlobalKeydown.bind(this);
  private _gotoWaiting = false;

  override connectedCallback(): void {
    super.connectedCallback();

    // Check for existing token
    const savedToken = sessionStorage.getItem(TOKEN_KEY);
    if (savedToken) {
      this._initWithToken(savedToken);
    }

    // Global keyboard shortcut handler
    document.addEventListener("keydown", this._boundKeyHandler);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._cleanup();
    document.removeEventListener("keydown", this._boundKeyHandler);
    if (this._pendingGotoKey) {
      clearTimeout(this._pendingGotoKey);
      this._pendingGotoKey = null;
    }
  }

  /** Check if a keyboard event target is an input-like element. */
  private _isInputTarget(e: KeyboardEvent): boolean {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if ((e.target as HTMLElement)?.isContentEditable) return true;
    return false;
  }

  private _handleGlobalKeydown(e: KeyboardEvent): void {
    // Ctrl+K / Cmd+K: Toggle command palette (works even in inputs)
    if ((e.ctrlKey || e.metaKey) && e.key === "k") {
      e.preventDefault();
      this._commandPaletteOpen = !this._commandPaletteOpen;
      return;
    }

    // Escape: Close overlays
    if (e.key === "Escape") {
      if (this._commandPaletteOpen) {
        this._commandPaletteOpen = false;
        return;
      }
      if (this._shortcutsHelpOpen) {
        this._shortcutsHelpOpen = false;
        return;
      }
      this.dispatchEvent(new CustomEvent("close-overlay", { bubbles: true, composed: true }));
      if (this._sidebarOpen) {
        this._sidebarOpen = false;
      }
      return;
    }

    // Skip remaining shortcuts if in an input-like element
    if (this._isInputTarget(e)) return;
    // Skip if command palette is open (it handles its own keys)
    if (this._commandPaletteOpen) return;

    // ?: Show shortcuts help
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this._shortcutsHelpOpen = !this._shortcutsHelpOpen;
      return;
    }

    // G+letter two-key sequences: Go to...
    if (this._gotoWaiting) {
      this._gotoWaiting = false;
      if (this._pendingGotoKey) {
        clearTimeout(this._pendingGotoKey);
        this._pendingGotoKey = null;
      }
      switch (e.key.toLowerCase()) {
        case "d": this._router?.navigate("dashboard"); return;
        case "a": this._router?.navigate("agents"); return;
        case "c": this._router?.navigate("chat"); return;
        case "s": this._router?.navigate("sessions"); return;
        case "o": this._router?.navigate("observe/overview"); return;
      }
      return;
    }

    // Start G+letter sequence
    if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this._gotoWaiting = true;
      this._pendingGotoKey = setTimeout(() => {
        this._gotoWaiting = false;
        this._pendingGotoKey = null;
      }, 500);
    }
  }

  /** Handle command dispatched from command palette. */
  private _handleCommand(commandId: string): void {
    switch (commandId) {
      case "refresh":
        window.location.reload();
        break;
      case "toggle-sidebar":
        this._sidebarOpen = !this._sidebarOpen;
        break;
      case "logout":
        this._handleLogout();
        break;
      case "show-shortcuts":
        this._shortcutsHelpOpen = true;
        break;
    }
  }

  private _initWithToken(token: string): void {
    this._token = token;

    // Determine base URL from current location
    const baseUrl = `${window.location.protocol}//${window.location.host}`;
    this._apiClient = createApiClient(baseUrl, token);

    // Verify token by calling an authenticated endpoint (not health, which is unauthenticated)
    this._apiClient
      .getAgents()
      .then(() => {
        sessionStorage.setItem(TOKEN_KEY, token);
        this._authenticated = true;
        this._authError = "";

        // Create RPC client and connect via WebSocket
        this._rpcClient = createRpcClient();
        const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
        this._rpcClient.connect(wsUrl, token);

        // Upgrade apiClient with RPC support so memory/session management
        // methods use WebSocket JSON-RPC instead of REST fallback
        const rpc = this._rpcClient;
        this._apiClient = createApiClient(baseUrl, token, (method, params) => rpc.call(method, params));

        // Create global state store
        this._globalState = createGlobalState();

        // Wire RPC status changes to global state
        this._rpcClient.onStatusChange((status) => {
          this._globalState?.update({ connectionStatus: status });
        });

        // Create event dispatcher (SSE) and start listening
        this._eventDispatcher = createEventDispatcher();
        this._eventDispatcher.start(baseUrl, token);

        // Wire SSE events to globalState for badge counts
        this._approvalUnsub = this._eventDispatcher.addEventListener(
          "approval:requested",
          () => {
            const snap = this._globalState!.getSnapshot();
            this._globalState!.update({
              pendingApprovals: snap.pendingApprovals + 1,
            });
          },
        );

        this._approvalResolvedUnsub = this._eventDispatcher.addEventListener(
          "approval:resolved",
          () => {
            const snap = this._globalState!.getSnapshot();
            this._globalState!.update({
              pendingApprovals: Math.max(0, snap.pendingApprovals - 1),
            });
          },
        );

        this._errorUnsub = this._eventDispatcher.addEventListener(
          "system:error",
          () => {
            const snap = this._globalState!.getSnapshot();
            this._globalState!.update({
              errorCount: (snap.errorCount ?? 0) + 1,
            });
          },
        );

        // Subscribe to global state for reactive UI updates
        this._stateUnsubscribe = this._globalState.subscribe(() => {
          const snap = this._globalState!.getSnapshot();
          this._connectionStatus = snap.connectionStatus;
          this._pendingApprovals = snap.pendingApprovals;
          this._errorCount = snap.errorCount;
          this._agentCount = snap.agentCount;
          this._channelCount = snap.channelCount;
          this._sessionCount = snap.sessionCount;
        });

        // Start polling for badge counts (agent/channel/session) + command palette data
        this._pollingController = new PollingController(
          this,
          this._rpcClient,
          (data) => {
            this._agentCount = data.agents;
            this._channelCount = data.channels;
            this._sessionCount = data.sessions;
            this._agentList = data.agentIds.map((id) => ({ id }));
            this._sessionList = data.sessionEntries.map((s) => ({ key: s.sessionKey, agentId: s.agentId }));
          },
          30_000,
        );
        // Host is already connected, so manually kick off the first poll
        this._pollingController.hostConnected();

        // Initialize parameterized router
        this._router = createRouter((match: RouteMatch) => {
          this._currentView = match.view;
          this._currentRoute = match.route;
          this._routeParams = match.params;
        });
        this._router.start();
      })
      .catch(() => {
        this._authError = "Invalid token or server unreachable";
        sessionStorage.removeItem(TOKEN_KEY);
      });
  }

  private _handleLogin(e: Event): void {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const input = form.querySelector("input") as HTMLInputElement;
    const token = input.value.trim();

    if (!token) {
      this._authError = "Please enter a token";
      return;
    }

    this._initWithToken(token);
  }

  private _handleLogout(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    this._authenticated = false;
    this._cleanup();
    this._apiClient = null;
    this._token = "";
  }

  private _cleanup(): void {
    if (this._pollingController) {
      this._pollingController.hostDisconnected();
      this._pollingController = null;
    }
    this._rpcClient?.disconnect();
    this._rpcClient = null;
    this._eventDispatcher?.stop();
    this._eventDispatcher = null;
    this._stateUnsubscribe?.();
    this._stateUnsubscribe = null;
    this._approvalUnsub?.();
    this._approvalUnsub = null;
    this._approvalResolvedUnsub?.();
    this._approvalResolvedUnsub = null;
    this._errorUnsub?.();
    this._errorUnsub = null;
    this._globalState = null;
    this._router?.stop();
    this._router = null;
  }

  private _renderAuth() {
    return html`
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-title">Comis</div>
          <div class="auth-subtitle">Enter your gateway token to continue</div>
          <form @submit=${this._handleLogin}>
            <input
              class="auth-input"
              type="password"
              placeholder="Gateway bearer token"
              autocomplete="off"
            />
            ${this._authError ? html`<div class="auth-error">${this._authError}</div>` : nothing}
            <button class="auth-btn" type="submit">Connect</button>
          </form>
        </div>
      </div>
    `;
  }

  private _renderApp() {
    return html`
      <div class="shell">
        <ic-sidebar
          .currentRoute=${this._currentRoute}
          .pendingApprovals=${this._pendingApprovals}
          .errorCount=${this._errorCount}
          .agentCount=${this._agentCount}
          .channelCount=${this._channelCount}
          .sessionCount=${this._sessionCount}
          ?open=${this._sidebarOpen}
          @navigate=${(e: CustomEvent<string>) => {
            this._router?.navigate(e.detail);
            this._sidebarOpen = false;
          }}
          @logout=${() => this._handleLogout()}
          @close=${() => { this._sidebarOpen = false; }}
        ></ic-sidebar>
        <div class="shell-main">
          <ic-topbar
            .connectionStatus=${this._connectionStatus}
            .notificationCount=${this._pendingApprovals}
            .tokenId=${this._token}
            @toggle-sidebar=${() => { this._sidebarOpen = !this._sidebarOpen; }}
            @logout=${() => this._handleLogout()}
          ></ic-topbar>
          <main class="content" role="main" aria-label="Main content" @navigate=${(e: CustomEvent<string>) => { this._router?.navigate(e.detail); }}>
            ${this._renderView()}
          </main>
        </div>
      </div>
      ${this._commandPaletteOpen ? html`
        <ic-command-palette
          ?open=${this._commandPaletteOpen}
          .agents=${this._agentList}
          .sessions=${this._sessionList}
          @navigate=${(e: CustomEvent<string>) => { this._router?.navigate(e.detail); this._commandPaletteOpen = false; }}
          @close=${() => { this._commandPaletteOpen = false; }}
          @command=${(e: CustomEvent<string>) => this._handleCommand(e.detail)}
        ></ic-command-palette>
      ` : nothing}
      ${this._shortcutsHelpOpen ? this._renderShortcutsHelp() : nothing}
      <ic-toast></ic-toast>
    `;
  }

  private _renderShortcutsHelp() {
    return html`
      <div class="shortcuts-backdrop" @click=${(e: MouseEvent) => { if ((e.target as HTMLElement).classList.contains("shortcuts-backdrop")) this._shortcutsHelpOpen = false; }}>
        <div class="shortcuts-panel" role="dialog" aria-label="Keyboard shortcuts">
          <div class="shortcuts-title">Keyboard Shortcuts</div>
          <table class="shortcuts-table">
            <tbody>
              <tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd></td><td>Command Palette</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>Close Overlay</td></tr>
              <tr><td><kbd>?</kbd></td><td>Toggle This Help</td></tr>
              <tr><td><kbd>G</kbd> then <kbd>D</kbd></td><td>Go to Dashboard</td></tr>
              <tr><td><kbd>G</kbd> then <kbd>A</kbd></td><td>Go to Agents</td></tr>
              <tr><td><kbd>G</kbd> then <kbd>C</kbd></td><td>Go to Chat</td></tr>
              <tr><td><kbd>G</kbd> then <kbd>S</kbd></td><td>Go to Sessions</td></tr>
              <tr><td><kbd>G</kbd> then <kbd>O</kbd></td><td>Go to Observability</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  private async _loadViewIfNeeded(viewTag: string): Promise<void> {
    if (this._loadedViews.has(viewTag)) return;
    const loader = VIEW_LOADERS[viewTag];
    if (!loader) return; // Eagerly loaded (dashboard) or unknown
    this._viewLoading = true;
    try {
      await loader();
      this._loadedViews.add(viewTag);
    } finally {
      this._viewLoading = false;
    }
  }

  /** Map view tags to skeleton variants for lazy-load placeholders. */
  private _getSkeletonVariant(): "dashboard" | "list" | "detail" | "table" | "editor" {
    switch (this._currentView) {
      case "ic-dashboard": return "dashboard";
      case "ic-agent-detail":
      case "ic-session-detail":
      case "ic-channel-detail":
      case "ic-chat-console":
      case "ic-message-center": return "detail";
      case "ic-config-editor":
      case "ic-pipeline-builder":
      case "ic-workspace-manager": return "editor";
      case "ic-billing-view":
      case "ic-delivery-view":
      case "ic-diagnostics-view":
      case "ic-observe-dashboard":
      case "ic-context-engine-view":
      case "ic-memory-inspector":
      case "ic-media-test-view":
      case "ic-media-config-view": return "table";
      default: return "list";
    }
  }

  private _renderView() {
    // Lazy-load views on first navigation
    if (!this._loadedViews.has(this._currentView) && VIEW_LOADERS[this._currentView]) {
      this._loadViewIfNeeded(this._currentView);
      return html`<ic-skeleton-view variant=${this._getSkeletonVariant()}></ic-skeleton-view>`;
    }

    switch (this._currentView) {
      case "ic-dashboard":
        return html`<ic-dashboard .apiClient=${this._apiClient} .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-dashboard>`;
      case "ic-chat-console":
        return html`<ic-chat-console
          .apiClient=${this._apiClient}
          .rpcClient=${this._rpcClient}
          .eventDispatcher=${this._eventDispatcher}
          .sessionKey=${this._routeParams["sessionKey"] ?? ""}
          .authToken=${this._token}
        ></ic-chat-console>`;
      case "ic-memory-inspector":
        return html`<ic-memory-inspector .apiClient=${this._apiClient} .rpcClient=${this._rpcClient}></ic-memory-inspector>`;
      case "ic-agent-list":
        return html`<ic-agent-list .apiClient=${this._apiClient} .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-agent-list>`;
      case "ic-agent-detail":
        return html`<ic-agent-detail .apiClient=${this._apiClient} .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher} .agentId=${this._routeParams.id ?? ""}></ic-agent-detail>`;
      case "ic-agent-editor":
        return html`<ic-agent-editor .rpcClient=${this._rpcClient} .agentId=${this._routeParams.id ?? ""}></ic-agent-editor>`;
      case "ic-workspace-manager":
        return html`<ic-workspace-manager
          .rpcClient=${this._rpcClient}
          .agentId=${this._routeParams.id ?? ""}
        ></ic-workspace-manager>`;
      case "ic-skills-view":
        return html`<ic-skills-view .apiClient=${this._apiClient} .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-skills-view>`;
      case "ic-mcp-management":
        return html`<ic-mcp-management .rpcClient=${this._rpcClient} .apiClient=${this._apiClient} .eventDispatcher=${this._eventDispatcher}></ic-mcp-management>`;
      case "ic-models-view":
        return html`<ic-models-view .apiClient=${this._apiClient} .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-models-view>`;
      case "ic-channel-list":
        return html`<ic-channel-list
          .apiClient=${this._apiClient}
          .rpcClient=${this._rpcClient}
          .eventDispatcher=${this._eventDispatcher}
          @navigate=${(e: CustomEvent<string>) => { this._router?.navigate(e.detail); }}
        ></ic-channel-list>`;
      case "ic-channel-detail":
        return html`<ic-channel-detail
          .apiClient=${this._apiClient}
          .rpcClient=${this._rpcClient}
          .eventDispatcher=${this._eventDispatcher}
          .channelType=${this._routeParams["type"] ?? ""}
          @navigate=${(e: CustomEvent<string>) => { this._router?.navigate(e.detail); }}
        ></ic-channel-detail>`;
      case "ic-message-center":
        return html`<ic-message-center
          .rpcClient=${this._rpcClient}
          .eventDispatcher=${this._eventDispatcher}
          .channelType=${this._routeParams["type"] ?? ""}
          @navigate=${(e: CustomEvent<string>) => { this._router?.navigate(e.detail); }}
        ></ic-message-center>`;
      case "ic-scheduler-view":
        return html`<ic-scheduler-view
          .rpcClient=${this._rpcClient}
          .eventDispatcher=${this._eventDispatcher}
          .routeParams=${this._routeParams}
        ></ic-scheduler-view>`;
      case "ic-session-list-view":
        return html`<ic-session-list-view .apiClient=${this._apiClient} .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-session-list-view>`;
      case "ic-session-detail":
        return html`<ic-session-detail .apiClient=${this._apiClient} .rpcClient=${this._rpcClient} .sessionKey=${this._routeParams.key ?? ""}></ic-session-detail>`;
      case "ic-subagents-view":
        return html`<ic-subagents-view .rpcClient=${this._rpcClient} .apiClient=${this._apiClient} .eventDispatcher=${this._eventDispatcher}></ic-subagents-view>`;
      case "ic-security-view":
        return html`<ic-security-view .rpcClient=${this._rpcClient} .apiClient=${this._apiClient} .eventDispatcher=${this._eventDispatcher}></ic-security-view>`;
      case "ic-approvals-view":
        return html`<ic-approvals-view .rpcClient=${this._rpcClient} .apiClient=${this._apiClient}></ic-approvals-view>`;
      case "ic-config-editor":
        return html`<ic-config-editor .rpcClient=${this._rpcClient}></ic-config-editor>`;
      case "ic-setup-wizard":
        return html`<ic-setup-wizard .rpcClient=${this._rpcClient}></ic-setup-wizard>`;
      case "ic-observe-dashboard":
        return html`<ic-observe-view .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher} .initialTab=${"overview"}></ic-observe-view>`;
      case "ic-context-engine-view":
        return html`<ic-context-engine-view .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-context-engine-view>`;
      case "ic-context-dag-browser":
        return html`<ic-context-dag-browser .rpcClient=${this._rpcClient}></ic-context-dag-browser>`;
      case "ic-media-test-view":
        return html`<ic-media-test-view .rpcClient=${this._rpcClient} .apiClient=${this._apiClient}></ic-media-test-view>`;
      case "ic-media-config-view":
        return html`<ic-media-config-view .rpcClient=${this._rpcClient}></ic-media-config-view>`;
      case "ic-billing-view":
        return html`<ic-billing-view .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-billing-view>`;
      case "ic-delivery-view":
        return html`<ic-delivery-view .rpcClient=${this._rpcClient}></ic-delivery-view>`;
      case "ic-diagnostics-view":
        return html`<ic-diagnostics-view .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-diagnostics-view>`;
      case "ic-pipeline-list":
        return html`<ic-pipeline-list .rpcClient=${this._rpcClient}></ic-pipeline-list>`;
      case "ic-pipeline-builder":
        return html`<ic-pipeline-builder .rpcClient=${this._rpcClient} .graphId=${this._routeParams["graphId"] ?? ""}></ic-pipeline-builder>`;
      case "ic-pipeline-monitor":
        return html`<ic-pipeline-monitor .rpcClient=${this._rpcClient} .graphId=${this._routeParams["graphId"] ?? ""} .eventDispatcher=${this._eventDispatcher}></ic-pipeline-monitor>`;
      case "ic-pipeline-history":
        return html`<ic-pipeline-history .rpcClient=${this._rpcClient}></ic-pipeline-history>`;
      case "ic-pipeline-history-detail":
        return html`<ic-pipeline-history-detail .rpcClient=${this._rpcClient} .graphId=${this._routeParams["graphId"] ?? ""}></ic-pipeline-history-detail>`;
      default:
        return this._renderPlaceholder();
    }
  }

  private _renderPlaceholder() {
    // Extract a human-readable name from the view tag
    const viewName = this._currentView
      .replace(/^ic-/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    return html`
      <div class="placeholder">
        <div class="placeholder-title">${viewName}</div>
        <div>Coming soon</div>
      </div>
    `;
  }

  override render() {
    return this._authenticated ? this._renderApp() : this._renderAuth();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ic-app": IcApp;
  }
}
