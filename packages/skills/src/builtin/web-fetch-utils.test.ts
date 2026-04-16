import { describe, it, expect } from "vitest";
import {
  htmlToMarkdown,
  markdownToText,
  detectErrorPagePattern,
  truncateText,
  extractReadableContent,
} from "./web-fetch-utils.js";

// ---------------------------------------------------------------------------
// htmlToMarkdown
// ---------------------------------------------------------------------------

describe("htmlToMarkdown", () => {
  it("strips script tags completely", () => {
    const html = "<p>Hello</p><script>alert('xss')</script><p>World</p>";
    const { text } = htmlToMarkdown(html);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("script");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
  });

  it("strips style tags completely", () => {
    const html = "<style>body { color: red; }</style><p>Content</p>";
    const { text } = htmlToMarkdown(html);
    expect(text).not.toContain("color");
    expect(text).toContain("Content");
  });

  it("strips noscript tags completely", () => {
    const html = "<noscript>Please enable JS</noscript><p>Main</p>";
    const { text } = htmlToMarkdown(html);
    expect(text).not.toContain("enable JS");
    expect(text).toContain("Main");
  });

  it("converts <a> with text to markdown link", () => {
    const html = '<a href="https://example.com">Example</a>';
    const { text } = htmlToMarkdown(html);
    expect(text).toBe("[Example](https://example.com)");
  });

  it("converts <a> with empty label to plain URL", () => {
    const html = '<a href="https://example.com"></a>';
    const { text } = htmlToMarkdown(html);
    expect(text).toBe("https://example.com");
  });

  it("converts h1 through h6 to markdown headings", () => {
    for (let level = 1; level <= 6; level++) {
      const html = `<h${level}>Heading ${level}</h${level}>`;
      const { text } = htmlToMarkdown(html);
      const prefix = "#".repeat(level);
      expect(text).toContain(`${prefix} Heading ${level}`);
    }
  });

  it("converts <li> items to dash-prefixed lines", () => {
    const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
    const { text } = htmlToMarkdown(html);
    expect(text).toContain("- Item 1");
    expect(text).toContain("- Item 2");
  });

  it("converts <br> and <hr> to newlines", () => {
    const html = "Line 1<br/>Line 2<hr>Line 3";
    const { text } = htmlToMarkdown(html);
    expect(text).toContain("Line 1");
    expect(text).toContain("Line 2");
    expect(text).toContain("Line 3");
  });

  it("decodes HTML entities", () => {
    const html = "<p>&amp; &lt; &gt; &quot; &#39; &#x41; &#65; &nbsp;</p>";
    const { text } = htmlToMarkdown(html);
    expect(text).toContain("&");
    expect(text).toContain("<");
    expect(text).toContain(">");
    expect(text).toContain('"');
    expect(text).toContain("'");
    // &#x41; and &#65; both = 'A'
    expect(text).toContain("A");
  });

  it("extracts title element content", () => {
    const html = "<html><head><title>My Page Title</title></head><body><p>Body</p></body></html>";
    const { title } = htmlToMarkdown(html);
    expect(title).toBe("My Page Title");
  });

  it("returns undefined title when no title tag present", () => {
    const html = "<p>No title here</p>";
    const { title } = htmlToMarkdown(html);
    expect(title).toBeUndefined();
  });

  it("normalizes whitespace (collapses runs, trims)", () => {
    const html = "<p>  Lots   of   spaces  </p>";
    const { text } = htmlToMarkdown(html);
    expect(text).not.toMatch(/  /); // no double spaces
    expect(text).toBe(text.trim());
  });
});

// ---------------------------------------------------------------------------
// markdownToText
// ---------------------------------------------------------------------------

describe("markdownToText", () => {
  it("removes image syntax", () => {
    const md = "Before ![alt text](image.png) After";
    expect(markdownToText(md)).toBe("Before After");
  });

  it("converts links to just label text", () => {
    const md = "Click [here](https://example.com) now";
    expect(markdownToText(md)).toBe("Click here now");
  });

  it("strips code blocks (triple backtick)", () => {
    const md = "Before\n```js\nconsole.log('hi');\n```\nAfter";
    const result = markdownToText(md);
    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).not.toContain("```");
  });

  it("strips inline code backticks", () => {
    const md = "Use `npm install` to install";
    expect(markdownToText(md)).toBe("Use npm install to install");
  });

  it("removes heading # prefixes", () => {
    const md = "# H1\n## H2\n### H3";
    const result = markdownToText(md);
    expect(result).toContain("H1");
    expect(result).toContain("H2");
    expect(result).toContain("H3");
    expect(result).not.toMatch(/^#/m);
  });

  it("removes list markers (dash, asterisk, plus, numbered)", () => {
    const md = "- item1\n* item2\n+ item3\n1. item4";
    const result = markdownToText(md);
    expect(result).toContain("item1");
    expect(result).toContain("item2");
    expect(result).toContain("item3");
    expect(result).toContain("item4");
    expect(result).not.toMatch(/^[-*+]\s/m);
    expect(result).not.toMatch(/^\d+\.\s/m);
  });
});

// ---------------------------------------------------------------------------
// detectErrorPagePattern
// ---------------------------------------------------------------------------

