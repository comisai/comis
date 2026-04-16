import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ApiClient } from "./api/api-client.js";
import "./app.js";
import type { IcApp } from "./app.js";

// Mock sessionStorage
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

// Mock fetch for health endpoint
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock WebSocket for RPC client
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
    // Do NOT auto-fire onopen - tests control lifecycle explicitly
  }
}
vi.stubGlobal("WebSocket", MockWebSocket);

// Mock EventSource for SSE event dispatcher
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

// Mock window.location for createApiClient
if (!window.location.protocol) {
  Object.defineProperty(window, "location", {
    value: { protocol: "http:", host: "localhost:3000", hash: "" },
    writable: true,
  });
}

/** Type-safe access to private properties on the app element. */
function priv(el: IcApp) {
  return el as unknown as {
    _authenticated: boolean;
    _authError: string;
    _currentView: string;
    _currentRoute: string;
    _routeParams: Record<string, string>;
    _connectionStatus: string;
    _pendingApprovals: number;
    _errorCount: number;
    _sidebarOpen: boolean;
    _apiClient: ApiClient | null;
    _router: { stop: () => void; start: () => void; navigate: (r: string) => void } | null;
    _rpcClient: { disconnect: () => void; connect: (url: string, token: string) => void } | null;
    _globalState: { subscribe: (h: () => void) => () => void; getSnapshot: () => unknown; update: (p: unknown) => void } | null;
    _eventDispatcher: { start: (url: string, token: string) => void; stop: () => void; addEventListener: (type: string, handler: (data: unknown) => void) => () => void } | null;
    _viewLoading: boolean;
    _loadedViews: Set<string>;
    _initWithToken(token: string): void;
    _handleLogin(e: Event): void;
    _handleLogout(): void;
    _cleanup(): void;
    _loadViewIfNeeded(viewTag: string): Promise<void>;
    _renderView(): unknown;
    _renderAuth(): unknown;
    _renderApp(): unknown;
  };
}

