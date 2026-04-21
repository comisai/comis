// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { sharedStyles } from "../../styles/shared.js";
import { IcToast } from "../feedback/ic-toast.js";

// Side-effect imports to register child components
import "./ic-code-block.js";
import "../display/ic-icon.js";

/**
 * Sanitize HTML content to prevent XSS attacks.
 * Strips script tags, iframes, objects, embeds, forms,
 * on-event handlers, and javascript: URLs.
 */
function sanitizeHtml(text: string): string {
  let result = text;
  // Strip dangerous tags (case-insensitive)
  result = result.replace(/<\/?(?:script|iframe|object|embed|form)\b[^>]*>/gi, "");
  // Strip on* event handlers from any remaining HTML
  result = result.replace(/\bon\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");
  // Strip javascript: URLs
  result = result.replace(/javascript\s*:/gi, "");
  return result;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parse a markdown table into an HTML table string.
 */
function parseTable(lines: string[]): string {
  if (lines.length < 2) return lines.join("\n");

  const rows = lines.filter((l) => l.trim() !== "");
  // Second row must be separator
  if (rows.length < 2 || !/^\s*\|[\s-:|]+\|\s*$/.test(rows[1])) {
    return lines.join("\n");
  }

  const parseRow = (row: string): string[] =>
    row
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());

  const headerCells = parseRow(rows[0]);
  const dataRows = rows.slice(2);

  let tableHtml = '<table><thead><tr>';
  for (const cell of headerCells) {
    tableHtml += `<th>${cell}</th>`;
  }
  tableHtml += '</tr></thead><tbody>';
  for (const row of dataRows) {
    const cells = parseRow(row);
    tableHtml += '<tr>';
    for (const cell of cells) {
      tableHtml += `<td>${cell}</td>`;
    }
    tableHtml += '</tr>';
  }
  tableHtml += '</tbody></table>';
  return tableHtml;
}

/**
 * Render an attachment marker into inline HTML (image, audio, video, or download link).
 */
function renderAttachment(json: string, token: string): string {
  try {
    const { url, type, fileName } = JSON.parse(json) as {
      url: string;
      type: string;
      mimeType: string;
      fileName: string;
    };
    // Append auth token to relative /media/ URLs only (never external URLs)
    const authedUrl = (token && url.startsWith("/media/"))
      ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
      : url;
    const safeUrl = escapeHtml(authedUrl);
    const safeName = escapeHtml(fileName);
    switch (type) {
      case "image":
        return `<img src="${safeUrl}" alt="${safeName}" style="max-width:100%;border-radius:8px;margin:4px 0" loading="lazy" />`;
      case "audio":
        return `<audio controls src="${safeUrl}" style="width:100%;margin:4px 0"></audio>`;
      case "video":
        return `<video controls src="${safeUrl}" style="max-width:100%;border-radius:8px;margin:4px 0"></video>`;
      default:
        return `<a href="${safeUrl}" download="${safeName}" target="_blank" rel="noopener" class="md-link">${safeName}</a>`;
    }
  } catch {
    return "";
  }
}

/**
 * Lightweight markdown-to-HTML renderer.
 * Handles code fences, inline code, bold, italic, links, headings,
 * lists, tables, and line breaks.
 */
function renderMarkdown(text: string, token = ""): string {
  // Sanitize first
  let sanitized = sanitizeHtml(text);

  // 1. Code fences: ```lang\n...\n```
  const codeFenceBlocks: string[] = [];
  sanitized = sanitized.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const escapedCode = escapeHtml(code.replace(/\n$/, ""));
      const placeholder = `\x00CODE_BLOCK_${codeFenceBlocks.length}\x00`;
      codeFenceBlocks.push(
        `<ic-code-block language="${escapeHtml(lang)}" code="${escapedCode}"></ic-code-block>`,
      );
      return placeholder;
    },
  );

  // 2. Inline code: `code`
  sanitized = sanitized.replace(
    /`([^`]+)`/g,
    (_, code) => `<code class="inline-code">${escapeHtml(code)}</code>`,
  );

  // Process block-level elements line by line
  const lines = sanitized.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check for code block placeholder
    if (line.includes("\x00CODE_BLOCK_")) {
      // eslint-disable-next-line no-control-regex
      const match = line.match(/\x00CODE_BLOCK_(\d+)\x00/);
      if (match) {
        output.push(codeFenceBlocks[parseInt(match[1], 10)]);
        i++;
        continue;
      }
    }

    // Table detection: line starts with |
    if (/^\s*\|/.test(line)) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      output.push(parseTable(tableLines));
      continue;
    }

    // Headings: # H1 through #### H4 -> h3 through h6 (downshift by 2)
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 2, 6);
      output.push(`<h${level}>${processInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list: - item or * item
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(processInline(lines[i].replace(/^\s*[-*]\s+/, "")));
        i++;
      }
      output.push(`<ul>${items.map((it) => `<li>${it}</li>`).join("")}</ul>`);
      continue;
    }

    // Ordered list: 1. item
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(processInline(lines[i].replace(/^\s*\d+\.\s+/, "")));
        i++;
      }
      output.push(`<ol>${items.map((it) => `<li>${it}</li>`).join("")}</ol>`);
      continue;
    }

    // Empty line: paragraph break
    if (line.trim() === "") {
      output.push("<br><br>");
      i++;
      continue;
    }

    // Regular paragraph line
    output.push(processInline(line));
    i++;
  }

  let result = output.join("\n");

  // Replace attachment markers with rendered media elements
  // HTML comments survive sanitizeHtml and processInline unchanged
  result = result.replace(
    /<!-- attachment:(.*?) -->/g,
    (_, json) => renderAttachment(json, token),
  );

  return result;
}