describe("detectErrorPagePattern", () => {
  it("detects Cloudflare DDoS protection", () => {
    const body = "<p>Please wait... Checking your browser. Ray ID: abc123</p>";
    expect(detectErrorPagePattern(body)).toBe(
      "Blocked by Cloudflare DDoS protection (Ray ID present)",
    );
  });

  it("detects CAPTCHA challenge", () => {
    const body = "<div class='g-recaptcha'>Verify you are human</div>";
    expect(detectErrorPagePattern(body)).toBe("Blocked by CAPTCHA challenge");
  });

  it("detects access denied", () => {
    const body = "<h1>403 Forbidden</h1><p>Access denied</p>";
    expect(detectErrorPagePattern(body)).toBe("Access denied by server");
  });

  it("detects rate limiting", () => {
    const body = "<p>Too many requests. Please slow down and retry after 60s.</p>";
    expect(detectErrorPagePattern(body)).toBe("Rate limited by server");
  });

  it("detects bot detection", () => {
    const body = "<p>Bot detected. Automated access is not allowed.</p>";
    expect(detectErrorPagePattern(body)).toBe("Blocked by bot detection");
  });

  it("returns null for normal page content", () => {
    const body = "<html><body><p>This is a perfectly normal page with no error patterns.</p></body></html>";
    expect(detectErrorPagePattern(body)).toBeNull();
  });

  it("only checks first 10,000 characters", () => {
    const padding = "a".repeat(10_001);
    const body = padding + "Ray ID: xyz789 Cloudflare";
    expect(detectErrorPagePattern(body)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// truncateText
// ---------------------------------------------------------------------------

describe("truncateText", () => {
  it("returns original with truncated=false for short text", () => {
    const result = truncateText("short", 100);
    expect(result).toEqual({ text: "short", truncated: false });
  });

  it("returns sliced text with truncated=true for long text", () => {
    const longText = "a".repeat(200);
    const result = truncateText(longText, 50);
    expect(result.text).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it("returns original with truncated=false for exact-length text", () => {
    const text = "exact";
    const result = truncateText(text, 5);
    expect(result).toEqual({ text: "exact", truncated: false });
  });
});

// ---------------------------------------------------------------------------
// extractReadableContent
// ---------------------------------------------------------------------------

describe("extractReadableContent", () => {
  it("produces markdown output via Readability when available", async () => {
    const html = "<html><head><title>Test</title></head><body><article><p>Article content here.</p></article></body></html>";
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "markdown",
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBeTruthy();
  });

  it("produces text output via Readability when extractMode is text", async () => {
    const html = "<html><head><title>Test Page</title></head><body><article><p>Some paragraph.</p></article></body></html>";
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "text",
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBeTruthy();
  });

  it("falls back to htmlToMarkdown when Readability returns null content", async () => {
    // Minimal HTML that Readability can't parse but htmlToMarkdown can handle
    const html = "<html><head><title>Fallback</title></head><body></body></html>";
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "markdown",
    });
    expect(result).not.toBeNull();
    // Should still work even with empty body via fallback
    expect(result!.title).toBe("Fallback");
  });

  it("text extractMode through fallback uses markdownToText", async () => {
    const html = "<html><body></body></html>";
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "text",
    });
    expect(result).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Visibility sanitization integration
  // ---------------------------------------------------------------------------

  it("strips aria-hidden elements before extraction", async () => {
    const html =
      '<html><head><title>Page</title></head><body>' +
      '<article><p>Visible content here.</p>' +
      '<div aria-hidden="true">Hidden from readers</div>' +
      '<p>More visible content.</p></article></body></html>';
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "text",
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Visible content");
    expect(result!.text).not.toContain("Hidden from readers");
  });

  it("passes HTML through unchanged when stripHidden is false", async () => {
    const html =
      '<html><head><title>Page</title></head><body>' +
      '<article><p>Visible.</p>' +
      '<div aria-hidden="true">Hidden text</div></article></body></html>';
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "text",
      stripHidden: false,
    });
    expect(result).not.toBeNull();
    // With stripHidden: false, the hidden text may appear in extraction
    // (Readability may or may not include it, but sanitizer did not run)
    expect(result!.sanitized).toBeUndefined();
    expect(result!.elementsRemoved).toBeUndefined();
  });

  it("returns sanitized metadata when elements were removed", async () => {
    const html =
      '<html><head><title>Page</title></head><body>' +
      '<article><p>Content here.</p>' +
      '<span aria-hidden="true">Icon glyph</span>' +
      '<svg><circle cx="50" cy="50" r="40"/></svg>' +
      '</article></body></html>';
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "markdown",
    });
    expect(result).not.toBeNull();
    expect(result!.sanitized).toBe(true);
    expect(result!.elementsRemoved).toBeGreaterThanOrEqual(2);
  });

  it("does not set sanitized metadata for clean HTML", async () => {
    const html =
      "<html><head><title>Clean</title></head><body>" +
      "<article><p>Just normal content.</p></article></body></html>";
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "markdown",
    });
    expect(result).not.toBeNull();
    expect(result!.sanitized).toBeUndefined();
  });

  it("strips zero-width Unicode from extracted text", async () => {
    const html =
      "<html><head><title>Unicode</title></head><body>" +
      "<article><p>Hello\u200Bworld\u200Dtest\uFEFFend.</p></article></body></html>";
    const result = await extractReadableContent({
      html,
      url: "https://example.com",
      extractMode: "text",
    });
    expect(result).not.toBeNull();
    expect(result!.text).not.toMatch(/[\u200B\u200D\uFEFF]/);
    expect(result!.text).toContain("Helloworldtestend");
  });
});
