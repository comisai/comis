/**
 * Platform-aware markdown format conversion for outbound messages.
 *
 * Converts markdown text to the appropriate format for each platform:
 * - **Telegram**: HTML (headings become bold, tables become code blocks)
 * - **Signal, WhatsApp, iMessage, LINE, IRC**: Platform-specific plain text
 *   with HTML sanitization (strips LLM-produced HTML tags)
 * - **Discord**: Passthrough (renders markdown natively)
 * - **Slack**: mrkdwn (via IR pipeline -- bold `*`, italic `_`, links `<url|text>`)
 * - **Gateway**: Passthrough (web client renders markdown)
 * - **Echo**: Passthrough (testing adapter)
 * - **Unknown**: Passthrough (safe default for dynamic plugins)
 *
 * @module
 */

import { parseMarkdownToIR } from "./markdown-ir.js";
import { renderIR } from "./ir-renderer.js";
import { isPlainTextSurface, sanitizeForPlainText } from "./sanitize-for-plain-text.js";

/**
 * Platforms that require IR-based rendering before delivery.
 *
 * These platforms either don't support raw markdown or have their own
 * formatting system (HTML, control codes, etc.) that the IR renderer
 * converts to.
 */
const PLATFORMS_NEEDING_IR_RENDER = new Set([
  "telegram",
  "signal",
  "whatsapp",
  "imessage",
  "line",
  "irc",
  "slack",
  "email",
]);

/**
 * Convert markdown text to platform-specific format.
 *
 * For platforms in `PLATFORMS_NEEDING_IR_RENDER`, parses the text through
 * the Markdown IR pipeline and renders to the target format. For all other
 * platforms (discord, slack, gateway, echo, unknown), returns text unchanged.
 *
 * @param text - The markdown text to convert
 * @param channelType - Target platform identifier (e.g. "telegram", "discord")
 * @returns Formatted string for the target platform
 */
export function formatForChannel(text: string, channelType: string): string {
  if (!text) return text;

  if (!PLATFORMS_NEEDING_IR_RENDER.has(channelType)) {
    return text;
  }

  const ir = parseMarkdownToIR(text);
  const rendered = renderIR(ir, channelType);

  // Strip HTML tags that the IR pipeline passed through for plain-text surfaces.
  // The IR pipeline converts markdown but LLMs sometimes produce raw HTML.
  if (isPlainTextSurface(channelType)) {
    return sanitizeForPlainText(rendered);
  }

  return rendered;
}
