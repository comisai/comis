// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for notification RPC handlers.
 * Verifies the notification.send handler bridges to notifyUser(),
 * maps params correctly, handles missing parameters gracefully,
 * and enforces the chain-depth guard.
 * Tool and programmatic notification dispatch.
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { createNotificationHandlers } from "./notification-handlers.js";
import type { NotificationDestination, NotificationService } from "../notification/notification-service.js";
import { ConversationRefSchema } from "@comis/core";
import { ok, err } from "@comis/shared";

// The destination the handler is expected to MINT (via resolveDestination) and
// thread into notifyUser. Before the fix the handler called notifyUser bare and
// this mock's resolveDestination was never exercised — the pin below now asserts
// the minted authority + endpoint are actually passed through.
const MINTED_DESTINATION: NotificationDestination = {
  authority: {
    tenantId: "default",
    agentId: "agent-1",
    conversationRef: ConversationRefSchema.parse(`cv_${"a".repeat(43)}`),
  },
  destinationEndpoint: {
    channelType: "telegram",
    channelInstanceId: "notification",
    conversationId: "chat-42",
    conversationKind: "direct",
  },
};

function makeMockService(overrides: Partial<NotificationService> = {}): NotificationService {
  return {
    notifyUser: vi.fn().mockResolvedValue(ok("entry-1")),
    resolveDestination: vi.fn().mockReturnValue(ok(MINTED_DESTINATION)),
    ...overrides,
  };
}

describe("createNotificationHandlers", () => {
  it("notification.send calls notifyUser with correct options mapping", async () => {
    const service = makeMockService();
    const handlers = createNotificationHandlers({ notificationService: service });
    const handler = handlers["notification.send"]!;

    await handler({
      _agentId: "agent-1",
      message: "Hello user",
      priority: "high",
      channel_type: "telegram",
      channel_id: "chat-42",
      destination_endpoint: MINTED_DESTINATION.destinationEndpoint,
    });

    // The handler mints the destination from the agent + requested channel first.
    expect(service.resolveDestination).toHaveBeenCalledWith({
      agentId: "agent-1",
      channelType: "telegram",
      channelId: "chat-42",
      destinationEndpoint: MINTED_DESTINATION.destinationEndpoint,
    });
    // …then threads the minted authority + endpoint into notifyUser (previously
    // it called notifyUser bare, which the guard rejected).
    expect(service.notifyUser).toHaveBeenCalledWith({
      agentId: "agent-1",
      message: "Hello user",
      priority: "high",
      channelType: "telegram",
      channelId: "chat-42",
      origin: "tool",
      authority: MINTED_DESTINATION.authority,
      destinationEndpoint: MINTED_DESTINATION.destinationEndpoint,
    });
  });

  it("includes _agentId from params as options.agentId", async () => {
    const service = makeMockService();
    const handlers = createNotificationHandlers({ notificationService: service });
    const handler = handlers["notification.send"]!;

    await handler({
      _agentId: "custom-agent",
      message: "test",
    });

    expect(service.notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "custom-agent" }),
    );
  });

  it("notifyUser returning ok produces success response", async () => {
    const service = makeMockService({
      notifyUser: vi.fn().mockResolvedValue(ok("entry-42")),
    });
    const handlers = createNotificationHandlers({ notificationService: service });
    const result = await handlers["notification.send"]!({
      _agentId: "a",
      message: "hello",
    });

    expect(result).toEqual({ success: true, entryId: "entry-42" });
  });

  it("notifyUser returning err produces error response with message", async () => {
    const service = makeMockService({
      notifyUser: vi.fn().mockResolvedValue(err(new Error("Rate limit exceeded"))),
    });
    const handlers = createNotificationHandlers({ notificationService: service });
    const result = await handlers["notification.send"]!({
      _agentId: "a",
      message: "hello",
    });

    expect(result).toEqual({ success: false, error: "Rate limit exceeded" });
  });

  it("returns structured error when message parameter is missing (no throw)", async () => {
    const service = makeMockService();
    const handlers = createNotificationHandlers({ notificationService: service });
    const result = await handlers["notification.send"]!({
      _agentId: "a",
      // message is missing
    });

    expect(result).toEqual({ success: false, error: "Missing required parameter: message" });
    // notifyUser should NOT have been called
    expect(service.notifyUser).not.toHaveBeenCalled();
  });

  it("returns chain-depth guard error when origin is 'notification'", async () => {
    const service = makeMockService();
    const handlers = createNotificationHandlers({ notificationService: service });
    const result = await handlers["notification.send"]!({
      _agentId: "a",
      message: "recursive attempt",
      origin: "notification",
    });

    expect(result).toEqual({
      success: false,
      error: "Chain-depth guard: cannot send notification from notification-originated context",
    });
    // notifyUser should NOT have been called
    expect(service.notifyUser).not.toHaveBeenCalled();
  });

  it("returns the resolver error and does NOT call notifyUser when no channel resolves", async () => {
    const service = makeMockService({
      resolveDestination: vi.fn().mockReturnValue(err(new Error("No channel resolved for notification delivery"))),
    });
    const handlers = createNotificationHandlers({ notificationService: service });
    const result = await handlers["notification.send"]!({
      _agentId: "a",
      message: "hello",
    });

    expect(result).toEqual({ success: false, error: "No channel resolved for notification delivery" });
    expect(service.notifyUser).not.toHaveBeenCalled();
  });
});
