// SPDX-License-Identifier: Apache-2.0
/**
 * Slack Format Pipeline E2E Integration Test
 *
 * Validates the full markdown -> format -> chunk -> adapter pipeline for Slack.
 * Ensures single IR conversion (no double conversion) and multi-chunk
 * bold-to-italic corruption is eliminated.
 *
 *   Single markdown message renders correct mrkdwn through pipeline
 *   Multi-chunk message preserves bold without italic corruption
 *   DeliveryService.deliverToChannel with mock Slack adapter sends mrkdwn, not raw markdown
 */

import { describe, it, expect } from "vitest";
import { formatForChannel } from "@comis/core";
import type {
  DeliveryAdapter,
  DeliveryAuthority,
  ChannelEndpoint,
  ConversationRef,
} from "@comis/core";
import { ok } from "@comis/shared";
import type { Result } from "@comis/shared";
import { makeDeliveryService } from "../support/factories.js";

// ---------------------------------------------------------------------------
// Mock adapter factory
// ---------------------------------------------------------------------------

interface CapturedMessage {
  channelId: string;
  text: string;
}

function createMockSlackAdapter(): DeliveryAdapter & { captured: CapturedMessage[] } {
  const captured: CapturedMessage[] = [];
  return {
    channelId: "test-instance",
    channelType: "slack",
    captured,
    async sendMessage(
      channelId: string,
      text: string,
    ): Promise<Result<string, Error>> {
      captured.push({ channelId, text });
      return ok("mock-ts-" + captured.length);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Slack Format Pipeline E2E", () => {
  it("single markdown message renders correct mrkdwn through pipeline", () => {
    const result = formatForChannel("**bold** and _italic_", "slack");

    // Bold in mrkdwn: *bold*
    expect(result).toContain("*bold*");
    // Italic in mrkdwn: _italic_
    expect(result).toContain("_italic_");
    // No double-conversion: bold should NOT become italic (_bold_)
    expect(result).not.toContain("_bold_");
    // No raw markdown markers
    expect(result).not.toContain("**bold**");
  });

  it("multi-chunk message preserves bold without italic corruption", () => {
    // Multi-paragraph with bold and italic in different paragraphs
    const input = [
      "# Summary",
      "",
      "This has **bold text** in the first paragraph.",
      "",
      "This has *italic text* in the second paragraph.",
      "",
      "And **more bold** with ~~strikethrough~~ at the end.",
    ].join("\n");

    const result = formatForChannel(input, "slack");

    // Heading rendered as bold in mrkdwn
    expect(result).toContain("*Summary*");

    // Bold stays bold (not corrupted to italic)
    expect(result).toContain("*bold text*");
    expect(result).toContain("*more bold*");

    // Italic stays italic
    expect(result).toContain("_italic text_");

    // Strikethrough rendered correctly
    expect(result).toContain("~strikethrough~");

    // No double-conversion artifacts
    expect(result).not.toContain("_bold text_");
    expect(result).not.toContain("_more bold_");
    expect(result).not.toContain("**bold text**");
    expect(result).not.toContain("**more bold**");
  });

  it("DeliveryService.deliverToChannel with mock Slack adapter sends mrkdwn, not raw markdown", async () => {
    const adapter = createMockSlackAdapter();
    const service = makeDeliveryService();

    // Delivery persistence requires explicit conversation authority + an exact
    // destination-endpoint snapshot (there is no active resolved-turn context in
    // this direct-call test). The endpoint must mirror adapter.channelType +
    // channelId so resolveDeliveryPersistenceScope accepts it.
    const authority: DeliveryAuthority = {
      tenantId: "tenant-test",
      agentId: "agent-test",
      conversationRef: `cv_${"A".repeat(43)}` as ConversationRef,
    };
    const destinationEndpoint: ChannelEndpoint = {
      channelType: adapter.channelType,
      channelInstanceId: "test-instance",
      conversationId: "C-test-channel",
      conversationKind: "direct",
    };

    const result = await service.deliverToChannel(
      adapter,
      "C-test-channel",
      "Hello **bold** and [link](https://example.com)",
      {
        completionMode: "settled",
        origin: "test:slack-fmt-03",
        authority,
        destinationEndpoint,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // At least one chunk delivered
    expect(result.value.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.value.chunks.every((chunk) => chunk.status === "accepted")).toBe(true);
    expect(result.value.platform).toMatchObject({
      status: "accepted",
      deliveredChunks: result.value.chunks.length,
    });
    expect(result.value.queueDisposition).toBe("settled");

    // Verify the mock adapter received mrkdwn, not raw markdown
    expect(adapter.captured.length).toBeGreaterThanOrEqual(1);
    const sentText = adapter.captured.map((c) => c.text).join("\n");

    // Bold rendered as mrkdwn *bold* (not **bold**)
    expect(sentText).toContain("*bold*");
    expect(sentText).not.toContain("**bold**");

    // Link rendered as Slack format <url|text> (not [text](url))
    expect(sentText).toContain("<https://example.com|link>");
    expect(sentText).not.toContain("[link](https://example.com)");

    // Channel ID passed correctly
    expect(adapter.captured[0].channelId).toBe("C-test-channel");
  });

  it("handles links with special characters correctly", () => {
    const result = formatForChannel(
      "[search](https://example.com?q=hello&lang=en)",
      "slack",
    );

    // Link should be in Slack format
    expect(result).toContain("<https://example.com?q=hello&lang=en|search>");
  });

  it("preserves code blocks unchanged through pipeline", () => {
    const input = [
      "Here is some code:",
      "",
      "```typescript",
      "const x = **notBold**;",
      "```",
    ].join("\n");

    const result = formatForChannel(input, "slack");

    // Code block content should NOT be converted
    expect(result).toContain("**notBold**");
    expect(result).toContain("```");
  });
});
