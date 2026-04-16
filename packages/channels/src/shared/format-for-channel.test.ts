import { describe, it, expect } from "vitest";
import { formatForChannel } from "./format-for-channel.js";

describe("formatForChannel", () => {
  // -------------------------------------------------------------------------
  // Telegram (HTML conversion)
  // -------------------------------------------------------------------------

  it("converts markdown headings to HTML bold for telegram", () => {
    const result = formatForChannel("# Hello World", "telegram");
    expect(result).toContain("<b>Hello World</b>");
  });

  it("converts bold markdown to HTML for telegram", () => {
    const result = formatForChannel("This is **bold** text", "telegram");
    expect(result).toContain("<b>bold</b>");
  });

  it("converts markdown tables to code blocks for telegram", () => {
    const input = "| A | B |\n|---|---|\n| 1 | 2 |";
    const result = formatForChannel(input, "telegram");
    expect(result).toMatch(/<pre>|<code>/);
  });

  // -------------------------------------------------------------------------
  // Passthrough platforms (discord, gateway, echo) and Slack (IR-rendered)
  // -------------------------------------------------------------------------

  it("passes through unchanged for discord", () => {
    const input = "# Hello **World**";
    expect(formatForChannel(input, "discord")).toBe(input);
  });

  it("renders mrkdwn for slack (IR pipeline)", () => {
    const result = formatForChannel("# Hello **World**", "slack");
    // Heading rendered as bold in mrkdwn: *Hello World*
    expect(result).toContain("*Hello World*");
    // Should NOT contain raw markdown markers
    expect(result).not.toContain("# ");
    expect(result).not.toContain("**");
  });

  it("renders slack mrkdwn without double-conversion artifacts", () => {
    const result = formatForChannel("This is **bold** and *italic*", "slack");
    // Bold: *bold*, Italic: _italic_
    expect(result).toContain("*bold*");
    expect(result).toContain("_italic_");
    // No double-conversion: no _bold_ (bold->italic corruption)
    expect(result).not.toContain("_bold_");
  });

  it("passes through unchanged for gateway", () => {
    const input = "# Hello **World**";
    expect(formatForChannel(input, "gateway")).toBe(input);
  });

  it("passes through unchanged for echo", () => {
    const input = "# Hello **World**";
    expect(formatForChannel(input, "echo")).toBe(input);
  });

  // -------------------------------------------------------------------------
  // Other IR-rendered platforms
  // -------------------------------------------------------------------------

  it("renders plain text for signal", () => {
    const result = formatForChannel("# Hello **World**", "signal");
    expect(result).not.toContain("#");
    expect(result).not.toContain("**");
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("handles plain text input without mangling for telegram", () => {
    const input = "Task failed: something went wrong.\nRuntime: 5.2s";
    const result = formatForChannel(input, "telegram");
    expect(result).toContain("Task failed: something went wrong.");
    expect(result).toContain("Runtime: 5.2s");
  });

  it("handles empty string", () => {
    expect(formatForChannel("", "telegram")).toBe("");
  });

  it("handles unknown platform as passthrough", () => {
    const input = "# Hello";
    expect(formatForChannel(input, "unknown-platform")).toBe(input);
  });

  // -------------------------------------------------------------------------
  // HTML sanitization for plain-text surfaces
  // -------------------------------------------------------------------------

  it("sanitizes HTML tags for whatsapp", () => {
    const result = formatForChannel("<b>bold</b> text", "whatsapp");
    expect(result).toContain("*bold*");
    expect(result).not.toContain("<b>");
  });

  it("sanitizes HTML tags for signal", () => {
    const result = formatForChannel("<b>bold</b> text", "signal");
    expect(result).toContain("*bold*");
    expect(result).not.toContain("<b>");
  });

  it("sanitizes HTML tags for irc", () => {
    const result = formatForChannel("<b>bold</b> text", "irc");
    expect(result).not.toContain("<b>");
  });

  it("sanitizes HTML tags for imessage", () => {
    const result = formatForChannel("<i>italic</i>", "imessage");
    expect(result).toContain("_italic_");
    expect(result).not.toContain("<i>");
  });

  it("sanitizes HTML tags for line", () => {
    const result = formatForChannel("<b>bold</b>", "line");
    expect(result).toContain("*bold*");
    expect(result).not.toContain("<b>");
  });

  it("does NOT sanitize for telegram (uses HTML natively)", () => {
    // Telegram IR renderer produces HTML -- sanitizer must NOT strip it
    const result = formatForChannel("**bold**", "telegram");
    expect(result).toContain("<b>bold</b>");
  });

  it("does NOT sanitize for slack (uses mrkdwn)", () => {
    // Slack IR renderer produces mrkdwn -- sanitizer must NOT alter it
    const result = formatForChannel("**bold**", "slack");
    expect(result).toContain("*bold*");
    // Slack mrkdwn bold uses single asterisks, which is also the sanitizer format.
    // Key: the IR renderer produced *bold* directly, not via sanitizer.
    // Verify no entity decoding artifacts (Slack renderer escapes & < >)
    expect(result).not.toContain("&amp;");
  });

  it("does NOT sanitize for discord (passthrough)", () => {
    const input = "**bold** and *italic*";
    expect(formatForChannel(input, "discord")).toBe(input);
  });

  it("decodes HTML entities for whatsapp", () => {
    const result = formatForChannel("5 &amp; 3", "whatsapp");
    expect(result).toContain("5 & 3");
  });
});
