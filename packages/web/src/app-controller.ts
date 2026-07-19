// SPDX-License-Identifier: Apache-2.0
/**
 * App-shell controller.
 *
 * App.ts has 0 `rpcClient.call(...)` direct sites at HEAD (RPC indirect
 * via PollingController). The controller owns auth + polling +
 * global-state + keyboard + command-palette orchestration so the shell
 * stays under the 800L cap. Shell retains `@customElement("ic-app")`,
 * static styles, router host (`_router`, `_currentView`, `_currentRoute`,
 * `_routeParams`), VIEW_LOADERS map, `_render*` template helpers, and
 * Lit lifecycle hooks.
 *
 * PollingController construction order MUST be: token-validation →
 * rpcClient → globalState wiring → PollingController. A dedicated
 * controller test asserts this. NEVER log token/err.cause/JSON.stringify(err)
 * in auth catch — only err.message. NO @customElement decorator here —
 * controller is a plain object implementing ReactiveController.
 *
 * @module
 */
import type { ReactiveController } from "lit";
import { createApiClient, type ApiClient } from "./api/api-client.js";
import { createRouter, type Router, type RouteMatch } from "./router.js";
import { createRpcClient, type RpcClient } from "./api/rpc-client.js";
import { createGlobalState, requireGlobalState, type GlobalState } from "./state/global-state.js";
import { createEventDispatcher, type EventDispatcher } from "./state/event-dispatcher.js";
import { PollingController } from "./state/polling-controller.js";
import type { ConnectionStatus } from "./api/types/index.js";
import { systemClearTimeout, systemSetTimeout } from "@comis/core";

/* ------------------------------------------------------------------ */
/*  Host contract                                                      */
/* ------------------------------------------------------------------ */

/**
 * Structural contract the controller requires from the app shell.
 *
 * The controller mutates these fields directly because the existing
 * Lit `@state` decorators on the shell drive `render()` reactivity —
 * the controller writing to `host._authenticated = true` triggers a
 * re-render via Lit's accessor magic exactly like the pre-extraction
 * inline body did.
 */
export interface AppHost {
  // Auth + connection
  _authenticated: boolean;
  _authError: string;
  _token: string;
  _apiClient: ApiClient | null;
  _rpcClient: RpcClient | null;

  // Global state + SSE
  _globalState: GlobalState | null;
  _eventDispatcher: EventDispatcher | null;
  _stateUnsubscribe: (() => void) | null;
  _approvalUnsub: (() => void) | null;
  _approvalResolvedUnsub: (() => void) | null;
  _errorUnsub: (() => void) | null;

  // Polling lifecycle
  _pollingController: PollingController | null;

  // Mirrored from globalState snapshot for sidebar/topbar bindings
  _connectionStatus: ConnectionStatus;
  _pendingApprovals: number;
  _errorCount: number;
  _agentCount: number;
  _channelCount: number;
  _sessionCount: number;

  // Command-palette search data (paired with PollingController callback)
  _agentList: Array<{ id: string; name?: string }>;
  _sessionList: Array<{ key: string; agentId: string }>;

  // Command-palette + keyboard UI flags
  _sidebarOpen: boolean;
  _commandPaletteOpen: boolean;
  _shortcutsHelpOpen: boolean;

  // G+letter sequence state (kept on host for app-keyboard.test.ts priv()
  // compatibility — pre-extraction app.ts had this as a private field).
  _gotoWaiting: boolean;

  // Router host (controller calls host._router?.navigate but does NOT own it)
  _router: Router | null;

  // Lit lifecycle hook used by controllers in shell context
  addController(controller: ReactiveController): void;
  removeController(controller: ReactiveController): void;
  requestUpdate(): void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

/** Session storage key for the auth token. */
const TOKEN_KEY = "comis_token";

/** Polling interval for badge counts. */
const POLLING_INTERVAL_MS = 30_000;

/** G+letter sequence timeout. */
const GOTO_SEQUENCE_TIMEOUT_MS = 500;

/* ------------------------------------------------------------------ */
/*  Controller interface                                                */
/* ------------------------------------------------------------------ */

export interface AppController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;

  /** Validate token, construct rpcClient, globalState, eventDispatcher,
   *  PollingController in the correct order; updates host fields. */
  initWithToken(token: string): void;

