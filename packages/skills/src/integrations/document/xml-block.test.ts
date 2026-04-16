import { describe, it, expect } from "vitest";
import { xmlEscapeAttr, escapeFileBlockContent, formatFileBlock } from "./xml-block.js";

describe("xmlEscapeAttr", () => {
  it("leaves a plain string unchanged", () => {
    expect(xmlEscapeAttr("hello world")).toBe("hello world");
  });

  it("escapes & to &amp;", () => {
    expect(xmlEscapeAttr("a&b")).toBe("a&amp;b");
  });

  it("escapes < to &lt;", () => {
    expect(xmlEscapeAttr("a<b")).toBe("a&lt;b");
  });

  it("escapes > to &gt;", () => {
    expect(xmlEscapeAttr("a>b")).toBe("a&gt;b");
  });

  it("escapes \" to &quot;", () => {
    expect(xmlEscapeAttr('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes ' to &apos;", () => {
    expect(xmlEscapeAttr("it's fine")).toBe("it&apos;s fine");
  });

  it("escapes all five special characters in combination", () => {
    expect(xmlEscapeAttr("a&b<c>d\"e'f")).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });

  it("does not double-escape (& must be escaped first)", () => {
    // If &amp; already exists it should become &amp;amp; (one pass)
    expect(xmlEscapeAttr("&amp;")).toBe("&amp;amp;");
  });

  it("escapes path traversal characters in filenames", () => {
    const result = xmlEscapeAttr("../../../etc/passwd");
    // Dots and slashes are not XML-special, so they stay
    expect(result).toBe("../../../etc/passwd");
  });

  it("escapes a filename with angle brackets and quotes", () => {
    expect(xmlEscapeAttr('<script>alert("xss")</script>.txt')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;.txt",
    );
  });
});

describe("escapeFileBlockContent", () => {
  it("leaves normal text unchanged", () => {
    expect(escapeFileBlockContent("Hello, world!")).toBe("Hello, world!");
  });

  it("leaves code with < and > unchanged", () => {
    expect(escapeFileBlockContent("if (a < b) { return a > 0; }")).toBe(
      "if (a < b) { return a > 0; }",
    );
  });

  it("leaves HTML tags that are not </file> unchanged", () => {
    expect(escapeFileBlockContent("<div>hello</div>")).toBe("<div>hello</div>");
  });

  it("leaves TypeScript generics unchanged", () => {
    expect(escapeFileBlockContent("Array<string>")).toBe("Array<string>");
  });

  it("escapes </file> closing tag", () => {
    expect(escapeFileBlockContent("content</file>more")).toBe("content&lt;/file&gt;more");
  });

  it("escapes </FILE> uppercase closing tag (case-insensitive, replacement is lowercase)", () => {
    // The regex matches case-insensitively but the replacement literal is lowercase
    expect(escapeFileBlockContent("content</FILE>more")).toBe("content&lt;/file&gt;more");
  });

  it("escapes </File> mixed-case closing tag (replacement is lowercase)", () => {
    // The regex matches case-insensitively but the replacement literal is lowercase
    expect(escapeFileBlockContent("content</File>more")).toBe("content&lt;/file&gt;more");
  });

  it("escapes <file name='x'> opening injection", () => {
    const result = escapeFileBlockContent('<file name="injected">evil</file>');
    expect(result).toContain("&lt;file");
    expect(result).not.toContain('<file name=');
  });

  it("escapes <file> simple opening tag (> is preserved as literal, not entity)", () => {
    // The regex replaces only < with &lt;, so <file> becomes &lt;file>
    // The > is consumed in the match pattern but kept as-is in the replacement
    const result = escapeFileBlockContent("<file>content</file>");
    expect(result).toContain("&lt;file");
    expect(result).not.toContain("<file>");
  });

  it("escapes multiple </file> occurrences", () => {
    const result = escapeFileBlockContent("a</file>b</file>c");
    expect(result).toBe("a&lt;/file&gt;b&lt;/file&gt;c");
  });

  it("escapes both opening and closing file tags in nested injection", () => {
    const result = escapeFileBlockContent('<file name="x"></file>');
    expect(result).toContain("&lt;file");
    expect(result).toContain("&lt;/file&gt;");
    expect(result).not.toContain('<file name=');
    expect(result).not.toContain("</file>");
  });
});

describe("formatFileBlock", () => {
  it("produces correct XML block for simple content", () => {
    const result = formatFileBlock("Hello, world!", "readme.txt", "text/plain");
    expect(result).toBe('<file name="readme.txt" mime="text/plain">\nHello, world!\n</file>');
  });

  it("starts with <file name= and ends with </file>", () => {
    const result = formatFileBlock("content", "file.md", "text/markdown");
    expect(result.startsWith('<file name="')).toBe(true);
    expect(result.endsWith("</file>")).toBe(true);
  });

  it("escapes special characters in filename attribute", () => {
    const result = formatFileBlock("content", 'say "hello" & bye', "text/plain");
    expect(result).toContain('name="say &quot;hello&quot; &amp; bye"');
  });

  it("escapes special characters in MIME type attribute", () => {
    const result = formatFileBlock("content", "file.txt", 'text/plain; charset="utf-8"');
    expect(result).toContain('mime="text/plain; charset=&quot;utf-8&quot;"');
  });

  it("escapes </file> injection attempts in content", () => {
    const result = formatFileBlock("before</file>after", "file.txt", "text/plain");
    expect(result).toContain("before&lt;/file&gt;after");
    // The block structure remains intact
    expect(result.endsWith("</file>")).toBe(true);
  });

  it("preserves code content with angle brackets", () => {
    const code = "if (a < b && c > d) { return Array<string>(); }";
    const result = formatFileBlock(code, "code.ts", "text/x-typescript");
    expect(result).toContain(code);
  });
});
