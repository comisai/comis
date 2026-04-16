import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ConnectionStatus } from "../api/types/index.js";
import "./channel-list.js";
import { IcChannelList, formatUptime } from "./channel-list.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getAgents: vi.fn().mockResolvedValue([]),
    getChannels: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    searchMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi.fn().mockResolvedValue({}),
    chat: vi.fn().mockResolvedValue({ response: "test response" }),
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
  };
}

/** Type-safe access to private properties on the channel list element. */
function priv(el: IcChannelList) {
  return el as unknown as {
    _loadState: "loading" | "loaded" | "error";
    _error: string;
    _channels: Array<{
      type: string;
      name: string;
      enabled: boolean;
      status: "connected" | "disconnected" | "error";
      uptime: number;
      messageCount: number;
      lastActivity: number;
      botName?: string;
    }>;
    _staleTypes: Set<string>;
    _actionPending: Set<string>;
    _confirmDisable: string | null;
    _hasLoaded: boolean;
    apiClient: ApiClient | null;
    rpcClient: RpcClient | null;
    _loadData(): Promise<void>;
    _handleRestart(type: string): Promise<void>;
    _handleEnable(type: string): Promise<void>;
    _handleDisable(type: string): Promise<void>;
    _handleConfigure(type: string): void;
    _handleCardAction(e: CustomEvent): void;
    _confirmDisableAction(): void;
    _cancelDisable(): void;
  };
}

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcChannelList> {
  const el = document.createElement("ic-channel-list") as IcChannelList;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("IcChannelList", () => {
  let toastShowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    toastShowSpy = vi.spyOn(IcToast, "show").mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("formatUptime helper", () => {
    it("formats days and hours", () => {
      expect(formatUptime(86400)).toBe("1d 0h");
    });

    it("formats hours and minutes", () => {
      expect(formatUptime(3720)).toBe("1h 2m");
    });

    it("formats minutes only", () => {
      expect(formatUptime(300)).toBe("5m");
    });

    it("returns '0m' for zero seconds", () => {
      expect(formatUptime(0)).toBe("0m");
    });

    it("returns '0m' for negative seconds", () => {
      expect(formatUptime(-10)).toBe("0m");
    });

    it("formats multi-day uptime", () => {
      expect(formatUptime(86400 * 14 + 3600 * 3)).toBe("14d 3h");
    });
  });

  describe("initial state", () => {
    it("starts in loading state", () => {
      const el = document.createElement("ic-channel-list") as IcChannelList;
      expect(priv(el)._loadState).toBe("loading");
    });

    it("has empty channels array initially", () => {
      const el = document.createElement("ic-channel-list") as IcChannelList;
      expect(priv(el)._channels).toEqual([]);
    });
  });

  describe("card grid layout", () => {
    it("renders channel cards in a grid container", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
        { type: "discord", name: "dc-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient();
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      const grid = el.shadowRoot?.querySelector(".card-grid");
      expect(grid).not.toBeNull();

      // Check that ic-channel-card elements are rendered, not the old .channel-card divs
      const cards = el.shadowRoot?.querySelectorAll("ic-channel-card");
      expect(cards?.length).toBe(2);
    });

    it("uses CSS grid with auto-fill responsive columns", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient();
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      const grid = el.shadowRoot?.querySelector(".card-grid");
      expect(grid).not.toBeNull();
      // Verify the grid class exists - actual CSS properties checked by the stylesheet
      // containing `grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))`
    });

    it("does not render accordion expand/collapse elements", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient();
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      // Old accordion elements should not exist
      const expandIcon = el.shadowRoot?.querySelector(".expand-icon");
      expect(expandIcon).toBeNull();

      const cardBody = el.shadowRoot?.querySelector(".card-body");
      expect(cardBody).toBeNull();

      const disabledRow = el.shadowRoot?.querySelector(".disabled-row");
      expect(disabledRow).toBeNull();
    });
  });

  describe("rendering", () => {
    it("renders loading state initially", async () => {
      const el = await createElement();
      const loading = el.shadowRoot?.querySelector("ic-skeleton-view");
      expect(loading).not.toBeNull();
    });

    it("renders empty state when no channels returned", async () => {
      const mockApi = createMockApiClient({
        getChannels: vi.fn().mockResolvedValue([]),
      });
      const mockRpc = createMockRpcClient();
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
      expect(emptyState).not.toBeNull();
      expect((emptyState as HTMLElement)?.getAttribute("message")).toBe("No channels connected");
    });

    it("renders error state with retry button", async () => {
      const mockApi = createMockApiClient({
        getChannels: vi.fn().mockRejectedValue(new Error("Network failure")),
      });
      const el = await createElement({ apiClient: mockApi });
      await priv(el)._loadData();
      await el.updateComplete;

      const errorMsg = el.shadowRoot?.querySelector(".error-message");
      expect(errorMsg?.textContent).toContain("Network failure");

      const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
      expect(retryBtn).not.toBeNull();
    });
  });

  describe("connected channel card props", () => {
    it("passes green status props for connected enabled channel", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "obs.channels.all") {
          return Promise.resolve({
            channels: [
              { channelId: "1", channelType: "telegram", lastActiveAt: Date.now(), messagesSent: 10, messagesReceived: 20 },
            ],
          });
        }
        if (method === "obs.channels.stale") {
          return Promise.resolve({ channels: [] });
        }
        return Promise.resolve({ channels: [] });
      });
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });

      await vi.waitFor(() => {
        expect(priv(el)._loadState).toBe("loaded");
      });
      await el.updateComplete;

      const card = el.shadowRoot?.querySelector("ic-channel-card") as HTMLElement;
      expect(card).not.toBeNull();
      expect((card as any).status).toBe("connected");
      expect((card as any).enabled).toBe(true);
      expect((card as any).isStale).toBe(false);
      expect((card as any).messageCount).toBe(30); // 10 + 20
    });
  });

  describe("disabled channel card props", () => {
    it("passes gray/disconnected status props for disabled channel", async () => {
      const channels = [
        { type: "whatsapp", name: "wa-main", enabled: false, status: "disconnected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient();
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      const card = el.shadowRoot?.querySelector("ic-channel-card") as HTMLElement;
      expect(card).not.toBeNull();
      expect((card as any).enabled).toBe(false);
      expect((card as any).status).toBe("disconnected");
    });
  });

  describe("stale channel card props", () => {
    it("passes isStale=true for stale channels", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
        { type: "discord", name: "dc-main", enabled: true, status: "connected" as const },
      ];
      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "obs.channels.all") {
          return Promise.resolve({
            channels: [
              { channelId: "1", channelType: "telegram", lastActiveAt: Date.now(), messagesSent: 10, messagesReceived: 20 },
              { channelId: "2", channelType: "discord", lastActiveAt: Date.now() - 600000, messagesSent: 5, messagesReceived: 3 },
            ],
          });
        }
        if (method === "obs.channels.stale") {
          return Promise.resolve({
            channels: [
              { channelId: "2", channelType: "discord", lastActiveAt: Date.now() - 600000, messagesSent: 5, messagesReceived: 3 },
            ],
          });
        }
        return Promise.resolve({ channels: [] });
      });
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });

      await vi.waitFor(() => {
        expect(priv(el)._loadState).toBe("loaded");
      });
      await el.updateComplete;

      const cards = el.shadowRoot?.querySelectorAll("ic-channel-card") as NodeListOf<HTMLElement>;
      expect(cards.length).toBe(2);

      // Telegram should NOT be stale
      expect((cards[0] as any).isStale).toBe(false);
      // Discord SHOULD be stale
      expect((cards[1] as any).isStale).toBe(true);
    });
  });

  describe("summary stats row", () => {
    it("renders correct channel counts", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "healthy" as const },
        { type: "discord", name: "dc-main", enabled: true, status: "healthy" as const },
        { type: "whatsapp", name: "wa-main", enabled: false, status: "disconnected" as const },
        { type: "slack", name: "sl-main", enabled: false, status: "disconnected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient();
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      const badges = el.shadowRoot?.querySelectorAll(".stat-badge");
      expect(badges).not.toBeNull();

      // Should have Total, Connected, Disabled (no Stale since none are stale)
      const badgeTexts = Array.from(badges ?? []).map((b) => b.textContent?.trim());
      expect(badgeTexts).toContain("4 Total");
      expect(badgeTexts).toContain("2 Connected");
      expect(badgeTexts).toContain("2 Disabled");
    });

    it("shows stale badge when stale channels exist", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "obs.channels.all") {
          return Promise.resolve({
            channels: [
              { channelId: "1", channelType: "telegram", lastActiveAt: Date.now() - 600000, messagesSent: 5, messagesReceived: 3 },
            ],
          });
        }
        if (method === "obs.channels.stale") {
          return Promise.resolve({
            channels: [
              { channelId: "1", channelType: "telegram", lastActiveAt: Date.now() - 600000, messagesSent: 5, messagesReceived: 3 },
            ],
          });
        }
        return Promise.resolve({ channels: [] });
      });
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });

      await vi.waitFor(() => {
        expect(priv(el)._loadState).toBe("loaded");
      });
      await el.updateComplete;

      const staleBadge = el.shadowRoot?.querySelector(".stat-badge--stale");
      expect(staleBadge).not.toBeNull();
      expect(staleBadge?.textContent?.trim()).toBe("1 Stale");
    });
  });

  describe("action handling via channel-action event", () => {
    it("restart action calls channels.restart RPC with correct channel_type", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ channels: [] }),
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      // Simulate channel-action event from ic-channel-card
      const card = el.shadowRoot?.querySelector("ic-channel-card") as HTMLElement;
      card?.dispatchEvent(new CustomEvent("channel-action", {
        detail: { action: "restart", channelType: "telegram" },
        bubbles: true,
        composed: true,
      }));

      await vi.waitFor(() => {
        expect(mockRpc.call).toHaveBeenCalledWith("channels.restart", { channel_type: "telegram" });
      });
    });

    it("enable action calls channels.enable RPC", async () => {
      const channels = [
        { type: "slack", name: "sl-main", enabled: false, status: "disconnected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ channels: [] }),
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      const card = el.shadowRoot?.querySelector("ic-channel-card") as HTMLElement;
      card?.dispatchEvent(new CustomEvent("channel-action", {
        detail: { action: "enable", channelType: "slack" },
        bubbles: true,
        composed: true,
      }));

      await vi.waitFor(() => {
        expect(mockRpc.call).toHaveBeenCalledWith("channels.enable", { channel_type: "slack" });
      });
    });

    it("disable action shows confirm dialog, then calls channels.disable RPC on confirm", async () => {
      const channels = [
        { type: "discord", name: "dc-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ channels: [] }),
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      // Trigger disable action -- should open confirm dialog
      const card = el.shadowRoot?.querySelector("ic-channel-card") as HTMLElement;
      card?.dispatchEvent(new CustomEvent("channel-action", {
        detail: { action: "disable", channelType: "discord" },
        bubbles: true,
        composed: true,
      }));
      await el.updateComplete;

      // Confirm dialog should be open
      const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog") as HTMLElement;
      expect(dialog).not.toBeNull();
      expect((dialog as any).open).toBe(true);
      expect((dialog as any).title).toBe("Disable Channel");

      // Simulate confirm
      dialog?.dispatchEvent(new CustomEvent("confirm"));
      await el.updateComplete;

      await vi.waitFor(() => {
        expect(mockRpc.call).toHaveBeenCalledWith("channels.disable", { channel_type: "discord" });
      });
    });

    it("disable action cancel closes dialog without calling RPC", async () => {
      const channels = [
        { type: "discord", name: "dc-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const callMock = vi.fn().mockResolvedValue({ channels: [] });
      const mockRpc = createMockRpcClient(undefined, {
        call: callMock,
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      // Open confirm dialog
      priv(el)._confirmDisable = "discord";
      await el.updateComplete;

      const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog") as HTMLElement;
      expect((dialog as any).open).toBe(true);

      // Cancel
      dialog?.dispatchEvent(new CustomEvent("cancel"));
      await el.updateComplete;

      expect(priv(el)._confirmDisable).toBeNull();
      // channels.disable should NOT have been called (only obs.channels.all and obs.channels.stale from initial load)
      expect(callMock).not.toHaveBeenCalledWith("channels.disable", expect.anything());
    });

    it("configure action dispatches navigate event to channel detail", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient();
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      const handler = vi.fn();
      el.addEventListener("navigate", handler);

      const card = el.shadowRoot?.querySelector("ic-channel-card") as HTMLElement;
      card?.dispatchEvent(new CustomEvent("channel-action", {
        detail: { action: "configure", channelType: "telegram" },
        bubbles: true,
        composed: true,
      }));

      expect(handler).toHaveBeenCalledOnce();
      expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("channels/telegram");
    });
  });

  describe("toast feedback", () => {
    it("shows toast feedback on successful restart", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockResolvedValue({ channels: [] }),
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      await priv(el)._handleRestart("telegram");

      expect(toastShowSpy).toHaveBeenCalledWith("Telegram restarted", "success");
    });

    it("shows error toast when RPC action fails", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const callMock = vi.fn().mockResolvedValue({ channels: [] });
      const mockRpc = createMockRpcClient(undefined, {
        call: callMock,
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await vi.waitFor(() => {
        expect(priv(el)._loadState).toBe("loaded");
      });

      // Make subsequent calls fail for the restart action
      callMock.mockRejectedValueOnce(new Error("RPC fail"));

      await priv(el)._handleRestart("telegram");

      expect(toastShowSpy).toHaveBeenCalledWith("Failed to restart telegram", "error");
    });
  });

  describe("fallback behavior", () => {
    it("renders cards without metrics when obs RPC calls fail", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      // obs calls reject but REST succeeds
      const callMock = vi.fn().mockRejectedValue(new Error("RPC unavailable"));
      const mockRpc = createMockRpcClient(undefined, {
        call: callMock,
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });
      await priv(el)._loadData();
      await el.updateComplete;

      // Should still render channel cards with zeroed metrics
      expect(priv(el)._channels.length).toBe(1);
      expect(priv(el)._channels[0].messageCount).toBe(0);
      expect(priv(el)._channels[0].lastActivity).toBe(0);
      expect(priv(el)._loadState).toBe("loaded");

      // Card should still render
      const card = el.shadowRoot?.querySelector("ic-channel-card");
      expect(card).not.toBeNull();
    });

    it("uses REST only when RPC client is null", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
      ];
      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const el = await createElement({ apiClient: mockApi, rpcClient: null });
      await priv(el)._loadData();
      await el.updateComplete;

      expect(priv(el)._channels.length).toBe(1);
      expect(priv(el)._channels[0].messageCount).toBe(0);
      expect(priv(el)._staleTypes.size).toBe(0);
    });
  });

  describe("data merging", () => {
    it("merges REST and RPC observability data correctly", async () => {
      const channels = [
        { type: "telegram", name: "tg-main", enabled: true, status: "connected" as const },
        { type: "discord", name: "dc-main", enabled: true, status: "connected" as const },
      ];

      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "obs.channels.all") {
          return Promise.resolve({
            channels: [
              { channelId: "1", channelType: "telegram", lastActiveAt: 1700000000000, messagesSent: 50, messagesReceived: 100 },
            ],
          });
        }
        if (method === "obs.channels.stale") {
          return Promise.resolve({ channels: [] });
        }
        return Promise.resolve({ channels: [] });
      });

      const mockApi = createMockApiClient({ getChannels: vi.fn().mockResolvedValue(channels) });
      const mockRpc = createMockRpcClient(undefined, {
        call: callMock,
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({ apiClient: mockApi, rpcClient: mockRpc });

      await vi.waitFor(() => {
        expect(priv(el)._loadState).toBe("loaded");
      });

      const tg = priv(el)._channels.find((c) => c.type === "telegram")!;
      expect(tg.messageCount).toBe(150); // 50 sent + 100 received
      expect(tg.lastActivity).toBe(1700000000000);

      const dc = priv(el)._channels.find((c) => c.type === "discord")!;
      expect(dc.messageCount).toBe(0); // No obs data
      expect(dc.lastActivity).toBe(0);
    });
  });
});
