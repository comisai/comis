import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcAgentEditor } from "./agent-editor.js";
import type { RpcClient } from "../../api/rpc-client.js";

// Side-effect import to register custom element
import "./agent-editor.js";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";

/** Mock RPC response for agents.get -- matches PerAgentConfig shape from backend. */
const mockRpcAgentResponse = {
  agentId: "default",
  config: {
    name: "Comis",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    maxSteps: 25,
    temperature: 0.7,
    thinkingLevel: "medium",
    budgets: { perExecution: 100000, perHour: 500000, perDay: 2000000 },
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60000 },
    contextGuard: { enabled: true, warnPercent: 80, blockPercent: 95 },
    sdkRetry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
    modelFailover: { fallbackModels: [], authProfiles: [], allowedModels: [], maxAttempts: 6, cooldownInitialMs: 60000 },
    rag: { enabled: true, maxResults: 10, maxContextChars: 4000, minScore: 0.5, includeTrustLevels: ["system", "learned"] },
    session: {
      resetPolicy: { mode: "daily", dailyResetHour: 4, dailyResetTimezone: "America/New_York", idleTimeoutMs: 300000 },
    },
    concurrency: { maxConcurrentRuns: 3, maxQueuedPerSession: 5 },
    skills: {
      discoveryPaths: ["/skills"],
      toolPolicy: { profile: "coding", allow: ["bash"], deny: [] },
      builtinTools: { bash: true, file_ops: true, memory_search: false },
    },
  },
};

/** Mock config.read response for system-wide streaming/delivery sections. */
const mockConfigReadResponse = {
  config: {
    streaming: {
      enabled: true,
      defaultChunkMode: "paragraph",
      defaultTypingMode: "thinking",
      defaultDeliveryTiming: { mode: "natural", minMs: 800, maxMs: 2500 },
      defaultCoalescer: { minChars: 0, maxChars: 500, idleMs: 1500 },
    },
    deliveryQueue: {
      enabled: true,
      maxQueueDepth: 10000,
      defaultMaxAttempts: 5,
    },
    deliveryMirror: {
      enabled: true,
      retentionMs: 86400000,
    },
  },
  sections: ["streaming", "deliveryQueue", "deliveryMirror"],
};

