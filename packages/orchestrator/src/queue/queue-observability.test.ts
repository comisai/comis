// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "@comis/core";
import { createQueueObservability } from "./queue-observability.js";

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(),
  } as never;
}

describe("queue observability containment", () => {
  it("contains a throwing lifecycle observer without blocking later observers", () => {
    const eventBus = new TypedEventBus();
    const logger = makeLogger();
    const laterObserver = vi.fn();
    eventBus.on("queue:enqueued", () => {
      throw new Error("observer failed");
    });
    eventBus.on("queue:enqueued", laterObserver);
    const observability = createQueueObservability(eventBus, logger);

    observability.emitQueueEvent("queue:enqueued", {
      sessionKey: { tenantId: "tenant", userId: "user-1", channelId: "chat-1" },
      channelType: "telegram",
      queueDepth: 1,
      mode: "followup",
      timestamp: 1_000,
    }, "telegram");

    expect(laterObserver).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "queue:enqueued",
        subscriberFailurePhase: "sync",
        subscriberFailureCount: 1,
        firstListenerIndex: 0,
        errorKind: "internal",
      }),
      "Observational event subscriber failed",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("observer failed");
  });

  it("contains a rejected background execution with an actionable error", async () => {
    const logger = makeLogger();
    const observability = createQueueObservability(new TypedEventBus(), logger);

    await observability.containBackgroundExecution(
      Promise.reject(new Error("execution failed")),
      "collect",
      "telegram",
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "collect", errorKind: "internal" }),
      "Command queue background execution failed",
    );
  });
});
