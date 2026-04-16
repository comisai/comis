/**
 * IR Renderer — Platform-specific rendering from MarkdownIR.
 *
 * Dispatches to per-platform renderers that convert the shared MarkdownIR
 * into Discord Markdown, Slack mrkdwn, Telegram HTML, or WhatsApp format.
 *
 * @module
 */

import type { MarkdownIR, MarkdownBlock, MarkdownSpan } from "./markdown-ir.js";
import { guardTelegramFileRefs, isTelegramFileGuardEnabled } from "./telegram-file-ref-guard.js";

// ---------------------------------------------------------------------------
// Shared table helper
// ---------------------------------------------------------------------------

/**
 * Build aligned plain-text table content (without code fence wrappers).
 * Used by Telegram, WhatsApp, Signal, iMessage, and LINE renderers.
 */
function buildAlignedTableText(headers: string[], rows: string[][]): string {
  if (headers.length === 0 && rows.length === 0) return "";

  const colCount = headers.length;
  const widths: number[] = headers.map((h) => h.length);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? "";
      widths[c] = Math.max(widths[c] ?? 0, cell.length);
    }
  }

  const pad = (text: string, colIdx: number): string => {
    const w = widths[colIdx] ?? 0;
    return text.padEnd(w);
  };

  const lines: string[] = [];
  lines.push(headers.map((h, i) => pad(h, i)).join("  "));
  lines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    lines.push(headers.map((_, i) => pad(row[i] ?? "", i)).join("  "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a MarkdownIR to a platform-specific string.
 *
 * @param ir - The parsed Markdown IR
 * @param platform - Target platform identifier
 * @returns Formatted string for the target platform
 */
export function renderIR(ir: MarkdownIR, platform: string): string {
  switch (platform) {
    case "discord":
      return renderForDiscord(ir);
    case "slack":
      return renderForSlack(ir);
    case "telegram":
      return renderForTelegram(ir);
    case "whatsapp":
      return renderForWhatsApp(ir);
    case "signal":
      return renderForSignal(ir);
    case "imessage":
      return renderForIMessage(ir);
    case "line":
      return renderForLine(ir);
    case "irc":
      return renderForIrc(ir);
    case "email":
      return renderForEmail(ir);
    default:
      // Graceful fallback for unknown dynamic plugins — plain text output
      return renderPlainText(ir);
  }
}

// ---------------------------------------------------------------------------
// Discord renderer (standard Markdown)
// ---------------------------------------------------------------------------

export function renderForDiscord(ir: MarkdownIR): string {
  return ir.blocks.map(renderDiscordBlock).join("\n\n");
}

function renderDiscordBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph":
      return renderDiscordSpans(block.spans);
    case "code_block":
      return renderDiscordCodeBlock(block);
    case "heading":
      return `${"#".repeat(block.depth ?? 1)} ${renderDiscordSpans(block.spans)}`;
    case "blockquote":
      return `> ${renderDiscordSpans(block.spans)}`;
    case "table":
      return renderDiscordTable(block);
    case "list":
      return renderDiscordList(block);
  }
}

function renderDiscordSpans(spans: MarkdownSpan[]): string {
  return spans.map(renderDiscordSpan).join("");
}

function renderDiscordSpan(span: MarkdownSpan): string {
  switch (span.type) {
    case "text":
      return span.text;
    case "bold":
      return `**${span.text}**`;
    case "italic":
      return `*${span.text}*`;
    case "code":
      return `\`${span.text}\``;
    case "strikethrough":
      return `~~${span.text}~~`;
    case "link":
      return `[${span.text}](${span.url})`;
    default:
      return span.text;
  }
}

function renderDiscordCodeBlock(block: MarkdownBlock): string {
  const lang = block.language ?? "";
  return `\`\`\`${lang}\n${block.raw ?? ""}\n\`\`\``;
}