  /** Form-submit handler: extracts token from form, validates, and calls
   *  `initWithToken`. Sets `_authError` if token is empty/whitespace. */
  handleLogin(e: Event): void;

  /** Clears sessionStorage + tears down all owned resources + resets
   *  host fields to logged-out state. */
  handleLogout(): void;

  /** Inverse of `initWithToken` — runs on logout AND on host disconnect.
   *  Tears down PollingController, rpcClient, eventDispatcher, globalState,
   *  router, and all SSE subscriptions. */
  cleanup(): void;

  /** Global keydown handler — Cmd/Ctrl+K, Escape, "?", G+letter goto. */
  handleGlobalKeydown(e: KeyboardEvent): void;

  /** Command-palette command dispatcher. */
  handleCommand(commandId: string): void;

  /** Helper: detects if a keyboard event target is an input-like element. */
  isInputTarget(e: KeyboardEvent): boolean;

  /** Initialize router instance with view-change callback. */
  initRouter(onMatch: (match: RouteMatch) => void): Router;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

/**
 * Options bag for the controller. The shell passes its router-match
 * callback here so the controller can install the router with the
 * correct route → @state mapping during the auth completion flow.
 */
export interface AppControllerOptions {
  /** Route-match callback invoked when a hash navigation resolves. The
   *  shell uses this to update `_currentView` / `_currentRoute` /
   *  `_routeParams`. Optional — controller installs a no-op if absent. */
  onRouteMatch?: (match: RouteMatch) => void;
}

export function createAppController(
  host: AppHost,
  options: AppControllerOptions = {},
): AppController {
  const routeMatchCallback = options.onRouteMatch ?? ((_match: RouteMatch) => { /* no-op */ });
  // Initialize host._gotoWaiting if undefined (test priv() may construct
  // a host without it, but the LitElement default sets it to false).
  if (host._gotoWaiting === undefined) host._gotoWaiting = false;
  // Internal: G+letter sequence timer (controller-local; the boolean
  // waiting-flag lives on host as `_gotoWaiting` for priv()-test access).
  let pendingGotoKey: ReturnType<typeof setTimeout> | null = null;
  // Bound keyboard handler reference for document add/removeEventListener.
  const boundKeyHandler = (e: KeyboardEvent): void => controller.handleGlobalKeydown(e);

  /**
   * Owned PollingController construction:
   *   1. rpcClient already exists (caller's responsibility).
   *   2. Construct `new PollingController(host, rpcClient, onData, 30_000)`.
   *
   * The constructor registers with Lit. When the host is connected, Lit
   * invokes hostConnected immediately, so starting it again here would create
   * a second interval whose handle cannot be cleaned up.
   */
  function startPolling(rpcClient: RpcClient): PollingController {
    const polling = new PollingController(
      host,
      rpcClient,
      (data) => {
        host._agentCount = data.agents;
        host._channelCount = data.channels;
        host._sessionCount = data.sessions;
        host._agentList = data.agentIds.map((id) => ({ id }));
        host._sessionList = data.sessionEntries.map((s) => ({
          key: s.sessionKey,
          agentId: s.agentId,
        }));
      },
      POLLING_INTERVAL_MS,
    );
    return polling;
  }

  /**
   * Wire SSE events to `globalState` for sidebar badge counts. Uses
   * `requireGlobalState` to surface null misuse as a typed throw
   * instead of silent non-null assertions (matches pre-extraction
   * source behaviour at app.ts:439-472).
   */
  function wireSseEventsToGlobalState(dispatcher: EventDispatcher): {
    approvalUnsub: () => void;
    approvalResolvedUnsub: () => void;
    errorUnsub: () => void;
  } {
    const approvalUnsub = dispatcher.addEventListener("approval:requested", () => {
      const state = requireGlobalState(host);
      const snap = state.getSnapshot();
      state.update({ pendingApprovals: snap.pendingApprovals + 1 });
    });
    const approvalResolvedUnsub = dispatcher.addEventListener("approval:resolved", () => {
      const state = requireGlobalState(host);
      const snap = state.getSnapshot();
      state.update({
        pendingApprovals: Math.max(0, snap.pendingApprovals - 1),
      });
    });
    const errorUnsub = dispatcher.addEventListener("system:error", () => {
      const state = requireGlobalState(host);
      const snap = state.getSnapshot();
      state.update({ errorCount: (snap.errorCount ?? 0) + 1 });
    });
    return { approvalUnsub, approvalResolvedUnsub, errorUnsub };
  }

  /**
   * Mirror globalState snapshot fields onto host @state for reactive UI.
   * Returns the unsubscribe handle.
   */
  function subscribeGlobalStateToHost(globalState: GlobalState): () => void {
    return globalState.subscribe(() => {
      const state = requireGlobalState(host);
      const snap = state.getSnapshot();
      host._connectionStatus = snap.connectionStatus;
      host._pendingApprovals = snap.pendingApprovals;
      host._errorCount = snap.errorCount;
      host._agentCount = snap.agentCount;
      host._channelCount = snap.channelCount;
      host._sessionCount = snap.sessionCount;
    });
  }

  /**
   * Completes auth init AFTER the token-verification getAgents() call has
   * succeeded. CRITICAL ORDER (matches app.ts:411-508):
   *   1. Persist token + flip _authenticated.
   *   2. Construct rpcClient + open WebSocket.
   *   3. Upgrade ApiClient with RPC bridge.
   *   4. Construct globalState + wire rpcClient.onStatusChange.
   *   5. Construct eventDispatcher + start SSE + wire badge events.
   *   6. Subscribe globalState to host mirror fields.
   *   7. Construct PollingController (depends on rpcClient existing).
   *   8. Manually kick off first poll.
   *   9. Initialize router with view-change callback.
   *
   * Threat-model: PollingController instantiation order inversion —
   * DO NOT reorder steps 2 vs 7. The dedicated controller test asserts
   * this order.
   */
  function _completeInit(token: string, baseUrl: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
    host._authenticated = true;
    host._authError = "";

    // STEP 2: Construct rpcClient and connect via WebSocket.
    host._rpcClient = createRpcClient();
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    host._rpcClient.connect(wsUrl, token);

    // STEP 3: Upgrade ApiClient with RPC support so memory/session methods
    // use WebSocket JSON-RPC instead of REST fallback.
    const rpc = host._rpcClient;
    host._apiClient = createApiClient(baseUrl, token, rpc.call.bind(rpc));

    // STEP 4: Construct globalState + wire RPC status mirror.
    host._globalState = createGlobalState();
    host._rpcClient.onStatusChange((status) => {
      host._globalState?.update({ connectionStatus: status });
    });

    // STEP 5: Construct eventDispatcher + start SSE + wire badge events.
    host._eventDispatcher = createEventDispatcher();
    host._eventDispatcher.start(baseUrl, token);
    const sseUnsubs = wireSseEventsToGlobalState(host._eventDispatcher);
    host._approvalUnsub = sseUnsubs.approvalUnsub;
    host._approvalResolvedUnsub = sseUnsubs.approvalResolvedUnsub;
    host._errorUnsub = sseUnsubs.errorUnsub;

    // STEP 6: Subscribe globalState to host mirror fields.
    host._stateUnsubscribe = subscribeGlobalStateToHost(host._globalState);
    host._globalState.update({ connectionStatus: host._rpcClient.status });

    // STEP 7+8: Construct PollingController (after rpcClient exists) and
    // kick off first poll (host is already connected by now).
    host._pollingController = startPolling(host._rpcClient);

    // STEP 9: Initialize parameterized router with the shell's
    // route-match callback (passed in at controller construction via
    // options.onRouteMatch). The shell uses this to update
    // _currentView / _currentRoute / _routeParams.
    host._router = controller.initRouter(routeMatchCallback);
  }

  const controller: AppController = {
    hostConnected(): void {
      // Restore session token if present and add global keyboard handler.
      const savedToken = sessionStorage.getItem(TOKEN_KEY);
      if (savedToken) {
        controller.initWithToken(savedToken);
      }
      document.addEventListener("keydown", boundKeyHandler);
    },

    hostDisconnected(): void {
      controller.cleanup();
      document.removeEventListener("keydown", boundKeyHandler);
      if (pendingGotoKey) {
        systemClearTimeout(pendingGotoKey);
        pendingGotoKey = null;
      }
    },

    initWithToken(token: string): void {
      host._token = token;

      const baseUrl = `${window.location.protocol}//${window.location.host}`;
      host._apiClient = createApiClient(baseUrl, token);

      // Verify token by calling an authenticated endpoint (not health, which
      // is unauthenticated). Same flow as pre-extraction.
      host._apiClient
        .getAgents()
        .then(() => {
          _completeInit(token, baseUrl);
        })
        .catch((err: unknown) => {
          // Redaction: only err.message — never err.cause, never
          // JSON.stringify(err), never the token itself.
          void err;
          host._authError = "Invalid token or server unreachable";
          sessionStorage.removeItem(TOKEN_KEY);
        });
    },

    handleLogin(e: Event): void {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const input = form.querySelector("input") as HTMLInputElement;
      const token = input.value.trim();
      if (!token) {
        host._authError = "Please enter a token";
        return;
      }
      controller.initWithToken(token);
    },

    handleLogout(): void {
      sessionStorage.removeItem(TOKEN_KEY);
      host._authenticated = false;
      controller.cleanup();
      host._apiClient = null;
      host._token = "";
    },

    cleanup(): void {
      if (host._pollingController) {
        const polling = host._pollingController;
        polling.hostDisconnected();
        host.removeController(polling);
        host._pollingController = null;
      }
      host._rpcClient?.disconnect();
      host._rpcClient = null;
      host._eventDispatcher?.stop();
      host._eventDispatcher = null;
      host._stateUnsubscribe?.();
      host._stateUnsubscribe = null;
      host._approvalUnsub?.();
      host._approvalUnsub = null;
      host._approvalResolvedUnsub?.();
      host._approvalResolvedUnsub = null;
      host._errorUnsub?.();
      host._errorUnsub = null;
      host._globalState = null;
      host._router?.stop();
      host._router = null;
    },

    isInputTarget(e: KeyboardEvent): boolean {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if ((e.target as HTMLElement)?.isContentEditable) return true;
      return false;
    },

    handleGlobalKeydown(e: KeyboardEvent): void {
      // Ctrl+K / Cmd+K: Toggle command palette (works even in inputs).
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        host._commandPaletteOpen = !host._commandPaletteOpen;
        return;
      }

      // Escape: Close overlays.
      if (e.key === "Escape") {
        if (host._commandPaletteOpen) {
          host._commandPaletteOpen = false;
          return;
        }
        if (host._shortcutsHelpOpen) {
          host._shortcutsHelpOpen = false;
          return;
        }
        // Dispatch close-overlay so child components can react.
        (host as unknown as EventTarget).dispatchEvent(
          new CustomEvent("close-overlay", { bubbles: true, composed: true }),
        );
        if (host._sidebarOpen) host._sidebarOpen = false;
        return;
      }

      // Skip remaining shortcuts if in an input-like element.
      if (controller.isInputTarget(e)) return;
      // Skip if command palette is open (it handles its own keys).
      if (host._commandPaletteOpen) return;

      // ?: Show shortcuts help.
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        host._shortcutsHelpOpen = !host._shortcutsHelpOpen;
        return;
      }

      // G+letter two-key sequences: Go to...
      if (host._gotoWaiting) {
        host._gotoWaiting = false;
        if (pendingGotoKey) {
          systemClearTimeout(pendingGotoKey);
          pendingGotoKey = null;
        }
        switch (e.key.toLowerCase()) {
          case "d": host._router?.navigate("dashboard"); return;
          case "a": host._router?.navigate("agents"); return;
          case "c": host._router?.navigate("chat"); return;
          case "s": host._router?.navigate("sessions"); return;
          case "o": host._router?.navigate("observe/overview"); return;
        }
        return;
      }

      // Start G+letter sequence.
      if (e.key === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        host._gotoWaiting = true;
        pendingGotoKey = systemSetTimeout(() => {
          host._gotoWaiting = false;
          pendingGotoKey = null;
        }, GOTO_SEQUENCE_TIMEOUT_MS);
      }
    },

    handleCommand(commandId: string): void {
      switch (commandId) {
        case "refresh":
          window.location.reload();
          break;
        case "toggle-sidebar":
          host._sidebarOpen = !host._sidebarOpen;
          break;
        case "logout":
          controller.handleLogout();
          break;
        case "show-shortcuts":
          host._shortcutsHelpOpen = true;
          break;
      }
    },

    initRouter(onMatch: (match: RouteMatch) => void): Router {
      const router = createRouter(onMatch);
      router.start();
      return router;
    },
  };

  host.addController(controller);
  return controller;
}
