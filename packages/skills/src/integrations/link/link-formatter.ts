/**
 * Link content formatting and prompt injection.
 *
 * Formats fetched link content for display and wraps it as external
 * untrusted content before injecting into agent prompts.
 *
 * @module
 */

import { wrapExternalContent, type WrapExternalContentOptions } from "@comis/core";

export interface LinkResult {
  /** Page title */
  title: string;
  /** Clean readable content */
  content: string;
  /** Source URL */
  url: string;
}

/**
 * Format an array of link results into a readable text block.
 *
 * Each result is rendered as a markdown link header followed by the content.
 * Results are separated by horizontal rules. Empty results are filtered out.
 *
 * @param results - Array of fetched link results
 * @returns Formatted text block, or empty string if no results
 */
export function formatLinkContext(results: LinkResult[]): string {
  const blocks = results
    .filter((r) => r.content.trim().length > 0)
    .map((r) => {
      const title = r.title.trim() || r.url;
      const content = r.content.trim();
      return `[Link: ${title}](${r.url})\n${content}`;
    });

  if (blocks.length === 0) {
    return "";
  }

  return blocks.join("\n\n---\n\n");
}

/**
 * Inject link context into the original message text.
 *
 * Wraps the link context as external untrusted content
 * before appending it to the original text. This ensures the LLM treats
 * fetched web content as untrusted and does not follow instructions within it.
 *
 * @param originalText - The original message text
 * @param linkContext - Formatted link context from formatLinkContext()
 * @returns Original text with wrapped link context appended, or unchanged if empty
 */
export function injectLinkContext(
  originalText: string,
  linkContext: string,
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"],
): string {
  if (!linkContext) {
    return originalText;
  }

  // Wrap fetched URL content as external untrusted content
  const wrapped = wrapExternalContent(linkContext, {
    source: "web_fetch",
    includeWarning: true,
    onSuspiciousContent,
  });

  return `${originalText}\n\n--- Linked Content ---\n\n${wrapped}`;
}
