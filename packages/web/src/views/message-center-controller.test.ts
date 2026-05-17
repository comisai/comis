// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createMessageCenterController } from "./message-center-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("MessageCenterController", () => {
  it("listChannels: returns channels.list response", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "channels.list") {
        return { channels: [{ channelType: "discord", status: "connected" }], total: 1 };
      }
      return {};
    });
    const controller = createMessageCenterController(host, rpc);
    const channels = await controller.listChannels();
    expect(channels.length).toBe(1);
    expect(channels[0]!.channelType).toBe("discord");
  });

  it("getChannelCapabilities: unpacks features field from response", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "channels.capabilities") {
        return { channelType: "telegram", features: { fetchHistory: true, mentions: false } };
      }
      return {};
    });
    const controller = createMessageCenterController(host, rpc);
    const caps = await controller.getChannelCapabilities("telegram");
    expect(caps?.fetchHistory).toBe(true);
  });

  it("getChannelConfig: returns full config record", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "channels.get") {
        return { botName: "comis-bot", name: "comis", channel_type: "discord" };
      }
      return {};
    });
    const controller = createMessageCenterController(host, rpc);
    const config = await controller.getChannelConfig("discord");
    expect(config?.botName).toBe("comis-bot");
  });

  it("listObsChannels: returns obs.channels.all channels array", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "obs.channels.all") {
        return {
          channels: [
            { channelId: "chat-1", channelType: "discord", messagesSent: 10, messagesReceived: 5, lastActiveAt: 1 },
          ],
        };
      }
      return {};
    });
    const controller = createMessageCenterController(host, rpc);
    const obs = await controller.listObsChannels();
    expect(obs.length).toBe(1);
    expect(obs[0]!.channelId).toBe("chat-1");
  });

  it("fetchMessages: returns message.fetch messages array", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      if (args[0] === "message.fetch") {
        return { messages: [{ id: "m1", text: "hi" }], channelId: "c1" };
      }
      return {};
    });
    const controller = createMessageCenterController(host, rpc);
    const messages = await controller.fetchMessages({ channel_type: "discord", channel_id: "c1", limit: 50 });
    expect(messages.length).toBe(1);
  });

  it("sendMessage / replyMessage / editMessage / deleteMessage: invoke matching rpc", async () => {
    const host = makeHost();
    const calls: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      calls.push(args[0] as string);
      return {};
    });
    const controller = createMessageCenterController(host, rpc);
    await controller.sendMessage({ channel_type: "discord", channel_id: "c1", text: "hello" });
    await controller.replyMessage({ channel_type: "discord", channel_id: "c1", text: "reply", message_id: "m1" });
    await controller.editMessage({ channel_type: "discord", channel_id: "c1", message_id: "m1", text: "edited" });
    await controller.deleteMessage({ channel_type: "discord", channel_id: "c1", message_id: "m1" });
    expect(calls).toEqual(["message.send", "message.reply", "message.edit", "message.delete"]);
  });

  it("reactMessage / attachMessage: invoke message.react / message.attach", async () => {
    const host = makeHost();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      calls.push({ method: args[0] as string, params: args[1] });
      return {};
    });
    const controller = createMessageCenterController(host, rpc);
    await controller.reactMessage({ channel_type: "telegram", channel_id: "c1", message_id: "m1", emoji: "👍" });
    await controller.attachMessage({
      channel_type: "telegram",
      channel_id: "c1",
      attachment_url: "https://example.com/img.png",
      attachment_type: "image",
      caption: "test",
    });
    expect(calls[0]!.method).toBe("message.react");
    expect(calls[1]!.method).toBe("message.attach");
    expect((calls[1]!.params as { attachment_url: string }).attachment_url).toBe("https://example.com/img.png");
  });

  it("invokePlatformAction: forwards to the named RPC method with params", async () => {
    const host = makeHost();
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      calls.push({ method: args[0] as string, params: args[1] });
      return { ok: true };
    });
    const controller = createMessageCenterController(host, rpc);
    const result = await controller.invokePlatformAction("discord.action", {
      action: "pin",
      channel_id: "c1",
      message_id: "m1",
    });
    expect(calls[0]!.method).toBe("discord.action");
    expect((calls[0]!.params as { action: string }).action).toBe("pin");
    expect(result).toEqual({ ok: true });
  });
});
