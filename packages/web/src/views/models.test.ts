// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcModelsView } from "./models.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect registration
import "./models.js";
import { createMockRpcClient as _createSharedMock } from "../test-support/mock-rpc-client.js";

/** Mock config data matching the real config.read shape for providers/models. */
const MOCK_CONFIG = {
  providers: {
    entries: {
      anthropic: {
        type: "anthropic",
        name: "Anthropic",
        baseUrl: "",
        apiKeyName: "ANTHROPIC_API_KEY",
        enabled: true,
        timeoutMs: 120000,
        maxRetries: 2,
        headers: {},
      },
      openai: {
        type: "openai",
        name: "OpenAI",
        baseUrl: "",
        apiKeyName: "OPENAI_API_KEY",
        enabled: true,
        timeoutMs: 120000,
        maxRetries: 2,
        headers: {},
      },
    },
  },
  models: {
    aliases: [{ alias: "claude", provider: "anthropic", modelId: "claude-sonnet-4-5-20250929" }],
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-5-20250929",
    scanOnStartup: false,
    scanTimeoutMs: 30000,
  },
};

const MOCK_MODELS_LIST = {
  models: [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5-20250929",
      displayName: "Claude Sonnet 4.5",
      contextWindow: 200000,
      maxTokens: 8192,
      input: true,
      reasoning: true,
      validated: true,
    },
    {
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      displayName: "Claude Opus 4",
      contextWindow: 200000,
      maxTokens: 16384,
      input: true,
      reasoning: true,
      validated: true,
    },
    {
      provider: "openai",
      modelId: "gpt-4o",
      displayName: "GPT-4o",
      contextWindow: 128000,
      maxTokens: 4096,
      input: true,
      reasoning: false,
      validated: true,
    },
    {
      provider: "openai",
      modelId: "gpt-4o-mini",
      displayName: "GPT-4o Mini",
      contextWindow: 128000,
      maxTokens: 4096,
      input: true,
      reasoning: false,
      validated: false,
    },
    {
      provider: "ollama",
      modelId: "llama-3.1-8b",
      displayName: "Llama 3.1 8B",
      contextWindow: 8192,
      maxTokens: 2048,
      input: true,
      reasoning: false,
      validated: false,
    },
  ],
  providers: ["anthropic", "openai", "ollama"],
  total: 5,
};

/** Creates a mock RPC client with configurable call responses. */
function createMockRpcClient(callImpl?: (...args: unknown[]) => unknown): RpcClient {
  return _createSharedMock(
    callImpl ??
      (async (method: string) => {
        if (method === "config.read") return { config: structuredClone(MOCK_CONFIG), sections: ["providers", "models"] };
        if (method === "models.list") return structuredClone(MOCK_MODELS_LIST);
        if (method === "models.test") return { status: "ok", modelsAvailable: 3, validatedModels: 2 };
        if (method === "config.patch") return { ok: true };
        return {};
      }),
  );
}

