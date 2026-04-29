// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcSkillsView } from "./skills.js";
import type { RpcClient } from "../api/rpc-client.js";

// Side-effect registration
import "./skills.js";
import { createMockRpcClient as _createSharedMock } from "../test-support/mock-rpc-client.js";

/** Mock skills configuration matching the real config.read RPC response shape. */
const MOCK_CONFIG = {
  config: {
    agents: {
      default: {
        skills: {
          discoveryPaths: ["./skills"],
          builtinTools: {
            read: true,
            write: true,
            edit: true,
            grep: true,
            find: true,
            ls: true,
            exec: true,
            process: true,
            webSearch: false,
            webFetch: false,
            browser: false,
          },
          toolPolicy: { profile: "full", allow: [], deny: [] },
          promptSkills: {
            maxBodyLength: 20000,
            enableDynamicContext: false,
            maxAutoInject: 3,
            allowedSkills: [],
            deniedSkills: [],
          },
        },
      },
    },
  },
  sections: ["agents"],
};

/** Mock discovered skills from skills.list RPC. */
const MOCK_SKILLS = {
  skills: [
    { name: "docx", description: "Create, read, edit Word documents", location: "/skills/docx" },
    { name: "pdf", description: "Process PDF files", location: "/skills/pdf" },
    { name: "xlsx", description: "Work with spreadsheets", location: "/skills/xlsx" },
  ],
};

/** Creates a mock RPC client with configurable call responses. */
function createMockRpcClient(callImpl?: (...args: unknown[]) => unknown): RpcClient {
  return _createSharedMock(
    callImpl ??
      (async (method: string) => {
        if (method === "skills.list") return structuredClone(MOCK_SKILLS);
        return structuredClone(MOCK_CONFIG);
      }),
  );
}

