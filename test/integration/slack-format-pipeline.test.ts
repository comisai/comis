// SPDX-License-Identifier: Apache-2.0
/**
 * SLACK-FMT: Slack Format Pipeline E2E Integration Test
 *
 * Validates the full markdown -> format -> chunk -> adapter pipeline for Slack.
 * Ensures single IR conversion (no double conversion) and multi-chunk
 * bold-to-italic corruption is eliminated.
 *
 *   SLACK-FMT-01: Single markdown message renders correct mrkdwn through pipeline
 *   SLACK-FMT-02: Multi-chunk message preserves bold without italic corruption
 *   SLACK-FMT-03: deliverToChannel with mock Slack adapter sends mrkdwn, not raw markdown
 */

import { describe, it, expect } from "vitest";
import { formatForChannel, deliverToChannel } from "@comis/channels";
import type { DeliveryAdapter } from "@comis/channels";
import { ok } from "@comis/shared";
import type { Result } from "@comis/shared";

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

describe("SLACK-FMT: Slack Format Pipeline E2E", () => {
  // SLACK-FMT-01
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

  // SLACK-FMT-02
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

  // SLACK-FMT-03
  it("deliverToChannel with mock Slack adapter sends mrkdwn, not raw markdown", async () => {
    const adapter = createMockSlackAdapter();

    const result = await deliverToChannel(
      adapter,
      "C-test-channel",
      "Hello **bold** and [link](https://example.com)",
      { origin: "test:slack-fmt-03" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // At least one chunk delivered
    expect(result.value.totalChunks).toBeGreaterThanOrEqual(1);
    expect(result.value.deliveredChunks).toBe(result.value.totalChunks);
    expect(result.value.failedChunks).toBe(0);

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
