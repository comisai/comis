// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcAgentList } from "./agent-list.js";
import type { ApiClient } from "../../api/api-client.js";
import type { RpcClient } from "../../api/rpc-client.js";

// Side-effect import to register custom element
import "./agent-list.js";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";

const MOCK_AGENTS = [
  { id: "default", name: "Comis", provider: "anthropic", model: "claude-sonnet-4-5", status: "active", messagesToday: 10 },
  { id: "support", name: "Helper", provider: "openai", model: "gpt-4o", status: "suspended", messagesToday: 5 },
  { id: "error-bot", name: "ErrorBot", provider: "anthropic", model: "claude-haiku", status: "error", messagesToday: 0 },
];

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getAgents: vi.fn().mockResolvedValue(MOCK_AGENTS),
    getChannels: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    searchMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi.fn().mockResolvedValue({}),
    chat: vi.fn().mockResolvedValue({ response: "" }),
    getChatHistory: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue({ status: "ok", timestamp: new Date().toISOString() }),
    subscribeEvents: vi.fn().mockReturnValue(() => {}),
    browseMemory: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemoryBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    exportMemory: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionDetail: vi.fn().mockResolvedValue({ session: {}, messages: [] }),
    resetSession: vi.fn().mockResolvedValue(undefined),
    compactSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue(""),
    resetSessionsBulk: vi.fn().mockResolvedValue({ reset: 0 }),
    exportSessionsBulk: vi.fn().mockResolvedValue(""),
    deleteSessionsBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
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

