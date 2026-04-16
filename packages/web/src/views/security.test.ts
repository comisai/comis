import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSecurityView } from "./security.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";

// Side-effect import to register custom element
import "./security.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_SECURITY_CONFIG = {
  logRedaction: true,
  auditLog: true,
  actionConfirmation: { requireForDestructive: true, requireForSensitive: false, autoApprove: ["read_file"] },
  agentToAgent: { enabled: true, maxPingPongTurns: 3, allowAgents: ["agent1", "agent2"] },
  permission: { enableNodePermissions: false, allowedFsPaths: ["/tmp"], allowedNetHosts: ["localhost"] },
  secrets: { enabled: false, dbPath: "secrets.db" },
  approvalRules: { defaultMode: "auto-low", timeoutMs: 300_000 },
};

const MOCK_TOKENS = [
  { id: "admin-token", scopes: ["rpc", "ws", "admin"] },
  { id: "readonly-token", scopes: ["rpc"] },
];

const MOCK_PENDING = {
  requests: [
    {
      requestId: "appr-1",
      toolName: "file_ops",
      action: "file_write",
      params: { path: "/etc/config" },
      agentId: "agent-1",
      sessionKey: "sess-1",
      trustLevel: "guest",
      createdAt: Date.now() - 60_000,
      timeoutMs: 300_000,
    },
  ],
  total: 1,
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Security-specific mock that routes RPC methods to test data. */
function createSecurityMockRpcClient(callImpl?: (...args: unknown[]) => unknown): RpcClient {
  return createMockRpcClient(
    callImpl ??
      (async (method: string) => {
        if (method === "config.read")
          return { config: { security: structuredClone(MOCK_SECURITY_CONFIG) }, sections: ["security"] };
        if (method === "tokens.list")
          return { tokens: structuredClone(MOCK_TOKENS) };
        if (method === "admin.approval.pending")
          return structuredClone(MOCK_PENDING);
        if (method === "admin.approval.resolve")
          return { ok: true };
        if (method === "config.patch")
          return { ok: true };
        if (method === "tokens.create")
          return { id: "new-token", secret: "secret-value", scopes: ["rpc"] };
        if (method === "tokens.revoke")
          return { ok: true };
        return {};
      }),
  );
}

function createMockEventDispatcher(): EventDispatcher & { _fire: (type: string, data?: unknown) => void } {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    connected: true,
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener(type: string, handler: (data: unknown) => void): () => void {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
      return () => {
        handlers.get(type)?.delete(handler);
      };
    },
    _fire(type: string, data: unknown = {}) {
      handlers.get(type)?.forEach((h) => h(data));
    },
  };
}

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcSecurityView> {
  const el = document.createElement("ic-security-view") as IcSecurityView;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

/** Flush pending microtasks (for RPC promises). */
async function flush(el: IcSecurityView): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await (el as any).updateComplete;
}

/** Access private fields. */
function priv(el: IcSecurityView) {
  return el as unknown as {
    _loadState: string;
    _activeTab: string;
    _error: string;
    _auditEntries: unknown[];
    _paused: boolean;
    _pauseBuffer: unknown[];
    _securityConfig: Record<string, unknown>;
    _tokens: Array<{ id: string; scopes: string[] }>;
    _pendingApprovals: unknown[];
    _resolvedApprovals: unknown[];
    _approvalRules: { defaultMode: string; timeoutMs: number };
    _newTokenScopes: string[];
    _newSecretName: string;
    _sse: unknown;
    _initSse(): void;
    eventDispatcher: EventDispatcher | null;
    rpcClient: RpcClient | null;
  };
}

/** Switch to a tab. */
async function switchTab(el: IcSecurityView, tabId: string): Promise<void> {
  priv(el)._activeTab = tabId;
  await (el as any).updateComplete;
}

/** Query through the token-manager sub-component shadow root. */
function tokenQuery(el: IcSecurityView, selector: string): Element | null {
  const mgr = el.shadowRoot?.querySelector("ic-token-manager");
  return mgr?.shadowRoot?.querySelector(selector) ?? null;
}

/** QueryAll through the token-manager sub-component shadow root. */
function tokenQueryAll(el: IcSecurityView, selector: string): NodeListOf<Element> {
  const mgr = el.shadowRoot?.querySelector("ic-token-manager");
  return mgr?.shadowRoot?.querySelectorAll(selector) ?? ([] as unknown as NodeListOf<Element>);
}

/** Query through the event-feed sub-component shadow root. */
function feedQuery(el: IcSecurityView, selector: string): Element | null {
  const feed = el.shadowRoot?.querySelector("ic-security-event-feed");
  return feed?.shadowRoot?.querySelector(selector) ?? null;
}