/** Helper to create and mount a skills view element. */
async function createElement(
  props?: Record<string, unknown>,
): Promise<IcSkillsView> {
  const el = document.createElement("ic-skills-view") as IcSkillsView;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

/** Type-safe access to private fields. */
function priv(el: IcSkillsView) {
  return el as unknown as {
    _loadState: "loading" | "loaded" | "error";
    _error: string;
    _activeTab: string;
    _skillsConfig: unknown;
    _discoveredSkills: unknown[];
    _searchQuery: string;
    _loadData(): Promise<void>;
    rpcClient: RpcClient | null;
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcSkillsView", () => {
  describe("loading state", () => {
    it("renders loading state initially when no rpcClient", async () => {
      const el = await createElement();
      const loading = el.shadowRoot?.querySelector("ic-skeleton-view");
      expect(loading).not.toBeNull();
    });

    it("renders loading state before RPC resolves", async () => {
      // Create RPC client that never resolves
      const callFn = vi.fn(() => new Promise(() => {}));
      const mockRpc = createMockRpcClient(callFn);
      const el = await createElement({ rpcClient: mockRpc });

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

      // Wait for the async _loadData to finish
      await priv(el)._loadData().catch(() => {});
      await el.updateComplete;

      const errorMsg = el.shadowRoot?.querySelector(".error-message");
      expect(errorMsg).not.toBeNull();
      expect(errorMsg?.textContent).toContain("Connection refused");
    });

    it("renders retry button on error", async () => {
      const mockRpc = createMockRpcClient(async () => {
        throw new Error("timeout");
      });
      const el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData().catch(() => {});
      await el.updateComplete;

      const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
      expect(retryBtn).not.toBeNull();
      expect(retryBtn?.textContent?.trim()).toBe("Retry");
    });

    it("retry button reloads data", async () => {
      // Always fail initially
      const mockRpc = createMockRpcClient(async () => {
        throw new Error("fail");
      });

      const el = await createElement({ rpcClient: mockRpc });
      // Wait for initial load attempts to fail
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(priv(el)._loadState).toBe("error");

      // Now make future calls succeed
      (mockRpc.call as ReturnType<typeof vi.fn>).mockResolvedValue(
        structuredClone(MOCK_CONFIG),
      );

      // Click retry
      const retryBtn = el.shadowRoot?.querySelector(".retry-btn") as HTMLButtonElement;
      expect(retryBtn).not.toBeNull();
      retryBtn?.click();

      // Wait for the re-triggered load
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(priv(el)._loadState).toBe("loaded");
    });
  });

  describe("loaded state with tabs", () => {
    let el: IcSkillsView;
    let mockRpc: RpcClient;

    beforeEach(async () => {
      mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;
    });

    it("renders 2 tabs after successful load", () => {
      const tabs = el.shadowRoot?.querySelector("ic-tabs");
      expect(tabs).not.toBeNull();

      const tabsProp = (tabs as any)?.tabs;
      expect(tabsProp).toHaveLength(2);
      expect(tabsProp.map((t: { label: string }) => t.label)).toEqual([
        "Built-in Tools",
        "Prompt Skills",
      ]);
    });

    it("renders view title", () => {
      const title = el.shadowRoot?.querySelector(".view-title");
      expect(title).not.toBeNull();
      expect(title?.textContent).toContain("Skills & Tools");
    });
  });

  describe("Built-in Tools tab", () => {
    let el: IcSkillsView;
    let mockRpc: RpcClient;

    beforeEach(async () => {
      mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;
    });

    it("shows categorized tool grid", () => {
      const headers = el.shadowRoot?.querySelectorAll(".category-header");
      expect(headers).not.toBeNull();
      // 4 built-in + 7 platform = 11 category headers
      expect(headers!.length).toBe(11);

      const headerTexts = Array.from(headers!).map((h) => h.textContent?.trim());
      // Built-in categories
      expect(headerTexts).toContain("File Operations");
      expect(headerTexts).toContain("Execution");
      expect(headerTexts).toContain("Search");
      expect(headerTexts).toContain("Web");
      // Platform categories
      expect(headerTexts).toContain("MEMORY");
      expect(headerTexts).toContain("SESSIONS");
      expect(headerTexts).toContain("AGENTS");
    });

    it("shows tool cards with names and descriptions", () => {
      const toolCards = el.shadowRoot?.querySelectorAll(".tool-card");
      expect(toolCards).not.toBeNull();
      // 11 built-in + 30 platform = 41 tool cards
      expect(toolCards!.length).toBe(41);

      const firstCard = toolCards![0];
      const name = firstCard.querySelector(".tool-name");
      const desc = firstCard.querySelector(".tool-desc");
      expect(name).not.toBeNull();
      expect(desc).not.toBeNull();
    });

    it("shows all built-in tool names", () => {
      // Tool cards are now read-only display; enable/disable moved to agent editor
      const toolNames = el.shadowRoot?.querySelectorAll(".tool-name");
      const nameArray = Array.from(toolNames!).map((n) => n.textContent?.trim());
      expect(nameArray).toContain("read");
      expect(nameArray).toContain("webSearch");
    });

    it("shows hint about per-agent configuration", () => {
      const hint = el.shadowRoot?.querySelector(".tool-hint");
      expect(hint).not.toBeNull();
      expect(hint?.textContent).toContain("agent editor");
    });

    it("shows updated webSearch description with provider info", () => {
      const toolCards = el.shadowRoot?.querySelectorAll(".tool-card");
      const webSearchCard = Array.from(toolCards!).find(
        (c) => c.querySelector(".tool-name")?.textContent?.trim() === "webSearch",
      );
      expect(webSearchCard).not.toBeNull();
      const desc = webSearchCard!.querySelector(".tool-desc");
      expect(desc?.textContent).toContain("Multi-provider");
    });

    it("shows freshness parameter hints on webSearch card", () => {
      const toolCards = el.shadowRoot?.querySelectorAll(".tool-card");
      const webSearchCard = Array.from(toolCards!).find(
        (c) => c.querySelector(".tool-name")?.textContent?.trim() === "webSearch",
      );
      expect(webSearchCard).not.toBeNull();
      const paramList = webSearchCard!.querySelector(".tool-params");
      expect(paramList).not.toBeNull();
      const items = paramList!.querySelectorAll("li");
      expect(items.length).toBe(3);
      // Verify freshness hint content
      const allText = Array.from(items).map((li) => li.textContent).join(" ");
      expect(allText).toContain("pd");
      expect(allText).toContain("pw");
      expect(allText).toContain("pm");
      expect(allText).toContain("py");
      expect(allText).toContain("YYYY-MM-DD");
    });

    it("does not show parameter hints on non-web tools", () => {
      const toolCards = el.shadowRoot?.querySelectorAll(".tool-card");
      const readCard = Array.from(toolCards!).find(
        (c) => c.querySelector(".tool-name")?.textContent?.trim() === "read",
      );
      expect(readCard).not.toBeNull();
      const paramList = readCard!.querySelector(".tool-params");
      expect(paramList).toBeNull();
    });
  });

  describe("Prompt Skills tab", () => {
    let el: IcSkillsView;

    beforeEach(async () => {
      const mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      priv(el)._activeTab = "skills";
      await el.updateComplete;
    });

    it("shows hint about per-agent prompt skill configuration", () => {
      // Prompt skill config fields moved to per-agent editor; tab now shows hint
      const hint = el.shadowRoot?.querySelector(".tool-hint");
      expect(hint).not.toBeNull();
      expect(hint?.textContent).toContain("per agent");
    });

    it("shows search input for filtering", () => {
      const searchInput = el.shadowRoot?.querySelector("ic-search-input");
      expect(searchInput).not.toBeNull();
    });

    it("shows discovered skills from skills.list RPC", () => {
      const toolCards = el.shadowRoot?.querySelectorAll(".tool-card");
      expect(toolCards).not.toBeNull();
      expect(toolCards!.length).toBe(3);

      const names = Array.from(toolCards!).map(
        (c) => c.querySelector(".tool-name")?.textContent?.trim(),
      );
      expect(names).toContain("docx");
      expect(names).toContain("pdf");
      expect(names).toContain("xlsx");
    });

    it("shows empty state when no skills discovered", async () => {
      const noSkillsImpl = async (method: string) => {
        if (method === "skills.list") return { skills: [] };
        return structuredClone(MOCK_CONFIG);
      };
      const mockRpc2 = createMockRpcClient(noSkillsImpl);
      const el2 = await createElement({ rpcClient: mockRpc2 });
      await priv(el2)._loadData();
      priv(el2)._activeTab = "skills";
      await el2.updateComplete;

      const emptyState = el2.shadowRoot?.querySelector("ic-empty-state");
      expect(emptyState).not.toBeNull();
    });
  });

  describe("Tool Policy section (within tools tab)", () => {
    let el: IcSkillsView;

    beforeEach(async () => {
      const mockRpc = createMockRpcClient();
      el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      // Policy section is rendered within the default "tools" tab
      await el.updateComplete;
    });

    it("shows policy explanation text", () => {
      // Policy section is now part of the tools tab
      const section = el.shadowRoot?.querySelector(".policy-section");
      expect(section).not.toBeNull();

      const hints = section?.querySelectorAll(".tool-hint");
      expect(hints).not.toBeNull();
      expect(hints!.length).toBeGreaterThanOrEqual(1);
      const allText = Array.from(hints!).map((h) => h.textContent).join(" ");
      expect(allText).toContain("Tool policy");
      expect(allText).toContain("agent editor");
    });
  });

  describe("tab switching", () => {
    it("switches between tabs correctly", async () => {
      const mockRpc = createMockRpcClient();
      const el = await createElement({ rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      // Default tab is 'tools'
      expect(priv(el)._activeTab).toBe("tools");

      // Switch to skills tab
      priv(el)._activeTab = "skills";
      await el.updateComplete;
      expect(priv(el)._activeTab).toBe("skills");
    });
  });

  describe("data loading lifecycle", () => {
    it("calls config.read on connectedCallback when rpcClient is set", async () => {
      const mockRpc = createMockRpcClient();
      const el = await createElement({ rpcClient: mockRpc });

      // Wait for load
      await new Promise((r) => setTimeout(r, 50));
      await el.updateComplete;

      expect(mockRpc.call).toHaveBeenCalledWith("config.read");
    });

    it("does nothing when rpcClient is null", async () => {
      const el = await createElement();
      expect(priv(el)._loadState).toBe("loading");
      expect(priv(el)._skillsConfig).toBeNull();
    });
  });
});
