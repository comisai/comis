// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { NormalizedMessage, RequestContext } from "@comis/core";
import {
  enrichCurrentContext,
  runWithContext,
  tryGetContext,
  TypedEventBus,
} from "@comis/core";
import { createSourceTerminalScope } from "../source-message-terminal.js";
import type { QueuedMessageEntry } from "./lane.js";
import {
  captureQueueAsyncScope,
  coalesceQueuedEntries,
  releaseQueueEntryResources,
} from "./queue-entry-lifecycle.js";

function makeEntry(
  id: string,
  releaseResources = vi.fn(),
): QueuedMessageEntry {
  const message: NormalizedMessage = {
    id,
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: id,
    timestamp: 1_000,
    attachments: [],
  };
  return {
    message,
    sessionKey: { tenantId: "tenant", userId: "user-1", channelId: "chat-1" },
    channelType: "telegram",
    enqueuedAt: id === "first" ? 100 : 200,
    receivedAt: id === "first" ? 90 : 190,
    logicalCount: 1,
    handler: vi.fn(async () => undefined),
    runInAsyncScope: (task) => task(),
    ownership: {
      executionStarted: false,
      resourcesReleased: false,
      releaseResources,
    },
    sourceTerminalScope: createSourceTerminalScope(
      { eventBus: new TypedEventBus() },
      message,
      "telegram",
    ),
  };
}

describe("queue entry lifecycle", () => {
  it("releases superseded coalesced ownership while retaining the newest entry", () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const first = makeEntry("first", firstRelease);
    const second = makeEntry("second", secondRelease);

    const merged = coalesceQueuedEntries(
      [first, second],
      (entry, reason) => releaseQueueEntryResources(entry, reason),
    );

    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    expect(merged.logicalCount).toBe(2);
    expect(merged.enqueuedAt).toBe(100);
    expect(merged.ownership).toBe(second.ownership);
  });

  it("releases active ownership only for shutdown and remains idempotent", () => {
    const releaseResources = vi.fn();
    const entry = makeEntry("active", releaseResources);
    entry.ownership.executionStarted = true;

    releaseQueueEntryResources(entry, "overflow");
    releaseQueueEntryResources(entry, "shutdown");
    releaseQueueEntryResources(entry, "shutdown");

    expect(releaseResources).toHaveBeenCalledOnce();
  });

  it("keeps captured queue authorization immutable after inbound resolution", () => {
    const context: RequestContext = {
      traceId: "550e8400-e29b-41d4-a716-446655440401",
      startedAt: 1_700_000_000_000,
      tenantId: "default",
      trustLevel: "user",
      channelType: "telegram",
    };
    const captured = runWithContext(context, () => {
      const enriched = enrichCurrentContext({
        tenantId: "default",
        userId: "user-1",
        sessionKey: {
          tenantId: "default",
          userId: "user-1",
          channelId: "chat-1",
        },
        agentId: "agent-a",
        trustLevel: "user",
        deliveryOrigin: {
          channelType: "telegram",
          channelId: "chat-1",
          userId: "user-1",
          tenantId: "default",
        },
      });
      expect(enriched.ok).toBe(true);
      return captureQueueAsyncScope();
    });

    expect(Reflect.set(context, "trustLevel", "admin")).toBe(false);
    expect(Reflect.set(context, "agentId", "agent-b")).toBe(false);
    let observed: RequestContext | undefined;
    captured(() => { observed = tryGetContext(); });

    expect(observed).toBe(context);
    expect(observed).toMatchObject({ agentId: "agent-a", trustLevel: "user" });
  });
});
