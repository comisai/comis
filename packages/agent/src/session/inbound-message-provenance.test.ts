// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManager as RealSessionManager } from "@earendil-works/pi-coding-agent";
import {
  INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
  type NormalizedMessage,
} from "@comis/core";
import {
  appendInboundMessageProvenance,
  planInboundMessageProvenance,
} from "./inbound-message-provenance.js";

const first = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "chat-a",
  channelType: "telegram",
  senderId: "sender-a",
  text: "first physical message",
  timestamp: 1_789_000_000_001,
} as const;

const second = {
  id: "22222222-2222-4222-8222-222222222222",
  channelId: "chat-a",
  channelType: "telegram",
  senderId: "sender-b",
  text: "second physical message",
  timestamp: 1_789_000_000_002,
} as const;

const RECORDED_AT = 1_789_000_100_000;

function makeSessionManager(appendCustomEntry: ReturnType<typeof vi.fn>): SessionManager {
  return { appendCustomEntry } as unknown as SessionManager;
}

describe("persistInboundMessageProvenance", () => {
  it("persists every original physical message in one exact structured batch", () => {
    const appendCustomEntry = vi.fn().mockReturnValue("entry-id");
    const message = {
      ...second,
      attachments: [],
      metadata: {},
      text: "synthetic coalesced prompt",
      originalMessages: [first, second],
    } satisfies NormalizedMessage;

    const planned = planInboundMessageProvenance(message, RECORDED_AT);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const result = appendInboundMessageProvenance(
      makeSessionManager(appendCustomEntry),
      planned.value,
    );

    expect(result).toEqual({ ok: true, value: "entry-id" });
    expect(appendCustomEntry).toHaveBeenCalledOnce();
    expect(appendCustomEntry).toHaveBeenCalledWith(
      INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
      {
        schemaVersion: 1,
        batchId: second.id,
        chunkIndex: 0,
        chunkCount: 1,
        recordedAt: RECORDED_AT,
        messages: [first, second],
      },
    );
    expect(planned.value.ledgerContent).toBe(
      `${JSON.stringify({
        type: "custom",
        customType: INBOUND_MESSAGE_PROVENANCE_CUSTOM_TYPE,
        data: planned.value.payloads[0],
      })}\n`,
    );
  });

  it("redacts credential assignments in durable inbound provenance without mutating the live message", () => {
    const username = "example-user-value";
    const password = "test-password-value";
    const message = {
      ...first,
      text: `Install the server with {"SERVICE_USERNAME":"${username}","SERVICE_PASSWORD":"${password}"}`,
      attachments: [],
      metadata: {},
    } satisfies NormalizedMessage;

    const planned = planInboundMessageProvenance(message, RECORDED_AT);

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const serialized = JSON.stringify(planned.value);
    expect(serialized).not.toContain(username);
    expect(serialized).not.toContain(password);
    expect(serialized).toContain("[REDACTED]");
    expect(message.text).toContain(username);
    expect(message.text).toContain(password);
  });

  it("redacts natural-language secret confirmations from durable inbound provenance", () => {
    const password = "test-secret-pass-747!";
    const message = {
      ...first,
      text: `Final confirmation: store SERVICE_PASSWORD in the encrypted secret store with the value ${password}, then continue.`,
      attachments: [],
      metadata: {},
    } satisfies NormalizedMessage;

    const planned = planInboundMessageProvenance(message, RECORDED_AT);

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(JSON.stringify(planned.value)).not.toContain(password);
    expect(JSON.stringify(planned.value)).toContain("[REDACTED]");
    expect(message.text).toContain(password);
  });

  it("splits a large physical batch into complete markers below the offline reader record ceiling", () => {
    const appendCustomEntry = vi.fn()
      .mockImplementation(() => `entry-${appendCustomEntry.mock.calls.length}`);
    const originalMessages = Array.from({ length: 40 }, (_, index) => ({
      id: `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      channelId: "chat-a",
      channelType: "telegram",
      senderId: "sender-a",
      text: "x".repeat(32_768),
      timestamp: 1_789_000_000_001 + index,
    }));
    const message = {
      ...second,
      attachments: [],
      metadata: {},
      text: "synthetic coalesced prompt",
      originalMessages,
    } satisfies NormalizedMessage;

    const planned = planInboundMessageProvenance(message, RECORDED_AT);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const result = appendInboundMessageProvenance(
      makeSessionManager(appendCustomEntry),
      planned.value,
    );

    expect(result.ok).toBe(true);
    expect(appendCustomEntry.mock.calls.length).toBeGreaterThan(1);
    const payloads = planned.value.payloads as Array<{
      batchId: string;
      chunkIndex: number;
      chunkCount: number;
      messages: typeof originalMessages;
    }>;
    for (const [index, payload] of payloads.entries()) {
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(1024 * 1024);
      expect(payload.batchId).toBe(second.id);
      expect(payload.chunkIndex).toBe(index);
      expect(payload.chunkCount).toBe(payloads.length);
    }
    expect(payloads.flatMap((payload) => payload.messages)).toEqual(originalMessages);
  });

  it("returns an error when the session custom-entry append throws", () => {
    const appendCustomEntry = vi.fn(() => {
      throw new Error("session disk unavailable");
    });
    const message = {
      ...first,
      attachments: [],
      metadata: {},
    } satisfies NormalizedMessage;

    const planned = planInboundMessageProvenance(message, RECORDED_AT);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const result = appendInboundMessageProvenance(
      makeSessionManager(appendCustomEntry),
      planned.value,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("session disk unavailable");
  });

  it("rejects an invalid provenance timestamp before appending a custom entry", () => {
    const appendCustomEntry = vi.fn().mockReturnValue("entry-id");
    const message = {
      ...first,
      timestamp: 8_640_000_000_000_001,
      attachments: [],
      metadata: {},
    } satisfies NormalizedMessage;

    const result = planInboundMessageProvenance(message, RECORDED_AT);

    expect(result.ok).toBe(false);
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("rejects an aggregate batch beyond the bounded ledger scan window before appending", () => {
    const appendCustomEntry = vi.fn().mockReturnValue("entry-id");
    const originalMessages = Array.from({ length: 260 }, (_, index) => ({
      id: `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      channelId: "chat-a",
      channelType: "telegram",
      senderId: "sender-a",
      text: "x".repeat(32_768),
      timestamp: 1_789_000_000_001 + index,
    }));
    const message = {
      ...second,
      attachments: [],
      metadata: {},
      text: "synthetic coalesced prompt",
      originalMessages,
    } satisfies NormalizedMessage;

    const result = planInboundMessageProvenance(message, RECORDED_AT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorKind).toBe("resource");
    expect(appendCustomEntry).not.toHaveBeenCalled();
  });

  it("keeps each real SDK custom-entry JSONL record below one MiB with escaped UTF-8 content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-provenance-"));
    try {
      const originalMessages = Array.from({ length: 36 }, (_, index) => ({
        id: `${(index + 1).toString(16).padStart(8, "0")}-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        channelId: "chat-a",
        channelType: "telegram",
        senderId: "sender-a",
        text: `${"\"\\\u0000שלום".repeat(3_200)}-${index}`,
        timestamp: 1_789_000_000_001 + index,
      }));
      const message = {
        ...second,
        attachments: [],
        metadata: {},
        text: "synthetic coalesced prompt",
        originalMessages,
      } satisfies NormalizedMessage;
      const planned = planInboundMessageProvenance(message, RECORDED_AT);
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      const sessionFile = path.join(dir, "session.jsonl");
      const sessionManager = RealSessionManager.open(sessionFile, dir);

      const appended = appendInboundMessageProvenance(sessionManager, planned.value);
      expect(appended.ok).toBe(true);
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "ack" }],
        timestamp: 1_789_000_100_000,
      } as never);

      const customLines = fs.readFileSync(sessionFile, "utf8")
        .trimEnd()
        .split("\n")
        .filter((line) => JSON.parse(line).type === "custom");
      expect(customLines.length).toBeGreaterThan(1);
      for (const line of customLines) {
        expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1024 * 1024);
      }
      expect(customLines.flatMap((line) =>
        (JSON.parse(line).data.messages as typeof originalMessages),
      )).toEqual(originalMessages);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
