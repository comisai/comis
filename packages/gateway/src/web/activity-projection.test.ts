// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { projectActivityPayload } from "./activity-projection.js";

const PRIVATE_TEXT = "PRIVATE-ACTIVITY-BODY-api-key=test-key";

describe("activity event projection", () => {
  it("removes inbound, outbound, and streaming message bodies at capture time", () => {
    const received = projectActivityPayload("message:received", {
      message: {
        id: "msg-in",
        channelType: "telegram",
        channelId: "chat-1",
        senderId: "user-1",
        text: PRIVATE_TEXT,
        timestamp: 42,
        attachments: [{ type: "file", url: PRIVATE_TEXT }],
        metadata: { token: PRIVATE_TEXT },
      },
      sessionKey: { tenantId: "tenant-1", userId: "user-1", channelId: "chat-1" },
    });
    const sent = projectActivityPayload("message:sent", {
      channelType: "telegram",
      channelId: "chat-1",
      messageId: "msg-out",
      content: PRIVATE_TEXT,
      sourceChannelType: "telegram",
      sourceChannelId: "chat-1",
      sourceMessageId: "msg-in",
    });
    const streaming = projectActivityPayload("message:streaming", {
      channelId: "chat-1",
      messageId: "msg-out",
      delta: PRIVATE_TEXT,
      accumulated: PRIVATE_TEXT,
    });

    expect(received).toEqual({
      messageId: "msg-in",
      channelType: "telegram",
      channelId: "chat-1",
      senderId: "user-1",
      timestamp: 42,
      hasText: true,
      attachmentCount: 1,
      tenantId: "tenant-1",
      userId: "user-1",
      sessionChannelId: "chat-1",
    });
    expect(sent).toEqual({
      channelType: "telegram",
      channelId: "chat-1",
      messageId: "msg-out",
      sourceChannelType: "telegram",
      sourceChannelId: "chat-1",
      sourceMessageId: "msg-in",
    });
    expect(streaming).toEqual({
      channelId: "chat-1",
      messageId: "msg-out",
      deltaChars: PRIVATE_TEXT.length,
      accumulatedChars: PRIVATE_TEXT.length,
    });
    expect(JSON.stringify({ received, sent, streaming })).not.toContain(PRIVATE_TEXT);
  });

  it("keeps the approval capability verb + request identity but drops params, metadata, errors, and unknown free text", () => {
    // `action` is the bounded capability verb the operator approval queue
    // renders (e.g. "agents.suspend") — a controlled tool identifier, not
    // caller-authored content, so it egresses like `toolName`. The nested
    // `params` (which may carry secrets) and `metadata` stay stripped.
    const approval = projectActivityPayload("approval:requested", {
      requestId: "request-1",
      shortId: "short-1",
      agentId: "agent-1",
      tenantId: "tenant-1",
      toolName: "exec",
      action: "agents.suspend",
      trustLevel: "admin",
      createdAt: 1234,
      params: { command: PRIVATE_TEXT },
      metadata: { token: PRIVATE_TEXT },
      timestamp: 99,
    });
    const systemError = projectActivityPayload("system:error", {
      source: "gateway",
      error: new Error(PRIVATE_TEXT),
    });
    const unknown = projectActivityPayload("unknown:event", {
      messageId: PRIVATE_TEXT,
      arbitrary: PRIVATE_TEXT,
    });

    expect(approval).toEqual({
      requestId: "request-1",
      shortId: "short-1",
      agentId: "agent-1",
      tenantId: "tenant-1",
      toolName: "exec",
      action: "agents.suspend",
      trustLevel: "admin",
      createdAt: 1234,
      timestamp: 99,
    });
    expect(systemError).toEqual({ source: "gateway", errorName: "Error" });
    expect(unknown).toEqual({});
    expect(JSON.stringify({ approval, systemError, unknown })).not.toContain(PRIVATE_TEXT);
  });

  it("keeps the approval resolution outcome + resolver identity but drops the free-form reason", () => {
    // The dashboard approval-history row needs the outcome (`approved`), the
    // resolver (`approvedBy`), and `resolvedAt`. The operator-authored,
    // free-form `reason` is content and stays stripped at the egress boundary.
    const resolved = projectActivityPayload("approval:resolved", {
      requestId: "request-1",
      approved: true,
      approvedBy: "operator",
      reason: PRIVATE_TEXT,
      resolvedAt: 4321,
    });

    expect(resolved).toEqual({
      requestId: "request-1",
      approved: true,
      approvedBy: "operator",
      resolvedAt: 4321,
    });
    expect(JSON.stringify(resolved)).not.toContain(PRIVATE_TEXT);
  });

  it("classifies an overwritten error name without exposing its text", () => {
    const error = new Error("safe message is discarded");
    error.name = PRIVATE_TEXT;

    const projected = projectActivityPayload("system:error", {
      source: "gateway",
      error,
    });

    expect(projected).toEqual({ source: "gateway", errorName: "UnknownError" });
    expect(JSON.stringify(projected)).not.toContain(PRIVATE_TEXT);
  });

  it("reads an approved error category only once at the projection boundary", () => {
    const error = new Error("discarded");
    let reads = 0;
    Object.defineProperty(error, "name", {
      get() {
        reads += 1;
        return reads === 1 ? "TypeError" : PRIVATE_TEXT;
      },
    });

    const projected = projectActivityPayload("system:error", { error, source: "gateway" });

    expect(projected).toEqual({ source: "gateway", errorName: "TypeError" });
    expect(reads).toBe(1);
    expect(JSON.stringify(projected)).not.toContain(PRIVATE_TEXT);
  });

  it("uses a content-free category when reading an error name fails", () => {
    const error = new Error("discarded");
    Object.defineProperty(error, "name", {
      get() {
        throw new Error(PRIVATE_TEXT);
      },
    });

    expect(projectActivityPayload("system:error", { error, source: "gateway" })).toEqual({
      source: "gateway",
      errorName: "UnknownError",
    });
  });

  it("retains graph lifecycle counts required by the live pipeline monitor", () => {
    const started = projectActivityPayload("graph:started", {
      graphId: "graph-1",
      label: PRIVATE_TEXT,
      nodeCount: 4,
      timestamp: 10,
    });
    const completed = projectActivityPayload("graph:completed", {
      graphId: "graph-1",
      status: "failed",
      durationMs: 25,
      nodeCount: 4,
      nodesCompleted: 2,
      nodesFailed: 1,
      nodesSkipped: 1,
      cancelReason: PRIVATE_TEXT,
      timestamp: 35,
    });

    expect(started).toEqual({
      graphId: "graph-1",
      nodeCount: 4,
      timestamp: 10,
    });
    expect(completed).toEqual({
      graphId: "graph-1",
      status: "failed",
      durationMs: 25,
      nodeCount: 4,
      nodesCompleted: 2,
      nodesFailed: 1,
      nodesSkipped: 1,
      timestamp: 35,
    });
    expect(JSON.stringify({ started, completed })).not.toContain(PRIVATE_TEXT);
  });
});