/** Helper to create and mount a models view element. */
async function createElement(
  props?: Record<string, unknown>,
): Promise<IcModelsView> {
  const el = document.createElement("ic-models-view") as IcModelsView;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Type-safe access to private fields. */
function priv(el: IcModelsView) {
  return el as unknown as {
    _loadState: "loading" | "loaded" | "error";
    _error: string;
    _activeTab: string;
    _providers: Record<string, unknown>;
    _models: unknown[];
    _aliases: unknown[];
    _defaultProvider: string;
    _defaultModel: string;
    _editingProvider: string | null;
    _editingAlias: number | null;
    _modelsSearchQuery: string;
    _modelsProviderFilter: string;
    _loadData(): Promise<void>;
    _updateDefaultProvider(provider: string): Promise<void>;
    _updateDefaultModel(model: string): Promise<void>;
    rpcClient: RpcClient | null;
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcModelsView", () => {
  describe("loading state", () => {
    it("renders loading state initially", async () => {
      const el = await createElement();
      const loading = el.shadowRoot?.querySelector("ic-skeleton-view");
      expect(loading).not.toBeNull();
    });
  });

  describe("error state", () => {
    it("renders error state on RPC failure", async () => {
      const mockRpc = createMockRpcClient(async () => {
        throw new Error("Connection refused");
      });
      const el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData().catch(() => {});
      await el.updateComplete;

      const errorMsg = el.shadowRoot?.querySelector(".error-message");
      expect(errorMsg).not.toBeNull();
      expect(errorMsg?.textContent).toContain("Connection refused");
    });

    it("retry button reloads data", async () => {
      const mockRpc = createMockRpcClient(async () => {
        throw new Error("fail");
      });
      const el = await createElement({ rpcClient: mockRpc });
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(priv(el)._loadState).toBe("error");

      // Make future calls succeed
      (mockRpc.call as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
        if (method === "config.read") return { config: structuredClone(MOCK_CONFIG), sections: ["providers", "models"] };
        if (method === "models.list") return structuredClone(MOCK_MODELS_LIST);
        return {};
      });

      const retryBtn = el.shadowRoot?.querySelector(".retry-btn") as HTMLButtonElement;
      expect(retryBtn).not.toBeNull();
      retryBtn?.click();

      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(priv(el)._loadState).toBe("loaded");
    });
  });

  describe("loaded state with tabs", () => {
    let el: IcModelsView;
    let mockRpc: RpcClient;

    beforeEach(async () => {
      mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;
    });

    it("renders 4 tabs after successful load", () => {
      const tabs = el.shadowRoot?.querySelector("ic-tabs");
      expect(tabs).not.toBeNull();

      const tabsProp = (tabs as any)?.tabs;
      expect(tabsProp).toHaveLength(4);
      expect(tabsProp.map((t: { label: string }) => t.label)).toEqual([
        "Providers",
        "Catalog",
        "Aliases",
        "Defaults",
      ]);
    });

    it("renders view title", () => {
      const title = el.shadowRoot?.querySelector(".view-title");
      expect(title).not.toBeNull();
      expect(title?.textContent).toContain("Models & Providers");
    });
  });

  describe("Providers tab", () => {
    let el: IcModelsView;
    let mockRpc: RpcClient;

    beforeEach(async () => {
      mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;
    });

    it("shows provider cards for configured providers", () => {
      const cards = el.shadowRoot?.querySelectorAll("ic-provider-card");
      expect(cards).not.toBeNull();
      expect(cards!.length).toBe(2);
    });

    it("test-connection calls models.test RPC", async () => {
      const cards = el.shadowRoot?.querySelectorAll("ic-provider-card");
      expect(cards!.length).toBeGreaterThan(0);

      // Fire test-connection event on first card
      cards![0].dispatchEvent(new CustomEvent("test-connection", { bubbles: true }));

      await new Promise((r) => setTimeout(r, 50));

      const calls = (mockRpc.call as ReturnType<typeof vi.fn>).mock.calls;
      const testCall = calls.find((c: unknown[]) => c[0] === "models.test");
      expect(testCall).toBeTruthy();
    });

    it("Add Provider button shows editor form", async () => {
      const addBtn = el.shadowRoot?.querySelector(".btn-add") as HTMLButtonElement;
      expect(addBtn).not.toBeNull();
      addBtn?.click();
      await el.updateComplete;

      const editor = el.shadowRoot?.querySelector(".editor-form");
      expect(editor).not.toBeNull();

      const title = editor?.querySelector(".editor-title");
      expect(title?.textContent).toContain("Add Provider");
    });
  });

  describe("Available Models tab", () => {
    let el: IcModelsView;

    beforeEach(async () => {
      const mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      priv(el)._activeTab = "models";
      await el.updateComplete;
    });

    it("shows table with model entries", () => {
      const table = el.shadowRoot?.querySelector(".models-table");
      expect(table).not.toBeNull();

      // happy-dom may not fully render table children in shadow DOM,
      // so verify through the full innerHTML or textContent
      const html = table?.innerHTML ?? "";
      // Both model IDs should be present (sorted: anthropic first)
      expect(html).toContain("claude-sonnet-4-5-20250929");
      expect(html).toContain("gpt-4o");
    });

    it("shows context window and max tokens formatted", () => {
      const table = el.shadowRoot?.querySelector(".models-table");
      const html = table?.innerHTML ?? "";

      // 200000 should be formatted with comma: "200,000"
      expect(html).toContain("200,000");
      // 8192 should be formatted: "8,192"
      expect(html).toContain("8,192");
    });

    it("shows validated check icon for validated models", () => {
      const table = el.shadowRoot?.querySelector(".models-table");
      const icons = table?.querySelectorAll("ic-icon");
      // 3 validated models: claude-sonnet, claude-opus, gpt-4o
      expect(icons!.length).toBe(3);
    });
  });

  describe("Aliases tab", () => {
    let el: IcModelsView;
    let mockRpc: RpcClient;

    beforeEach(async () => {
      mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      priv(el)._activeTab = "aliases";
      await el.updateComplete;
    });

    it("shows alias table with existing aliases", () => {
      const table = el.shadowRoot?.querySelector(".alias-table");
      expect(table).not.toBeNull();

      // Verify alias data through innerHTML (happy-dom table rendering quirk)
      const html = table?.innerHTML ?? "";
      expect(html).toContain("claude");
      expect(html).toContain("anthropic");
      expect(html).toContain("claude-sonnet-4-5-20250929");
    });

    it("delete calls config.patch", async () => {
      const deleteBtn = el.shadowRoot?.querySelector('.btn-danger[aria-label*="Delete"]') as HTMLButtonElement;
      expect(deleteBtn).not.toBeNull();
      deleteBtn?.click();

      await new Promise((r) => setTimeout(r, 50));

      const calls = (mockRpc.call as ReturnType<typeof vi.fn>).mock.calls;
      const patchCall = calls.find((c: unknown[]) => c[0] === "config.patch");
      expect(patchCall).toBeTruthy();
      expect(patchCall![1]).toHaveProperty("section", "models");
      expect(patchCall![1]).toHaveProperty("key", "aliases");
    });

    it("shows empty state when no aliases", async () => {
      const emptyConfig = structuredClone(MOCK_CONFIG);
      emptyConfig.models.aliases = [];
      const emptyRpc = createMockRpcClient(async (...args: unknown[]) => {
        const method = args[0] as string;
        if (method === "config.read") return { config: emptyConfig, sections: ["providers", "models"] };
        if (method === "models.list") return structuredClone(MOCK_MODELS_LIST);
        return {};
      });
      const el2 = await createElement({ rpcClient: emptyRpc });
      await priv(el2)._loadData();
      priv(el2)._activeTab = "aliases";
      await el2.updateComplete;

      const emptyState = el2.shadowRoot?.querySelector("ic-empty-state");
      expect(emptyState).not.toBeNull();
    });
  });

  describe("Defaults tab", () => {
    let el: IcModelsView;
    let mockRpc: RpcClient;

    beforeEach(async () => {
      mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      priv(el)._activeTab = "defaults";
      await el.updateComplete;
    });

    it("shows current provider and model", () => {
      const selects = el.shadowRoot?.querySelectorAll<HTMLSelectElement>(".defaults-select");
      expect(selects).not.toBeNull();
      expect(selects!.length).toBe(2);

      // Check summary shows current defaults
      const summary = el.shadowRoot?.querySelector(".defaults-summary");
      expect(summary).not.toBeNull();
      expect(summary?.textContent).toContain("anthropic");
      expect(summary?.textContent).toContain("claude-sonnet-4-5-20250929");
    });

    it("change fires config.patch", async () => {
      const selects = el.shadowRoot?.querySelectorAll<HTMLSelectElement>(".defaults-select");

      // Change provider
      const providerSelect = selects![0];
      providerSelect.value = "openai";
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));

      await new Promise((r) => setTimeout(r, 50));

      const calls = (mockRpc.call as ReturnType<typeof vi.fn>).mock.calls;
      const patchCall = calls.find((c: unknown[]) => c[0] === "config.patch" && (c[1] as { section: string }).section === "models" && !(c[1] as { key?: string }).key);
      expect(patchCall).toBeTruthy();
      const patchValue = (patchCall![1] as { value: { defaultProvider: string } }).value;
      expect(patchValue.defaultProvider).toBe("openai");
    });
  });

  describe("Available Models tab - search and filter", () => {
    let el: IcModelsView;

    beforeEach(async () => {
      const mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      priv(el)._activeTab = "models";
      await el.updateComplete;
    });

    it("search filters models by model ID", async () => {
      priv(el)._modelsSearchQuery = "opus";
      await el.updateComplete;

      const table = el.shadowRoot?.querySelector(".models-table");
      const content = table?.innerHTML ?? "";
      expect(content).toContain("claude-opus-4-20250514");
      expect(content).not.toContain("gpt-4o");
      expect(content).not.toContain("llama-3.1-8b");
    });

    it("search filters models by provider name", async () => {
      priv(el)._modelsSearchQuery = "ollama";
      await el.updateComplete;

      const table = el.shadowRoot?.querySelector(".models-table");
      const content = table?.innerHTML ?? "";
      expect(content).toContain("llama-3.1-8b");
      expect(content).not.toContain("claude-sonnet");
      expect(content).not.toContain("gpt-4o");
    });

    it("provider filter shows only selected provider models", async () => {
      priv(el)._modelsProviderFilter = "anthropic";
      await el.updateComplete;

      const table = el.shadowRoot?.querySelector(".models-table");
      const content = table?.innerHTML ?? "";
      expect(content).toContain("claude-sonnet-4-5-20250929");
      expect(content).toContain("claude-opus-4-20250514");
      expect(content).not.toContain("gpt-4o");
      expect(content).not.toContain("llama-3.1-8b");
    });

    it("combined search + provider filter", async () => {
      priv(el)._modelsProviderFilter = "anthropic";
      priv(el)._modelsSearchQuery = "opus";
      await el.updateComplete;

      const table = el.shadowRoot?.querySelector(".models-table");
      const content = table?.innerHTML ?? "";
      expect(content).toContain("claude-opus-4-20250514");
      expect(content).not.toContain("claude-sonnet");
      expect(content).not.toContain("gpt-4o");
    });

    it("shows filter count", async () => {
      priv(el)._modelsProviderFilter = "anthropic";
      await el.updateComplete;

      const count = el.shadowRoot?.querySelector(".filter-count");
      expect(count).not.toBeNull();
      expect(count?.textContent).toContain("2 of 5 models");
    });

    it("shows empty state when no models match filter", async () => {
      priv(el)._modelsSearchQuery = "nonexistent";
      await el.updateComplete;

      const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
      expect(emptyState).not.toBeNull();
      expect(emptyState?.getAttribute("message")).toBe("No models match your filter");
    });
  });

  describe("Defaults tab - correlation", () => {
    let el: IcModelsView;
    let mockRpc: RpcClient;

    beforeEach(async () => {
      mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      priv(el)._activeTab = "defaults";
      await el.updateComplete;
    });

    it("selecting model auto-updates provider", async () => {
      // Start with anthropic provider, select an openai model
      expect(priv(el)._defaultProvider).toBe("anthropic");

      await priv(el)._updateDefaultModel("gpt-4o");
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(priv(el)._defaultProvider).toBe("openai");
      expect(priv(el)._defaultModel).toBe("gpt-4o");
    });

    it("selecting provider clears mismatched model", async () => {
      // Start with anthropic/claude-sonnet
      expect(priv(el)._defaultProvider).toBe("anthropic");
      expect(priv(el)._defaultModel).toBe("claude-sonnet-4-5-20250929");

      // Change provider to openai -- model is anthropic, so should be cleared
      await priv(el)._updateDefaultProvider("openai");
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(priv(el)._defaultProvider).toBe("openai");
      expect(priv(el)._defaultModel).toBe("");
    });

    it("model dropdown shows provider prefix when no provider selected", async () => {
      priv(el)._defaultProvider = "";
      await el.updateComplete;

      const selects = el.shadowRoot?.querySelectorAll<HTMLSelectElement>(".defaults-select");
      const modelSelect = selects![1];
      const options = modelSelect?.querySelectorAll("option");

      // Find a non-placeholder option and verify it has provider/ prefix
      const modelOptions = Array.from(options ?? []).filter((o) => o.value !== "");
      expect(modelOptions.length).toBeGreaterThan(0);

      // At least one option should have provider prefix format
      const hasPrefix = modelOptions.some((o) => o.textContent?.includes("/"));
      expect(hasPrefix).toBe(true);
    });

    it("shows resolved pairing when both provider and model set", async () => {
      const resolved = el.shadowRoot?.querySelector(".defaults-resolved");
      expect(resolved).not.toBeNull();
      expect(resolved?.textContent).toContain("anthropic/claude-sonnet-4-5-20250929");
    });

    it("shows warning when provider or model not set", async () => {
      priv(el)._defaultProvider = "";
      priv(el)._defaultModel = "";
      await el.updateComplete;

      const resolved = el.shadowRoot?.querySelector(".defaults-resolved");
      expect(resolved).not.toBeNull();
      expect(resolved?.textContent).toContain("Select both a provider and model");
    });
  });

  describe("data loading lifecycle", () => {
    it("calls config.read and models.list on load", async () => {
      const mockRpc = createMockRpcClient();
      const el = await createElement({ rpcClient: mockRpc });

      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      const calls = (mockRpc.call as ReturnType<typeof vi.fn>).mock.calls;
      const methods = calls.map((c: unknown[]) => c[0]);
      expect(methods).toContain("config.read");
      expect(methods).toContain("models.list");
    });
  });
});