/** Type-safe access to private fields. */
function priv(el: IcAgentList) {
  return el as unknown as {
    _agents: Array<{ id: string; name?: string; provider: string; model: string; status: string; costToday: number; budgetUtilization: number; suspended: boolean; messagesToday: number }>;
    _loadState: "loading" | "loaded" | "error";
    _error: string;
    _deleteTarget: { id: string } | null;
    _actionPending: string;
    _searchQuery: string;
    _statusFilters: Set<string>;
    _wizardOpen: boolean;
    _wizardStep: 1 | 2 | 3;
    _wizardError: string;
    _wizardAgentId: string;
    _wizardAgentName: string;
    _wizardProvider: string;
    _wizardModel: string;
    _wizardToolProfile: string;
    apiClient: ApiClient | null;
    rpcClient: RpcClient | null;
    _loadAgents(): Promise<void>;
    _openWizard(): void;
    _closeWizard(): void;
    _wizardNext(): void;
    _wizardBack(): void;
    _wizardCreate(): Promise<void>;
    _handleSearch(e: CustomEvent<string>): void;
    _handleFilterChange(e: CustomEvent<{ selected: Set<string> }>): void;
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcAgentList", () => {
  it("renders loading state initially", async () => {
    const el = await createElement<IcAgentList>("ic-agent-list");
    const loading = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(loading).toBeTruthy();
  });

  it("renders search input and filter chips after load", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    const search = el.shadowRoot?.querySelector("ic-search-input");
    expect(search).toBeTruthy();
    const chips = el.shadowRoot?.querySelector("ic-filter-chips");
    expect(chips).toBeTruthy();
  });

  it("renders data table with agent data after load", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    const table = el.shadowRoot?.querySelector("ic-data-table");
    expect(table).toBeTruthy();
  });

  it("data table receives enriched agent rows", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    // Check private _agents has enriched fields
    expect(priv(el)._agents.length).toBe(3);
    expect(priv(el)._agents[0]).toHaveProperty("costToday");
    expect(priv(el)._agents[0]).toHaveProperty("budgetUtilization");
    expect(priv(el)._agents[0]).toHaveProperty("suspended");
  });

  // --- Search filtering ---

  it("search filters agents by name (case-insensitive)", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    // Simulate search event
    priv(el)._handleSearch(new CustomEvent("search", { detail: "helper" }) as CustomEvent<string>);
    await el.updateComplete;

    // The filtered agents should only include the "Helper" agent
    expect(priv(el)._searchQuery).toBe("helper");
  });

  it("search filters agents by ID", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    priv(el)._handleSearch(new CustomEvent("search", { detail: "error-bot" }) as CustomEvent<string>);
    await el.updateComplete;

    expect(priv(el)._searchQuery).toBe("error-bot");
  });

  // --- Status filter chips ---

  it("status filter chips filter agents by status", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    // Simulate filter change to only show active agents
    priv(el)._handleFilterChange(
      new CustomEvent("filter-change", { detail: { selected: new Set(["active"]) } }) as CustomEvent<{ selected: Set<string> }>,
    );
    await el.updateComplete;

    expect(priv(el)._statusFilters.size).toBe(1);
    expect(priv(el)._statusFilters.has("active")).toBe(true);
  });

  it("when no filters active, shows all agents", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    expect(priv(el)._statusFilters.size).toBe(0);
    expect(priv(el)._agents.length).toBe(3);
  });

  // --- Row click navigation ---

  it("row click dispatches navigate event via data table", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    // Simulate ic-data-table row-click event
    const table = el.shadowRoot?.querySelector("ic-data-table");
    expect(table).toBeTruthy();
    table?.dispatchEvent(
      new CustomEvent("row-click", {
        detail: { id: "default", name: "Comis", status: "active" },
        bubbles: true,
      }),
    );

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toBe("agents/default");
  });

  // --- Helper to find buttons inside ic-data-table shadow DOM ---

  function findActionButton(el: IcAgentList, ariaLabelMatch: string): HTMLElement | null {
    const table = el.shadowRoot?.querySelector("ic-data-table");
    if (!table?.shadowRoot) return null;
    return table.shadowRoot.querySelector(`button[aria-label${ariaLabelMatch}]`);
  }

  // --- CRUD: Suspend action ---

  it("clicking suspend calls agents.suspend RPC", async () => {
    const mockApi = createMockApiClient({
      getAgents: vi.fn().mockResolvedValue([
        { id: "active-agent", name: "Active", provider: "anthropic", model: "claude", status: "active" },
      ]),
    });
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
      rpcClient: mockRpc,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    // Action buttons are rendered inside ic-data-table's shadow DOM
    const suspendBtn = findActionButton(el, '="Suspend agent"');
    expect(suspendBtn).toBeTruthy();
    suspendBtn?.click();

    await new Promise((r) => setTimeout(r, 10));

    expect(mockRpc.call).toHaveBeenCalledWith("agents.suspend", { agentId: "active-agent" });
  });

  // --- CRUD: Resume action ---

  it("clicking resume calls agents.resume RPC for suspended agent", async () => {
    const mockApi = createMockApiClient({
      getAgents: vi.fn().mockResolvedValue([
        { id: "susp-agent", name: "Suspended", provider: "openai", model: "gpt-4o", status: "suspended" },
      ]),
    });
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
      rpcClient: mockRpc,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    const resumeBtn = findActionButton(el, '="Resume agent"');
    expect(resumeBtn).toBeTruthy();
    resumeBtn?.click();

    await new Promise((r) => setTimeout(r, 10));

    expect(mockRpc.call).toHaveBeenCalledWith("agents.resume", { agentId: "susp-agent" });
  });

  // --- CRUD: Delete ---

  it("clicking delete shows confirm dialog", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    const deleteBtn = findActionButton(el, '^="Delete"');
    expect(deleteBtn).toBeTruthy();
    deleteBtn?.click();
    await el.updateComplete;

    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute("open")).not.toBeNull();
  });

  it("confirming delete calls agents.delete RPC", async () => {
    const mockApi = createMockApiClient();
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
      rpcClient: mockRpc,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    const deleteBtn = findActionButton(el, '^="Delete"');
    deleteBtn?.click();
    await el.updateComplete;

    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect(dialog).toBeTruthy();
    dialog?.dispatchEvent(new CustomEvent("confirm"));
    await el.updateComplete;

    await new Promise((r) => setTimeout(r, 10));

    expect(mockRpc.call).toHaveBeenCalledWith("agents.delete", expect.objectContaining({ agentId: expect.any(String) }));
  });

  // --- Empty state ---

  it("shows empty state when no agents", async () => {
    const mockApi = createMockApiClient({
      getAgents: vi.fn().mockResolvedValue([]),
    });
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState).toBeTruthy();
    expect(emptyState?.getAttribute("message")).toBe("No agents configured");
  });

  // --- Error state ---

  it("renders error state with retry button on load failure", async () => {
    const mockApi = createMockApiClient({
      getAgents: vi.fn().mockRejectedValue(new Error("Network error")),
    });
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    const errorMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg?.textContent).toContain("Network error");

    const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
    expect(retryBtn).toBeTruthy();
  });

  // --- Create Agent button opens wizard ---

  it("Create Agent button opens wizard modal", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    expect(priv(el)._wizardOpen).toBe(false);

    const createBtn = el.shadowRoot?.querySelector(".create-btn");
    expect(createBtn).toBeTruthy();
    (createBtn as HTMLElement)?.click();
    await el.updateComplete;

    expect(priv(el)._wizardOpen).toBe(true);
    const dialog = el.shadowRoot?.querySelector(".wizard-dialog");
    expect(dialog).toBeTruthy();
  });

  // --- Wizard step navigation ---

  it("wizard starts at step 1", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    priv(el)._openWizard();
    await el.updateComplete;

    expect(priv(el)._wizardStep).toBe(1);
  });

  it("wizard validates agent ID before advancing to step 2", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    priv(el)._openWizard();
    await el.updateComplete;

    // Try to advance with empty ID
    priv(el)._wizardNext();
    await el.updateComplete;

    expect(priv(el)._wizardStep).toBe(1);
    expect(priv(el)._wizardError).toContain("Agent ID");

    // Set valid ID and advance
    priv(el)._wizardAgentId = "test-agent";
    priv(el)._wizardNext();
    await el.updateComplete;

    expect(priv(el)._wizardStep).toBe(2);
    expect(priv(el)._wizardError).toBe("");
  });

  it("wizard validates model ID before advancing to step 3", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    priv(el)._openWizard();
    priv(el)._wizardAgentId = "test-agent";
    priv(el)._wizardNext(); // -> step 2
    await el.updateComplete;

    // Try to advance without model
    priv(el)._wizardNext();
    await el.updateComplete;

    expect(priv(el)._wizardStep).toBe(2);
    expect(priv(el)._wizardError).toContain("Please select a model");

    // Set model and advance
    priv(el)._wizardModel = "claude-sonnet-4";
    priv(el)._wizardNext();
    await el.updateComplete;

    expect(priv(el)._wizardStep).toBe(3);
  });

  it("wizard back button navigates to previous step", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });
    await priv(el)._loadAgents();
    await el.updateComplete;

    priv(el)._openWizard();
    priv(el)._wizardAgentId = "test";
    priv(el)._wizardNext(); // -> step 2
    expect(priv(el)._wizardStep).toBe(2);

    priv(el)._wizardBack();
    expect(priv(el)._wizardStep).toBe(1);
  });

  // --- Wizard creates agent ---

  it("wizard creates agent via RPC on final step", async () => {
    const mockApi = createMockApiClient();
    const mockRpc = createMockRpcClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
      rpcClient: mockRpc,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    priv(el)._openWizard();
    priv(el)._wizardAgentId = "new-agent";
    priv(el)._wizardAgentName = "New Agent";
    priv(el)._wizardProvider = "anthropic";
    priv(el)._wizardModel = "claude-sonnet-4";
    priv(el)._wizardToolProfile = "standard";
    priv(el)._wizardStep = 3;

    await priv(el)._wizardCreate();
    await el.updateComplete;

    expect(mockRpc.call).toHaveBeenCalledWith("agents.create", {
      agentId: "new-agent",
      config: {
        name: "New Agent",
        provider: "anthropic",
        model: "claude-sonnet-4",
        skills: {
          toolPolicy: { profile: "standard" },
        },
      },
    });
  });

  it("wizard shows inline error on creation failure", async () => {
    const mockApi = createMockApiClient();
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockRejectedValue(new Error("Agent already exists")),
    });
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
      rpcClient: mockRpc,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    priv(el)._openWizard();
    priv(el)._wizardAgentId = "dup-agent";
    priv(el)._wizardModel = "test";
    priv(el)._wizardStep = 3;

    await priv(el)._wizardCreate();
    await el.updateComplete;

    expect(priv(el)._wizardError).toContain("Agent already exists");
    expect(priv(el)._wizardOpen).toBe(true); // dialog stays open
  });

  // --- Billing enrichment graceful degradation ---

  it("graceful degradation when billing enrichment fails", async () => {
    const mockApi = createMockApiClient();
    const mockRpc = createMockRpcClient(undefined, {
      call: vi.fn().mockRejectedValue(new Error("Billing unavailable")),
    });
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
      rpcClient: mockRpc,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    // Agents should still load even if billing fails
    expect(priv(el)._loadState).toBe("loaded");
    expect(priv(el)._agents.length).toBe(3);
    // Cost/budget should be 0 (fallback)
    expect(priv(el)._agents[0].costToday).toBe(0);
    expect(priv(el)._agents[0].budgetUtilization).toBe(0);
  });

  // --- Configure action navigates ---

  it("configure button dispatches navigate to edit route", async () => {
    const mockApi = createMockApiClient();
    const el = await createElement<IcAgentList>("ic-agent-list", {
      apiClient: mockApi,
    });

    await priv(el)._loadAgents();
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    const configBtn = findActionButton(el, '^="Configure"');
    expect(configBtn).toBeTruthy();
    configBtn?.click();

    expect(handler).toHaveBeenCalled();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toMatch(/\/edit$/);
  });
});
