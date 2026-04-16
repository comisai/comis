/**
 * Tests for IR renderers.
 *
 * Verifies that each platform renderer (Discord, Slack, Telegram, WhatsApp)
 * produces valid platform-specific formatting from a MarkdownIR.
 */
import { describe, it, expect } from "vitest";
import { parseMarkdownToIR } from "./markdown-ir.js";
import {
  renderIR,
  renderForDiscord,
  renderForSlack,
  renderForTelegram,
  renderForWhatsApp,
  renderForSignal,
  renderForIMessage,
  renderForLine,
  renderForIrc,
  renderForEmail,
} from "./ir-renderer.js";

/** Shorthand: parse markdown and render for platform. */
function render(md: string, platform: string): string {
  return renderIR(parseMarkdownToIR(md), platform);
}

// ---------------------------------------------------------------------------
// renderIR dispatcher
// ---------------------------------------------------------------------------

describe("renderIR", () => {
  it("dispatches to correct platform renderer", () => {
    const ir = parseMarkdownToIR("**bold**");
    // Discord uses **bold**, Slack uses *bold*
    expect(renderIR(ir, "discord")).toContain("**bold**");
    expect(renderIR(ir, "slack")).toContain("*bold*");
  });

  it("dispatches to new platform renderers", () => {
    const ir = parseMarkdownToIR("**bold**");
    // Signal/iMessage/LINE use plain text (bold formatting stripped)
    expect(renderIR(ir, "signal")).toBe("bold");
    expect(renderIR(ir, "imessage")).toBe("bold");
    expect(renderIR(ir, "line")).toBe("bold");
    // IRC uses control codes for bold
    expect(renderIR(ir, "irc")).toContain("\x02bold\x02");
  });

  it("returns plain text for unknown platform (graceful fallback)", () => {
    const ir = parseMarkdownToIR("**bold** text");
    const result = renderIR(ir, "unknown-plugin");
    expect(result).toContain("bold");
    expect(result).toContain("text");
    // Should NOT throw
  });

  it("default fallback renders code blocks", () => {
    const ir = parseMarkdownToIR("```js\ncode\n```");
    const result = renderIR(ir, "some-future-platform");
    expect(result).toContain("code");
  });
});

// ---------------------------------------------------------------------------
// Discord renderer
// ---------------------------------------------------------------------------

describe("renderForDiscord", () => {
  it("renders bold", () => {
    expect(render("**bold**", "discord")).toBe("**bold**");
  });

  it("renders italic", () => {
    expect(render("*italic*", "discord")).toBe("*italic*");
  });

  it("renders inline code", () => {
    expect(render("`code`", "discord")).toBe("`code`");
  });

  it("renders strikethrough", () => {
    expect(render("~~strike~~", "discord")).toBe("~~strike~~");
  });

  it("renders links", () => {
    expect(render("[text](https://x.com)", "discord")).toBe("[text](https://x.com)");
  });

  it("renders code blocks with language", () => {
    const result = render("```js\ncode\n```", "discord");
    expect(result).toBe("```js\ncode\n```");
  });

  it("renders headings", () => {
    expect(render("# Title", "discord")).toBe("# Title");
  });

  it("renders h2 heading", () => {
    expect(render("## Sub", "discord")).toBe("## Sub");
  });

  it("renders blockquotes", () => {
    expect(render("> quote", "discord")).toBe("> quote");
  });

  it("renders unordered lists", () => {
    const result = render("- a\n- b", "discord");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });

  it("renders ordered lists", () => {
    const result = render("1. a\n2. b", "discord");
    expect(result).toContain("1. a");
    expect(result).toContain("2. b");
  });
});

// ---------------------------------------------------------------------------
// Slack renderer
// ---------------------------------------------------------------------------

