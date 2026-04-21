// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSessionListView } from "./session-list.js";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { SessionInfo } from "../api/types/index.js";

// Side-effect import to register custom element
import "./session-list.js";

const testSessions: SessionInfo[] = [
  {
    key: "abc12345",
    agentId: "default",
    channelType: "telegram",
    messageCount: 47,
    totalTokens: 23400,
    inputTokens: 15234,
    outputTokens: 8166,
    toolCalls: 12,
    compactions: 1,
    resetCount: 0,
    createdAt: Date.now() - 7200000,
    lastActiveAt: Date.now() - 3600000,
  },
  {
    key: "def67890",
    agentId: "default",
    channelType: "discord",
    messageCount: 12,
    totalTokens: 8100,
    inputTokens: 5200,
    outputTokens: 2900,
    toolCalls: 3,
    compactions: 0,
    resetCount: 1,
    createdAt: Date.now() - 18000000,
    lastActiveAt: Date.now() - 7200000,
  },
  {
    key: "ghi11223",
    agentId: "support",
    channelType: "slack",
    messageCount: 103,
    totalTokens: 67200,
    inputTokens: 42000,
    outputTokens: 25200,
    toolCalls: 28,
    compactions: 2,
    resetCount: 0,
    createdAt: Date.now() - 86400000,
    lastActiveAt: Date.now() - 43200000,
  },
];

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getAgents: vi.fn().mockResolvedValue([]),
    getChannels: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    searchMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi.fn().mockResolvedValue({ totalEntries: 0, totalSessions: 0, embeddedEntries: 0, dbSizeBytes: 0 }),
    browseMemory: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemoryBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    exportMemory: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue(testSessions),
    getSessionDetail: vi.fn().mockResolvedValue({ session: testSessions[0], messages: [] }),
    resetSession: vi.fn().mockResolvedValue(undefined),
    compactSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue('{"key":"abc"}'),
    resetSessionsBulk: vi.fn().mockResolvedValue({ reset: 2 }),
    exportSessionsBulk: vi.fn().mockResolvedValue('{"key":"abc"}\n{"key":"def"}'),
    deleteSessionsBulk: vi.fn().mockResolvedValue({ deleted: 2 }),
    chat: vi.fn().mockResolvedValue({ response: "" }),
    getChatHistory: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue({ status: "ok", timestamp: "" }),
    subscribeEvents: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as ApiClient;
}

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcSessionListView", () => {
  it("renders without error", async () => {
    const el = await createElement<IcSessionListView>("ic-session-list-view");
    expect(el.shadowRoot).toBeTruthy();
  });

  it("loads sessions on mount when apiClient is set", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    // Wait for async load to complete
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    expect(api.listSessions).toHaveBeenCalled();
  });

  it("renders ic-session-list component after loading", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    const sessionList = el.shadowRoot?.querySelector("ic-session-list");
    expect(sessionList).toBeTruthy();
  });

  it("renders search input", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    const search = el.shadowRoot?.querySelector("ic-search-input");
    expect(search).toBeTruthy();
  });

  it("renders agent filter dropdown", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    const selects = el.shadowRoot?.querySelectorAll("select");
    const agentSelect = Array.from(selects ?? []).find((s) =>
      s.getAttribute("aria-label")?.includes("agent"),
    );
    expect(agentSelect).toBeTruthy();
  });

  it("renders channel filter dropdown", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    const selects = el.shadowRoot?.querySelectorAll("select");
    const channelSelect = Array.from(selects ?? []).find((s) =>
      s.getAttribute("aria-label")?.includes("channel"),
    );
    expect(channelSelect).toBeTruthy();
  });

  it("displays sessions in the table", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    const sessionList = el.shadowRoot?.querySelector("ic-session-list") as any;
    expect(sessionList?.sessions).toHaveLength(3);
  });

  it("search filters sessions by key/agent/channel text match", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Simulate search for "support" which should match only the third session
    (el as any)._searchQuery = "support";
    (el as any)._applyFilters();
    await el.updateComplete;

    const sessionList = el.shadowRoot?.querySelector("ic-session-list") as any;
    expect(sessionList?.sessions).toHaveLength(1);
    expect(sessionList?.sessions[0].agentId).toBe("support");
  });

  it("agent filter narrows sessions to matching agent", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    (el as any)._agentFilter = "support";
    (el as any)._applyFilters();
    await el.updateComplete;

    const sessionList = el.shadowRoot?.querySelector("ic-session-list") as any;
    expect(sessionList?.sessions).toHaveLength(1);
    expect(sessionList?.sessions[0].agentId).toBe("support");
  });

  it("channel filter narrows sessions to matching channel", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    (el as any)._channelFilter = "telegram";
    (el as any)._applyFilters();
    await el.updateComplete;

    const sessionList = el.shadowRoot?.querySelector("ic-session-list") as any;
    expect(sessionList?.sessions).toHaveLength(1);
    expect(sessionList?.sessions[0].channelType).toBe("telegram");
  });

  it("session click navigates to session detail route", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Directly call the handler to test navigation
    (el as any)._handleSessionClick(
      new CustomEvent("session-click", { detail: testSessions[0] }),
    );
    expect(window.location.hash).toBe("#/sessions/abc12345");
  });

  it("bulk actions hidden when no sessions selected", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const bulkBar = el.shadowRoot?.querySelector(".bulk-bar");
    expect(bulkBar).toBeFalsy();
  });

  it("bulk actions shown when sessions selected", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    (el as any)._selectedKeys = ["abc12345", "def67890"];
    await el.updateComplete;

    const bulkBar = el.shadowRoot?.querySelector(".bulk-bar");
    expect(bulkBar).toBeTruthy();
    expect(bulkBar?.textContent).toContain("2 selected");
  });

  it("bulk reset calls resetSessionsBulk", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    (el as any)._selectedKeys = ["abc12345"];
    (el as any)._confirmAction = "reset";
    await (el as any)._handleConfirm();

    expect(api.resetSessionsBulk).toHaveBeenCalledWith(["abc12345"]);
  });

  it("bulk export calls exportSessionsBulk and creates download", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Mock URL.createObjectURL and revokeObjectURL
    const mockUrl = "blob:test";
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue(mockUrl),
      revokeObjectURL: vi.fn(),
    });

    (el as any)._selectedKeys = ["abc12345"];
    await (el as any)._handleBulkExport();

    expect(api.exportSessionsBulk).toHaveBeenCalledWith(["abc12345"]);

    vi.unstubAllGlobals();
  });

  it("bulk delete shows confirm dialog then calls deleteSessionsBulk", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    (el as any)._selectedKeys = ["abc12345", "def67890"];
    // Show confirm
    (el as any)._showBulkConfirm("delete");
    await el.updateComplete;

    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect((dialog as any)?.open).toBe(true);
    expect((dialog as any)?.variant).toBe("danger");

    // Confirm the action
    await (el as any)._handleConfirm();
    expect(api.deleteSessionsBulk).toHaveBeenCalledWith(["abc12345", "def67890"]);
  });

  it("displays page title 'Sessions'", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    const title = el.shadowRoot?.querySelector(".page-title");
    expect(title?.textContent).toContain("Sessions");
  });

  it("renders status filter dropdown", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;
    const selects = el.shadowRoot?.querySelectorAll("select");
    const statusSelect = Array.from(selects ?? []).find((s) =>
      s.getAttribute("aria-label")?.includes("status"),
    );
    expect(statusSelect).toBeTruthy();
  });

  it("status filter narrows sessions by computed status", async () => {
    // Create sessions with different lastActiveAt values for different statuses
    const sessionsWithStatus: SessionInfo[] = [
      {
        ...testSessions[0],
        key: "active-session",
        lastActiveAt: Date.now() - 60000, // 1 min ago -> active
      },
      {
        ...testSessions[1],
        key: "idle-session",
        lastActiveAt: Date.now() - 30 * 60 * 1000, // 30 min ago -> idle
      },
      {
        ...testSessions[2],
        key: "expired-session",
        lastActiveAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago -> expired
      },
    ];

    const api = createMockApiClient({
      listSessions: vi.fn().mockResolvedValue(sessionsWithStatus),
    });
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Filter to active only
    (el as any)._statusFilter = "active";
    (el as any)._applyFilters();
    await el.updateComplete;

    const sessionList = el.shadowRoot?.querySelector("ic-session-list") as any;
    expect(sessionList?.sessions).toHaveLength(1);
    expect(sessionList?.sessions[0].key).toBe("active-session");
  });

  it("content search calls session.search RPC when rpcClient available", async () => {
    const api = createMockApiClient();
    const mockRpcClient = {
      call: vi.fn().mockResolvedValue([
        { sessionKey: "abc12345", agentId: "default", channelType: "telegram", snippet: "hello", score: 0.9, timestamp: Date.now() },
      ]),
      connect: vi.fn(),
      disconnect: vi.fn(),
      onStatusChange: vi.fn().mockReturnValue(() => {}),
      onNotification: vi.fn().mockReturnValue(() => {}),
      status: "connected" as const,
    } as unknown as RpcClient;

    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
      rpcClient: mockRpcClient,
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Trigger search which starts the debounce
    (el as any)._handleSearch(new CustomEvent("search", { detail: "hello" }));

    // Wait for the 300ms debounce
    await new Promise((r) => setTimeout(r, 350));
    await el.updateComplete;

    expect(mockRpcClient.call).toHaveBeenCalledWith("session.search", { query: "hello", limit: 50 });

    // After RPC returns, filteredSessions should only contain the matched session
    const sessionList = el.shadowRoot?.querySelector("ic-session-list") as any;
    expect(sessionList?.sessions).toHaveLength(1);
    expect(sessionList?.sessions[0].key).toBe("abc12345");
  });

  it("falls back to client-side search when rpcClient unavailable", async () => {
    const api = createMockApiClient();
    const el = await createElement<IcSessionListView>("ic-session-list-view", {
      apiClient: api,
      // No rpcClient
    });
    await new Promise((r) => setTimeout(r, 10));
    await el.updateComplete;

    // Trigger search without rpcClient -- should apply client-side filter immediately
    (el as any)._handleSearch(new CustomEvent("search", { detail: "support" }));
    await el.updateComplete;

    const sessionList = el.shadowRoot?.querySelector("ic-session-list") as any;
    expect(sessionList?.sessions).toHaveLength(1);
    expect(sessionList?.sessions[0].agentId).toBe("support");
  });
});
