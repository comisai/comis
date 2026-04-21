// SPDX-License-Identifier: Apache-2.0
/**
 * CADPT: Custom Adapter Contract & Capability Validation
 *
 * Integration tests validating the custom adapter contract:
 * - ChannelPort interface compliance (all 10 methods with Result<T,E> return types)
 * - Unsupported operation handling (editMessage returning err())
 * - ChannelCapabilitySchema strict Zod validation
 * - ChannelPluginPort lifecycle (register -> activate -> deactivate)
 * - Plugin hook registration via PluginRegistryApi.registerHook()
 * - Factory function pattern validation (createEchoPlugin shape)
 */

import { describe, it, expect } from "vitest";
import { ok, err } from "@comis/shared";
import type {
  ChannelPort,
  MessageHandler,
  ChannelStatus,
  AttachmentPayload,
  NormalizedMessage,
  ChannelPluginPort,
  ChannelCapability,
  PluginRegistryApi,
  HookHandlerMap,
} from "@comis/core";
import {
  NormalizedMessageSchema,
  ChannelCapabilitySchema,
  TypedEventBus,
  createPluginRegistry,
} from "@comis/core";
import { createEchoPlugin, createChannelRegistry } from "@comis/channels";
import type { Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Custom adapter factory (closure-based, not class -- per decision 102-02)
// ---------------------------------------------------------------------------

interface CustomAdapterOptions {
  channelId: string;
  channelType: string;
}

function createCustomAdapter(options: CustomAdapterOptions): ChannelPort & {
  getStatus(): ChannelStatus;
  injectMessage(msg: NormalizedMessage): Promise<void>;
} {
  const { channelId, channelType } = options;
  let running = false;
  let messageCounter = 0;
  const handlers: MessageHandler[] = [];

  return {
    channelId,
    channelType,

    async start(): Promise<Result<void, Error>> {
      running = true;
      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      running = false;
      return ok(undefined);
    },

    async sendMessage(
      _channelId: string,
      _text: string,
      _options?: unknown,
    ): Promise<Result<string, Error>> {
      return ok(`custom-msg-${messageCounter++}`);
    },

    async editMessage(
      _channelId: string,
      _messageId: string,
      _text: string,
    ): Promise<Result<void, Error>> {
      return err(new Error("Edit not supported on custom platform"));
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    async reactToMessage(
      _channelId: string,
      _messageId: string,
      _emoji: string,
    ): Promise<Result<void, Error>> {
      return err(new Error("Reactions not supported"));
    },

    async deleteMessage(
      _channelId: string,
      _messageId: string,
    ): Promise<Result<void, Error>> {
      return ok(undefined);
    },

    async fetchMessages(
      _channelId: string,
      _options?: unknown,
    ): Promise<Result<unknown[], Error>> {
      return ok([]);
    },

    async sendAttachment(
      _channelId: string,
      _attachment: AttachmentPayload,
      _options?: unknown,
    ): Promise<Result<string, Error>> {
      return ok(`custom-attach-${messageCounter++}`);
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      return ok({ action, params, echoed: true });
    },

    getStatus(): ChannelStatus {
      return {
        connected: running,
        channelId,
        channelType,
      };
    },

    async injectMessage(msg: NormalizedMessage): Promise<void> {
      for (const handler of handlers) {
        await handler(msg);
      }
    },
  };
}

/**
 * Full-feature adapter: all operations supported (editMessage, reactToMessage return ok).
 */
function createFullFeatureAdapter(options: CustomAdapterOptions): ChannelPort {
  const base = createCustomAdapter(options);
  return {
    ...base,
    async editMessage(
      _channelId: string,
      _messageId: string,
      _text: string,
    ): Promise<Result<void, Error>> {
      return ok(undefined);
    },
    async reactToMessage(
      _channelId: string,
      _messageId: string,
      _emoji: string,
    ): Promise<Result<void, Error>> {
      return ok(undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CADPT: Custom Adapter Contract & Capability Validation", () => {
  // ── ChannelPort contract ─────────────────────────────────────────────

  describe("ChannelPort contract (CADPT-01 through CADPT-04)", () => {
    it("CADPT-01: custom adapter start() and stop() return ok Results and toggle running state", async () => {
      const adapter = createCustomAdapter({
        channelId: "test-01",
        channelType: "custom",
      });

      // start() returns ok
      const startResult = await adapter.start();
      expect(startResult.ok).toBe(true);
      expect(adapter.getStatus().connected).toBe(true);

      // stop() returns ok
      const stopResult = await adapter.stop();
      expect(stopResult.ok).toBe(true);
      expect(adapter.getStatus().connected).toBe(false);
    });

    it("CADPT-02: all 10 ChannelPort methods exist and have correct signatures", () => {
      const adapter = createCustomAdapter({
        channelId: "test-02",
        channelType: "custom",
      });

      const methodNames = [
        "start",
        "stop",
        "sendMessage",
        "editMessage",
        "onMessage",
        "reactToMessage",
        "deleteMessage",
        "fetchMessages",
        "sendAttachment",
        "platformAction",
      ] as const;

      for (const name of methodNames) {
        expect(typeof adapter[name]).toBe("function");
      }

      // Verify channelId and channelType are readonly strings
      expect(typeof adapter.channelId).toBe("string");
      expect(adapter.channelId).toBe("test-02");
      expect(typeof adapter.channelType).toBe("string");
      expect(adapter.channelType).toBe("custom");
    });

    it("CADPT-03: sendMessage returns ok(string) with message ID, sendAttachment returns ok(string)", async () => {
      const adapter = createCustomAdapter({
        channelId: "test-03",
        channelType: "custom",
      });

      // sendMessage returns ok(string)
      const msg1 = await adapter.sendMessage("ch-1", "hello");
      expect(msg1.ok).toBe(true);
      if (msg1.ok) {
        expect(typeof msg1.value).toBe("string");
      }

      // sendAttachment returns ok(string)
      const attachment: AttachmentPayload = {
        type: "image",
        url: "https://example.com/image.png",
        mimeType: "image/png",
        fileName: "image.png",
      };
      const attach1 = await adapter.sendAttachment("ch-1", attachment);
      expect(attach1.ok).toBe(true);
      if (attach1.ok) {
        expect(typeof attach1.value).toBe("string");
      }

      // Message IDs are unique
      const msg2 = await adapter.sendMessage("ch-1", "world");
      if (msg1.ok && msg2.ok) {
        expect(msg1.value).not.toBe(msg2.value);
      }
    });

    it("CADPT-04: unsupported editMessage returns err(), unsupported reactToMessage returns err()", async () => {
      const adapter = createCustomAdapter({
        channelId: "test-04",
        channelType: "custom",
      });

      // editMessage on custom adapter returns err
      const editResult = await adapter.editMessage("ch-1", "msg-1", "new text");
      expect(editResult.ok).toBe(false);
      if (!editResult.ok) {
        expect(editResult.error.message).toContain("not supported");
      }

      // reactToMessage on custom adapter returns err
      const reactResult = await adapter.reactToMessage("ch-1", "msg-1", "thumbs_up");
      expect(reactResult.ok).toBe(false);
      if (!reactResult.ok) {
        expect(reactResult.error.message).toContain("not supported");
      }

      // Contrast: full-feature adapter editMessage returns ok
      const fullAdapter = createFullFeatureAdapter({
        channelId: "test-04-full",
        channelType: "custom-full",
      });
      const fullEditResult = await fullAdapter.editMessage("ch-1", "msg-1", "new text");
      expect(fullEditResult.ok).toBe(true);
    });
  });

  // ── NormalizedMessage shape compliance ────────────────────────────────

  describe("NormalizedMessage shape compliance (CADPT-05)", () => {
    it("CADPT-05: onMessage handler receives NormalizedMessage-shaped objects", async () => {
      const adapter = createCustomAdapter({
        channelId: "test-05",
        channelType: "custom-msg",
      });

      let receivedMessage: NormalizedMessage | undefined;

      adapter.onMessage((msg) => {
        receivedMessage = msg;
      });

      const testMessage: NormalizedMessage = {
        id: crypto.randomUUID(),
        channelId: "test-05",
        channelType: "custom-msg",
        senderId: "user-123",
        text: "Hello, world!",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      };

      // Verify the message matches NormalizedMessage schema via Zod parse
      const parsed = NormalizedMessageSchema.parse(testMessage);
      expect(parsed.id).toBe(testMessage.id);
      expect(parsed.channelId).toBe(testMessage.channelId);
      expect(parsed.senderId).toBe(testMessage.senderId);
      expect(parsed.text).toBe(testMessage.text);

      // Simulate invoking the stored handler
      await adapter.injectMessage(testMessage);

      // Verify handler received the message
      expect(receivedMessage).toBeDefined();
      expect(receivedMessage!.id).toBe(testMessage.id);
      expect(receivedMessage!.text).toBe("Hello, world!");
    });
  });

  // ── Factory function pattern ──────────────────────────────────────────

  describe("factory function pattern (CADPT-06, CADPT-07)", () => {
    it("CADPT-06: createEchoPlugin() returns ChannelPluginPort with correct shape", () => {
      const plugin = createEchoPlugin();

      // Plugin identity
      expect(plugin.id).toBe("channel-echo");
      expect(plugin.name).toBe("Echo Channel Plugin");
      expect(plugin.version).toBe("1.0.0");

      // Channel type
      expect(plugin.channelType).toBe("echo");

      // Capabilities
      expect(plugin.capabilities.chatTypes).toContain("dm");
      expect(plugin.capabilities.limits.maxMessageChars).toBe(10000);

      // Adapter
      expect(plugin.adapter).toBeDefined();
      expect(plugin.adapter.channelType).toBe("echo");

      // Lifecycle methods
      expect(typeof plugin.register).toBe("function");
      expect(typeof plugin.activate).toBe("function");
      expect(typeof plugin.deactivate).toBe("function");
    });

    it("CADPT-07: createEchoPlugin() with custom options overrides channelId and channelType", () => {
      const plugin = createEchoPlugin({
        channelId: "my-echo",
        channelType: "echo-custom",
      });

      // Adapter should reflect custom options
      expect(plugin.adapter.channelId).toBe("my-echo");
      expect(plugin.adapter.channelType).toBe("echo-custom");

      // Plugin channelType uses adapter.channelType
      expect(plugin.channelType).toBe("echo-custom");
    });
  });

  // ── ChannelCapabilitySchema validation ────────────────────────────────

  describe("ChannelCapabilitySchema validation (CADPT-08 through CADPT-12)", () => {
    it("CADPT-08: valid capabilities pass schema validation with all fields", () => {
      const capabilities = {
        chatTypes: ["dm", "group"] as const,
        features: {
          reactions: true,
          editMessages: true,
          deleteMessages: true,
          fetchHistory: true,
          attachments: true,
          threads: true,
          mentions: true,
          formatting: ["markdown", "html"],
        },
        limits: {
          maxMessageChars: 4096,
          maxAttachmentSizeMb: 25,
        },
        streaming: {
          supported: true,
          method: "edit" as const,
          throttleMs: 200,
        },
        threading: {
          supported: true,
          threadType: "native" as const,
          maxDepth: 10,
        },
      };

      const parsed = ChannelCapabilitySchema.parse(capabilities);
      expect(parsed.chatTypes).toEqual(["dm", "group"]);
      expect(parsed.features.reactions).toBe(true);
      expect(parsed.features.editMessages).toBe(true);
      expect(parsed.limits.maxMessageChars).toBe(4096);
      expect(parsed.streaming.supported).toBe(true);
      expect(parsed.streaming.method).toBe("edit");
      expect(parsed.streaming.throttleMs).toBe(200);
      expect(parsed.threading.supported).toBe(true);
      expect(parsed.threading.threadType).toBe("native");
      expect(parsed.threading.maxDepth).toBe(10);
    });

    it("CADPT-09: capabilities with only required fields pass validation (defaults applied)", () => {
      const minimal = {
        chatTypes: ["dm"] as const,
        limits: { maxMessageChars: 2000 },
      };

      const parsed = ChannelCapabilitySchema.parse(minimal);

      // Defaults applied for features
      expect(parsed.features.reactions).toBe(false);
      expect(parsed.features.editMessages).toBe(false);
      expect(parsed.features.deleteMessages).toBe(false);
      expect(parsed.features.fetchHistory).toBe(false);
      expect(parsed.features.attachments).toBe(false);
      expect(parsed.features.threads).toBe(false);
      expect(parsed.features.mentions).toBe(false);
      expect(parsed.features.formatting).toEqual([]);

      // Defaults applied for streaming
      expect(parsed.streaming.supported).toBe(false);
      expect(parsed.streaming.throttleMs).toBe(300);
      expect(parsed.streaming.method).toBe("none");

      // Defaults applied for threading
      expect(parsed.threading.supported).toBe(false);
      expect(parsed.threading.threadType).toBe("none");
    });

    it("CADPT-10: missing chatTypes rejects validation", () => {
      const invalid = {
        limits: { maxMessageChars: 4096 },
      };

      expect(() => ChannelCapabilitySchema.parse(invalid)).toThrow();
    });

    it("CADPT-11: missing maxMessageChars rejects validation", () => {
      const invalid = {
        chatTypes: ["dm"],
        limits: {},
      };

      expect(() => ChannelCapabilitySchema.parse(invalid)).toThrow();
    });

    it("CADPT-12: extra unknown keys rejected by strictObject", () => {
      const withExtraKey = {
        chatTypes: ["dm"],
        limits: { maxMessageChars: 4096 },
        unknownField: true,
      };

      expect(() => ChannelCapabilitySchema.parse(withExtraKey)).toThrow(
        /unrecognized/i,
      );
    });
  });

  // ── ChannelPluginPort lifecycle ───────────────────────────────────────

  describe("ChannelPluginPort lifecycle (CADPT-13 through CADPT-15)", () => {
    /**
     * Setup helper: creates fresh eventBus, pluginRegistry, and channelRegistry
     * per test group. Uses real TypedEventBus instances per decision 107-01.
     */
    function setup() {
      const eventBus = new TypedEventBus();
      const pluginRegistry = createPluginRegistry({ eventBus });
      const channelRegistry = createChannelRegistry({ pluginRegistry, eventBus });
      return { eventBus, pluginRegistry, channelRegistry };
    }

    /**
     * Create a custom ChannelPluginPort for lifecycle testing.
     */
    function createCustomPlugin(opts: {
      channelType: string;
      id?: string;
      capabilities?: ChannelCapability;
      registerFn?: (api: PluginRegistryApi) => Result<void, Error>;
    }): ChannelPluginPort {
      const adapter = createCustomAdapter({
        channelId: `${opts.channelType}-adapter`,
        channelType: opts.channelType,
      });

      const lifecycleLog: string[] = [];

      const capabilities: ChannelCapability = opts.capabilities ?? {
        chatTypes: ["dm"],
        features: {
          reactions: false,
          editMessages: false,
          deleteMessages: false,
          fetchHistory: false,
          attachments: false,
          threads: false,
          mentions: false,
          formatting: [],
        },
        limits: { maxMessageChars: 5000 },
        streaming: { supported: false, throttleMs: 300, method: "none" as const },
        threading: { supported: false, threadType: "none" as const },
      };

      return {
        id: opts.id ?? `plugin-${opts.channelType}`,
        name: `Custom ${opts.channelType} Plugin`,
        version: "1.0.0",
        channelType: opts.channelType,
        capabilities,
        adapter,

        register(api: PluginRegistryApi): Result<void, Error> {
          lifecycleLog.push("register");
          if (opts.registerFn) {
            return opts.registerFn(api);
          }
          return ok(undefined);
        },

        async activate(): Promise<Result<void, Error>> {
          lifecycleLog.push("activate");
          return adapter.start();
        },

        async deactivate(): Promise<Result<void, Error>> {
          lifecycleLog.push("deactivate");
          return adapter.stop();
        },

        // Expose lifecycle log for assertions via a getter on the object
        get _lifecycleLog() {
          return lifecycleLog;
        },
      } as ChannelPluginPort & { _lifecycleLog: string[] };
    }

    it("CADPT-13: register -> activate -> deactivate lifecycle executes in order", async () => {
      const { pluginRegistry, channelRegistry } = setup();

      const plugin = createCustomPlugin({ channelType: "custom-lifecycle" }) as ChannelPluginPort & {
        _lifecycleLog: string[];
      };

      // Register
      const registerResult = channelRegistry.registerChannel(plugin);
      expect(registerResult.ok).toBe(true);

      // Activate all
      const activateResult = await pluginRegistry.activateAll();
      expect(activateResult.ok).toBe(true);

      // Deactivate all
      const deactivateResult = await pluginRegistry.deactivateAll();
      expect(deactivateResult.ok).toBe(true);

      // Verify lifecycle order
      expect(plugin._lifecycleLog).toEqual(["register", "activate", "deactivate"]);
    });

    it("CADPT-14: plugin hook registration via PluginRegistryApi.registerHook()", () => {
      const { pluginRegistry, channelRegistry } = setup();

      const hookHandler: HookHandlerMap["before_agent_start"] = (
        _event,
        _ctx,
      ) => {
        return { systemPrompt: "modified" };
      };

      const plugin = createCustomPlugin({
        channelType: "custom-hooks",
        registerFn: (api) => {
          api.registerHook("before_agent_start", hookHandler);
          return ok(undefined);
        },
      });

      // Register the plugin via channelRegistry
      const result = channelRegistry.registerChannel(plugin);
      expect(result.ok).toBe(true);

      // Verify the hook is stored via pluginRegistry.getHooksByName()
      const hooks = pluginRegistry.getHooksByName("before_agent_start");
      expect(hooks.length).toBeGreaterThanOrEqual(1);

      const registeredHook = hooks.find((h) => h.pluginId === plugin.id);
      expect(registeredHook).toBeDefined();
      expect(registeredHook!.hookName).toBe("before_agent_start");
      expect(registeredHook!.pluginId).toBe("plugin-custom-hooks");
    });

    it("CADPT-15: duplicate channelType registration rejected by ChannelRegistry", () => {
      const { channelRegistry } = setup();

      const plugin1 = createCustomPlugin({
        channelType: "custom-dup",
        id: "plugin-dup-1",
      });
      const plugin2 = createCustomPlugin({
        channelType: "custom-dup",
        id: "plugin-dup-2",
      });

      // First registration succeeds
      const result1 = channelRegistry.registerChannel(plugin1);
      expect(result1.ok).toBe(true);

      // Second registration with same channelType fails
      const result2 = channelRegistry.registerChannel(plugin2);
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.message).toContain("already registered");
      }
    });
  });
});