describe("IcApp", () => {
  let el: IcApp;

  beforeEach(() => {
    // Clear mock storage
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
    mockFetch.mockReset();
    vi.clearAllMocks();
    MockWebSocket.lastInstance = null;
    MockEventSource.lastInstance = null;

    el = document.createElement("ic-app") as IcApp;
  });

  afterEach(() => {
    if (el.isConnected) {
      document.body.removeChild(el);
    }
  });

  describe("initial state", () => {
    it("starts as not authenticated", () => {
      expect(priv(el)._authenticated).toBe(false);
    });

    it("starts with empty auth error", () => {
      expect(priv(el)._authError).toBe("");
    });

    it("starts with default view ic-dashboard", () => {
      expect(priv(el)._currentView).toBe("ic-dashboard");
    });

    it("starts with default route 'dashboard'", () => {
      expect(priv(el)._currentRoute).toBe("dashboard");
    });

    it("starts with null apiClient", () => {
      expect(priv(el)._apiClient).toBeNull();
    });

    it("starts with null router", () => {
      expect(priv(el)._router).toBeNull();
    });
  });

  describe("_handleLogin", () => {
    it("sets _authError when token is empty", () => {
      // Create a mock form with an empty input
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.value = "";
      form.appendChild(input);

      const event = new Event("submit");
      Object.defineProperty(event, "target", { value: form });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });

      priv(el)._handleLogin(event);

      expect(priv(el)._authError).toBe("Please enter a token");
    });

    it("sets _authError when token is whitespace only", () => {
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.value = "   ";
      form.appendChild(input);

      const event = new Event("submit");
      Object.defineProperty(event, "target", { value: form });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });

      priv(el)._handleLogin(event);

      expect(priv(el)._authError).toBe("Please enter a token");
    });

    it("calls _initWithToken when token is provided", () => {
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.value = "valid-token-123";
      form.appendChild(input);

      const event = new Event("submit");
      Object.defineProperty(event, "target", { value: form });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });

      // Mock fetch for the health check that _initWithToken will trigger
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._handleLogin(event);

      // _initWithToken creates an apiClient
      expect(priv(el)._apiClient).not.toBeNull();
    });
  });

  describe("_initWithToken", () => {
    it("creates apiClient via createApiClient", () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._initWithToken("test-token");

      expect(priv(el)._apiClient).not.toBeNull();
    });

    it("calls getAgents (authenticated endpoint) to verify token, not health", () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._initWithToken("test-token");

      // fetch should be called with /api/agents (authenticated), not /api/health (unauthenticated)
      expect(mockFetch).toHaveBeenCalled();
      const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain("/api/agents");
      expect(calledUrl).not.toContain("/api/health");
    });

    it("sets _authenticated=true on successful health check", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._initWithToken("test-token");

      // Wait for the async .then() chain to resolve
      await new Promise((r) => setTimeout(r, 10));

      expect(priv(el)._authenticated).toBe(true);
      expect(priv(el)._authError).toBe("");
    });

    it("saves token to sessionStorage on successful health check", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._initWithToken("my-secret-token");

      await new Promise((r) => setTimeout(r, 10));

      expect(sessionStorage.setItem).toHaveBeenCalledWith("comis_token", "my-secret-token");
    });

    it("sets _authError on failed health check", async () => {
      mockFetch.mockRejectedValue(new Error("network error"));

      priv(el)._initWithToken("bad-token");

      await new Promise((r) => setTimeout(r, 10));

      expect(priv(el)._authError).toBe("Invalid token or server unreachable");
      expect(priv(el)._authenticated).toBe(false);
    });

    it("removes token from sessionStorage on failed health check", async () => {
      mockFetch.mockRejectedValue(new Error("network error"));

      priv(el)._initWithToken("bad-token");

      await new Promise((r) => setTimeout(r, 10));

      expect(sessionStorage.removeItem).toHaveBeenCalledWith("comis_token");
    });

    it("initializes router on successful auth", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._initWithToken("test-token");

      await new Promise((r) => setTimeout(r, 10));

      expect(priv(el)._router).not.toBeNull();
    });

    it("creates RPC client on successful auth", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._initWithToken("test-token");

      await new Promise((r) => setTimeout(r, 10));

      expect(priv(el)._rpcClient).not.toBeNull();
    });

    it("creates global state on successful auth", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._initWithToken("test-token");

      await new Promise((r) => setTimeout(r, 10));

      expect(priv(el)._globalState).not.toBeNull();
    });

    it("creates event dispatcher on successful auth", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      priv(el)._initWithToken("test-token");

      await new Promise((r) => setTimeout(r, 10));

      expect(priv(el)._eventDispatcher).not.toBeNull();
    });
  });

  describe("token restoration", () => {
    it("restores token from sessionStorage on connectedCallback", async () => {
      mockStorage["comis_token"] = "saved-token";
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });

      document.body.appendChild(el);

      expect(sessionStorage.getItem).toHaveBeenCalledWith("comis_token");
      // It should call _initWithToken with the saved token
      expect(priv(el)._apiClient).not.toBeNull();
    });

    it("does not call _initWithToken when no saved token", () => {
      // No token in storage
      document.body.appendChild(el);

      expect(priv(el)._apiClient).toBeNull();
      expect(priv(el)._authenticated).toBe(false);
    });
  });

  describe("_handleLogout", () => {
    it("clears sessionStorage", async () => {
      // First authenticate
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });
      priv(el)._initWithToken("test-token");
      await new Promise((r) => setTimeout(r, 10));

      vi.clearAllMocks();

      priv(el)._handleLogout();

      expect(sessionStorage.removeItem).toHaveBeenCalledWith("comis_token");
    });

    it("sets _authenticated=false", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });
      priv(el)._initWithToken("test-token");
      await new Promise((r) => setTimeout(r, 10));
      expect(priv(el)._authenticated).toBe(true);

      priv(el)._handleLogout();

      expect(priv(el)._authenticated).toBe(false);
    });

    it("nulls apiClient", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });
      priv(el)._initWithToken("test-token");
      await new Promise((r) => setTimeout(r, 10));

      priv(el)._handleLogout();

      expect(priv(el)._apiClient).toBeNull();
    });

    it("stops router and cleans up all resources", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: [] }),
      });
      priv(el)._initWithToken("test-token");
      await new Promise((r) => setTimeout(r, 10));

      const router = priv(el)._router;
      expect(router).not.toBeNull();

      priv(el)._handleLogout();

      expect(priv(el)._router).toBeNull();
      expect(priv(el)._rpcClient).toBeNull();
      expect(priv(el)._eventDispatcher).toBeNull();
      expect(priv(el)._globalState).toBeNull();
    });
  });

  describe("_renderView", () => {
    it("returns dashboard component by default (eagerly loaded)", () => {
      priv(el)._currentView = "ic-dashboard";
      // Dashboard is eagerly loaded, so it renders directly
      expect(() => priv(el)._renderView()).not.toThrow();
    });

    it("returns loading placeholder for lazily-loaded views on first render", () => {
      // Views in VIEW_LOADERS show a loading placeholder on first render
      priv(el)._currentView = "ic-agent-list";
      // Prevent the dynamic import from actually firing
      const loadSpy = vi.spyOn(priv(el), "_loadViewIfNeeded").mockResolvedValue(undefined);
      const result = priv(el)._renderView();
      expect(result).toBeDefined();
      expect(loadSpy).toHaveBeenCalledWith("ic-agent-list");
      loadSpy.mockRestore();
    });

    it("renders view directly after it has been loaded", () => {
      // Simulate that the view was already loaded
      priv(el)._loadedViews.add("ic-agent-list");
      priv(el)._currentView = "ic-agent-list";
      expect(() => priv(el)._renderView()).not.toThrow();
    });

    it("renders placeholder for unknown view", () => {
      priv(el)._currentView = "ic-unknown-view";
      expect(() => priv(el)._renderView()).not.toThrow();
    });
  });
});