/** Agent-editor-specific mock that routes RPC methods to test data. */
function createAgentEditorMockRpcClient(overrides?: Partial<RpcClient>): RpcClient {
  return createMockRpcClient(
    async (method: string) => {
      if (method === "agents.get") return Promise.resolve(mockRpcAgentResponse);
      if (method === "agents.create") return Promise.resolve({ agentId: "new-agent" });
      if (method === "agents.update") return Promise.resolve({ agentId: "default" });
      if (method === "config.validate") return Promise.resolve({ valid: true });
      if (method === "config.read") return Promise.resolve(mockConfigReadResponse);
      if (method === "config.patch") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    },
    overrides,
  );
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
function priv(el: IcAgentEditor) {
  return el as unknown as {
    _loadState: "loading" | "loaded" | "error";
    _saving: boolean;
    _validating: boolean;
    _error: string;
    _validationErrors: string[];
    _validationSuccess: boolean;
    _form: Record<string, unknown>;
    _isNew: boolean;
    _expanded: Set<string>;
    _loadAgent(): Promise<void>;
    _loadTopLevelConfig(): Promise<void>;
    _handleSave(): Promise<void>;
    _handleCancel(): void;
    _handleValidate(): void;
    _updateField(key: string, value: unknown): void;
    _getField<T>(key: string, defaultValue: T): T;
    _buildPayload(): Record<string, unknown>;
    _streamingConfig: Record<string, unknown>;
    _deliveryQueueConfig: Record<string, unknown>;
    _deliveryMirrorConfig: Record<string, unknown>;
    _queueConfig: Record<string, unknown>;
    _autoReplyConfig: Record<string, unknown>;
    _sendPolicyConfig: Record<string, unknown>;
    _logLevelApplied: string;
    rpcClient: RpcClient | null;
    agentId: string;
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcAgentEditor", () => {
  it("Essential section is always visible (not collapsible)", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    // Essential section uses a plain div with .essential-header, not a <details>
    const essential = el.shadowRoot?.querySelector(".essential-header");
    expect(essential).toBeTruthy();
    expect(essential!.textContent).toContain("Essential");

    // It should NOT be inside a <details> element
    const detailsParent = essential!.closest("details");
    expect(detailsParent).toBeNull();

    // Essential content should be visible
    const content = el.shadowRoot?.querySelector(".essential-content");
    expect(content).toBeTruthy();
  });

  it("accordion sections expand/collapse via details elements", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    // Should have 12 collapsible sections: budget, session, skills, heartbeat, advanced,
    // context engine, streaming, delivery, queue, auto-reply, send policy, log levels
    const detailsElements = el.shadowRoot?.querySelectorAll("details");
    expect(detailsElements).toBeTruthy();
    expect(detailsElements!.length).toBe(12);

    const summaryTexts = Array.from(detailsElements!).map(
      (d) => d.querySelector("summary")?.textContent?.trim(),
    );
    expect(summaryTexts).toContain("Budget");
    expect(summaryTexts).toContain("Session Policy");
    expect(summaryTexts).toContain("Skills");
    expect(summaryTexts).toContain("Heartbeat");
    expect(summaryTexts).toContain("Advanced");
    expect(summaryTexts).toContain("Context Engine");
    expect(summaryTexts).toContain("Streaming (System-Wide)");
    expect(summaryTexts).toContain("Delivery (System-Wide)");
    expect(summaryTexts).toContain("Queue / Overflow (System-Wide)");
    expect(summaryTexts).toContain("Auto-Reply (System-Wide)");
    expect(summaryTexts).toContain("Send Policy (System-Wide)");
    expect(summaryTexts).toContain("Log Levels (Runtime)");
  });

  it("form fields update _form state", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    priv(el)._updateField("name", "TestBot");
    priv(el)._updateField("model", "gpt-4o");
    priv(el)._updateField("temperature", 0.8);

    expect(priv(el)._form.name).toBe("TestBot");
    expect(priv(el)._form.model).toBe("gpt-4o");
    expect(priv(el)._form.temperature).toBe(0.8);
  });

  it("YAML preview updates when form fields change", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    // Set some fields
    priv(el)._updateField("name", "MyAgent");
    priv(el)._updateField("model", "claude-sonnet-4-5");
    priv(el)._updateField("provider", "anthropic");
    await el.updateComplete;

    const yamlPre = el.shadowRoot?.querySelector(".yaml-preview");
    expect(yamlPre).toBeTruthy();

    const yamlText = yamlPre!.textContent!;
    expect(yamlText).toContain("name: MyAgent");
    expect(yamlText).toContain("model: claude-sonnet-4-5");
    expect(yamlText).toContain("provider: anthropic");
  });

  it("Validate button checks required fields", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    // Validate without filling required fields
    priv(el)._handleValidate();
    await el.updateComplete;

    expect(priv(el)._validationErrors.length).toBeGreaterThan(0);
    expect(priv(el)._validationErrors.some((e) => e.includes("Agent ID"))).toBe(true);
    expect(priv(el)._validationSuccess).toBe(false);

    // Fill required fields and validate again
    priv(el)._updateField("id", "test-agent");
    priv(el)._updateField("model", "gpt-4o");
    priv(el)._handleValidate();
    await el.updateComplete;

    expect(priv(el)._validationErrors.length).toBe(0);
    expect(priv(el)._validationSuccess).toBe(true);
  });

  it("Save button calls agents.create for new agent", async () => {
    const rpc = createAgentEditorMockRpcClient();
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
      rpcClient: rpc,
    });

    // Fill in required fields
    priv(el)._updateField("id", "test-agent");
    priv(el)._updateField("model", "claude-sonnet-4-5");
    await el.updateComplete;

    const navigateHandler = vi.fn();
    el.addEventListener("navigate", navigateHandler);

    await priv(el)._handleSave();
    await el.updateComplete;

    expect(rpc.call).toHaveBeenCalledWith(
      "agents.create",
      expect.objectContaining({ agentId: "test-agent", config: expect.objectContaining({ model: "claude-sonnet-4-5" }) }),
    );
  });

  it("Save button calls agents.update for existing agent", async () => {
    const rpc = createAgentEditorMockRpcClient();
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "default",
      rpcClient: rpc,
    });

    await priv(el)._loadAgent();
    await el.updateComplete;

    // Modify a field
    priv(el)._updateField("name", "Updated Name");
    await el.updateComplete;

    await priv(el)._handleSave();
    await el.updateComplete;

    expect(rpc.call).toHaveBeenCalledWith(
      "agents.update",
      expect.objectContaining({ agentId: "default", config: expect.objectContaining({ name: "Updated Name" }) }),
    );
  });

  it("sticky save bar is rendered", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    const saveBar = el.shadowRoot?.querySelector(".save-bar");
    expect(saveBar).toBeTruthy();

    // Check for Validate and Save buttons
    const buttons = saveBar!.querySelectorAll("button");
    const buttonTexts = Array.from(buttons).map((b) => b.textContent?.trim());
    expect(buttonTexts).toContain("Validate");
    expect(buttonTexts).toContain("Save");
    expect(buttonTexts).toContain("Cancel");

    // Check sticky positioning is in styles
    const styles = (el.constructor as typeof LitElement).styles;
    const cssText = Array.isArray(styles)
      ? styles.map((s) => (s as any).cssText || "").join("")
      : (styles as any)?.cssText || "";
    expect(cssText).toContain("position: sticky");
    expect(cssText).toContain("bottom: 0");
  });

  it('shows "Create Agent" title when agentId is "new"', async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    const title = el.shadowRoot?.querySelector(".title");
    expect(title).toBeTruthy();
    expect(title!.textContent).toContain("Create Agent");
  });

  it('shows "Edit Agent" title when agentId is an existing ID', async () => {
    const rpc = createAgentEditorMockRpcClient();
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "default",
      rpcClient: rpc,
    });

    await priv(el)._loadAgent();
    await el.updateComplete;

    const title = el.shadowRoot?.querySelector(".title");
    expect(title).toBeTruthy();
    expect(title!.textContent).toContain("Edit Agent");
    expect(title!.textContent).toContain("default");
  });

  it("loads existing agent data in edit mode", async () => {
    const rpc = createAgentEditorMockRpcClient();
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "default",
      rpcClient: rpc,
    });

    await priv(el)._loadAgent();
    await el.updateComplete;

    expect(rpc.call).toHaveBeenCalledWith("agents.get", { agentId: "default" });
    expect(priv(el)._form.name).toBe("Comis");
    expect(priv(el)._form.model).toBe("claude-sonnet-4-5");
    expect(priv(el)._form.provider).toBe("anthropic");
    expect(priv(el)._form["budgets.perExecution"]).toBe(100000);
    expect(priv(el)._form["budgets.perHour"]).toBe(500000);
    expect(priv(el)._form["budgets.perDay"]).toBe(2000000);
  });

  it("Cancel button dispatches navigate event", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    priv(el)._handleCancel();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("agents");
  });

  it("Cancel navigates to agent detail when editing", async () => {
    const rpc = createAgentEditorMockRpcClient();
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "default",
      rpcClient: rpc,
    });

    await priv(el)._loadAgent();
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    priv(el)._handleCancel();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("agents/default");
  });

  it("shows loading state while fetching in edit mode", async () => {
    const rpc = createMockRpcClient(undefined, {
      call: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });

    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "default",
      rpcClient: rpc,
    });

    const loading = el.shadowRoot?.querySelector("ic-loading");
    expect(loading).toBeTruthy();
  });

  it("_buildPayload reconstructs nested object from flat form", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    priv(el)._updateField("name", "TestBot");
    priv(el)._updateField("model", "gpt-4o");
    priv(el)._updateField("budgets.perExecution", 50000);
    priv(el)._updateField("advanced.rag.enabled", true);
    priv(el)._updateField("advanced.concurrency.maxConcurrent", 3);

    const payload = priv(el)._buildPayload();

    expect(payload.name).toBe("TestBot");
    expect(payload.model).toBe("gpt-4o");
    expect((payload.budgets as Record<string, unknown>)?.perExecution).toBe(50000);
    expect((payload.rag as Record<string, unknown>)?.enabled).toBe(true);
    expect((payload.concurrency as Record<string, unknown>)?.maxConcurrentRuns).toBe(3);
  });

  describe("Heartbeat section", () => {
    it("populates heartbeat form fields from agent config", async () => {
      const rpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation((method: string) => {
          if (method === "agents.get") {
            return Promise.resolve({
              agentId: "hb-agent",
              config: {
                ...mockRpcAgentResponse.config,
                scheduler: {
                  heartbeat: {
                    enabled: true,
                    intervalMs: 900000,
                    model: "gpt-4o",
                    prompt: "Check system health",
                    target: {
                      channelType: "telegram",
                      channelId: "chan-123",
                      chatId: "chat-456",
                    },
                  },
                },
              },
            });
          }
          return Promise.resolve({});
        }),
      });
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "hb-agent",
        rpcClient: rpc,
      });

      await priv(el)._loadAgent();
      await el.updateComplete;

      expect(priv(el)._form["heartbeat.enabled"]).toBe(true);
      expect(priv(el)._form["heartbeat.intervalMs"]).toBe(900000);
      expect(priv(el)._form["heartbeat.model"]).toBe("gpt-4o");
      expect(priv(el)._form["heartbeat.prompt"]).toBe("Check system health");
      expect(priv(el)._form["heartbeat.target.channelType"]).toBe("telegram");
      expect(priv(el)._form["heartbeat.target.channelId"]).toBe("chan-123");
      expect(priv(el)._form["heartbeat.target.chatId"]).toBe("chat-456");
    });

    it("builds correct scheduler.heartbeat payload from form", async () => {
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
      });

      priv(el)._updateField("heartbeat.enabled", true);
      priv(el)._updateField("heartbeat.intervalMs", 600000);
      priv(el)._updateField("heartbeat.model", "gpt-4o");
      priv(el)._updateField("heartbeat.target.channelType", "discord");
      priv(el)._updateField("heartbeat.target.channelId", "ch-1");
      priv(el)._updateField("heartbeat.target.chatId", "chat-1");

      const payload = priv(el)._buildPayload();
      const sched = payload.scheduler as Record<string, unknown>;
      expect(sched).toBeTruthy();
      const hb = sched.heartbeat as Record<string, unknown>;
      expect(hb.enabled).toBe(true);
      expect(hb.intervalMs).toBe(600000);
      expect(hb.model).toBe("gpt-4o");
      const target = hb.target as Record<string, unknown>;
      expect(target.channelType).toBe("discord");
      expect(target.channelId).toBe("ch-1");
      expect(target.chatId).toBe("chat-1");
    });

    it("omits scheduler.heartbeat from payload when all fields empty", async () => {
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
      });

      const payload = priv(el)._buildPayload();
      expect(payload.scheduler).toBeUndefined();
    });

    it("omits target from heartbeat payload when target fields empty", async () => {
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
      });

      priv(el)._updateField("heartbeat.enabled", true);

      const payload = priv(el)._buildPayload();
      const sched = payload.scheduler as Record<string, unknown>;
      expect(sched).toBeTruthy();
      const hb = sched.heartbeat as Record<string, unknown>;
      expect(hb.enabled).toBe(true);
      expect(hb.target).toBeUndefined();
    });
  });

  it("shows error when saving without required fields in create mode", async () => {
    const rpc = createAgentEditorMockRpcClient();
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
      rpcClient: rpc,
    });

    // Try to save without setting id
    await priv(el)._handleSave();
    await el.updateComplete;

    expect(priv(el)._error).toBe("Agent ID is required");
    // agents.create should NOT have been called
    expect(rpc.call).not.toHaveBeenCalledWith("agents.create", expect.anything());
  });

  it("YAML preview panel is a read-only pre element", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    const yamlPre = el.shadowRoot?.querySelector("pre.yaml-preview");
    expect(yamlPre).toBeTruthy();
    // Pre element should not be contenteditable
    expect(yamlPre!.getAttribute("contenteditable")).toBeNull();
  });

  it("editor layout uses grid with form and yaml panels", async () => {
    const el = await createElement<IcAgentEditor>("ic-agent-editor", {
      agentId: "new",
    });

    const layout = el.shadowRoot?.querySelector(".editor-layout");
    expect(layout).toBeTruthy();

    const formPanel = el.shadowRoot?.querySelector(".form-panel");
    const yamlPanel = el.shadowRoot?.querySelector(".yaml-panel");
    expect(formPanel).toBeTruthy();
    expect(yamlPanel).toBeTruthy();
  });

  describe("Context Engine section", () => {
    it("context engine sub-component is rendered", async () => {
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
      });

      const ceEditor = el.shadowRoot!.querySelector("ic-agent-context-engine-editor");
      expect(ceEditor).toBeTruthy();
    });

    it("context engine fields round-trip through _populateForm -> _buildPayload (DAG mode)", async () => {
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
      });

      // Set context engine fields for DAG mode
      priv(el)._updateField("contextEngine.enabled", true);
      priv(el)._updateField("contextEngine.version", "dag");
      priv(el)._updateField("contextEngine.freshTailTurns", 5);
      priv(el)._updateField("contextEngine.thinkingKeepTurns", 12);
      priv(el)._updateField("contextEngine.compactionModel", "anthropic:claude-haiku-4-5-20250929");

      const payload = priv(el)._buildPayload();
      const ce = payload.contextEngine as Record<string, unknown>;

      expect(ce).toBeTruthy();
      expect(ce.enabled).toBe(true);
      expect(ce.version).toBe("dag");
      expect(ce.freshTailTurns).toBe(5);
      expect(ce.thinkingKeepTurns).toBe(12);
      expect(ce.compactionModel).toBe("anthropic:claude-haiku-4-5-20250929");
    });

    it("_buildPayload only includes pipeline fields when version is pipeline", async () => {
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
      });

      priv(el)._updateField("contextEngine.version", "pipeline");
      priv(el)._updateField("contextEngine.historyTurns", 20);
      priv(el)._updateField("contextEngine.freshTailTurns", 5); // DAG field -- should be excluded

      const payload = priv(el)._buildPayload();
      const ce = payload.contextEngine as Record<string, unknown>;

      expect(ce).toBeTruthy();
      expect(ce.historyTurns).toBe(20);
      expect(ce.freshTailTurns).toBeUndefined();
    });

    it("populates context engine fields from agent config", async () => {
      const rpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation((method: string) => {
          if (method === "agents.get") {
            return Promise.resolve({
              agentId: "ce-agent",
              config: {
                ...mockRpcAgentResponse.config,
                contextEngine: {
                  enabled: true,
                  version: "dag",
                  freshTailTurns: 10,
                  contextThreshold: 0.8,
                  thinkingKeepTurns: 15,
                },
              },
            });
          }
          if (method === "config.read") return Promise.resolve(mockConfigReadResponse);
          return Promise.resolve({});
        }),
      });
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "ce-agent",
        rpcClient: rpc,
      });

      await priv(el)._loadAgent();
      await el.updateComplete;

      expect(priv(el)._form["contextEngine.enabled"]).toBe(true);
      expect(priv(el)._form["contextEngine.version"]).toBe("dag");
      expect(priv(el)._form["contextEngine.freshTailTurns"]).toBe(10);
      expect(priv(el)._form["contextEngine.contextThreshold"]).toBe(0.8);
      expect(priv(el)._form["contextEngine.thinkingKeepTurns"]).toBe(15);
    });
  });

  describe("System-wide config (streaming/delivery)", () => {
    it("_loadTopLevelConfig calls config.read and populates streaming/delivery state", async () => {
      const rpc = createAgentEditorMockRpcClient();
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "default",
        rpcClient: rpc,
      });

      await priv(el)._loadTopLevelConfig();
      await el.updateComplete;

      expect(rpc.call).toHaveBeenCalledWith("config.read");
      expect(priv(el)._streamingConfig).toEqual(mockConfigReadResponse.config.streaming);
      expect(priv(el)._deliveryQueueConfig).toEqual(mockConfigReadResponse.config.deliveryQueue);
      expect(priv(el)._deliveryMirrorConfig).toEqual(mockConfigReadResponse.config.deliveryMirror);
    });

    it("renders streaming sub-editor component", async () => {
      const rpc = createAgentEditorMockRpcClient();
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
        rpcClient: rpc,
      });

      await priv(el)._loadTopLevelConfig();
      await el.updateComplete;

      const streamingEditor = el.shadowRoot!.querySelector("ic-agent-streaming-editor");
      expect(streamingEditor).toBeTruthy();
    });

    it("renders delivery sub-editor component", async () => {
      const rpc = createAgentEditorMockRpcClient();
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
        rpcClient: rpc,
      });

      await priv(el)._loadTopLevelConfig();
      await el.updateComplete;

      const deliveryEditor = el.shadowRoot!.querySelector("ic-agent-delivery-editor");
      expect(deliveryEditor).toBeTruthy();
    });

    it("config-change event calls config.patch with correct section/key/value", async () => {
      const rpc = createAgentEditorMockRpcClient();
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
        rpcClient: rpc,
      });

      await priv(el)._loadTopLevelConfig();
      await el.updateComplete;

      // Simulate a config-change event from the streaming editor
      const streamingEditor = el.shadowRoot!.querySelector("ic-agent-streaming-editor")!;
      streamingEditor.dispatchEvent(
        new CustomEvent("config-change", {
          detail: { section: "streaming", key: "enabled", value: false },
          bubbles: true,
          composed: true,
        }),
      );

      // Wait for the async handler
      await new Promise((r) => setTimeout(r, 50));

      expect(rpc.call).toHaveBeenCalledWith("config.patch", {
        section: "streaming",
        key: "enabled",
        value: false,
      });

      // Verify local state was updated
      expect(priv(el)._streamingConfig.enabled).toBe(false);
    });

    it("config-change for deliveryQueue updates deliveryQueue state", async () => {
      const rpc = createAgentEditorMockRpcClient();
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
        rpcClient: rpc,
      });

      await priv(el)._loadTopLevelConfig();
      await el.updateComplete;

      const deliveryEditor = el.shadowRoot!.querySelector("ic-agent-delivery-editor")!;
      deliveryEditor.dispatchEvent(
        new CustomEvent("config-change", {
          detail: { section: "deliveryQueue", key: "maxQueueDepth", value: 5000 },
          bubbles: true,
          composed: true,
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(rpc.call).toHaveBeenCalledWith("config.patch", {
        section: "deliveryQueue",
        key: "maxQueueDepth",
        value: 5000,
      });

      expect(priv(el)._deliveryQueueConfig.maxQueueDepth).toBe(5000);
    });
  });

  describe("Queue, Auto-Reply, Send Policy editors (System-Wide)", () => {
    it("_loadTopLevelConfig populates queue, autoReply, sendPolicy from config.read", async () => {
      const rpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation((method: string) => {
          if (method === "config.read") {
            return Promise.resolve({
              config: {
                queue: { enabled: true, maxConcurrentSessions: 10 },
                autoReplyEngine: { enabled: false, groupActivation: "mention-gated" },
                sendPolicy: { enabled: true, defaultAction: "allow", rules: [] },
              },
              sections: [],
            });
          }
          if (method === "agents.get") return Promise.resolve(mockRpcAgentResponse);
          return Promise.resolve({});
        }),
      });
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
        rpcClient: rpc,
      });

      await priv(el)._loadTopLevelConfig();
      await el.updateComplete;

      expect(priv(el)._queueConfig.enabled).toBe(true);
      expect(priv(el)._queueConfig.maxConcurrentSessions).toBe(10);
      expect(priv(el)._autoReplyConfig.enabled).toBe(false);
      expect(priv(el)._autoReplyConfig.groupActivation).toBe("mention-gated");
      expect(priv(el)._sendPolicyConfig.enabled).toBe(true);
      expect(priv(el)._sendPolicyConfig.defaultAction).toBe("allow");
    });

    it("renders all 4 new sub-components", async () => {
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
      });

      expect(el.shadowRoot!.querySelector("ic-agent-queue-editor")).toBeTruthy();
      expect(el.shadowRoot!.querySelector("ic-agent-auto-reply-editor")).toBeTruthy();
      expect(el.shadowRoot!.querySelector("ic-agent-send-policy-editor")).toBeTruthy();
      expect(el.shadowRoot!.querySelector("ic-agent-log-level-editor")).toBeTruthy();
    });
  });

  describe("Log Level editor (Runtime)", () => {
    it("_handleLogLevelChange calls daemon.setLogLevel RPC", async () => {
      const rpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation((method: string) => {
          if (method === "daemon.setLogLevel") return Promise.resolve({});
          if (method === "agents.get") return Promise.resolve(mockRpcAgentResponse);
          if (method === "config.read") return Promise.resolve({ config: {}, sections: [] });
          return Promise.resolve({});
        }),
      });
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
        rpcClient: rpc,
      });

      await el.updateComplete;

      // Dispatch log-level-change event from the log level editor
      const logEditor = el.shadowRoot!.querySelector("ic-agent-log-level-editor")!;
      logEditor.dispatchEvent(
        new CustomEvent("log-level-change", {
          detail: { module: "agent", level: "debug" },
          bubbles: true,
          composed: true,
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(rpc.call).toHaveBeenCalledWith("daemon.setLogLevel", {
        level: "debug",
        module: "agent",
      });
    });

    it("_handleLogLevelChange sets _logLevelApplied on success", async () => {
      const rpc = createMockRpcClient(undefined, {
        call: vi.fn().mockImplementation((method: string) => {
          if (method === "daemon.setLogLevel") return Promise.resolve({});
          if (method === "config.read") return Promise.resolve({ config: {}, sections: [] });
          return Promise.resolve({});
        }),
      });
      const el = await createElement<IcAgentEditor>("ic-agent-editor", {
        agentId: "new",
        rpcClient: rpc,
      });

      await el.updateComplete;

      const logEditor = el.shadowRoot!.querySelector("ic-agent-log-level-editor")!;
      logEditor.dispatchEvent(
        new CustomEvent("log-level-change", {
          detail: { level: "warn" },
          bubbles: true,
          composed: true,
        }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(rpc.call).toHaveBeenCalledWith("daemon.setLogLevel", { level: "warn" });
      expect(priv(el)._logLevelApplied).toBe("__global__");
    });
  });
});
