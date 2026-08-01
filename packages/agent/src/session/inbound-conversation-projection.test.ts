// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NormalizedMessage } from "@comis/core";
import * as inboundProvenance from "./inbound-message-provenance.js";

type ProjectionResult = {
  ok: true;
  value: {
    messages: AgentMessage[];
    sourceMessages: AgentMessage[];
    diagnostics: {
      projectedUserMessages: number;
      omittedLocaleRepairTurns: number;
      duplicateProvenanceEntries: number;
      invalidProvenanceEntries: number;
      incompleteProvenanceBatches: number;
    };
  };
};

const projectInboundConversation = (
  inboundProvenance as unknown as {
    projectInboundConversation(sessionManager: SessionManager): ProjectionResult;
  }
).projectInboundConversation;

const FIRST = {
  id: "11111111-1111-4111-8111-111111111111",
  channelId: "chat-a",
  channelType: "telegram",
  senderId: "sender-a",
  text: "first physical message",
  timestamp: 1_789_000_000_001,
  attachments: [],
  metadata: {},
} satisfies NormalizedMessage;

const SECOND = {
  id: "22222222-2222-4222-8222-222222222222",
  channelId: "chat-a",
  channelType: "telegram",
  senderId: "sender-b",
  text: "second physical message",
  timestamp: 1_789_000_000_002,
  attachments: [],
  metadata: {},
} satisfies NormalizedMessage;

function appendProvenance(
  sessionManager: SessionManager,
  message: NormalizedMessage,
): void {
  const planned = inboundProvenance.planInboundMessageProvenance(
    message,
    message.timestamp + 100,
  );
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;
  const appended = inboundProvenance.appendInboundMessageProvenance(
    sessionManager,
    planned.value,
  );
  expect(appended.ok).toBe(true);
}

function appendAssistant(sessionManager: SessionManager, text: string, timestamp: number): void {
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "example",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as never);
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object"
      && block !== null
      && (block as { type?: string }).type === "text"
      && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("");
}

describe("structured inbound conversation projection", () => {
  it("replaces persisted prompt wrappers with compact physical-message history", () => {
    const sessionManager = SessionManager.inMemory("/workspace");
    appendProvenance(sessionManager, FIRST);
    appendProvenance(sessionManager, FIRST);
    sessionManager.appendMessage({
      role: "user",
      content: [{
        type: "text",
        text:
          "[Relevant context from memory: old recall]\n"
          + "[System context]\nlarge runtime preamble\n[End system context]\n\n"
          + "[telegram] sender-a (5:00 PM):\nfirst physical message",
      }, {
        type: "image",
        data: "aGVsbG8=",
        mimeType: "image/png",
      }],
      timestamp: FIRST.timestamp,
    } as never);
    appendAssistant(sessionManager, "first answer", FIRST.timestamp + 1);

    const result = projectInboundConversation(sessionManager);

    expect(result.ok).toBe(true);
    const projected = result.value.messages;
    expect(projected.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(textOf(projected[0]!)).toBe(
      "[telegram] sender-a (2026-09-10T00:26:40.001Z):\nfirst physical message",
    );
    expect(textOf(projected[0]!)).not.toContain("System context");
    expect(textOf(projected[0]!)).not.toContain("Relevant context from memory");
    expect((projected[0] as { content: unknown[] }).content[1]).toEqual({
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(textOf(result.value.sourceMessages[0]!)).toContain("System context");
    expect(result.value.diagnostics).toMatchObject({
      projectedUserMessages: 1,
      duplicateProvenanceEntries: 1,
      invalidProvenanceEntries: 0,
      incompleteProvenanceBatches: 0,
    });
  });

  it("replaces a rejected locale draft without dropping a matching user message", () => {
    const sessionManager = SessionManager.inMemory("/workspace");
    appendProvenance(sessionManager, FIRST);
    sessionManager.appendMessage({
      role: "user",
      content: "wrapped first request",
      timestamp: FIRST.timestamp,
    });
    appendAssistant(sessionManager, "טיוטה", FIRST.timestamp + 1);
    sessionManager.appendMessage({
      role: "user",
      content:
        "<response-locale-repair locale=\"und-Latn\">\n"
        + "runtime rewrite instruction\n</response-locale-repair>",
      timestamp: FIRST.timestamp + 2,
    });
    appendAssistant(sessionManager, "first answer", FIRST.timestamp + 3);

    const userAuthoredProtocolText = {
      ...SECOND,
      text: "<response-locale-repair locale=\"und-Latn\">typed by the user",
    } satisfies NormalizedMessage;
    appendProvenance(sessionManager, userAuthoredProtocolText);
    sessionManager.appendMessage({
      role: "user",
      content: "wrapped second request",
      timestamp: SECOND.timestamp,
    });
    appendAssistant(sessionManager, "second answer", SECOND.timestamp + 1);

    const result = projectInboundConversation(sessionManager);

    expect(result.ok).toBe(true);
    expect(result.value.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(result.value.messages.map(textOf)).toEqual([
      "[telegram] sender-a (2026-09-10T00:26:40.001Z):\nfirst physical message",
      "first answer",
      "[telegram] sender-b (2026-09-10T00:26:40.002Z):\n"
        + "<response-locale-repair locale=\"und-Latn\">typed by the user",
      "second answer",
    ]);
    expect(result.value.diagnostics.omittedLocaleRepairTurns).toBe(1);
  });
});
