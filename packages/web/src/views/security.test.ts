// SPDX-License-Identifier: Apache-2.0
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
      tenantId: "tenant-a",
      agentId: "agent-1",
      conversationRef: "conversation-a",
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
function createSecurityMockRpcClient(callImpl?: (...args: never[]) => unknown): RpcClient {
  return createMockRpcClient(
    callImpl ??
      (async (method: string) => {
        if (method === "config.read")
          return {
            config: { tenantId: "tenant-a", security: structuredClone(MOCK_SECURITY_CONFIG) },
            sections: ["security"],
          };
        if (method === "agents.list")
          return { agents: ["agent-1"] };
        if (method === "session.list")
          return {
            sessions: [{ conversationRef: "conversation-a", agentId: "agent-1" }],
            total: 1,
          };
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
  // SseController listens for SSE events on `document` (EventDispatcher's
  // channel-2 delivery path). The mock dispatcher therefore just needs to
  // satisfy the EventDispatcher shape; _fire routes via document.dispatchEvent
  // so SseController-driven views observe the event.
  return {
    connected: true,
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn(() => vi.fn()),
    _fire(type: string, data: unknown = {}) {
      document.dispatchEvent(new CustomEvent(type, { detail: data }));
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

  it("shows 7 tab elements inside the IcSecurityView ic-tabs container", async () => {
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

  it("honors initialTab so the bell can deep-link the pending-approvals queue", async () => {
    // The topbar notification bell navigates to `security?tab=pending`; app.ts
    // threads that query value in as `initialTab`. The view must open on that
    // tab instead of the default "events" tab.
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc, initialTab: "pending" });
    await flush(el);

    expect(priv(el)._activeTab).toBe("pending");
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
    // Flush the rejected promise through _loadData's try/catch
    await flush(el);

    // _loadData catches the config.read rejection and sets _loadState = "error"
    expect(priv(el)._loadState).toBe("error");

    // Error state renders .error-message
    const errorMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errorMsg).toBeTruthy();

    // Error state renders .retry-btn
    const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
    expect(retryBtn).toBeTruthy();
  });

  // --- Audit tab tests: the audit tab renders the durable obs.audit.query view
  //     (ic-durable-audit-log), not the live SSE feed used by the events tab. ---

  it("audit tab renders the durable ic-durable-audit-log (NOT the live SSE feed)", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    await switchTab(el, "audit");

    // The audit tab renders the durable, queryable obs.audit.query view.
    const durable = el.shadowRoot?.querySelector("ic-durable-audit-log");
    expect(durable).toBeTruthy();
    // The audit tab must not render the live SSE feed.
    const feed = el.shadowRoot?.querySelector("ic-security-event-feed");
    expect(feed).toBeFalsy();
  });

  it("audit tab threads the rpcClient into the durable view (the obs.audit.query consumer)", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    await switchTab(el, "audit");

    const durable = el.shadowRoot?.querySelector("ic-durable-audit-log") as any;
    expect(durable?.rpcClient).toBe(rpc);
  });

  it("events tab renders the live SSE feed and not the durable audit view", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Default tab is "events".
    const feed = el.shadowRoot?.querySelector("ic-security-event-feed") as any;
    expect(feed).toBeTruthy();
    expect(feed.activeSubTab).toBe("events");
    // No durable view on the events tab.
    expect(el.shadowRoot?.querySelector("ic-durable-audit-log")).toBeFalsy();
  });

  it("events tab shows empty state when no security events", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);

    // Default tab is "events" which renders ic-security-event-feed.
    const empty = feedQuery(el, "ic-empty-state");
    expect(empty).toBeTruthy();
  });

  it("the audit:event SSE forwards events to the event-feed instance", async () => {
    // The audit:event SSE wiring (onAuditEvent) forwards to the event-feed
    // sub-component, which renders on the events tab. The durable audit tab
    // does not consume the SSE feed.
    const rpc = createSecurityMockRpcClient();
    const mockDispatcher = createMockEventDispatcher();
    const el = await createElement({ rpcClient: rpc, eventDispatcher: mockDispatcher });
    await flush(el);

    const feed = el.shadowRoot?.querySelector("ic-security-event-feed") as any;
    expect(feed).toBeTruthy();

    mockDispatcher._fire("audit:event", {
      timestamp: Date.now(),
      agentId: "a",
      action: "x",
      classification: "low",
      user: "u",
    });
    await feed?.updateComplete;

    // The event-feed received the audit event via onAuditEvent.
    expect(feed.auditEntries.length).toBe(1);
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

  it("secrets tab renders read-only storage mode and db path with no toggle since storage is runtime-immutable", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "secrets");

    // security.storage is runtime-immutable — no write control offered.
    const toggle = el.shadowRoot?.querySelector("ic-toggle");
    expect(toggle).toBeNull();

    // DB path row is still displayed (second .tls-value; first is storage mode).
    const tlsValues = el.shadowRoot?.querySelectorAll(".tls-value");
    expect(tlsValues?.length).toBeGreaterThanOrEqual(2);
    const dbPath = tlsValues?.[1];
    expect(dbPath).toBeTruthy();
    expect(dbPath!.textContent).toContain("secrets.db");
  });

  it("secrets tab shows credential storage section header", async () => {
    const rpc = createSecurityMockRpcClient();
    const el = await createElement({ rpcClient: rpc });
    await flush(el);
    await switchTab(el, "secrets");

    const header = el.shadowRoot?.querySelector(".section-header");
    expect(header).toBeTruthy();
    expect(header!.textContent).toContain("Credential Storage");
  });

  // --- Secrets tab storage mode rendering (all 3 values) ---

  describe("secrets tab storage mode rendering (all 3 values)", () => {
    for (const mode of ["encrypted", "file", "env"] as const) {
      it(`renders storage mode '${mode}' in Secrets tab`, async () => {
        const rpc = createSecurityMockRpcClient(async (method: string) => {
          if (method === "config.read")
            return {
              config: {
                security: { ...MOCK_SECURITY_CONFIG, storage: mode },
              },
              sections: ["security"],
            };
          if (method === "tokens.list") return { tokens: [] };
          if (method === "admin.approval.pending") return { requests: [], total: 0 };
          return {};
        });
        const el = await createElement({ rpcClient: rpc });
        await flush(el);
        await switchTab(el, "secrets");

        // First .tls-value in Secrets tab is the storage mode
        const tlsValues = el.shadowRoot?.querySelectorAll(".tls-value");
        const storageModeValue = tlsValues?.[0];
        expect(storageModeValue?.textContent?.trim()).toBe(mode);
      });
    }
  });

  // --- Rules tab tests ---

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
