// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { ApiClient } from "./api/api-client.js";
import type { Router, RouteMatch } from "./router.js";
import type { RpcClient } from "./api/rpc-client.js";
import type { GlobalState } from "./state/global-state.js";
import type { EventDispatcher } from "./state/event-dispatcher.js";
import type { PollingController } from "./state/polling-controller.js";
import type { ConnectionStatus } from "./api/types/index.js";
import { createAppController, type AppController, type AppHost } from "./app-controller.js";
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
  "ic-cache-health-view": () => import("./views/cache-health.js"),
  "ic-spend-governance-view": () => import("./views/spend-governance.js"),
  "ic-incident-view": () => import("./views/incident-view.js"),
  "ic-subagents-view": () => import("./views/subagents.js"),
  "ic-security-view": () => import("./views/security.js"),
  "ic-config-editor": () => import("./views/config-editor.js"),
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
 * Root application component for the Comis operator console.
 *
 * Handles authentication, routing, and provides the API client
 * to child views via property passing. Uses sidebar + topbar shell
 * layout with grouped navigation and parameterized routes.
 *
 * Auth + polling + global-state + keyboard + command-palette
 * orchestration is owned by `app-controller.ts` (createAppController).
 * The shell retains the Lit @customElement tag registration, static
 * styles, router host fields, the VIEW_LOADERS map, _renderAuth /
 * _renderApp / _renderShortcutsHelp template helpers, and the render()
 * method. The controller's `_completeInit` preserves the documented
 * PollingController-after-rpcClient construction order verbatim.
 */
@customElement("ic-app")
export class IcApp extends LitElement implements AppHost {
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