describe("renderForSlack", () => {
  it("renders bold as *text*", () => {
    expect(render("**bold**", "slack")).toBe("*bold*");
  });

  it("renders italic as _text_", () => {
    expect(render("*italic*", "slack")).toBe("_italic_");
  });

  it("renders inline code", () => {
    expect(render("`code`", "slack")).toBe("`code`");
  });

  it("renders strikethrough as ~text~", () => {
    expect(render("~~strike~~", "slack")).toBe("~strike~");
  });

  it("renders links as <url|text>", () => {
    expect(render("[link](https://x.com)", "slack")).toBe("<https://x.com|link>");
  });

  it("renders code blocks without language hint", () => {
    const result = render("```js\ncode\n```", "slack");
    expect(result).toBe("```\ncode\n```");
  });

  it("renders headings as bold", () => {
    expect(render("# Title", "slack")).toBe("*Title*");
  });

  it("renders blockquotes", () => {
    expect(render("> quote", "slack")).toBe("&gt; quote");
  });

  it("escapes &, <, > in text", () => {
    expect(render("A & B < C > D", "slack")).toBe("A &amp; B &lt; C &gt; D");
  });

  it("renders unordered lists", () => {
    const result = render("- a\n- b", "slack");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });

  it("renders ordered lists", () => {
    const result = render("1. a\n2. b", "slack");
    expect(result).toContain("1. a");
    expect(result).toContain("2. b");
  });
});

// ---------------------------------------------------------------------------
// Telegram renderer
// ---------------------------------------------------------------------------

describe("renderForTelegram", () => {
  it("renders bold as <b>text</b>", () => {
    expect(render("**bold**", "telegram")).toBe("<b>bold</b>");
  });

  it("renders italic as <i>text</i>", () => {
    expect(render("*italic*", "telegram")).toBe("<i>italic</i>");
  });

  it("renders inline code as <code>text</code>", () => {
    expect(render("`code`", "telegram")).toBe("<code>code</code>");
  });

  it("renders strikethrough as <s>text</s>", () => {
    expect(render("~~strike~~", "telegram")).toBe("<s>strike</s>");
  });

  it("renders links as <a> tags", () => {
    expect(render("[link](https://x.com)", "telegram")).toBe(
      '<a href="https://x.com">link</a>',
    );
  });

  it("renders code blocks with language class", () => {
    const result = render("```js\ncode\n```", "telegram");
    expect(result).toBe('<pre><code class="language-js">code</code></pre>');
  });

  it("renders code blocks without language", () => {
    const result = render("```\ncode\n```", "telegram");
    expect(result).toBe("<pre><code>code</code></pre>");
  });

  it("renders headings as bold", () => {
    expect(render("# Title", "telegram")).toBe("<b>Title</b>");
  });

  it("renders blockquotes", () => {
    expect(render("> quote", "telegram")).toBe("<blockquote>quote</blockquote>");
  });

  it("HTML-escapes text content", () => {
    expect(render("A & B", "telegram")).toBe("A &amp; B");
  });

  it("HTML-escapes inside formatting tags", () => {
    expect(render("**A & B**", "telegram")).toBe("<b>A &amp; B</b>");
  });

  it("HTML-escapes < and > in text", () => {
    expect(render("x < y > z", "telegram")).toBe("x &lt; y &gt; z");
  });

  it("renders unordered lists as plain text", () => {
    const result = render("- a\n- b", "telegram");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });

  it("renders ordered lists as plain text", () => {
    const result = render("1. a\n2. b", "telegram");
    expect(result).toContain("1. a");
    expect(result).toContain("2. b");
  });
});

// ---------------------------------------------------------------------------
// WhatsApp renderer
// ---------------------------------------------------------------------------

