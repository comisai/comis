// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ApiClient } from "../api/api-client.js";
import type { MemoryEntry, EmbeddingCacheStats } from "../api/types/index.js";
import type { RpcClient } from "../api/rpc-client.js";
import "./memory-inspector.js";
import type { IcMemoryInspector } from "./memory-inspector.js";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getAgents: vi.fn().mockResolvedValue([]),
    getChannels: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    searchMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi
      .fn()
      .mockResolvedValue({
        totalEntries: 100,
        totalSessions: 10,
        embeddedEntries: 80,
        dbSizeBytes: 1024000,
      }),
    browseMemory: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemoryBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    exportMemory: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionDetail: vi
      .fn()
      .mockResolvedValue({ session: {}, messages: [] }),
    resetSession: vi.fn().mockResolvedValue(undefined),
    compactSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue(""),
    resetSessionsBulk: vi.fn().mockResolvedValue({ reset: 0 }),
    exportSessionsBulk: vi.fn().mockResolvedValue(""),
    deleteSessionsBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    chat: vi.fn().mockResolvedValue({ response: "" }),
    getChatHistory: vi.fn().mockResolvedValue([]),
    health: vi
      .fn()
      .mockResolvedValue({ status: "ok", timestamp: "" }),
    ...overrides,
  };
}

/** Type-safe access to private properties on the memory inspector element. */
function priv(el: IcMemoryInspector) {
  return el as unknown as {
    _mode: "search" | "browse";
    _query: string;
    _results: MemoryEntry[];
    _loading: boolean;
    _searched: boolean;
    _error: string;
    _stats: { totalEntries: number; totalSessions: number; embeddedEntries: number; dbSizeBytes: number; byAgent?: Record<string, number>; oldestCreatedAt?: number | null } | null;
    _statsLoaded: boolean;
    _selectedEntry: MemoryEntry | null;
    _selectedIds: string[];
    _typeFilter: Set<string>;
    _trustFilter: Set<string>;
    _agentFilter: string;
    _dateFrom: string;
    _dateTo: string;
    _browseOffset: number;
    _browseLimit: number;
    _total: number;
    _agents: string[];
    _confirmOpen: boolean;
    _createOpen: boolean;
    _createContent: string;
    _createTrustLevel: string;
    _createVisibility: string;
    _createAgentId: string;
    _createMessageType: "success" | "error";
    _tenantId: string;
    _flushAgentId: string;
    _loadTenant(): Promise<void>;
    _submitCreate(): Promise<void>;
    _confirmFlush(): Promise<void>;
    apiClient: ApiClient | null;
    rpcClient: RpcClient | null;
    _embeddingStats: EmbeddingCacheStats | null;
    _embeddingLoading: boolean;
    _loadStats(): Promise<void>;
    _loadAgents(): Promise<void>;
    _loadEmbeddingStats(): Promise<void>;
    _search(): Promise<void>;
    _browse(): Promise<void>;
    _applyFilters(entries: MemoryEntry[]): MemoryEntry[];
    _getFilteredResults(): MemoryEntry[];
    _handleModeChange(mode: "search" | "browse"): void;
    _handleDetailRequested(e: CustomEvent<MemoryEntry>): void;
    _handleDetailClose(): void;
    _handleSelectionChange(e: CustomEvent<string[]>): void;
    _handleBulkDelete(): void;
    _confirmBulkDelete(): Promise<void>;
    _cancelBulkDelete(): void;
    _handleExport(ids?: string[]): Promise<void>;
    _handleEntryDeleted(e: CustomEvent<string>): Promise<void>;
    _formatBytes(bytes: number): string;
    _formatNumber(n: number): string;
  };
}

