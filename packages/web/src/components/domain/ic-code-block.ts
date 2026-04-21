// SPDX-License-Identifier: Apache-2.0
import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sharedStyles, focusStyles } from "../../styles/shared.js";

// Side-effect import to register ic-icon
import "../display/ic-icon.js";

/** Keyword set for JavaScript/TypeScript highlighting. */
const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "import", "export", "from", "true", "false", "null", "undefined",
  "class", "new", "this", "async", "await", "throw", "try", "catch",
  "switch", "case", "break", "continue", "default", "typeof", "instanceof",
  "void", "delete", "in", "of", "yield", "static", "extends", "implements",
  "interface", "type", "enum", "abstract", "readonly",
]);

/**
 * Escape HTML special characters in a string.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Apply lightweight regex-based syntax highlighting.
 * Returns HTML string with span-wrapped tokens.
 */
function highlightCode(code: string, language: string): string {
  if (!language) return escapeHtml(code);

  const lang = language.toLowerCase();
  const escaped = escapeHtml(code);

  // Process in order: comments, strings, numbers, property keys, keywords
  let result = escaped;

  // Block comments (/* ... */)
  result = result.replace(
    /\/\*[\s\S]*?\*\//g,
    (m) => `<span class="hl-comment">${m}</span>`,
  );

  // Line comments (// ...)
  result = result.replace(
    /\/\/[^\n]*/g,
    (m) => {
      // Skip if already inside a span (block comment)
      if (m.includes("hl-comment")) return m;
      return `<span class="hl-comment">${m}</span>`;
    },
  );

  // Hash comments (# ...) for YAML, bash, python
  if (lang === "yaml" || lang === "yml" || lang === "bash" || lang === "sh" || lang === "python" || lang === "py") {
    result = result.replace(
      /(?:^|(?<=\n))(\s*#[^\n]*)/g,
      (m) => `<span class="hl-comment">${m}</span>`,
    );
  }

  // Strings (double-quoted)
  result = result.replace(
    /(?<!<span class=")(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g,
    (m) => {
      if (m.includes("hl-")) return m;
      return `<span class="hl-string">${m}</span>`;
    },
  );

  // Strings (single-quoted) -- avoid matching inside already highlighted spans
  result = result.replace(
    /(?<![=\w])('[^'\\]*(?:\\.[^'\\]*)*')/g,
    (m) => {
      if (m.includes("hl-")) return m;
      return `<span class="hl-string">${m}</span>`;
    },
  );

  // Numbers
  result = result.replace(
    /\b(\d+(?:\.\d+)?)\b/g,
    (m) => {
      if (m.includes("hl-")) return m;
      return `<span class="hl-number">${m}</span>`;
    },
  );

  // Property keys for JSON/YAML (word before colon)
  if (lang === "json" || lang === "yaml" || lang === "yml") {
    result = result.replace(
      /(?:^|(?<=\n))(\s*)(&quot;[\w.-]+&quot;)(\s*:)/gm,
      (_, indent, key, colon) => `${indent}<span class="hl-property">${key}</span>${colon}`,
    );
    // YAML unquoted keys
    if (lang === "yaml" || lang === "yml") {
      result = result.replace(
        /(?:^|(?<=\n))(\s*)([\w.-]+)(\s*:)/gm,
        (_, indent, key, colon) => {
          if (key.includes("hl-")) return _;
          return `${indent}<span class="hl-property">${key}</span>${colon}`;
        },
      );
    }
  }

  // Keywords (only for JS/TS-like languages)
  if (lang === "javascript" || lang === "js" || lang === "typescript" || lang === "ts" ||
      lang === "jsx" || lang === "tsx") {
    result = result.replace(
      /\b([a-z]+)\b/g,
      (m) => {
        if (JS_KEYWORDS.has(m)) {
          return `<span class="hl-keyword">${m}</span>`;
        }
        return m;
      },
    );
  }

  return result;
}

/**
 * Syntax-highlighted code block with copy-to-clipboard and language label.
 *
 * Renders code content with lightweight regex-based tokenization for
 * strings, numbers, keywords, comments, and property keys. Supports
 * a copy button with visual feedback.
 *
 * @example
 * ```html
 * <ic-code-block language="json" code='{"key": "value"}'></ic-code-block>
 * <ic-code-block language="typescript" .code=${snippet}></ic-code-block>
 * ```
 */
@customElement("ic-code-block")
export class IcCodeBlock extends LitElement {
  static override styles = [
    sharedStyles,
    focusStyles,
    css`
      :host {
        display: block;
      }

      .container {
        background: var(--ic-bg);
        border: 1px solid var(--ic-border);
        border-radius: var(--ic-radius-md);
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: var(--ic-surface-2);
        padding: var(--ic-space-xs) var(--ic-space-md);
        border-bottom: 1px solid var(--ic-border);
      }

      .language-label {
        font-size: var(--ic-text-xs);
        color: var(--ic-text-dim);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: 500;
      }

      .copy-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: none;
        border: none;
        color: var(--ic-text-dim);
        cursor: pointer;
        padding: 2px 4px;
        border-radius: var(--ic-radius-sm);
        font-size: var(--ic-text-xs);
        font-family: inherit;
        transition: color var(--ic-transition);
      }

      .copy-btn:hover {
        color: var(--ic-text);
      }

      .code-area {
        max-height: 24rem;
        overflow-y: auto;
        overflow-x: auto;
      }

      pre {
        margin: 0;
        padding: var(--ic-space-md);
      }

      code {
        font-family: var(--ic-font-mono);
        font-size: var(--ic-text-sm);
        line-height: 1.6;
        color: var(--ic-text);
        white-space: pre;
        tab-size: 2;
      }

      /* Syntax highlighting colors */
      .hl-string { color: #a5d6ff; }
      .hl-number { color: #79c0ff; }
      .hl-keyword { color: #ff7b72; }
      .hl-comment { color: var(--ic-text-dim); font-style: italic; }
      .hl-property { color: #7ee787; }
    `,
  ];

  /** The code content to display. */
  @property() code = "";

  /** Language label (e.g., "json", "yaml", "typescript"). Empty = plain text. */
  @property() language = "";

  /** Whether to show the copy button. */
  @property({ type: Boolean }) copyable = true;

  @state() private _copied = false;
  private _copyTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._copyTimer !== null) {
      clearTimeout(this._copyTimer);
      this._copyTimer = null;
    }
  }

  private async _handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.code);
      this._copied = true;
      if (this._copyTimer !== null) clearTimeout(this._copyTimer);
      this._copyTimer = setTimeout(() => {
        this._copied = false;
        this._copyTimer = null;
      }, 2000);
    } catch {
      // Clipboard write failed silently
    }
  }

  private _renderHeader() {
    if (!this.language && !this.copyable) return nothing;

    return html`
      <div class="header">
        <span class="language-label">${this.language || ""}</span>
        ${this.copyable
          ? html`
              <button
                class="copy-btn"
                @click=${this._handleCopy}
                aria-label="Copy code"
              >
                ${this._copied
                  ? html`<span>Copied!</span>`
                  : html`<ic-icon name="copy" size="14px"></ic-icon><span>Copy</span>`}
              </button>
            `
          : nothing}
      </div>
    `;
  }

  override render() {
    const highlighted = highlightCode(this.code, this.language);

    return html`
      <div class="container" role="region" aria-label="Code block">
        ${this._renderHeader()}
        <div class="code-area">
          <pre><code .innerHTML=${highlighted}></code></pre>
        </div>
      </div>
    `;
  }
}

/** Exported for testing. */
export { highlightCode };

declare global {
  interface HTMLElementTagNameMap {
    "ic-code-block": IcCodeBlock;
  }
}