describe("renderForWhatsApp", () => {
  it("renders bold as *text*", () => {
    expect(render("**bold**", "whatsapp")).toBe("*bold*");
  });

  it("renders italic as _text_", () => {
    expect(render("*italic*", "whatsapp")).toBe("_italic_");
  });

  it("renders inline code", () => {
    expect(render("`code`", "whatsapp")).toBe("`code`");
  });

  it("renders strikethrough as ~text~", () => {
    expect(render("~~strike~~", "whatsapp")).toBe("~strike~");
  });

  it("renders links as plain URL when text differs", () => {
    const result = render("[click](https://x.com)", "whatsapp");
    expect(result).toContain("https://x.com");
    expect(result).toContain("click");
  });

  it("renders code blocks without language hint", () => {
    const result = render("```js\ncode\n```", "whatsapp");
    expect(result).toBe("```\ncode\n```");
  });

  it("renders headings as bold", () => {
    expect(render("# Title", "whatsapp")).toBe("*Title*");
  });

  it("renders blockquotes with > prefix", () => {
    expect(render("> quote", "whatsapp")).toBe("> quote");
  });

  it("renders unordered lists", () => {
    const result = render("- a\n- b", "whatsapp");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });

  it("renders ordered lists", () => {
    const result = render("1. a\n2. b", "whatsapp");
    expect(result).toContain("1. a");
    expect(result).toContain("2. b");
  });
});

// ---------------------------------------------------------------------------
// Signal renderer (plain text)
// ---------------------------------------------------------------------------

describe("renderForSignal", () => {
  it("renders bold as plain text", () => {
    expect(render("**bold**", "signal")).toBe("bold");
  });

  it("renders italic as plain text", () => {
    expect(render("*italic*", "signal")).toBe("italic");
  });

  it("renders inline code as plain text", () => {
    expect(render("`code`", "signal")).toBe("code");
  });

  it("renders code blocks with fences", () => {
    const result = render("```js\ncode\n```", "signal");
    expect(result).toBe("```\ncode\n```");
  });

  it("renders headings as uppercase", () => {
    expect(render("# Title", "signal")).toBe("TITLE");
  });

  it("renders blockquotes with > prefix", () => {
    expect(render("> quote", "signal")).toBe("> quote");
  });

  it("renders unordered lists", () => {
    const result = render("- a\n- b", "signal");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });

  it("renders ordered lists", () => {
    const result = render("1. a\n2. b", "signal");
    expect(result).toContain("1. a");
    expect(result).toContain("2. b");
  });
});

// ---------------------------------------------------------------------------
// iMessage renderer (plain text)
// ---------------------------------------------------------------------------

describe("renderForIMessage", () => {
  it("renders bold as plain text", () => {
    expect(render("**bold**", "imessage")).toBe("bold");
  });

  it("renders headings as uppercase", () => {
    expect(render("# Title", "imessage")).toBe("TITLE");
  });

  it("renders code blocks with fences", () => {
    const result = render("```\ncode\n```", "imessage");
    expect(result).toBe("```\ncode\n```");
  });

  it("renders blockquotes with > prefix", () => {
    expect(render("> quote", "imessage")).toBe("> quote");
  });

  it("renders lists", () => {
    const result = render("- a\n- b", "imessage");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });
});

// ---------------------------------------------------------------------------
// LINE renderer (plain text)
// ---------------------------------------------------------------------------

describe("renderForLine", () => {
  it("renders bold as plain text", () => {
    expect(render("**bold**", "line")).toBe("bold");
  });

  it("renders headings as uppercase", () => {
    expect(render("# Title", "line")).toBe("TITLE");
  });

  it("renders code blocks with fences", () => {
    const result = render("```js\ncode\n```", "line");
    expect(result).toBe("```\ncode\n```");
  });

  it("renders blockquotes with > prefix", () => {
    expect(render("> quote", "line")).toBe("> quote");
  });

  it("renders lists", () => {
    const result = render("- a\n- b", "line");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });
});

// ---------------------------------------------------------------------------
// IRC renderer (control codes)
// ---------------------------------------------------------------------------

