// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix text transforms: a pure outbound markdown renderer and a pure inbound
 * HTML sanitizer. No I/O, no SDK — both are total functions of their input.
 *
 * Outbound: `renderMarkdownToMatrixHtml` turns the agent's markdown into the
 * two fields an `m.room.message` carries — a plaintext `body` fallback and an
 * `org.matrix.custom.html` `formattedBody`. This channel is not in the delivery
 * pipeline's markdown-render set, so the adapter renders markdown itself here.
 * Every text node is HTML-escaped and only a fixed set of formatting tags is
 * emitted, so agent text can never inject active markup, and a link whose
 * scheme is not http(s)/mxc is degraded to plain text.
 *
 * Inbound: `sanitizeInboundHtml` reduces a federated, attacker-controlled
 * `formatted_body` to a safe subset before any of it is carried into the
 * normalized message — script/style/iframe/object/embed elements are removed
 * with their contents, `on*` event-handler attributes are stripped, `href`/
 * `src` values whose scheme is not http(s)/mxc are dropped, and any tag outside
 * a small allowlist has its markup removed (its text is kept). When in doubt it
 * strips rather than preserves. This is defense-in-depth: the executor
 * pipeline's central `wrapExternalContent` remains the primary prompt-injection
 * barrier for external text flowing into a prompt.
 *
 * @module
 */

/** The HTML formatting tags the inbound sanitizer keeps; every other tag's markup is removed. */
const ALLOWED_INBOUND_TAGS = new Set<string>([
  "a", "b", "strong", "i", "em", "u", "s", "del", "code", "pre", "blockquote",
  "p", "br", "hr", "span", "div", "ul", "ol", "li", "sub", "sup", "img",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td", "caption",
]);

/**
 * Elements removed with their entire contents — active or embedding markup.
 * A paired form (open + matching close via a backreference) removes the element
 * and its body; an orphan form removes any leftover open/close/void tag.
 */
const DANGEROUS_PAIRED =
  /<(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const DANGEROUS_ORPHAN =
  /<\/?(?:script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>/gi;

/** The two fields an `m.room.message` carries for formatted text. */
export interface MatrixFormattedText {
  /** Plaintext fallback for clients that do not render `org.matrix.custom.html`. */
  body: string;
  /** The `org.matrix.custom.html` rendering. */
  formattedBody: string;
}

/** Escape the HTML-significant characters in a text node. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Whether a URL is safe to keep as an `href`/`src`. Relative URLs (no scheme)
 * are safe; an absolute URL is safe only when its scheme is http(s) or mxc.
 * Whitespace is removed before the scheme is read so a scheme cannot be hidden
 * with embedded tabs or newlines (which HTML URL parsing ignores).
 */
function isSafeUrl(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  const schemeMatch = normalized.match(/^([a-z][a-z0-9+.-]*):/);
  if (schemeMatch === null) return true; // relative URL — no scheme to distrust
  const scheme = schemeMatch[1];
  return scheme === "http" || scheme === "https" || scheme === "mxc";
}

/**
 * Render inline markdown within one line of already-block-classified text.
 * Text is HTML-escaped first, then a fixed set of inline constructs is turned
 * into safe tags: inline code, links (safe-scheme only), bold, and italic.
 */
function renderInline(text: string): string {
  let out = escapeHtml(text);
  // Inline code first so its contents are not re-interpreted as emphasis.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);
  // Links: keep only a safe scheme; otherwise degrade to the plain label.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const href = url.trim();
    if (!isSafeUrl(href)) return label;
    return `<a href="${href.replace(/"/g, "&quot;")}">${label}</a>`;
  });
  // Bold before italic so `**x**` is not consumed by the single-asterisk rule.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out;
}

/**
 * Render outbound markdown to a Matrix plaintext `body` and an
 * `org.matrix.custom.html` `formattedBody`.
 *
 * The `body` is the raw markdown source — the plaintext fallback a client shows
 * when it ignores the HTML. The `formattedBody` is a minimal, safe HTML
 * rendering: text nodes are escaped and only known formatting tags are emitted.
 *
 * @param md - The markdown text produced by the agent.
 */
export function renderMarkdownToMatrixHtml(md: string): MatrixFormattedText {
  const lines = md.split(/\r?\n/);
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: contents are literal, never inline-rendered.
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence
      blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote — consecutive `>` lines.
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(renderInline(lines[i].replace(/^>\s?/, "")));
        i++;
      }
      blocks.push(`<blockquote>${quoted.join("<br>")}</blockquote>`);
      continue;
    }

    // Unordered list — consecutive `-`/`*` bullets.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list — consecutive `N.` items.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Blank line — a paragraph separator, emits nothing on its own.
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // Paragraph — consecutive plain lines joined with a line break. Emitted
    // without a wrapping <p> so a single plain line renders as bare text.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !lines[i].startsWith("```") &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i])
    ) {
      para.push(renderInline(lines[i]));
      i++;
    }
    blocks.push(para.join("<br>"));
  }

  return { body: md, formattedBody: blocks.join("") };
}

/**
 * Sanitize an inbound `formatted_body` to a safe HTML subset.
 *
 * @param html - The attacker-controllable HTML from a federated event.
 * @returns HTML reduced to a safe subset — safe to carry into a normalized
 *   message (and still wrapped downstream by `wrapExternalContent`).
 */
export function sanitizeInboundHtml(html: string): string {
  let out = html;

  // Remove active/embedding elements together with their contents, then any
  // orphan open/close/void tag of the same name that a nested structure left.
  out = out.replace(DANGEROUS_PAIRED, "");
  out = out.replace(DANGEROUS_ORPHAN, "");

  // Strip `on*` event-handler attributes (quoted and unquoted forms).
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");

  // Drop `href`/`src` attributes whose scheme is not http(s)/mxc.
  out = out.replace(
    /\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (match, dq: string | undefined, sq: string | undefined) => {
      const value = dq ?? sq ?? "";
      return isSafeUrl(value) ? match : "";
    },
  );

  // Remove markup for any tag outside the allowlist, keeping its text content.
  out = out.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g,
    (match, tag: string) => (ALLOWED_INBOUND_TAGS.has(tag.toLowerCase()) ? match : ""),
  );

  return out;
}