async function createElement(): Promise<IcMemoryInspector> {
  const el = document.createElement("ic-memory-inspector") as IcMemoryInspector;
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

describe("IcMemoryInspector", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders without error", async () => {
    const el = await createElement();
    expect(el.shadowRoot).toBeTruthy();
    const header = el.shadowRoot?.querySelector(".page-header");
    expect(header?.textContent?.trim()).toBe("Memory Inspector");
  });

  it("loads stats on mount when apiClient is set", async () => {
    const mockClient = createMockApiClient();
    const el = document.createElement("ic-memory-inspector") as IcMemoryInspector;
    el.apiClient = mockClient;
    document.body.appendChild(el);
    await (el as any).updateComplete;

    // Stats are per (tenant, agent): the view needs a resolved scope to read.
    priv(el)._tenantId = "acme";
    priv(el)._agents = ["default"];

    // Wait for async loadStats
    await priv(el)._loadStats();
    expect(mockClient.getMemoryStats).toHaveBeenCalled();
    expect(priv(el)._statsLoaded).toBe(true);
  });

  it("displays stat cards with stats values", async () => {
    const el = await createElement();
    el.apiClient = createMockApiClient();
    priv(el)._tenantId = "acme";
    priv(el)._agents = ["default"];
    await priv(el)._loadStats();
    await (el as any).updateComplete;

    const statCards = el.shadowRoot?.querySelectorAll("ic-stat-card");
    expect(statCards?.length).toBe(4);

    const labels = Array.from(statCards!).map(
      (c) => (c as any).label,
    );
    expect(labels).toContain("Total Entries");
    expect(labels).toContain("Sessions");
    expect(labels).toContain("Vectors");
    expect(labels).toContain("DB Size");
  });

  it("has search and browse mode toggle buttons", async () => {
    const el = await createElement();
    const modeButtons = el.shadowRoot?.querySelectorAll(".mode-btn");
    expect(modeButtons?.length).toBe(2);
    const texts = Array.from(modeButtons!).map((b) => b.textContent?.trim());
    expect(texts).toContain("Search");
    expect(texts).toContain("Browse All");
  });

  it("default mode is search", async () => {
    const el = await createElement();
    expect(priv(el)._mode).toBe("search");
    const searchBtn = el.shadowRoot?.querySelectorAll(".mode-btn")[0];
    expect(searchBtn?.hasAttribute("data-active")).toBe(true);
  });

  it("search mode shows search input", async () => {
    const el = await createElement();
    const searchInput = el.shadowRoot?.querySelector("ic-search-input");
    expect(searchInput).toBeTruthy();
  });

  it("browse mode hides search input and calls browseMemory", async () => {
    const mockClient = createMockApiClient();
    const el = await createElement();
    el.apiClient = mockClient;
    await (el as any).updateComplete;

    priv(el)._handleModeChange("browse");
    await (el as any).updateComplete;

    const searchInput = el.shadowRoot?.querySelector("ic-search-input");
    expect(searchInput).toBeNull();
    expect(priv(el)._mode).toBe("browse");
  });

  it("enables Browse-All Next and pages forward when the total exceeds the page size", async () => {
    // A full first page (25 of 383). The Next button must be ENABLED and a click
    // advances the offset by the page size. The pager must read the FULL total, not
    // the page length; otherwise it shows '1-25 of 25' with Next disabled and no way
    // past the first page.
    const page = Array.from({ length: 25 }, (_, i) => ({
      id: `m-${i}`,
      content: `entry ${i}`,
      trustLevel: "learned",
      tags: [],
      agentId: "default",
      createdAt: Date.now(),
    }));
    const browseMemory = vi.fn().mockResolvedValue({ entries: page, total: 383 });
    const el = await createElement();
    el.apiClient = createMockApiClient({ browseMemory } as Partial<ApiClient>);
    await (el as any).updateComplete;
    // A resolved single-agent scope: browse is per (tenant, agent).
    priv(el)._tenantId = "acme";
    priv(el)._agents = ["default"];

    priv(el)._handleModeChange("browse");
    await (el as any).updateComplete;
    await priv(el)._browse();
    await (el as any).updateComplete;

    expect(priv(el)._total).toBe(383);

    // The "of N" header reflects the FULL total, not the page length.
    const info = el.shadowRoot?.querySelector(".browse-info");
    expect(info?.textContent?.replace(/\s+/g, " ").trim()).toBe("1-25 of 383");

    // Next is enabled (offset 0 + limit 25 < 383).
    const browseBtns = el.shadowRoot?.querySelectorAll(".browse-btn");
    const nextBtn = browseBtns?.[1] as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);

    // Clicking Next advances the offset by the page size and re-queries.
    const callsBefore = browseMemory.mock.calls.length;
    nextBtn.click();
    await (el as any).updateComplete;
    expect(priv(el)._browseOffset).toBe(25);
    expect(browseMemory.mock.calls.length).toBe(callsBefore + 1);
  });

  it("renders exactly one pager in browse mode (no duplicate from the inner table)", async () => {
    const page = Array.from({ length: 25 }, (_, i) => ({
      id: `m-${i}`,
      content: `entry ${i}`,
      trustLevel: "learned",
      tags: [],
      agentId: "default",
      createdAt: Date.now(),
    }));
    const browseMemory = vi.fn().mockResolvedValue({ entries: page, total: 383 });
    const el = await createElement();
    el.apiClient = createMockApiClient({ browseMemory } as Partial<ApiClient>);
    await (el as any).updateComplete;
    priv(el)._tenantId = "acme";
    priv(el)._agents = ["default"];

    priv(el)._handleModeChange("browse");
    await (el as any).updateComplete;
    await priv(el)._browse();
    await (el as any).updateComplete;

    // The view renders its own server-side pager (browse-controls) exactly once.
    expect(el.shadowRoot?.querySelectorAll(".browse-controls").length).toBe(1);

    // The inner memory table must have its built-in pager suppressed so the two
    // pagers no longer stack — assert both the forwarded flag AND that the
    // nested data-table renders no .pagination footer.
    const memTable = el.shadowRoot?.querySelector("ic-memory-table") as HTMLElement & { hidePagination: boolean };
    expect(memTable.hidePagination).toBe(true);
    const innerTable = memTable.shadowRoot?.querySelector("ic-data-table");
    expect(innerTable?.shadowRoot?.querySelector(".pagination")).toBeNull();
  });

  it("filter checkboxes for memory type are rendered (4 types)", async () => {
    const el = await createElement();
    const filterGroups = el.shadowRoot?.querySelectorAll(".filter-group");
    // First filter group is Type
    const typeGroup = filterGroups?.[0];
    const checkboxes = typeGroup?.querySelectorAll(".filter-checkbox");
    expect(checkboxes?.length).toBe(4);
    const labels = Array.from(checkboxes!).map((c) => c.textContent?.trim());
    expect(labels).toContain("working");
    expect(labels).toContain("episodic");
    expect(labels).toContain("semantic");
    expect(labels).toContain("procedural");
  });

  it("filter checkboxes for trust level are rendered (3 levels)", async () => {
    const el = await createElement();
    const filterGroups = el.shadowRoot?.querySelectorAll(".filter-group");
    // Second filter group is Trust
    const trustGroup = filterGroups?.[1];
    const checkboxes = trustGroup?.querySelectorAll(".filter-checkbox");
    expect(checkboxes?.length).toBe(3);
    const labels = Array.from(checkboxes!).map((c) => c.textContent?.trim());
    expect(labels).toContain("system");
    expect(labels).toContain("learned");
    expect(labels).toContain("external");
  });

  it("agent filter dropdown is present", async () => {
    const el = await createElement();
    const filtersRow = el.shadowRoot?.querySelector(".filters-row");
    const agentSelect = filtersRow?.querySelector(".filter-select");
    expect(agentSelect).toBeTruthy();
    // Default option is "All"
    const options = agentSelect?.querySelectorAll("option");
    expect(options?.length).toBeGreaterThanOrEqual(1);
    expect(options?.[0].textContent?.trim()).toBe("All");
  });

  it("date range fields are present (from/to)", async () => {
    const el = await createElement();
    const dateInputs = el.shadowRoot?.querySelectorAll('.filter-date');
    expect(dateInputs?.length).toBe(2);
  });

  it("results area shows ic-memory-table component after search", async () => {
    const mockClient = createMockApiClient({
      searchMemory: vi.fn().mockResolvedValue([]),
    });
    const el = await createElement();
    el.apiClient = mockClient;
    priv(el)._query = "test";
    await priv(el)._search();
    await (el as any).updateComplete;

    const table = el.shadowRoot?.querySelector("ic-memory-table");
    expect(table).toBeTruthy();
  });

  it("bulk action bar hidden when no entries selected", async () => {
    const el = await createElement();
    const bulkBar = el.shadowRoot?.querySelector(".bulk-bar");
    expect(bulkBar).toBeNull();
  });

  it("bulk action bar shown when entries selected", async () => {
    const el = await createElement();
    priv(el)._selectedIds = ["1", "2"];
    await (el as any).updateComplete;

    const bulkBar = el.shadowRoot?.querySelector(".bulk-bar");
    expect(bulkBar).toBeTruthy();
    const count = bulkBar?.querySelector(".bulk-count");
    expect(count?.textContent).toContain("2 selected");
  });

  it("delete selected shows confirm dialog", async () => {
    const el = await createElement();
    priv(el)._selectedIds = ["1"];
    await (el as any).updateComplete;

    priv(el)._handleBulkDelete();
    await (el as any).updateComplete;

    expect(priv(el)._confirmOpen).toBe(true);
    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect(dialog).toBeTruthy();
    expect((dialog as any).open).toBe(true);
  });

  it("opens detail panel when detail-requested fires from table", async () => {
    const mockEntry: MemoryEntry = {
      id: "test-id",
      content: "test",
      memoryType: "episodic",
      trustLevel: "learned",
      agentId: "default",
      tenantId: "default",
      hasEmbedding: false,
      createdAt: Date.now(),
    };
    const el = await createElement();
    priv(el)._handleDetailRequested(
      new CustomEvent("detail-requested", { detail: mockEntry }),
    );
    await (el as any).updateComplete;

    expect(priv(el)._selectedEntry).toBe(mockEntry);
    const panel = el.shadowRoot?.querySelector("ic-detail-panel");
    expect((panel as any).open).toBe(true);
  });

  it("closes detail panel on close event", async () => {
    const el = await createElement();
    priv(el)._selectedEntry = {
      id: "x",
      content: "x",
      memoryType: "episodic",
      trustLevel: "system",
      agentId: "default",
      tenantId: "default",
      hasEmbedding: false,
      createdAt: Date.now(),
    };
    await (el as any).updateComplete;

    priv(el)._handleDetailClose();
    await (el as any).updateComplete;

    expect(priv(el)._selectedEntry).toBeNull();
    const panel = el.shadowRoot?.querySelector("ic-detail-panel");
    expect((panel as any).open).toBe(false);
  });

  it("_formatBytes formats correctly", () => {
    const el = document.createElement("ic-memory-inspector") as IcMemoryInspector;
    expect(priv(el)._formatBytes(0)).toBe("0 B");
    expect(priv(el)._formatBytes(1024)).toBe("1.0 KB");
    expect(priv(el)._formatBytes(1048576)).toBe("1.0 MB");
  });

  it("_formatNumber formats large numbers", () => {
    const el = document.createElement("ic-memory-inspector") as IcMemoryInspector;
    expect(priv(el)._formatNumber(500)).toBe("500");
    expect(priv(el)._formatNumber(1500)).toBe("1.5k");
  });

  // --- Creation form ---

  it("has create entry toggle button", async () => {
    const el = await createElement();
    const toggleBtn = el.shadowRoot?.querySelector(".create-toggle");
    expect(toggleBtn).toBeTruthy();
    expect(toggleBtn?.textContent?.trim()).toBe("+ Create Entry");
  });

  it("create form toggles open and closed", async () => {
    const el = await createElement();

    // Initially closed
    let form = el.shadowRoot?.querySelector(".create-form");
    expect(form).toBeNull();

    // Open
    (priv(el) as any)._createOpen = true;
    await (el as any).updateComplete;

    form = el.shadowRoot?.querySelector(".create-form");
    expect(form).toBeTruthy();

    // Has content textarea
    const textarea = form?.querySelector(".create-textarea");
    expect(textarea).toBeTruthy();

    // Has submit button
    const submitBtn = form?.querySelector(".create-submit");
    expect(submitBtn).toBeTruthy();
  });

  it("create-entry submits explicit tenant, agent, and visibility to memory.store", async () => {
    // memory.store binds the operator write to an EXPLICIT tenant/agent + an
    // explicit visibility under the daemon's control-plane authority model —
    // the create form must supply all three, never a silent default.
    const rpcCall = vi.fn().mockResolvedValue({ stored: true, id: "mem-1" });
    const el = await createElement();
    (el as any).rpcClient = { call: rpcCall };

    const p = priv(el);
    p._tenantId = "acme";
    p._createAgentId = "aria";
    p._createVisibility = "agent-shared";
    p._createContent = "operator-authored note";

    await p._submitCreate();

    expect(rpcCall).toHaveBeenCalledWith(
      "memory.store",
      expect.objectContaining({
        content: "operator-authored note",
        visibility: "agent-shared",
        tenantId: "acme",
        agentId: "aria",
      }),
    );
  });

  it("create-entry refuses to submit memory.store when the tenant is unresolved (no silent default)", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ stored: true, id: "mem-1" });
    const el = await createElement();
    (el as any).rpcClient = { call: rpcCall };

    const p = priv(el);
    p._tenantId = ""; // never resolved
    p._createAgentId = "aria";
    p._createContent = "note";

    await p._submitCreate();

    // Lifecycle calls (config.read / embeddingCache) may run, but the guard must
    // stop the store itself from ever reaching the daemon without a tenant.
    expect(rpcCall).not.toHaveBeenCalledWith("memory.store", expect.anything());
    expect(p._createMessageType).toBe("error");
  });

  it("_loadTenant resolves the deployment tenant from config.read", async () => {
    const rpcCall = vi.fn(async (method: string) =>
      method === "config.read"
        ? { config: { tenantId: "acme" } }
        : {},
    );
    const el = await createElement();
    (el as any).rpcClient = { call: rpcCall };

    await priv(el)._loadTenant();

    expect(rpcCall).toHaveBeenCalledWith("config.read", expect.anything());
    expect(priv(el)._tenantId).toBe("acme");
  });

  it("create form has visibility options in sync with the memory-visibility schema", async () => {
    const el = await createElement();
    (priv(el) as any)._createOpen = true;
    await (el as any).updateComplete;

    const form = el.shadowRoot?.querySelector(".create-form");
    const visibilitySelect = form?.querySelector(".create-visibility-select");
    expect(visibilitySelect).toBeTruthy();
    const options = Array.from(
      visibilitySelect!.querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    expect(options).toEqual(["agent-shared", "principal", "conversation"]);
  });

  // --- Scoped memory reads/deletes/flush (explicit authority) ---

  it("_loadStats scopes getMemoryStats to the cached tenant and selected agent", async () => {
    const getMemoryStats = vi.fn().mockResolvedValue({ stats: { totalEntries: 0 } });
    const el = await createElement();
    el.apiClient = createMockApiClient({ getMemoryStats });
    const p = priv(el);
    p._tenantId = "acme";
    p._agentFilter = "aria";

    await p._loadStats();

    expect(getMemoryStats).toHaveBeenCalledWith({ tenantId: "acme", agentId: "aria" });
  });

  it("_search scopes searchMemory to the cached tenant and selected agent", async () => {
    const searchMemory = vi.fn().mockResolvedValue([]);
    const el = await createElement();
    el.apiClient = createMockApiClient({ searchMemory });
    const p = priv(el);
    p._tenantId = "acme";
    p._agentFilter = "aria";
    p._query = "hello";

    await p._search();

    expect(searchMemory).toHaveBeenCalledWith("hello", { tenantId: "acme", agentId: "aria" }, 50);
  });

  it("_browse scopes browseMemory to the cached tenant and selected agent", async () => {
    const browseMemory = vi.fn().mockResolvedValue({ entries: [], total: 0 });
    const el = await createElement();
    el.apiClient = createMockApiClient({ browseMemory });
    const p = priv(el);
    p._tenantId = "acme";
    p._agentFilter = "aria";

    await p._browse();

    expect(browseMemory).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "acme", agentId: "aria" }),
    );
  });

  it("flush sends explicit tenant/agent for the selected agent", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ flushed: true, entriesRemoved: 0 });
    const el = await createElement();
    el.apiClient = createMockApiClient();
    (el as any).rpcClient = { call: rpcCall };
    const p = priv(el);
    p._tenantId = "acme";
    p._flushAgentId = "aria";

    await p._confirmFlush();

    expect(rpcCall).toHaveBeenCalledWith("memory.flush", { tenant_id: "acme", agent_id: "aria" });
  });

  it("_loadStats aggregates stats across every agent when the filter is 'All'", async () => {
    const getMemoryStats = vi.fn(async ({ agentId }: { tenantId: string; agentId: string }) =>
      agentId === "aria"
        ? { stats: { totalEntries: 3, totalSessions: 1, embeddedEntries: 2, dbSizeBytes: 4096, byAgent: { aria: 3 }, byType: { episodic: 3 }, oldestCreatedAt: 100 } }
        : { stats: { totalEntries: 5, totalSessions: 2, embeddedEntries: 1, dbSizeBytes: 4096, byAgent: { sol: 5 }, byType: { semantic: 5 }, oldestCreatedAt: 50 } },
    );
    const el = await createElement();
    el.apiClient = createMockApiClient({ getMemoryStats } as Partial<ApiClient>);
    const p = priv(el);
    p._tenantId = "acme";
    p._agents = ["aria", "sol"];
    p._agentFilter = ""; // "All Agents"

    await p._loadStats();

    // One scoped call per configured agent (the lifecycle may re-run it, so
    // assert the per-agent fan-out rather than an exact count).
    expect(getMemoryStats).toHaveBeenCalledWith({ tenantId: "acme", agentId: "aria" });
    expect(getMemoryStats).toHaveBeenCalledWith({ tenantId: "acme", agentId: "sol" });
    expect(p._stats!.totalEntries).toBe(8); // 3 + 5 summed
    expect(p._stats!.totalSessions).toBe(3); // 1 + 2 summed
    expect(p._stats!.embeddedEntries).toBe(3); // 2 + 1 summed
    expect(p._stats!.dbSizeBytes).toBe(4096); // whole-DB metric: max, NOT summed
    expect(p._stats!.byAgent).toEqual({ aria: 3, sol: 5 });
    expect(p._stats!.oldestCreatedAt).toBe(50); // earliest across agents
  });

  it("_browse fans out and merges entries newest-first across every agent when the filter is 'All'", async () => {
    const browseMemory = vi.fn(async ({ agentId }: { agentId: string }) =>
      agentId === "aria"
        ? { entries: [{ id: "a1", content: "x", agentId: "aria", trustLevel: "learned", tags: [], createdAt: 200 }], total: 1 }
        : { entries: [{ id: "s1", content: "y", agentId: "sol", trustLevel: "learned", tags: [], createdAt: 300 }], total: 3 },
    );
    const el = await createElement();
    el.apiClient = createMockApiClient({ browseMemory } as Partial<ApiClient>);
    const p = priv(el);
    p._tenantId = "acme";
    p._agents = ["aria", "sol"];
    p._agentFilter = ""; // "All Agents"

    await p._browse();

    expect(browseMemory).toHaveBeenCalledTimes(2);
    expect(p._total).toBe(4); // 1 + 3 summed
    // merged newest-first: sol (createdAt 300) before aria (createdAt 200)
    expect(p._results.map((e) => e.id)).toEqual(["s1", "a1"]);
  });

  it("flush with 'All Agents' flushes every configured agent under explicit authority", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ flushed: true, entriesRemoved: 0 });
    const el = await createElement();
    el.apiClient = createMockApiClient();
    (el as any).rpcClient = { call: rpcCall };
    const p = priv(el);
    p._tenantId = "acme";
    p._agents = ["aria", "sol"];
    p._flushAgentId = ""; // "All Agents"

    await p._confirmFlush();

    expect(rpcCall).toHaveBeenCalledWith("memory.flush", { tenant_id: "acme", agent_id: "aria" });
    expect(rpcCall).toHaveBeenCalledWith("memory.flush", { tenant_id: "acme", agent_id: "sol" });
  });

  // --- Flush ---

  it("has flush memory button in toolbar", async () => {
    const el = await createElement();
    const flushBtn = el.shadowRoot?.querySelector(".flush-btn");
    expect(flushBtn).toBeTruthy();
    expect(flushBtn?.textContent?.trim()).toBe("Flush Memory");
  });

  it("flush scope selector is in toolbar", async () => {
    const el = await createElement();
    const toolbarRight = el.shadowRoot?.querySelector(".toolbar-right");
    expect(toolbarRight).toBeTruthy();
    const scopeSelect = toolbarRight?.querySelector(".filter-select");
    expect(scopeSelect).toBeTruthy();
    const firstOption = scopeSelect?.querySelector("option");
    expect(firstOption?.textContent?.trim()).toBe("All Agents");
  });

  // --- Embedding Infrastructure ---

  it("renders without throwing when stats omit circuitBreaker (partial daemon response)", async () => {
    const el = await createElement();
    priv(el)._embeddingStats = {
      enabled: false,
      l1: null,
      l2: null,
      provider: null,
      vecAvailable: false,
    } as unknown as EmbeddingCacheStats;
    await (el as any).updateComplete;

    const section = el.shadowRoot?.querySelector(".embedding-section");
    expect(section).toBeTruthy();
    expect(section?.textContent).toContain("Unknown");
  });

  it("renders embedding infrastructure section when stats loaded", async () => {
    const el = await createElement();
    priv(el)._embeddingStats = {
      enabled: true,
      l1: { entries: 42, maxEntries: 1000, hitRate: 0.873, hits: 350, misses: 51 },
      l2: null,
      provider: "openai",
      vecAvailable: true,
      circuitBreaker: { state: "closed" },
    };
    await (el as any).updateComplete;

    const section = el.shadowRoot?.querySelector(".embedding-section");
    expect(section).toBeTruthy();

    const heading = section?.querySelector(".section-heading");
    expect(heading?.textContent?.trim()).toBe("Embedding Infrastructure");

    // Should have stat cards for embedding metrics
    const statCards = section?.querySelectorAll("ic-stat-card");
    expect(statCards?.length).toBeGreaterThanOrEqual(6);

    const labels = Array.from(statCards!).map((c) => (c as any).label);
    expect(labels).toContain("Provider");
    expect(labels).toContain("L1 Hit Rate");
    expect(labels).toContain("L1 Entries");
    expect(labels).toContain("L1 Hits");
    expect(labels).toContain("L1 Misses");
    expect(labels).toContain("Circuit Breaker");
  });

  it("renders embedding disabled state when not configured", async () => {
    const el = await createElement();
    priv(el)._embeddingStats = {
      enabled: false,
      l2: null,
      vecAvailable: false,
      circuitBreaker: { state: "unknown" },
    };
    await (el as any).updateComplete;

    const disabled = el.shadowRoot?.querySelector(".embedding-disabled");
    expect(disabled).toBeTruthy();
    expect(disabled?.textContent).toContain("Embedding cache not configured");
  });
});
