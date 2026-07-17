// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import { restartChannelAdapter } from "./channel-adapter-restart.js";

describe("restartChannelAdapter health recovery", () => {
  it("rejects and does not start when adapter stop returns an error Result", async () => {
    const start = vi.fn(async () => ok(undefined));
    const stopError = new Error("health stop failed");
    const logger = { warn: vi.fn() };

    await expect(restartChannelAdapter({
      adapter: { start, stop: vi.fn(async () => err(stopError)) } as never,
      channelType: "telegram",
      logger: logger as never,
    })).rejects.toBe(stopError);

    expect(start).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "telegram", errorKind: "platform" }),
      "Channel health auto-restart failed",
    );
  });

  it("rejects instead of reporting recovery when adapter start returns an error Result", async () => {
    const startError = new Error("health start failed");
    const logger = { warn: vi.fn() };

    await expect(restartChannelAdapter({
      adapter: {
        stop: vi.fn(async () => ok(undefined)),
        start: vi.fn(async () => err(startError)),
      } as never,
      channelType: "telegram",
      logger: logger as never,
    })).rejects.toBe(startError);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "telegram", errorKind: "platform" }),
      "Channel health auto-restart failed",
    );
  });
});