describe("renderForIrc", () => {
  it("renders bold with \\x02 control codes", () => {
    expect(render("**bold**", "irc")).toBe("\x02bold\x02");
  });

  it("renders italic with \\x1D control codes", () => {
    expect(render("*italic*", "irc")).toBe("\x1Ditalic\x1D");
  });

  it("renders inline code as plain text", () => {
    expect(render("`code`", "irc")).toBe("code");
  });

  it("renders strikethrough as plain text", () => {
    expect(render("~~strike~~", "irc")).toBe("strike");
  });

  it("renders code blocks with line prefix", () => {
    const result = render("```js\nfoo\nbar\n```", "irc");
    expect(result).toContain("| foo");
    expect(result).toContain("| bar");
  });

  it("renders headings as bold", () => {
    expect(render("# Title", "irc")).toBe("\x02Title\x02");
  });

  it("renders blockquotes with > prefix", () => {
    expect(render("> quote", "irc")).toBe("> quote");
  });

  it("renders links with URL in parens", () => {
    const result = render("[click](https://x.com)", "irc");
    expect(result).toContain("click");
    expect(result).toContain("(https://x.com)");
  });

  it("renders unordered lists", () => {
    const result = render("- a\n- b", "irc");
    expect(result).toContain("- a");
    expect(result).toContain("- b");
  });

  it("renders ordered lists", () => {
    const result = render("1. a\n2. b", "irc");
    expect(result).toContain("1. a");
    expect(result).toContain("2. b");
  });
});

// ---------------------------------------------------------------------------
// Sequential numbering for loose/multi-line ordered lists
// ---------------------------------------------------------------------------

describe("ordered list sequential numbering", () => {
  it("renders correct 1. 2. 3. numbering for loose ordered list (Telegram)", () => {
    const md = [
      "1. **What kind of creature am I?**",
      "   Examples: AI assistant, machine ghost",
      "",
      "2. **What's my vibe?**",
      "   Examples: curious, playful",
      "",
      "3. **What do I sound like?**",
      "   Examples: poetic, casual",
    ].join("\n");
    const result = render(md, "telegram");
    // All three items should appear with correct sequential numbering
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("3.");
    // Specifically, there should NOT be three separate "1." lines
    const matches = result.match(/^\d+\./gm);
    expect(matches).toBeDefined();
    expect(matches!.length).toBe(3);
    expect(matches![0]).toBe("1.");
    expect(matches![1]).toBe("2.");
    expect(matches![2]).toBe("3.");
  });

  it("renders correct numbering for loose ordered list (Discord)", () => {
    const md = "1. Alpha\n\n2. Beta\n\n3. Gamma";
    const result = render(md, "discord");
    expect(result).toContain("1. Alpha");
    expect(result).toContain("2. Beta");
    expect(result).toContain("3. Gamma");
  });

  it("renders correct numbering for loose ordered list (Slack)", () => {
    const md = "1. Alpha\n\n2. Beta\n\n3. Gamma";
    const result = render(md, "slack");
    expect(result).toContain("1. Alpha");
    expect(result).toContain("2. Beta");
    expect(result).toContain("3. Gamma");
  });
});

// ---------------------------------------------------------------------------
// Cross-platform cases from plan spec
// ---------------------------------------------------------------------------

describe("cross-platform spec cases", () => {
  it("renderIR(parse('**bold**'), 'telegram') -> <b>bold</b>", () => {
    expect(render("**bold**", "telegram")).toBe("<b>bold</b>");
  });

  it("renderIR(parse('**bold**'), 'slack') -> *bold*", () => {
    expect(render("**bold**", "slack")).toBe("*bold*");
  });

  it("renderIR(parse('[link](https://x.com)'), 'slack') -> <https://x.com|link>", () => {
    expect(render("[link](https://x.com)", "slack")).toBe("<https://x.com|link>");
  });

  it("renderIR(parse('A & B'), 'telegram') -> A &amp; B", () => {
    expect(render("A & B", "telegram")).toBe("A &amp; B");
  });

  it("renderIR(parse('```js\\ncode\\n```'), 'telegram') -> <pre><code>", () => {
    expect(render("```js\ncode\n```", "telegram")).toBe(
      '<pre><code class="language-js">code</code></pre>',
    );
  });

  it("renderIR(parse('```js\\ncode\\n```'), 'whatsapp') -> ```\\ncode\\n```", () => {
    expect(render("```js\ncode\n```", "whatsapp")).toBe("```\ncode\n```");
  });
});

