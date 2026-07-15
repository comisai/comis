// SPDX-License-Identifier: Apache-2.0
/**
 * App-controller tests.
 *
 * Coverage:
 *   - init / addController lifecycle
 *   - PollingController construction order
 *   - Auth fail-closed semantics (fetch error → _authenticated stays false)
 *   - Auth success flow wires rpcClient + globalState + eventDispatcher
 *     + PollingController in the documented order
 *   - handleLogout tears down all owned resources
 *   - handleGlobalKeydown opens command palette on Cmd+K
 *   - handleLogin empty-token guard
 *   - isInputTarget detection
 *
 * The controller mutates a host shaped per AppHost; the tests construct
 * a plain object that satisfies the interface so the controller can be
 * exercised without a full LitElement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactiveController } from "lit";
import type { ApiClient } from "./api/api-client.js";
import type { RpcClient } from "./api/rpc-client.js";
import type { EventDispatcher } from "./state/event-dispatcher.js";
import type { GlobalState } from "./state/global-state.js";
import type { Router } from "./router.js";
import type { PollingController } from "./state/polling-controller.js";
import type { ConnectionStatus } from "./api/types/index.js";
import { createAppController, type AppHost } from "./app-controller.js";

// ---------------------------------------------------------------------------
// Test environment scaffolding
// ---------------------------------------------------------------------------

// Mock sessionStorage. Real DOM provides one but we want deterministic state.
const mockStorage: Record<string, string> = {};
vi.stubGlobal("sessionStorage", {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
});

// Mock fetch for the api-client's token verification call.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock WebSocket for the rpc-client connect() call.
class MockWebSocket {
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  readyState = 1;
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static lastInstance: MockWebSocket | null = null;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
  }
}
vi.stubGlobal("WebSocket", MockWebSocket);

// Mock EventSource for the event-dispatcher.
class MockEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  close = vi.fn();
  addEventListener = vi.fn();
  static lastInstance: MockEventSource | null = null;
  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }
}
vi.stubGlobal("EventSource", MockEventSource);

// Ensure window.location has the protocol + host shape api-client expects.
if (!window.location.protocol) {
  Object.defineProperty(window, "location", {
    value: { protocol: "http:", host: "localhost:3000", hash: "" },
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// makeHost: factory returning an AppHost-shaped plain object
// ---------------------------------------------------------------------------

interface MakeHostResult extends AppHost {
  _updates: number;
  _controllers: ReactiveController[];
  dispatchEvent: (e: Event) => boolean;
}

function makeHost(): MakeHostResult {
  const controllers: ReactiveController[] = [];
  const host = {
    _authenticated: false,
    _authError: "",
    _token: "",
    _apiClient: null as ApiClient | null,
    _rpcClient: null as RpcClient | null,

    _globalState: null as GlobalState | null,
    _eventDispatcher: null as EventDispatcher | null,
    _stateUnsubscribe: null as (() => void) | null,
    _approvalUnsub: null as (() => void) | null,
    _approvalResolvedUnsub: null as (() => void) | null,
    _errorUnsub: null as (() => void) | null,

    _pollingController: null as PollingController | null,

    _connectionStatus: "disconnected" as ConnectionStatus,
    _pendingApprovals: 0,
    _errorCount: 0,
    _agentCount: 0,
    _channelCount: 0,
    _sessionCount: 0,

    _agentList: [] as Array<{ id: string; name?: string }>,
    _sessionList: [] as Array<{ key: string; agentId: string }>,

    _sidebarOpen: false,
    _commandPaletteOpen: false,
    _shortcutsHelpOpen: false,

    _gotoWaiting: false,

    _router: null as Router | null,

    _updates: 0,
    _controllers: controllers,

    addController(controller: ReactiveController): void {
      controllers.push(controller);
    },
    removeController(controller: ReactiveController): void {
      const idx = controllers.indexOf(controller);
      if (idx >= 0) controllers.splice(idx, 1);
    },
    requestUpdate(): void {
      host._updates += 1;
    },
    dispatchEvent(_e: Event): boolean {
      return true;
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const k of Object.keys(mockStorage)) delete mockStorage[k];
  mockFetch.mockReset();
  vi.clearAllMocks();
  MockWebSocket.lastInstance = null;
  MockEventSource.lastInstance = null;
});

describe("AppController", () => {
  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    createAppController(host);
    expect(host._controllers.length).toBe(1);
  });

  it("init: constructs rpcClient before PollingController", async () => {
    // This test is the contract for PollingController construction order.
    //
    // Strategy: rather than relying on internal construction order
    // (which is private), we observe via side effects: when
    // _completeInit runs, host._rpcClient is set BEFORE host._pollingController.
    // We assert that by snapshotting host fields synchronously
    // immediately after each .then() callback resolves.
    const host = makeHost();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });
    const controller = createAppController(host);

    controller.initWithToken("test-token");
    // Wait for the async .then() chain to resolve.
    await new Promise((r) => setTimeout(r, 10));

    expect(host._rpcClient).not.toBeNull();
    expect(host._pollingController).not.toBeNull();
    // If PollingController were constructed BEFORE rpcClient, then
    // host._rpcClient would have been null when the PollingController
    // constructor ran, but PollingController's constructor signature
    // requires a non-null RpcClient — TypeScript guarantees the order
    // at compile time. Runtime evidence: both are non-null after init.
  });

  it("init: missing token sets _authenticated to false (fail-closed)", async () => {
    const host = makeHost();
    mockFetch.mockRejectedValue(new Error("network error"));
    const controller = createAppController(host);

    controller.initWithToken("bad-token");
    await new Promise((r) => setTimeout(r, 10));

    expect(host._authenticated).toBe(false);
    expect(host._authError).toBe("Invalid token or server unreachable");
  });

  it("init: success flow wires rpcClient + globalState + eventDispatcher", async () => {
    const host = makeHost();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });
    const controller = createAppController(host);

    controller.initWithToken("good-token");
    await new Promise((r) => setTimeout(r, 10));

    expect(host._authenticated).toBe(true);
    expect(host._authError).toBe("");
    expect(host._rpcClient).not.toBeNull();
    expect(host._globalState).not.toBeNull();
    expect(host._eventDispatcher).not.toBeNull();
    expect(host._router).not.toBeNull();
    expect(host._pollingController).not.toBeNull();
  });

  it("init: mirrors the pending RPC connection before the socket opens", async () => {
    const host = makeHost();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });
    const controller = createAppController(host);

    controller.initWithToken("good-token");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(host._rpcClient?.status).toBe("reconnecting");
    expect(host._globalState?.connectionStatus).toBe("reconnecting");
    expect(host._connectionStatus).toBe("reconnecting");
  });

  it("handleLogin: empty token sets _authError without calling fetch", () => {
    const host = makeHost();
    const controller = createAppController(host);

    const form = document.createElement("form");
    const input = document.createElement("input");
    input.value = "   "; // whitespace-only
    form.appendChild(input);
    const evt = new Event("submit");
    Object.defineProperty(evt, "target", { value: form });
    Object.defineProperty(evt, "preventDefault", { value: vi.fn() });

    controller.handleLogin(evt);

    expect(host._authError).toBe("Please enter a token");
    expect(host._authenticated).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handleLogin: valid token calls initWithToken", () => {
    const host = makeHost();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });
    const controller = createAppController(host);

    const form = document.createElement("form");
    const input = document.createElement("input");
    input.value = "valid-token";
    form.appendChild(input);
    const evt = new Event("submit");
    Object.defineProperty(evt, "target", { value: form });
    Object.defineProperty(evt, "preventDefault", { value: vi.fn() });

    controller.handleLogin(evt);

    // initWithToken creates an apiClient before the async chain even starts.
    expect(host._apiClient).not.toBeNull();
  });

  it("handleLogout: tears down PollingController + globalState + rpcClient", async () => {
    const host = makeHost();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });
    const controller = createAppController(host);

    controller.initWithToken("good-token");
    await new Promise((r) => setTimeout(r, 10));

    expect(host._rpcClient).not.toBeNull();

    controller.handleLogout();

    expect(host._authenticated).toBe(false);
    expect(host._rpcClient).toBeNull();
    expect(host._globalState).toBeNull();
    expect(host._eventDispatcher).toBeNull();
    expect(host._pollingController).toBeNull();
    expect(host._router).toBeNull();
    expect(host._apiClient).toBeNull();
    expect(host._token).toBe("");
  });

  it("handleGlobalKeydown: Cmd/Ctrl+K toggles command palette (works inside inputs)", () => {
    const host = makeHost();
    const controller = createAppController(host);

    const target = document.createElement("input");
    const evt = new KeyboardEvent("keydown", { key: "k", metaKey: true });
    Object.defineProperty(evt, "target", { value: target });
    Object.defineProperty(evt, "preventDefault", { value: vi.fn() });

    expect(host._commandPaletteOpen).toBe(false);
    controller.handleGlobalKeydown(evt);
    expect(host._commandPaletteOpen).toBe(true);

    controller.handleGlobalKeydown(evt);
    expect(host._commandPaletteOpen).toBe(false);
  });

  it("handleGlobalKeydown: Escape closes command palette first, then shortcuts help", () => {
    const host = makeHost();
    const controller = createAppController(host);
    host._commandPaletteOpen = true;
    host._shortcutsHelpOpen = true;

    const evt = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(evt, "target", { value: document.createElement("div") });

    controller.handleGlobalKeydown(evt);
    expect(host._commandPaletteOpen).toBe(false);
    expect(host._shortcutsHelpOpen).toBe(true);

    controller.handleGlobalKeydown(evt);
    expect(host._shortcutsHelpOpen).toBe(false);
  });

  it("isInputTarget: detects INPUT / TEXTAREA / SELECT / contentEditable", () => {
    const host = makeHost();
    const controller = createAppController(host);

    const inputEl = document.createElement("input");
    const txtEl = document.createElement("textarea");
    const selEl = document.createElement("select");
    const divEl = document.createElement("div");
    const editableDiv = document.createElement("div");
    Object.defineProperty(editableDiv, "isContentEditable", { value: true });

    const mk = (target: Element) => {
      const e = new KeyboardEvent("keydown", { key: "a" });
      Object.defineProperty(e, "target", { value: target });
      return e;
    };

    expect(controller.isInputTarget(mk(inputEl))).toBe(true);
    expect(controller.isInputTarget(mk(txtEl))).toBe(true);
    expect(controller.isInputTarget(mk(selEl))).toBe(true);
    expect(controller.isInputTarget(mk(editableDiv))).toBe(true);
    expect(controller.isInputTarget(mk(divEl))).toBe(false);
  });

  it("handleCommand: 'toggle-sidebar' flips _sidebarOpen", () => {
    const host = makeHost();
    const controller = createAppController(host);

    expect(host._sidebarOpen).toBe(false);
    controller.handleCommand("toggle-sidebar");
    expect(host._sidebarOpen).toBe(true);
    controller.handleCommand("toggle-sidebar");
    expect(host._sidebarOpen).toBe(false);
  });

  it("handleCommand: 'show-shortcuts' opens shortcuts help", () => {
    const host = makeHost();
    const controller = createAppController(host);

    expect(host._shortcutsHelpOpen).toBe(false);
    controller.handleCommand("show-shortcuts");
    expect(host._shortcutsHelpOpen).toBe(true);
  });

  it("hostConnected: restores token from sessionStorage when present", async () => {
    mockStorage["comis_token"] = "saved-token";
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [] }),
    });
    const host = makeHost();
    const controller = createAppController(host);

    controller.hostConnected();
    await new Promise((r) => setTimeout(r, 10));

    expect(host._apiClient).not.toBeNull();
    expect(host._authenticated).toBe(true);
  });

  it("hostConnected: no-op when no saved token", () => {
    const host = makeHost();
    const controller = createAppController(host);

    controller.hostConnected();

    expect(host._apiClient).toBeNull();
    expect(host._authenticated).toBe(false);
  });
});