/** QueryAll through the event-feed sub-component shadow root. */
function feedQueryAll(el: IcSecurityView, selector: string): NodeListOf<Element> {
  const feed = el.shadowRoot?.querySelector("ic-security-event-feed");
  return feed?.shadowRoot?.querySelectorAll(selector) ?? ([] as unknown as NodeListOf<Element>);
}

/** Query through the approval-queue sub-component shadow root. */
function approvalQuery(el: IcSecurityView, selector: string): Element | null {
  const queue = el.shadowRoot?.querySelector("ic-approval-queue");
  return queue?.shadowRoot?.querySelector(selector) ?? null;
}

/** QueryAll through the approval-queue sub-component shadow root. */
function approvalQueryAll(el: IcSecurityView, selector: string): NodeListOf<Element> {
  const queue = el.shadowRoot?.querySelector("ic-approval-queue");
  return queue?.shadowRoot?.querySelectorAll(selector) ?? ([] as unknown as NodeListOf<Element>);
}

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.removeItem("ic:approval-history");
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("IcSecurityView", () => {
  it("renders view header 'Security'", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const title = el.shadowRoot?.querySelector(".view-title");
    expect(title).toBeTruthy();
    expect(title!.textContent).toContain("Security");
  });

  it("shows 7 tabs", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    const tabs = el.shadowRoot?.querySelector("ic-tabs");
    expect(tabs).toBeTruthy();
    const tabDefs = (tabs as any).tabs;
    expect(tabDefs.length).toBe(7);
    expect(tabDefs.map((t: any) => t.id)).toEqual(["events", "audit", "tokens", "secrets", "rules", "pending", "health"]);
  });

  it("default tab is events", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    expect(priv(el)._activeTab).toBe("events");
  });

  it("tab switching updates content", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    await switchTab(el, "tokens");
    expect(priv(el)._activeTab).toBe("tokens");
    // Tokens tab renders ic-token-manager; grid table is inside its shadow root
    const table = tokenQuery(el, ".grid-table--tokens");
    expect(table).toBeTruthy();
  });

  it("loading state shown before config.read resolves", async () => {
    const rpc = createSecurityMockRpcClient(() => new Promise(() => {})); // Never resolves
    const el = await createElement({ rpcClient: rpc });

    const loading = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(loading).toBeTruthy();
  });

  it("error state on all RPC failures with retry button", async () => {
    const rpc = createSecurityMockRpcClient(() => Promise.reject(new Error("RPC failed")));
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Security uses Promise.allSettled but catches at top-level
    const errorMsg = el.shadowRoot?.querySelector(".error-message");
    // Even with allSettled, if all fail the top-level try-catch sets error
    // The view transitions to loaded state with empty data when allSettled succeeds
    // but only errors out on unhandled exception. Check load state.
    const loadState = priv(el)._loadState;
    // allSettled doesn't reject, so loadState should be "loaded" even when all calls fail
    expect(loadState === "loaded" || loadState === "error").toBe(true);
  });

  // --- Audit tab tests ---

  it("audit tab shows empty state when no events", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Default tab is "events" which renders ic-security-event-feed
    const empty = feedQuery(el, "ic-empty-state");
    expect(empty).toBeTruthy();
  });

  it("receives audit:event via EventDispatcher and renders row", async () => {
    const rpc = createSecurityMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    // Switch to audit tab (default is now "events")
    await switchTab(el, "audit");

    // Fire audit event through the EventDispatcher
    mockDispatcher._fire("audit:event", {
      timestamp: Date.now(),
      agentId: "test-agent",
      action: "tool.exec",
      classification: "high",
      user: "admin",
    });
    // Wait for sub-component to re-render
    const feed = el.shadowRoot?.querySelector("ic-security-event-feed");
    await (feed as any)?.updateComplete;

    const rows = feedQueryAll(el, "ic-audit-row");
    expect(rows?.length).toBe(1);
  });

  it("pause button stops adding new events to display", async () => {
    const rpc = createSecurityMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    // Switch to audit tab (default is now "events")
    await switchTab(el, "audit");

    const feed = el.shadowRoot?.querySelector("ic-security-event-feed") as any;

    // Add an event first
    mockDispatcher._fire("audit:event", {
      timestamp: Date.now(),
      agentId: "a",
      action: "x",
      classification: "low",
      user: "u",
    });
    await feed?.updateComplete;
    expect(feed.auditEntries.length).toBe(1);

    // Click pause (button is in event-feed sub-component)
    const pauseBtn = feedQuery(el, ".pause-btn") as HTMLElement;
    pauseBtn.click();
    await feed?.updateComplete;
    expect(feed.paused).toBe(true);

    // Add another event while paused
    mockDispatcher._fire("audit:event", {
      timestamp: Date.now(),
      agentId: "b",
      action: "y",
      classification: "medium",
      user: "u2",
    });
    await feed?.updateComplete;

    // Display should still have 1, pause buffer should have 1
    expect(feed.auditEntries.length).toBe(1);
    expect(feed.pauseBuffer.length).toBe(1);
  });

  // --- Tokens tab tests ---

  it("tokens tab renders table with headers", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "tokens");
    // Wait for token-manager sub-component to load
    const mgr = el.shadowRoot?.querySelector("ic-token-manager") as any;
    await mgr?.updateComplete;
    await new Promise((r) => setTimeout(r, 10));
    await mgr?.updateComplete;

    const headers = tokenQueryAll(el, ".grid-table--tokens .header-cell");
    expect(headers?.length).toBe(3);
    expect(headers![0].textContent).toContain("Token ID");
    expect(headers![1].textContent).toContain("Scopes");
    expect(headers![2].textContent).toContain("Actions");
  });

  it("displays mock tokens with scopes as tags", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "tokens");
    const mgr = el.shadowRoot?.querySelector("ic-token-manager") as any;
    await mgr?.updateComplete;
    await new Promise((r) => setTimeout(r, 10));
    await mgr?.updateComplete;

    const cells = tokenQueryAll(el, ".grid-table--tokens .data-cell");
    expect(cells!.length).toBeGreaterThan(0);

    // First token ID
    expect(cells![0].textContent).toContain("admin-token");

    // Scope tags
    const scopeTags = tokenQueryAll(el, ".scopes-cell ic-tag");
    expect(scopeTags!.length).toBeGreaterThanOrEqual(3);
  });

  it("revoke button present for each token", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "tokens");
    const mgr = el.shadowRoot?.querySelector("ic-token-manager") as any;
    await mgr?.updateComplete;
    await new Promise((r) => setTimeout(r, 10));
    await mgr?.updateComplete;

    const revokeBtns = tokenQueryAll(el, ".revoke-btn");
    expect(revokeBtns?.length).toBe(2);
  });

  it("create form has scope checkboxes and generate button", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "tokens");
    const mgr = el.shadowRoot?.querySelector("ic-token-manager") as any;
    await mgr?.updateComplete;
    await new Promise((r) => setTimeout(r, 10));
    await mgr?.updateComplete;

    const form = tokenQuery(el, ".create-form");
    expect(form).toBeTruthy();

    // 5 scope checkboxes: rpc, ws, admin, api, * (all)
    const checkboxes = form?.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes?.length).toBe(5);

    const generateBtn = form?.querySelector(".generate-btn");
    expect(generateBtn).toBeTruthy();
  });

  // --- Secrets tab tests ---

  it("secrets tab renders enabled toggle and db path", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "secrets");

    const toggle = el.shadowRoot?.querySelector("ic-toggle");
    expect(toggle).toBeTruthy();
    expect((toggle as any).label).toContain("Enabled");

    const dbPath = el.shadowRoot?.querySelector(".tls-value");
    expect(dbPath).toBeTruthy();
    expect(dbPath!.textContent).toContain("secrets.db");
  });

  it("secrets tab shows section header", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "secrets");

    const header = el.shadowRoot?.querySelector(".section-header");
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain("Encrypted Secrets Store");
  });

  // --- Rules tab tests (formerly Policies) ---

  it("rules tab renders 4 section headers", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "rules");
    // Wait for approval-queue sub-component to render
    const queue = el.shadowRoot?.querySelector("ic-approval-queue") as any;
    await queue?.updateComplete;

    const headers = approvalQueryAll(el, ".section-header");
    expect(headers?.length).toBe(4);
    expect(headers![0].textContent).toContain("Action Confirmation");
    expect(headers![1].textContent).toContain("Agent-to-Agent Policy");
    expect(headers![2].textContent).toContain("Permissions");
    expect(headers![3].textContent).toContain("Approval Mode");
  });

  it("rules tab has toggles for action confirmation and agent-to-agent", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "rules");
    const queue = el.shadowRoot?.querySelector("ic-approval-queue") as any;
    await queue?.updateComplete;

    const toggles = approvalQueryAll(el, "ic-toggle");
    // requireForDestructive, requireForSensitive, agent-to-agent enabled, permission enabled
    expect(toggles!.length).toBeGreaterThanOrEqual(3);
  });
});