    .auth-label {
      display: block;
      margin-bottom: 0.375rem;
      color: var(--ic-text-muted, #9ca3af);
      font-size: 0.8125rem;
      font-weight: 500;
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
      position: relative;
      background: var(--ic-surface, #111827);
      border: 1px solid var(--ic-border, #374151);
      border-radius: var(--ic-radius-lg, 0.75rem);
      padding: 1.5rem;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
    }

    .shortcuts-close {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      border: 0;
      background: transparent;
      color: var(--ic-text-muted, #9ca3af);
      cursor: pointer;
      font-size: 1.25rem;
      line-height: 1;
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

  // Auth + connection
  @state() _authenticated = false;
  @state() _authError = "";
  @state() _token = "";
  // Router host (driven by createAppController's initRouter callback)
  @state() _currentView = "ic-dashboard";
  @state() _currentRoute = "dashboard";
  @state() _routeParams: Record<string, string> = {};
  // Query string parsed by the router (e.g. #/security?tab=pending). Threaded
  // to views that deep-link sub-state; previously parsed but never delivered.
  @state() _routeQuery: Record<string, string> = {};
  // Mirrored from globalState snapshot
  @state() _connectionStatus: ConnectionStatus = "disconnected";
  @state() _pendingApprovals = 0;
  @state() _errorCount = 0;
  @state() _agentCount = 0;
  @state() _channelCount = 0;
  @state() _sessionCount = 0;
  // Shell UI flags
  @state() _sidebarOpen = false;
  @state() _viewLoading = false;
  @state() _commandPaletteOpen = false;
  @state() _shortcutsHelpOpen = false;
  // G+letter sequence waiting flag (kept on view for app-keyboard.test.ts
  // priv() test access; controller mutates it via host._gotoWaiting).
  _gotoWaiting = false;
  // Command-palette search data (controller updates from PollingController)
  @state() _agentList: Array<{ id: string; name?: string }> = [];
  @state() _sessionList: Array<{ key: string; agentId: string }> = [];

  _loadedViews = new Set<string>();

  // Controller-owned resources (controller mutates these on host).
  _apiClient: ApiClient | null = null;
  _router: Router | null = null;
  _rpcClient: RpcClient | null = null;
  _globalState: GlobalState | null = null;
  _eventDispatcher: EventDispatcher | null = null;
  _stateUnsubscribe: (() => void) | null = null;
  _approvalUnsub: (() => void) | null = null;
  _approvalResolvedUnsub: (() => void) | null = null;
  _errorUnsub: (() => void) | null = null;
  _pollingController: PollingController | null = null;

  private _appController: AppController | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Instantiate the controller if needed. Lit invokes hostConnected for a
    // controller registered on an already-connected host; a controller that
    // existed before this callback was invoked by super.connectedCallback().
    this._ensureController();
  }

  // ---------------------------------------------------------------------
  // Test-facing delegate methods (existing app.test.ts uses priv() to
  // call these directly; the bodies live in the controller).
  //
  // Lazy controller instantiation (`_ensureController`) lets the tests
  // call these methods before document.body.appendChild — preserves the
  // pre-extraction API where `priv(el)._initWithToken("…")` works
  // synchronously on a disconnected element.
  // ---------------------------------------------------------------------

  /** Lazily instantiate the app-controller. The Lit `connectedCallback`
   *  also calls `createAppController` — this is the test-friendly path
   *  for `priv(el)._initWithToken(…)` etc. on a disconnected element. */
  private _ensureController(): AppController {
    if (!this._appController) {
      this._appController = createAppController(this, {
        onRouteMatch: (match: RouteMatch) => {
          this._currentView = match.view;
          this._currentRoute = match.route;
          this._routeParams = match.params;
          this._routeQuery = match.query;
        },
      });
    }
    return this._appController;
  }

  /** Test-facing: delegates to controller.isInputTarget. */
  private _isInputTarget(e: KeyboardEvent): boolean {
    return this._ensureController().isInputTarget(e);
  }

  /** Test-facing: delegates to controller.handleGlobalKeydown. */
  private _handleGlobalKeydown(e: KeyboardEvent): void {
    this._ensureController().handleGlobalKeydown(e);
  }

  /** Test-facing: delegates to controller.handleCommand. */
  private _handleCommand(commandId: string): void {
    this._ensureController().handleCommand(commandId);
  }

  /** Test-facing: delegates to controller.initWithToken. */
  private _initWithToken(token: string): void {
    this._ensureController().initWithToken(token);
  }

  /** Test-facing: delegates to controller.handleLogin. */
  private _handleLogin(e: Event): void {
    this._ensureController().handleLogin(e);
  }

  /** Test-facing: delegates to controller.handleLogout. */
  private _handleLogout(): void {
    this._ensureController().handleLogout();
  }

  /** Test-facing: delegates to controller.cleanup (used by app.test.ts). */
  private _cleanup(): void {
    this._ensureController().cleanup();
  }

  private _renderAuth() {
    return html`
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-title">Comis</div>
          <div class="auth-subtitle">Enter your gateway token to continue</div>
          <form @submit=${this._handleLogin}>
            <label class="auth-label" for="gateway-token">Gateway token</label>
            <input
              id="gateway-token"
              name="gateway-token"
              class="auth-input"
              type="password"
              placeholder="Gateway bearer token"
              autocomplete="current-password"
              aria-invalid=${this._authError ? "true" : "false"}
              aria-describedby=${this._authError ? "gateway-token-error" : nothing}
            />
            ${this._authError
              ? html`<div id="gateway-token-error" class="auth-error" role="alert" aria-live="assertive">${this._authError}</div>`
              : nothing}
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
            @toggle-sidebar=${() => { this._sidebarOpen = !this._sidebarOpen; }}
            @navigate=${(e: CustomEvent<string>) => { this._router?.navigate(e.detail); }}
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
        <div class="shortcuts-panel" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
          <button class="shortcuts-close" type="button" aria-label="Close keyboard shortcuts" @click=${() => { this._shortcutsHelpOpen = false; }}>&times;</button>
          <div class="shortcuts-title" id="shortcuts-title">Keyboard Shortcuts</div>
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
      case "ic-cache-health-view":
      case "ic-spend-governance-view":
      case "ic-incident-view":
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
          .conversationRef=${this._routeParams["conversationRef"] ?? ""}
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
        return html`<ic-session-detail .apiClient=${this._apiClient} .rpcClient=${this._rpcClient} .conversationRef=${this._routeParams["conversationRef"] ?? ""}></ic-session-detail>`;
      case "ic-subagents-view":
        return html`<ic-subagents-view .rpcClient=${this._rpcClient} .apiClient=${this._apiClient} .eventDispatcher=${this._eventDispatcher}></ic-subagents-view>`;
      case "ic-security-view":
        return html`<ic-security-view .rpcClient=${this._rpcClient} .apiClient=${this._apiClient} .eventDispatcher=${this._eventDispatcher} .initialTab=${this._routeQuery["tab"] ?? "events"}></ic-security-view>`;
      case "ic-config-editor":
        return html`<ic-config-editor .rpcClient=${this._rpcClient}></ic-config-editor>`;
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
      case "ic-cache-health-view":
        return html`<ic-cache-health-view .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-cache-health-view>`;
      case "ic-spend-governance-view":
        return html`<ic-spend-governance-view .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher}></ic-spend-governance-view>`;
      case "ic-incident-view":
        // The drill ref (a sessionKey | traceId) rides the query string
        // (#/observe/incident?ref=<ref>). Pass it as the single `ref` — the view
        // classifies the shape (UUID → traceId, else sessionKey) so a traceId-shaped
        // ref resolves. Previously forced into `.sessionKey`, so a traceId never did.
        return html`<ic-incident-view .rpcClient=${this._rpcClient} .eventDispatcher=${this._eventDispatcher} .ref=${this._routeQuery["ref"] ?? ""}></ic-incident-view>`;
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
