import { describe, it, expect } from "vitest";
import {
  sanitizeHtmlVisibility,
  stripInvisibleUnicode,
} from "./web-fetch-visibility.js";

// ---------------------------------------------------------------------------
// sanitizeHtmlVisibility — aria-hidden
// ---------------------------------------------------------------------------

describe("sanitizeHtmlVisibility", () => {
  describe("aria-hidden removal", () => {
    it("removes div with aria-hidden='true'", () => {
      const html = '<p>Visible</p><div aria-hidden="true">Hidden</div><p>Also visible</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toContain("Visible");
      expect(result.html).toContain("Also visible");
      expect(result.html).not.toContain("Hidden");
      expect(result.elementsRemoved).toBeGreaterThanOrEqual(1);
    });

    it("removes span with aria-hidden='true'", () => {
      const html = '<p>Text <span aria-hidden="true">icon</span> more</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("icon");
      expect(result.elementsRemoved).toBeGreaterThanOrEqual(1);
    });

    it("removes p with aria-hidden='true'", () => {
      const html = '<p aria-hidden="true">Screen reader text</p><p>Visible</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Screen reader text");
      expect(result.html).toContain("Visible");
    });

    it("does NOT remove aria-hidden='false' elements", () => {
      const html = '<div aria-hidden="false">Keep me</div>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toContain("Keep me");
      expect(result.elementsRemoved).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Inline style removal
  // ---------------------------------------------------------------------------

  describe("inline style removal", () => {
    it("removes element with display:none", () => {
      const html = '<div style="display: none;">Hidden text</div><p>Visible</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Hidden text");
      expect(result.html).toContain("Visible");
      expect(result.elementsRemoved).toBeGreaterThanOrEqual(1);
    });

    it("removes element with visibility:hidden", () => {
      const html = '<span style="visibility: hidden;">Ghost</span><span>Solid</span>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Ghost");
      expect(result.html).toContain("Solid");
      expect(result.elementsRemoved).toBeGreaterThanOrEqual(1);
    });

    it("removes element with opacity:0", () => {
      const html = '<div style="opacity: 0;">Transparent</div><p>Opaque</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Transparent");
      expect(result.html).toContain("Opaque");
      expect(result.elementsRemoved).toBeGreaterThanOrEqual(1);
    });

    it("handles display:none without spaces", () => {
      const html = '<div style="display:none">No spaces</div>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("No spaces");
    });
  });

  // ---------------------------------------------------------------------------
  // CSS class removal
  // ---------------------------------------------------------------------------

  describe("CSS class removal", () => {
    it("removes sr-only class element", () => {
      const html = '<span class="sr-only">Skip to content</span><p>Main</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Skip to content");
      expect(result.html).toContain("Main");
      expect(result.elementsRemoved).toBeGreaterThanOrEqual(1);
    });

    it("removes visually-hidden class element", () => {
      const html = '<div class="visually-hidden">Accessible label</div><p>Body</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Accessible label");
      expect(result.html).toContain("Body");
    });

    it("removes screen-reader-only class element", () => {
      const html = '<span class="screen-reader-only">For readers</span><p>For eyes</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("For readers");
      expect(result.html).toContain("For eyes");
    });

    it("does NOT remove sr-only-text (partial match)", () => {
      const html = '<span class="sr-only-text">Keep this</span>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toContain("Keep this");
    });

    it("removes sr-only when among multiple classes", () => {
      const html = '<span class="label sr-only active">Hidden label</span>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Hidden label");
    });
  });

  // ---------------------------------------------------------------------------
  // Always-remove tags
  // ---------------------------------------------------------------------------

  describe("always-remove tags", () => {
    it("removes meta tags", () => {
      const html = '<meta charset="utf-8"><p>Content</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("meta");
      expect(result.html).toContain("Content");
    });

    it("removes template elements", () => {
      const html = "<template><div>Template content</div></template><p>Visible</p>";
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Template content");
      expect(result.html).toContain("Visible");
    });

    it("removes svg elements", () => {
      const html = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg><p>After SVG</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("circle");
      expect(result.html).not.toContain("viewBox");
      expect(result.html).toContain("After SVG");
    });

    it("removes canvas elements", () => {
      const html = "<canvas>Fallback text</canvas><p>Real content</p>";
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Fallback text");
      expect(result.html).toContain("Real content");
    });

    it("removes iframe elements", () => {
      const html = '<iframe src="https://example.com"></iframe><p>Main page</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("iframe");
      expect(result.html).toContain("Main page");
    });

    it("removes object elements", () => {
      const html = '<object data="plugin.swf">Plugin</object><p>HTML content</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Plugin");
      expect(result.html).toContain("HTML content");
    });

    it("removes embed elements", () => {
      const html = '<embed src="video.mp4"><p>Text content</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("embed");
      expect(result.html).toContain("Text content");
    });

    it("removes all always-remove tags and counts them", () => {
      const html =
        '<meta name="x"><template>T</template><svg>S</svg><canvas>C</canvas>' +
        '<iframe>I</iframe><object>O</object><embed src="x"><p>Keep</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toBe("<p>Keep</p>");
      expect(result.elementsRemoved).toBe(7);
    });
  });

  // ---------------------------------------------------------------------------
  // Preserved elements (per user decision)
  // ---------------------------------------------------------------------------

  describe("preserved elements (not removed per user decision)", () => {
    it("does NOT remove script tags", () => {
      const html = "<script>var x = 1;</script><p>Content</p>";
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toContain("<script>");
      expect(result.html).toContain("var x = 1;");
    });

    it("does NOT remove noscript tags", () => {
      const html = "<noscript>Enable JS</noscript><p>Content</p>";
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toContain("<noscript>");
      expect(result.html).toContain("Enable JS");
    });

    it("does NOT remove hidden inputs", () => {
      const html = '<input type="hidden" name="csrf" value="token123"><p>Form</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toContain('type="hidden"');
      expect(result.html).toContain("token123");
    });

    it("does NOT strip data attributes", () => {
      const html = '<div data-id="42" data-tracking="abc">Content</div>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toContain('data-id="42"');
      expect(result.html).toContain('data-tracking="abc"');
    });
  });

  // ---------------------------------------------------------------------------
  // elementsRemoved accuracy and edge cases
  // ---------------------------------------------------------------------------

  describe("metadata and edge cases", () => {
    it("returns elementsRemoved: 0 for clean HTML", () => {
      const html = "<p>Normal paragraph with no hidden content</p>";
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toBe("<p>Normal paragraph with no hidden content</p>");
      expect(result.elementsRemoved).toBe(0);
    });

    it("accurately counts multiple different removals", () => {
      const html =
        '<meta charset="utf-8">' +
        '<div aria-hidden="true">A</div>' +
        '<span style="display: none;">B</span>' +
        '<span class="sr-only">C</span>' +
        "<p>Visible</p>";
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).toBe("<p>Visible</p>");
      expect(result.elementsRemoved).toBe(4);
    });

    it("handles nested hidden elements (at least one level)", () => {
      const html = '<div aria-hidden="true"><span aria-hidden="true">Deep</span>Outer</div><p>Visible</p>';
      const result = sanitizeHtmlVisibility(html);
      expect(result.html).not.toContain("Deep");
      expect(result.html).not.toContain("Outer");
      expect(result.html).toContain("Visible");
    });

    it("handles empty HTML", () => {
      const result = sanitizeHtmlVisibility("");
      expect(result.html).toBe("");
      expect(result.elementsRemoved).toBe(0);
    });

    it("handles whitespace-only HTML", () => {
      const result = sanitizeHtmlVisibility("   \n\t  ");
      expect(result.html).toBe("");
      expect(result.elementsRemoved).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// stripInvisibleUnicode
// ---------------------------------------------------------------------------

describe("stripInvisibleUnicode", () => {
  it("strips zero-width space (U+200B)", () => {
    expect(stripInvisibleUnicode("hello\u200Bworld")).toBe("helloworld");
  });

  it("strips zero-width non-joiner (U+200C)", () => {
    expect(stripInvisibleUnicode("ab\u200Ccd")).toBe("abcd");
  });

  it("strips zero-width joiner (U+200D) -- per user decision, no emoji exceptions", () => {
    expect(stripInvisibleUnicode("a\u200Db")).toBe("ab");
  });

  it("strips BOM / zero-width no-break space (U+FEFF)", () => {
    expect(stripInvisibleUnicode("\uFEFFHello")).toBe("Hello");
  });

  it("strips left-to-right mark (U+200E)", () => {
    expect(stripInvisibleUnicode("text\u200Emore")).toBe("textmore");
  });

  it("strips right-to-left mark (U+200F)", () => {
    expect(stripInvisibleUnicode("text\u200Fmore")).toBe("textmore");
  });

  it("strips BiDi override characters (U+202A-U+202E)", () => {
    const input = "a\u202Ab\u202Bc\u202Cd\u202De\u202Ef";
    expect(stripInvisibleUnicode(input)).toBe("abcdef");
  });

  it("strips word joiner (U+2060)", () => {
    expect(stripInvisibleUnicode("no\u2060break")).toBe("nobreak");
  });

  it("strips invisible separators (U+2061-U+2064)", () => {
    const input = "a\u2061b\u2062c\u2063d\u2064e";
    expect(stripInvisibleUnicode(input)).toBe("abcde");
  });

  it("strips deprecated format chars (U+206A-U+206F)", () => {
    const input = "x\u206Ay\u206Fz";
    expect(stripInvisibleUnicode(input)).toBe("xyz");
  });

  it("strips Unicode tag characters (U+E0001, U+E0020-U+E007F)", () => {
    const input = "text\u{E0001}\u{E0020}\u{E007F}end";
    expect(stripInvisibleUnicode(input)).toBe("textend");
  });

  it("returns normal text unchanged", () => {
    const input = "Hello, world! This is normal text.";
    expect(stripInvisibleUnicode(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(stripInvisibleUnicode("")).toBe("");
  });

  it("strips emoji joiners (ZWJ) per user decision", () => {
    // Family emoji: person + ZWJ + person + ZWJ + child
    // ZWJ (U+200D) is stripped, breaking the emoji sequence -- per user decision
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const result = stripInvisibleUnicode(family);
    expect(result).not.toContain("\u200D");
    // The base emoji codepoints should remain
    expect(result).toContain("\u{1F468}");
    expect(result).toContain("\u{1F469}");
    expect(result).toContain("\u{1F467}");
  });

  it("strips multiple invisible chars in sequence", () => {
    const input = "\u200B\u200C\u200D\u200E\u200F\uFEFF";
    expect(stripInvisibleUnicode(input)).toBe("");
  });
});