function renderDiscordTable(block: MarkdownBlock): string {
  // Passthrough as GFM table (Discord renders nothing special)
  const headers = block.headers ?? [];
  const rows = block.rows ?? [];
  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

function renderDiscordList(block: MarkdownBlock): string {
  const items = block.items ?? [];
  return items
    .map((item, idx) => {
      const prefix = block.ordered ? `${idx + 1}. ` : "- ";
      return `${prefix}${renderDiscordSpans(item.spans)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Slack renderer (mrkdwn)
// ---------------------------------------------------------------------------

export function renderForSlack(ir: MarkdownIR): string {
  return ir.blocks.map(renderSlackBlock).join("\n\n");
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderSlackBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph":
      return renderSlackSpans(block.spans);
    case "code_block":
      return `\`\`\`\n${block.raw ?? ""}\n\`\`\``;
    case "heading":
      // Slack has no headings -- render as bold
      return `*${renderSlackSpansRaw(block.spans)}*`;
    case "blockquote":
      return `&gt; ${renderSlackSpans(block.spans)}`;
    case "table":
      return renderSlackTable(block);
    case "list":
      return renderSlackList(block);
  }
}

/** Render spans with Slack escaping. */
function renderSlackSpans(spans: MarkdownSpan[]): string {
  return spans.map(renderSlackSpan).join("");
}

/** Render spans for use inside Slack formatting markers (no double-escaping). */
function renderSlackSpansRaw(spans: MarkdownSpan[]): string {
  return spans.map((s) => s.text).join("");
}

function renderSlackSpan(span: MarkdownSpan): string {
  switch (span.type) {
    case "text":
      return escapeSlackText(span.text);
    case "bold":
      return `*${span.text}*`;
    case "italic":
      return `_${span.text}_`;
    case "code":
      return `\`${span.text}\``;
    case "strikethrough":
      return `~${span.text}~`;
    case "link":
      return `<${span.url}|${span.text}>`;
    default:
      return escapeSlackText(span.text);
  }
}

function renderSlackTable(block: MarkdownBlock): string {
  // Passthrough raw
  const headers = block.headers ?? [];
  const rows = block.rows ?? [];
  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

function renderSlackList(block: MarkdownBlock): string {
  const items = block.items ?? [];
  return items
    .map((item, idx) => {
      const prefix = block.ordered ? `${idx + 1}. ` : "- ";
      return `${prefix}${renderSlackSpansRaw(item.spans)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Telegram renderer (HTML)
// ---------------------------------------------------------------------------

export function renderForTelegram(ir: MarkdownIR): string {
  return ir.blocks.map(renderTelegramBlock).join("\n\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderTelegramBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph":
      return renderTelegramSpans(block.spans);
    case "code_block":
      return renderTelegramCodeBlock(block);
    case "heading":
      // Telegram has no heading tags -- render as bold
      return `<b>${renderTelegramSpans(block.spans)}</b>`;
    case "blockquote":
      return `<blockquote>${renderTelegramSpans(block.spans)}</blockquote>`;
    case "table":
      return renderTelegramTable(block);
    case "list":
      return renderTelegramList(block);
  }
}

function renderTelegramSpans(spans: MarkdownSpan[]): string {
  return spans.map(renderTelegramSpan).join("");
}

function renderTelegramSpan(span: MarkdownSpan): string {
  const escaped = escapeHtml(span.text);
  switch (span.type) {
    case "text":
      return isTelegramFileGuardEnabled() ? guardTelegramFileRefs(escaped) : escaped;
    case "bold":
      return `<b>${escaped}</b>`;
    case "italic":
      return `<i>${escaped}</i>`;
    case "code":
      return `<code>${escaped}</code>`;
    case "strikethrough":
      return `<s>${escaped}</s>`;
    case "link":
      return `<a href="${span.url}">${escaped}</a>`;
    default:
      return escaped;
  }
}

function renderTelegramCodeBlock(block: MarkdownBlock): string {
  const raw = escapeHtml(block.raw ?? "");
  if (block.language) {
    return `<pre><code class="language-${block.language}">${raw}</code></pre>`;
  }
  return `<pre><code>${raw}</code></pre>`;
}

function renderTelegramTable(block: MarkdownBlock): string {
  // Render as monospace code block for readability (Telegram has no GFM tables)
  const headers = block.headers ?? [];
  const rows = block.rows ?? [];
  const raw = buildAlignedTableText(headers, rows);
  return `<pre><code>${escapeHtml(raw)}</code></pre>`;
}

function renderTelegramList(block: MarkdownBlock): string {
  const items = block.items ?? [];
  return items
    .map((item, idx) => {
      const prefix = block.ordered ? `${idx + 1}. ` : "- ";
      return `${prefix}${renderTelegramSpans(item.spans)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// WhatsApp renderer
// ---------------------------------------------------------------------------

export function renderForWhatsApp(ir: MarkdownIR): string {
  return ir.blocks.map(renderWhatsAppBlock).join("\n\n");
}

function renderWhatsAppBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph":
      return renderWhatsAppSpans(block.spans);
    case "code_block":
      return `\`\`\`\n${block.raw ?? ""}\n\`\`\``;
    case "heading":
      // WhatsApp has no headings -- render as bold
      return `*${renderWhatsAppSpansRaw(block.spans)}*`;
    case "blockquote":
      return `> ${renderWhatsAppSpans(block.spans)}`;
    case "table":
      return renderWhatsAppTable(block);
    case "list":
      return renderWhatsAppList(block);
  }
}

function renderWhatsAppSpans(spans: MarkdownSpan[]): string {
  return spans.map(renderWhatsAppSpan).join("");
}

/** Plain text rendering for inside formatting markers. */
function renderWhatsAppSpansRaw(spans: MarkdownSpan[]): string {
  return spans.map((s) => s.text).join("");
}

function renderWhatsAppSpan(span: MarkdownSpan): string {
  switch (span.type) {
    case "text":
      return span.text;
    case "bold":
      return `*${span.text}*`;
    case "italic":
      return `_${span.text}_`;
    case "code":
      return `\`${span.text}\``;
    case "strikethrough":
      return `~${span.text}~`;
    case "link":
      // WhatsApp auto-links URLs. When text differs from URL, format as "text: url"
      if (span.text === span.url) {
        return span.url ?? span.text;
      }
      return `${span.text}: ${span.url}`;
    default:
      return span.text;
  }
}

function renderWhatsAppTable(block: MarkdownBlock): string {
  // Render as code block for readability (WhatsApp has no GFM tables)
  const headers = block.headers ?? [];
  const rows = block.rows ?? [];
  const raw = buildAlignedTableText(headers, rows);
  return "```\n" + raw + "\n```";
}

function renderWhatsAppList(block: MarkdownBlock): string {
  const items = block.items ?? [];
  return items
    .map((item, idx) => {
      const prefix = block.ordered ? `${idx + 1}. ` : "- ";
      return `${prefix}${renderWhatsAppSpansRaw(item.spans)}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Email renderer (inline-CSS HTML)
// ---------------------------------------------------------------------------

export function renderForEmail(ir: MarkdownIR): string {
  const body = ir.blocks.map(renderEmailBlock).join("\n");
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5; color: #333;">${body}</div>`;
}

function escapeEmailHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmailBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph":
      return `<p style="margin: 0 0 12px 0;">${renderEmailSpans(block.spans)}</p>`;
    case "code_block":
      return `<pre style="background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; font-family: monospace; font-size: 13px;"><code>${escapeEmailHtml(block.raw ?? "")}</code></pre>`;
    case "heading":
      return `<p style="margin: 16px 0 8px 0; font-weight: bold; font-size: ${block.depth === 1 ? "18px" : "16px"};">${renderEmailSpans(block.spans)}</p>`;
    case "blockquote":
      return `<blockquote style="margin: 8px 0; padding-left: 12px; border-left: 3px solid #ddd; color: #666;">${renderEmailSpans(block.spans)}</blockquote>`;
    case "table":
      return renderEmailTable(block);
    case "list":
      return renderEmailList(block);
  }
}

function renderEmailSpans(spans: MarkdownSpan[]): string {
  return spans.map(renderEmailSpan).join("");
}

function renderEmailSpan(span: MarkdownSpan): string {
  const escaped = escapeEmailHtml(span.text);
  switch (span.type) {
    case "text":
      return escaped;
    case "bold":
      return `<b>${escaped}</b>`;
    case "italic":
      return `<i>${escaped}</i>`;
    case "code":
      return `<code style="background: #f5f5f5; padding: 2px 4px; border-radius: 3px; font-family: monospace; font-size: 13px;">${escaped}</code>`;
    case "strikethrough":
      return `<s>${escaped}</s>`;
    case "link":
      return `<a href="${escapeEmailHtml(span.url ?? "")}" style="color: #0066cc;">${escaped}</a>`;
    default:
      return escaped;
  }
}

function renderEmailTable(block: MarkdownBlock): string {
  const headers = block.headers ?? [];
  const rows = block.rows ?? [];
  const headerCells = headers
    .map((h) => `<th style="border-bottom: 2px solid #ddd; padding: 8px; text-align: left;">${escapeEmailHtml(h)}</th>`)
    .join("");
  const bodyRows = rows
    .map((row) => {
      const cells = row
        .map((cell) => `<td style="border-bottom: 1px solid #eee; padding: 8px;">${escapeEmailHtml(cell)}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table style="border-collapse: collapse; width: 100%;"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function renderEmailList(block: MarkdownBlock): string {
  const items = block.items ?? [];
  const tag = block.ordered ? "ol" : "ul";
  const listItems = items
    .map((item) => `<li style="margin: 4px 0;">${renderEmailSpans(item.spans)}</li>`)
    .join("");
  return `<${tag} style="margin: 8px 0; padding-left: 24px;">${listItems}</${tag}>`;
}

// ---------------------------------------------------------------------------
// Shared plain-text block renderer
// ---------------------------------------------------------------------------

/**
 * Render a single block as plain text.
 * Reused by Signal, iMessage, and LINE renderers.
 */
function renderPlainTextBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph":
      return renderPlainTextSpans(block.spans);
    case "code_block":
      return `\`\`\`\n${block.raw ?? ""}\n\`\`\``;
    case "heading":
      return `${renderPlainTextSpans(block.spans).toUpperCase()}`;
    case "blockquote":
      return `> ${renderPlainTextSpans(block.spans)}`;
    case "table":
      return renderPlainTextTable(block);
    case "list":
      return renderPlainTextList(block);
  }
}

function renderPlainTextSpans(spans: MarkdownSpan[]): string {
  return spans.map((s) => s.text).join("");
}

function renderPlainTextTable(block: MarkdownBlock): string {
  // Render as code block for readability (Signal/iMessage/LINE have no GFM tables)
  const headers = block.headers ?? [];
  const rows = block.rows ?? [];
  const raw = buildAlignedTableText(headers, rows);
  return "```\n" + raw + "\n```";
}

function renderPlainTextList(block: MarkdownBlock): string {
  const items = block.items ?? [];
  return items
    .map((item, idx) => {
      const prefix = block.ordered ? `${idx + 1}. ` : "- ";
      return `${prefix}${renderPlainTextSpans(item.spans)}`;
    })
    .join("\n");
}

/**
 * Render a full MarkdownIR as plain text.
 * Used as the default fallback for unknown platforms.
 */
function renderPlainText(ir: MarkdownIR): string {
  return ir.blocks.map(renderPlainTextBlock).join("\n\n");
}

// ---------------------------------------------------------------------------
// Signal renderer (plain text — byte-offset styles handled in adapter)
// ---------------------------------------------------------------------------

export function renderForSignal(ir: MarkdownIR): string {
  return ir.blocks.map(renderPlainTextBlock).join("\n\n");
}

// ---------------------------------------------------------------------------
// iMessage renderer (plain text — no formatting support in automation)
// ---------------------------------------------------------------------------

export function renderForIMessage(ir: MarkdownIR): string {
  return ir.blocks.map(renderPlainTextBlock).join("\n\n");
}

// ---------------------------------------------------------------------------
// LINE renderer (plain text — rich content uses Flex Messages)
// ---------------------------------------------------------------------------

export function renderForLine(ir: MarkdownIR): string {
  return ir.blocks.map(renderPlainTextBlock).join("\n\n");
}

// ---------------------------------------------------------------------------
// IRC renderer (control code formatting)
// ---------------------------------------------------------------------------

export function renderForIrc(ir: MarkdownIR): string {
  return ir.blocks.map(renderIrcBlock).join("\n\n");
}

function renderIrcBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph":
      return renderIrcSpans(block.spans);
    case "code_block":
      return (block.raw ?? "")
        .split("\n")
        .map((line) => `| ${line}`)
        .join("\n");
    case "heading":
      // Bold heading
      return `\x02${renderIrcSpansRaw(block.spans)}\x02`;
    case "blockquote":
      return `> ${renderIrcSpans(block.spans)}`;
    case "table":
      return renderIrcTable(block);
    case "list":
      return renderIrcList(block);
  }
}

function renderIrcSpans(spans: MarkdownSpan[]): string {
  return spans.map(renderIrcSpan).join("");
}

function renderIrcSpansRaw(spans: MarkdownSpan[]): string {
  return spans.map((s) => s.text).join("");
}

function renderIrcSpan(span: MarkdownSpan): string {
  switch (span.type) {
    case "text":
      return span.text;
    case "bold":
      return `\x02${span.text}\x02`;
    case "italic":
      return `\x1D${span.text}\x1D`;
    case "code":
      // No inline code formatting in IRC — plain text
      return span.text;
    case "strikethrough":
      // No strikethrough in IRC — plain text
      return span.text;
    case "link":
      if (span.text === span.url) {
        return span.url ?? span.text;
      }
      return `${span.text} (${span.url})`;
    default:
      return span.text;
  }
}

function renderIrcTable(block: MarkdownBlock): string {
  const headers = block.headers ?? [];
  const rows = block.rows ?? [];
  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

function renderIrcList(block: MarkdownBlock): string {
  const items = block.items ?? [];
  return items
    .map((item, idx) => {
      const prefix = block.ordered ? `${idx + 1}. ` : "- ";
      return `${prefix}${renderIrcSpansRaw(item.spans)}`;
    })
    .join("\n");
}
