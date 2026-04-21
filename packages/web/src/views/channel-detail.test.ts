// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { ApiClient } from "../api/api-client.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ConnectionStatus } from "../api/types/index.js";
import "./channel-detail.js";
import { IcChannelDetail } from "./channel-detail.js";
import { IcToast } from "../components/feedback/ic-toast.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

// ---- Mock helpers ----

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

// ---- Platform config mocks ----

const TELEGRAM_CONFIG = {
  enabled: true,
  status: "connected",
  botToken: "SECRET_TOKEN_VALUE",
  webhookUrl: "https://example.com/hook",
  allowFrom: ["12345"],
  ackReaction: { enabled: true, emoji: "\u{1F440}" },
};

const DISCORD_CONFIG = {
  enabled: true,
  status: "connected",
  botToken: "SECRET_DISCORD_TOKEN",
  guildId: "123456789",
  allowFrom: [],
};

const SLACK_CONFIG = {
  enabled: true,
  status: "connected",
  botToken: "SECRET_SLACK_BOT",
  appToken: "SECRET_SLACK_APP",
  signingSecret: "SECRET_SIGNING",
  mode: "socket",
  allowFrom: [],
};

const IRC_CONFIG = {
  enabled: true,
  status: "connected",
  host: "irc.example.com",
  port: 6697,
  nick: "comis",
  tls: true,
  channels: ["#general", "#dev"],
  nickservPassword: "SECRET_NICKSERV",
  allowFrom: [],
};

const WHATSAPP_CONFIG = {
  enabled: true,
  status: "connected",
  authDir: "/var/lib/comis/whatsapp",
  printQR: true,
  allowFrom: [],
};

const LINE_CONFIG = {
  enabled: true,
  status: "connected",
  channelSecret: "SECRET_LINE_CHANNEL",
  webhookPath: "/webhooks/line",
  allowFrom: [],
};

const SIGNAL_CONFIG = {
  enabled: true,
  status: "connected",
  baseUrl: "http://127.0.0.1:8080",
  account: "+15551234567",
  cliPath: "/usr/local/bin/signal-cli",
  allowFrom: [],
};

const IMESSAGE_CONFIG = {
  enabled: false,
  status: "disconnected",
  binaryPath: "/usr/local/bin/imessage",
  account: "user@icloud.com",
  allowFrom: [],
};

const PLATFORM_CONFIGS: Record<string, Record<string, unknown>> = {
  telegram: TELEGRAM_CONFIG,
  discord: DISCORD_CONFIG,
  slack: SLACK_CONFIG,
  irc: IRC_CONFIG,
  whatsapp: WHATSAPP_CONFIG,
  line: LINE_CONFIG,
  signal: SIGNAL_CONFIG,
  imessage: IMESSAGE_CONFIG,
};

/** Creates a mock RPC that dispatches configs by method and params. */
function createDispatchRpcClient(platformConfig: Record<string, unknown>): RpcClient {
  const callMock = vi.fn().mockImplementation((method: string) => {
    if (method === "channels.get") {
      return Promise.resolve(platformConfig);
    }
    if (method === "obs.delivery.recent") {
      return Promise.resolve({ entries: [] });
    }
    if (method === "obs.channels.get") {
      return Promise.resolve({ channel: null });
    }
    return Promise.resolve({});
  });

  return createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
}

// ---- Private accessor ----

function priv(el: IcChannelDetail) {
  return el as unknown as {
    _loadState: "loading" | "loaded" | "error";
    _error: string;
    _config: Record<string, unknown>;
    _enabled: boolean;
    _status: string;
    _deliveryTrace: Array<{ messageId: string; latencyMs: number; timestamp: number; status: string }>;
    _activityData: number[];
    _actionPending: boolean;
    _hasLoaded: boolean;
    apiClient: ApiClient | null;
    rpcClient: RpcClient | null;
    channelType: string;
    _loadData(): Promise<void>;
    _handleRestart(): Promise<void>;
    _handleToggleEnabled(): Promise<void>;
  };
}

