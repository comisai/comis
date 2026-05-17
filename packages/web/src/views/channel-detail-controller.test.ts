// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createChannelDetailController } from "./channel-detail-controller.js";

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

describe("ChannelDetailController", () => {
  it("getChannel: invokes channels.get with channel_type param", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { enabled: true, status: "running" };
    });
    const controller = createChannelDetailController(host, rpc);
    const result = await controller.getChannel("telegram");
    expect((seen[0] as unknown[])[0]).toBe("channels.get");
    expect((seen[0] as unknown[])[1]).toEqual({ channel_type: "telegram" });
    expect(result.enabled).toBe(true);
  });

  it("readChannelsConfig: invokes config.read with section=channels", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { telegram: { mediaProcessing: { transcribeAudio: true } } };
    });
    const controller = createChannelDetailController(host, rpc);
    const result = await controller.readChannelsConfig();
    expect((seen[0] as unknown[])[0]).toBe("config.read");
    expect((seen[0] as unknown[])[1]).toEqual({ section: "channels" });
    expect(result.telegram).toBeDefined();
  });

  it("getRecentDelivery: passes type + limit; tolerates entries OR deliveries shape", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return { entries: [{ latencyMs: 42, success: true }] };
    });
    const controller = createChannelDetailController(host, rpc);
    const result = await controller.getRecentDelivery("telegram", 10);
    expect((seen[0] as unknown[])[1]).toEqual({
      type: "telegram",
      limit: 10,
    });
    expect(result.entries?.[0]!.latencyMs).toBe(42);
  });

  it("getChannelObs + getDeliveryQueueStatus + getChannelCapabilities: forward channelId/type params", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      const method = args[0] as string;
      if (method === "obs.channels.get")
        return {
          channel: {
            channelId: "telegram",
            channelType: "telegram",
            lastActiveAt: 1,
            messagesSent: 2,
            messagesReceived: 3,
          },
        };
      if (method === "delivery.queue.status")
        return { pending: 0, inflight: 0, failed: 0 };
      if (method === "channels.capabilities")
        return { channelType: "telegram", features: {} };
      return {};
    });
    const controller = createChannelDetailController(host, rpc);
    const obs = await controller.getChannelObs("telegram");
    const queue = await controller.getDeliveryQueueStatus("telegram");
    const caps = await controller.getChannelCapabilities("telegram");
    expect((seen[0] as unknown[])[1]).toEqual({ channelId: "telegram" });
    expect(obs.channel?.messagesSent).toBe(2);
    expect((seen[1] as unknown[])[1]).toEqual({ channel_type: "telegram" });
    expect(queue.pending).toBe(0);
    expect((seen[2] as unknown[])[1]).toEqual({ channel_type: "telegram" });
    expect(caps.channelType).toBe("telegram");
  });

  it("restartChannel + disableChannel + enableChannel: invoke channels lifecycle endpoints", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createChannelDetailController(host, rpc);
    await controller.restartChannel("telegram");
    await controller.disableChannel("telegram");
    await controller.enableChannel("telegram");
    expect((seen[0] as unknown[])[0]).toBe("channels.restart");
    expect((seen[1] as unknown[])[0]).toBe("channels.disable");
    expect((seen[2] as unknown[])[0]).toBe("channels.enable");
    expect((seen[0] as unknown[])[1]).toEqual({ channel_type: "telegram" });
  });

  it("patchConfig: forwards section + key + value verbatim", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createChannelDetailController(host, rpc);
    await controller.patchConfig(
      "channels",
      "telegram.mediaProcessing.transcribeAudio",
      false,
    );
    expect((seen[0] as unknown[])[0]).toBe("config.patch");
    expect((seen[0] as unknown[])[1]).toEqual({
      section: "channels",
      key: "telegram.mediaProcessing.transcribeAudio",
      value: false,
    });
  });

  it("RPC errors propagate verbatim to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createChannelDetailController(host, rpc);
    await expect(controller.getChannel("telegram")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(controller.restartChannel("telegram")).rejects.toThrow(
      "daemon unreachable",
    );
    await expect(
      controller.patchConfig("channels", "telegram.x", true),
    ).rejects.toThrow("daemon unreachable");
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createChannelDetailController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });
});