// ---------------------------------------------------------------------------
// Email renderer (inline-CSS HTML)
// ---------------------------------------------------------------------------

describe("renderForEmail", () => {
  it("renders paragraph with inline style", () => {
    const result = render("Hello world", "email");
    expect(result).toContain('<p style="margin: 0 0 12px 0;">Hello world</p>');
  });

  it("renders code_block with background #f5f5f5", () => {
    const result = render("```\ncode\n```", "email");
    expect(result).toContain('<pre style="background: #f5f5f5');
    expect(result).toContain("<code>code</code></pre>");
  });

  it("renders heading depth 1 with font-size 18px", () => {
    const result = render("# Title", "email");
    expect(result).toContain("font-weight: bold");
    expect(result).toContain("font-size: 18px");
    expect(result).toContain("Title");
  });

  it("renders heading depth 2 with font-size 16px", () => {
    const result = render("## Sub", "email");
    expect(result).toContain("font-size: 16px");
    expect(result).toContain("Sub");
  });

  it("renders blockquote with border-left", () => {
    const result = render("> quote", "email");
    expect(result).toContain("border-left: 3px solid #ddd");
    expect(result).toContain("quote");
  });

  it("renders bold span as <b>", () => {
    const result = render("**bold**", "email");
    expect(result).toContain("<b>bold</b>");
  });

  it("renders italic span as <i>", () => {
    const result = render("*italic*", "email");
    expect(result).toContain("<i>italic</i>");
  });

  it("renders code span with inline style", () => {
    const result = render("`code`", "email");
    expect(result).toContain("<code style=");
    expect(result).toContain("code</code>");
  });

  it("renders link span as <a> with color", () => {
    const result = render("[click](https://x.com)", "email");
    expect(result).toContain('<a href="https://x.com" style="color: #0066cc;">click</a>');
  });

  it("renders table with inline styles", () => {
    const result = render("| A | B |\n|---|---|\n| 1 | 2 |", "email");
    expect(result).toContain("<table");
    expect(result).toContain("border-collapse: collapse");
    expect(result).toContain("<th");
    expect(result).toContain("<td");
  });

  it("renders unordered list as <ul>", () => {
    const result = render("- a\n- b", "email");
    expect(result).toContain("<ul");
    expect(result).toContain("<li");
    expect(result).toContain("a</li>");
    expect(result).toContain("b</li>");
  });

  it("renders ordered list as <ol>", () => {
    const result = render("1. a\n2. b", "email");
    expect(result).toContain("<ol");
    expect(result).toContain("<li");
  });

  it("escapes HTML special characters", () => {
    const result = render("A & B < C > D", "email");
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
  });

  it("wraps output in div with font-family", () => {
    const result = render("Hello", "email");
    expect(result).toContain('<div style="font-family: -apple-system');
    expect(result).toContain("</div>");
  });

  it("renderIR dispatches email to renderForEmail", () => {
    const ir = parseMarkdownToIR("**bold**");
    const result = renderIR(ir, "email");
    expect(result).toContain("<b>bold</b>");
    expect(result).toContain("font-family");
  });

  it("does not use CSS classes (inline only)", () => {
    const result = render("# Title\n\n**bold** `code`\n\n```js\nfoo\n```", "email");
    expect(result).not.toContain("class=");
  });
});