// ---- createElement helper ----

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcChannelDetail> {
  const el = document.createElement("ic-channel-detail") as IcChannelDetail;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

// ---- Tests ----

describe("IcChannelDetail", () => {
  let toastShowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    toastShowSpy = vi.spyOn(IcToast, "show").mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("loading and error states", () => {
    it("renders loading state initially", async () => {
      const el = await createElement();
      const loading = el.shadowRoot?.querySelector("ic-loading");
      expect(loading).not.toBeNull();
    });

    it("renders error state on RPC failure", async () => {
      const mockRpc = createMockRpcClient(undefined, {
        call: vi.fn().mockRejectedValue(new Error("Connection refused")),
        status: "connected" as ConnectionStatus,
      });
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const errorMsg = el.shadowRoot?.querySelector(".error-message");
      expect(errorMsg?.textContent).toContain("Connection refused");

      const retryBtn = el.shadowRoot?.querySelector(".retry-btn");
      expect(retryBtn).not.toBeNull();
    });
  });

  describe("breadcrumb navigation", () => {
    it("renders breadcrumb with platform name", async () => {
      const mockRpc = createDispatchRpcClient(TELEGRAM_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const breadcrumb = el.shadowRoot?.querySelector("ic-breadcrumb");
      expect(breadcrumb).not.toBeNull();

      const items = (breadcrumb as unknown as { items: Array<{ label: string; route?: string }> })?.items;
      expect(items).toHaveLength(2);
      expect(items[0].label).toBe("Channels");
      expect(items[0].route).toBe("channels");
      expect(items[1].label).toBe("Telegram");
    });
  });

  describe("platform-specific fields", () => {
    it("renders Telegram-specific fields", async () => {
      const mockRpc = createDispatchRpcClient(TELEGRAM_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot?.querySelectorAll(".field label") ?? []);
      const labelTexts = labels.map((l) => l.textContent);
      expect(labelTexts).toContain("Bot Token");
      expect(labelTexts).toContain("Webhook URL");
      expect(labelTexts).toContain("Ack Reaction");
      expect(labelTexts).toContain("Ack Emoji");
    });

    it("renders Discord-specific fields", async () => {
      const mockRpc = createDispatchRpcClient(DISCORD_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "discord",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot?.querySelectorAll(".field label") ?? []);
      const labelTexts = labels.map((l) => l.textContent);
      expect(labelTexts).toContain("Bot Token");
      expect(labelTexts).toContain("Guild ID");
    });

    it("renders Slack-specific fields with mode select", async () => {
      const mockRpc = createDispatchRpcClient(SLACK_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "slack",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot?.querySelectorAll(".field label") ?? []);
      const labelTexts = labels.map((l) => l.textContent);
      expect(labelTexts).toContain("Bot Token");
      expect(labelTexts).toContain("App Token");
      expect(labelTexts).toContain("Signing Secret");
      expect(labelTexts).toContain("Mode");

      // Verify 3 secret fields are masked
      const secretFields = el.shadowRoot?.querySelectorAll(".field-value.secret");
      expect(secretFields?.length).toBe(3);
    });

    it("renders IRC-specific fields including channels list", async () => {
      const mockRpc = createDispatchRpcClient(IRC_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "irc",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot?.querySelectorAll(".field label") ?? []);
      const labelTexts = labels.map((l) => l.textContent);
      expect(labelTexts).toContain("Host");
      expect(labelTexts).toContain("Port");
      expect(labelTexts).toContain("Nick");
      expect(labelTexts).toContain("TLS");
      expect(labelTexts).toContain("NickServ Password");
      expect(labelTexts).toContain("Channels");

      // Verify the list field shows channels
      const listField = el.shadowRoot?.querySelector(".field-value.list");
      expect(listField?.textContent).toContain("#general");
      expect(listField?.textContent).toContain("#dev");
    });

    it("renders Signal-specific fields", async () => {
      const mockRpc = createDispatchRpcClient(SIGNAL_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "signal",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const labels = Array.from(el.shadowRoot?.querySelectorAll(".field label") ?? []);
      const labelTexts = labels.map((l) => l.textContent);
      expect(labelTexts).toContain("Base URL");
      expect(labelTexts).toContain("Account");
      expect(labelTexts).toContain("CLI Path");
    });
  });

  describe("secret masking", () => {
    it("masks SecretRef values and never shows raw secrets", async () => {
      const mockRpc = createDispatchRpcClient(TELEGRAM_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      // The raw token value must NOT appear in rendered output
      const allText = el.shadowRoot?.innerHTML ?? "";
      expect(allText).not.toContain("SECRET_TOKEN_VALUE");

      // Masked dots should be present
      const secretFields = el.shadowRoot?.querySelectorAll(".field-value.secret");
      expect(secretFields?.length).toBeGreaterThan(0);
      const maskedText = secretFields![0].textContent ?? "";
      expect(maskedText).toContain("\u2022\u2022\u2022\u2022");
    });
  });

  describe("allow-from section", () => {
    it("renders allow-from list with sender IDs", async () => {
      const mockRpc = createDispatchRpcClient(TELEGRAM_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const allowItems = el.shadowRoot?.querySelectorAll(".allow-item");
      expect(allowItems?.length).toBe(1);
      expect(allowItems![0].textContent).toContain("12345");
    });

    it("renders empty allow-from message when no restrictions", async () => {
      const mockRpc = createDispatchRpcClient(DISCORD_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "discord",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const hint = el.shadowRoot?.innerHTML ?? "";
      expect(hint).toContain("all senders allowed");
    });
  });

  describe("delivery trace and activity", () => {
    it("renders delivery trace table with entries", async () => {
      const deliveryEntries = [
        { messageId: "msg-1", latencyMs: 120, timestamp: Date.now() - 60000, status: "delivered" },
        { messageId: "msg-2", latencyMs: 340, timestamp: Date.now() - 120000, status: "failed" },
      ];

      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "channels.get") return Promise.resolve(TELEGRAM_CONFIG);
        if (method === "obs.delivery.recent") return Promise.resolve({ entries: deliveryEntries });
        if (method === "obs.channels.get") return Promise.resolve({ channel: null });
        return Promise.resolve({});
      });

      const mockRpc = createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      // Grid-based trace: each delivery entry renders a row with 3 cells
      const cells = el.shadowRoot?.querySelectorAll('.trace-grid [role="cell"]');
      expect(cells?.length).toBe(6); // 2 rows x 3 cells

      // Check that ic-tag is used for status
      const tags = el.shadowRoot?.querySelectorAll(".trace-grid ic-tag");
      expect(tags?.length).toBe(2);
    });

    it("renders activity sparkline bars from delivery traces", async () => {
      // Generate delivery trace entries spread across multiple hours
      const now = Date.now();
      const deliveryEntries = Array.from({ length: 10 }, (_, i) => ({
        messageId: `msg-${i}`,
        latencyMs: 100 + i * 10,
        timestamp: now - i * 3600000, // spread across hours
        status: "delivered",
      }));

      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "channels.get") return Promise.resolve(TELEGRAM_CONFIG);
        if (method === "obs.delivery.recent") return Promise.resolve({ entries: deliveryEntries });
        if (method === "obs.channels.get") return Promise.resolve({ channel: null });
        return Promise.resolve({});
      });

      const mockRpc = createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const bars = el.shadowRoot?.querySelectorAll(".spark-bar");
      // Sparkline derives 24 buckets from delivery traces
      expect(bars?.length).toBe(24);
    });
  });

  describe("action handlers", () => {
    it("Restart button calls RPC", async () => {
      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "channels.get") return Promise.resolve(TELEGRAM_CONFIG);
        if (method === "obs.delivery.recent") return Promise.resolve({ entries: [] });
        if (method === "obs.channels.get") return Promise.resolve({ channel: null });
        return Promise.resolve({});
      });

      const mockRpc = createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      await priv(el)._handleRestart();

      expect(callMock).toHaveBeenCalledWith("channels.restart", { channel_type: "telegram" });
      expect(toastShowSpy).toHaveBeenCalledWith("Telegram restarted", "success");
    });

    it("Enable/Disable toggle calls correct RPC when enabled", async () => {
      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "channels.get") return Promise.resolve(TELEGRAM_CONFIG);
        if (method === "obs.delivery.recent") return Promise.resolve({ entries: [] });
        if (method === "obs.channels.get") return Promise.resolve({ channel: null });
        return Promise.resolve({});
      });

      const mockRpc = createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      // Config has enabled: true, so toggling should disable
      expect(priv(el)._enabled).toBe(true);
      await priv(el)._handleToggleEnabled();

      expect(callMock).toHaveBeenCalledWith("channels.disable", { channel_type: "telegram" });
      expect(toastShowSpy).toHaveBeenCalledWith("Telegram disabled", "success");
    });

    it("Enable/Disable toggle calls correct RPC when disabled", async () => {
      const callMock = vi.fn().mockImplementation((method: string) => {
        if (method === "channels.get") return Promise.resolve(IMESSAGE_CONFIG);
        if (method === "obs.delivery.recent") return Promise.resolve({ entries: [] });
        if (method === "obs.channels.get") return Promise.resolve({ channel: null });
        return Promise.resolve({});
      });

      const mockRpc = createMockRpcClient(undefined, { call: callMock, status: "connected" as ConnectionStatus });
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "imessage",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      // Config has enabled: false, so toggling should enable
      expect(priv(el)._enabled).toBe(false);
      await priv(el)._handleToggleEnabled();

      expect(callMock).toHaveBeenCalledWith("channels.enable", { channel_type: "imessage" });
      expect(toastShowSpy).toHaveBeenCalledWith("Imessage enabled", "success");
    });
  });

  describe("shared sections rendering", () => {
    it("renders streaming config when present", async () => {
      const configWithStreaming = {
        ...TELEGRAM_CONFIG,
        streaming: { chunkMode: "word", pacingMs: 200, typingMode: "auto" },
      };
      const mockRpc = createDispatchRpcClient(configWithStreaming);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const allText = el.shadowRoot?.innerHTML ?? "";
      expect(allText).toContain("word");
      expect(allText).toContain("200ms");
      expect(allText).toContain("auto");
    });

    it("shows default hint when no streaming config", async () => {
      const mockRpc = createDispatchRpcClient(TELEGRAM_CONFIG);
      const el = await createElement({
        rpcClient: mockRpc,
        channelType: "telegram",
      });
      await priv(el)._loadData();
      await el.updateComplete;

      const allText = el.shadowRoot?.innerHTML ?? "";
      expect(allText).toContain("Default settings");
    });
  });
});