/**
 * Process inline markdown: bold, italic, links.
 */
function processInline(text: string): string {
  let result = text;

  // Links: [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, linkText, url) =>
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="md-link">${linkText}</a>`,
  );

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_ (not inside bold/word)
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<em>$1</em>");
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<em>$1</em>");

  return result;
}

/**
 * Single chat message bubble for user/assistant/error/system roles.
 *
 * Renders user messages as plain text (right-aligned, accent background),
 * assistant messages with full markdown support (left-aligned, surface background),
 * error messages with red tint, and system messages centered and dimmed.
 *
 * Markdown support includes: bold, italic, inline code, links, headings,
 * unordered/ordered lists, tables, and code fences (delegated to ic-code-block).
 *
 * XSS protection: strips script, iframe, object, embed, form tags,
 * on* event handlers, and javascript: URLs before processing.
 *
 * @example
 * ```html
 * <ic-chat-message role="user" content="Hello!"></ic-chat-message>
 * <ic-chat-message role="assistant" content="**Bold** and `code`"></ic-chat-message>
 * ```
 */
@customElement("ic-chat-message")
export class IcChatMessage extends LitElement {
  static override styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .wrapper {
        display: flex;
        flex-direction: column;
        max-width: min(80%, 640px);
        width: fit-content;
        position: relative;
      }

      /* Role-specific alignment */
      .wrapper--user {
        align-self: flex-end;
        margin-left: auto;
      }

      .wrapper--assistant {
        align-self: flex-start;
        margin-right: auto;
      }

      .wrapper--error {
        align-self: flex-start;
        margin-right: auto;
      }

      .wrapper--system {
        align-self: center;
        max-width: 100%;
        text-align: center;
      }

      /* Bubble styles */
      .bubble {
        padding: var(--ic-space-sm) var(--ic-space-md);
        border-radius: var(--ic-radius-xl);
        font-size: var(--ic-text-sm);
        line-height: 1.6;
      }

      .bubble--user {
        background: var(--ic-accent);
        color: white;
        border-radius: var(--ic-radius-lg);
        border-bottom-right-radius: 4px;
        white-space: pre-wrap;
        word-break: break-word;
        padding: 6px 12px;
        line-height: 1.4;
      }

      .bubble--assistant {
        background: var(--ic-surface);
        color: var(--ic-text);
        border-bottom-left-radius: 4px;
      }

      .bubble--error {
        background: color-mix(in srgb, var(--ic-error) 15%, transparent);
        border: 1px solid var(--ic-error);
        color: var(--ic-text);
        border-bottom-left-radius: 4px;
      }

      .bubble--system {
        color: var(--ic-text-dim);
        font-size: var(--ic-text-xs);
        font-style: italic;
        padding: var(--ic-space-xs);
      }

      /* Timestamp */
      .timestamp {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        margin-top: 2px;
      }

      .wrapper--user .timestamp {
        text-align: right;
      }

      /* Markdown inline styles */
      .bubble--assistant code.inline-code,
      .bubble--error code.inline-code {
        background: var(--ic-surface-2);
        padding: 0.125em 0.375em;
        border-radius: var(--ic-radius-sm);
        font-family: var(--ic-font-mono);
        font-size: 0.9em;
      }

      .bubble--assistant strong,
      .bubble--error strong {
        font-weight: 600;
      }

      .bubble--assistant a.md-link,
      .bubble--error a.md-link {
        color: var(--ic-accent);
        text-decoration: none;
      }

      .bubble--assistant a.md-link:hover,
      .bubble--error a.md-link:hover {
        text-decoration: underline;
      }

      .bubble--assistant h3,
      .bubble--assistant h4,
      .bubble--assistant h5,
      .bubble--assistant h6,
      .bubble--error h3,
      .bubble--error h4,
      .bubble--error h5,
      .bubble--error h6 {
        margin: var(--ic-space-sm) 0;
        font-weight: 600;
        line-height: 1.3;
      }

      .bubble--assistant h3,
      .bubble--error h3 { font-size: 1.1em; }
      .bubble--assistant h4,
      .bubble--error h4 { font-size: 1.05em; }

      .bubble--assistant ul,
      .bubble--error ul {
        list-style: disc;
        padding-left: 1.5em;
        margin: var(--ic-space-xs) 0;
      }

      .bubble--assistant ol,
      .bubble--error ol {
        list-style: decimal;
        padding-left: 1.5em;
        margin: var(--ic-space-xs) 0;
      }

      .bubble--assistant table,
      .bubble--error table {
        border-collapse: collapse;
        border: 1px solid var(--ic-border);
        margin: var(--ic-space-xs) 0;
        width: 100%;
        font-size: var(--ic-text-xs);
      }

      .bubble--assistant th,
      .bubble--assistant td,
      .bubble--error th,
      .bubble--error td {
        padding: var(--ic-space-xs) var(--ic-space-sm);
        border: 1px solid var(--ic-border);
        text-align: left;
      }

      .bubble--assistant th,
      .bubble--error th {
        background: var(--ic-surface-2);
        font-weight: 600;
      }

      /* Inline attachment media */
      .bubble--assistant img {
        max-width: 100%;
        border-radius: var(--ic-radius-lg);
        margin: var(--ic-space-xs) 0;
      }

      .bubble--assistant audio,
      .bubble--assistant video {
        max-width: 100%;
        margin: var(--ic-space-xs) 0;
      }

      /* Code blocks inside messages */
      .bubble--assistant ic-code-block,
      .bubble--error ic-code-block {
        margin: var(--ic-space-xs) 0;
      }

      /* Message action buttons */
      .message-actions {
        position: absolute;
        top: -0.5rem;
        display: flex;
        gap: 2px;
        background: var(--ic-surface-2);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-sm);
        padding: 2px;
        box-shadow: var(--ic-shadow-sm);
        opacity: 0;
        transition: opacity var(--ic-transition);
        pointer-events: none;
        z-index: 1;
      }

      .wrapper--user .message-actions {
        right: 0;
      }

      .wrapper--assistant .message-actions,
      .wrapper--error .message-actions {
        left: 0;
      }

      .wrapper:hover .message-actions {
        opacity: 1;
        pointer-events: auto;
      }

      .action-btn {
        background: transparent;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 4px;
        border-radius: var(--ic-radius-sm);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: color var(--ic-transition);
      }

      .action-btn:hover {
        color: var(--ic-text);
      }
    `,
  ];

  /** Message sender role. */
  @property() role: "user" | "assistant" | "error" | "system" = "user";

  /** Raw message content (plain text or markdown). */
  @property() content = "";

  /** Unix timestamp in milliseconds. */
  @property({ type: Number }) timestamp = 0;

  /** Unique message identifier. */
  @property() messageId = "";

  /** Whether to show hover action buttons. */
  @property({ type: Boolean }) showActions = true;

  /** Auth token appended to relative /media/ URLs for authenticated media loading. */
  @property() mediaToken = "";

  private _handleCopy(): void {
    navigator.clipboard.writeText(this.content).then(() => {
      IcToast.show("Copied to clipboard", "success");
    // eslint-disable-next-line no-restricted-syntax
    }).catch(() => {
      // Silent fail if clipboard API is not available
    });
  }

  private _handleRetry(): void {
    this.dispatchEvent(new CustomEvent("retry", {
      detail: { messageId: this.messageId },
      bubbles: true,
      composed: true,
    }));
  }

  private _handleDelete(): void {
    this.dispatchEvent(new CustomEvent("delete", {
      detail: { messageId: this.messageId },
      bubbles: true,
      composed: true,
    }));
  }

  private _formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private _renderContent() {
    if (this.role === "user") {
      return this.content;
    }
    // Markdown rendering for assistant, error, system
    const rendered = renderMarkdown(this.content, this.mediaToken);
    return unsafeHTML(rendered);
  }

  private _renderActions() {
    if (!this.showActions || this.role === "system") return nothing;

    return html`
      <div class="message-actions">
        <button class="action-btn" aria-label="Copy message" @click=${this._handleCopy}>
          <ic-icon name="copy" size="14px"></ic-icon>
        </button>
        ${this.role === "assistant"
          ? html`
              <button class="action-btn" aria-label="Retry message" @click=${this._handleRetry}>
                <ic-icon name="retry" size="14px"></ic-icon>
              </button>
            `
          : nothing}
        <button class="action-btn" aria-label="Delete message" @click=${this._handleDelete}>
          <ic-icon name="trash" size="14px"></ic-icon>
        </button>
      </div>
    `;
  }

  override render() {
    const wrapperClass = `wrapper wrapper--${this.role}`;
    const bubbleClass = `bubble bubble--${this.role}`;

    return html`
      <div class=${wrapperClass} role="article" aria-label="${this.role} message">
        ${this._renderActions()}
        <div class=${bubbleClass}>${this._renderContent()}</div>
        ${this.timestamp > 0
          ? html`<span class="timestamp">${this._formatTime(this.timestamp)}</span>`
          : nothing}
      </div>
    `;
  }
}

/** Exported for testing. */
export { renderMarkdown, sanitizeHtml };

declare global {
  interface HTMLElementTagNameMap {
    "ic-chat-message": IcChatMessage;
  }
}
