// SPDX-License-Identifier: Apache-2.0
/**
 * Markdown IR Pipeline Integration Tests
 *
 * End-to-end tests for the full Markdown IR pipeline covering:
 * parse -> render, format-first chunking, table conversion, and code fence preservation.
 *
 * Also covers edge cases: tilde fences, Telegram
 * HTML escaping, table-to-bullets column context, surrogate pairs at chunk
 * boundaries, and cross-platform rendering consistency.
 */

import { describe, it, expect } from "vitest";
import { parseMarkdownToIR } from "./markdown-ir.js";
import {
  renderIR,
  renderForDiscord,
  renderForSlack,
  renderForTelegram,
  renderForWhatsApp,
} from "./ir-renderer.js";
import { chunkIR } from "./ir-chunker.js";
import { convertTable } from "./table-converter.js";
import type { MarkdownIR, MarkdownBlock } from "./markdown-ir.js";

// ---------------------------------------------------------------------------
// Realistic LLM response samples
// ---------------------------------------------------------------------------

/** A realistic multi-format LLM response. */
const REALISTIC_LLM_RESPONSE = `# Getting Started with TypeScript

TypeScript is a **strongly typed** programming language that builds on JavaScript.

Here are the key benefits:

- *Type safety* at compile time
- Better **IDE support** with autocompletion
- Easier ~~debugging~~ refactoring

## Quick Example

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

const result = greet("World");
console.log(result);
\`\`\`

You can learn more at the [official docs](https://www.typescriptlang.org/).

> TypeScript is JavaScript that scales.

| Feature | JavaScript | TypeScript |
| --- | --- | --- |
| Types | Dynamic | Static |
| Tooling | Basic | Advanced |
| Compilation | None | Required |`;

/** A long LLM response for chunking tests. */
const LONG_LLM_RESPONSE = `# Architecture Overview

The system follows a hexagonal architecture pattern with ports and adapters. This ensures clean separation of concerns and makes the codebase highly testable.

## Core Domain

The core domain contains all business logic. It defines port interfaces that adapters implement. This is the heart of the application and has zero external dependencies.

The domain model includes entities like User, Message, Session, and Channel. Each entity has a corresponding Zod schema for validation.

## Adapter Layer

Adapters bridge the core domain to external systems. We have input adapters for receiving messages and output adapters for sending them.

### Input Adapters

Input adapters receive messages from external platforms like Telegram, Discord, and Slack. They normalize messages into our internal format.

### Output Adapters

Output adapters send messages back to platforms. They handle platform-specific formatting, rate limiting, and error recovery.

## Infrastructure

Infrastructure concerns like logging, configuration, and database access are isolated in their own packages.

\`\`\`typescript
// Example: Creating the application container
const container = await bootstrap({
  configPath: '/etc/comis/config.yaml',
  logLevel: 'info',
});

const { eventBus, channelManager, agentExecutor } = container;
\`\`\`

## Deployment

The application runs as a systemd service on Linux. Configuration is loaded from YAML files with environment variable overrides.

Each component can be independently tested, deployed, and scaled. The event bus provides loose coupling between modules.`;

// ---------------------------------------------------------------------------
// Full pipeline parse -> render
// ---------------------------------------------------------------------------

describe("Full pipeline parse -> render", () => {
  const ir = parseMarkdownToIR(REALISTIC_LLM_RESPONSE);

  it("parses realistic LLM response into non-empty IR", () => {
    expect(ir.blocks.length).toBeGreaterThan(0);
    // Should have heading, paragraph, list, code_block, blockquote, table
    const types = new Set(ir.blocks.map((b) => b.type));
    expect(types.has("heading")).toBe(true);
    expect(types.has("paragraph")).toBe(true);
    expect(types.has("list")).toBe(true);
    expect(types.has("code_block")).toBe(true);
    expect(types.has("blockquote")).toBe(true);
    expect(types.has("table")).toBe(true);
  });

  it("Discord output is standard Markdown", () => {
    const output = renderIR(ir, "discord");

    // Should contain Markdown formatting
    expect(output).toContain("# Getting Started with TypeScript");
    expect(output).toContain("**strongly typed**");
    expect(output).toContain("*Type safety*");
    expect(output).toContain("```typescript");
    expect(output).toContain("> TypeScript is JavaScript that scales.");
    expect(output).toContain("[official docs](https://www.typescriptlang.org/)");
  });

  it("Slack output uses mrkdwn syntax", () => {
    const output = renderIR(ir, "slack");

    // Slack bold is single * instead of **
    expect(output).toContain("*strongly typed*");
    // Slack list items use raw span rendering (no italic markers in list items)
    // But paragraph italic would use _. Test italic in paragraph context:
    expect(output).toContain("Type safety");
    // Slack link format
    expect(output).toContain("<https://www.typescriptlang.org/|official docs>");
    // Slack blockquote uses &gt;
    expect(output).toContain("&gt;");
    // Code blocks still use triple backticks
    expect(output).toContain("```");
    // Slack heading rendered as bold
    expect(output).toContain("*Getting Started with TypeScript*");
  });

  it("Telegram output is HTML with proper escaping", () => {
    const output = renderIR(ir, "telegram");

    // Bold tags
    expect(output).toContain("<b>strongly typed</b>");
    // Italic tags
    expect(output).toContain("<i>Type safety</i>");
    // Code block: pre+code with language class
    expect(output).toContain('<pre><code class="language-typescript">');
    expect(output).toContain("</code></pre>");
    // Link tags
    expect(output).toContain('<a href="https://www.typescriptlang.org/">official docs</a>');
    // Blockquote tags
    expect(output).toContain("<blockquote>");
    // Heading rendered as bold
    expect(output).toContain("<b>Getting Started with TypeScript</b>");
  });

  it("WhatsApp output uses WhatsApp markers", () => {
    const output = renderIR(ir, "whatsapp");

    // WhatsApp bold
    expect(output).toContain("*strongly typed*");
    // WhatsApp list items use raw span rendering (no italic markers in list)
    // Content is preserved though
    expect(output).toContain("Type safety");
    // WhatsApp link (text: url format when text differs)
    expect(output).toContain("official docs: https://www.typescriptlang.org/");
    // WhatsApp code blocks
    expect(output).toContain("```");
    // WhatsApp blockquote
    expect(output).toContain("> TypeScript is JavaScript that scales.");
    // WhatsApp heading rendered as bold
    expect(output).toContain("*Getting Started with TypeScript*");
  });
});

// ---------------------------------------------------------------------------
// Format-first chunking
// ---------------------------------------------------------------------------

describe("Format-first chunking", () => {
  it("chunks long LLM response with maxChars=500", () => {
    const ir = parseMarkdownToIR(LONG_LLM_RESPONSE);
    const chunks = chunkIR(ir, {
      maxChars: 500,
      platform: "discord",
      tableMode: "off",
    });

    expect(chunks.length).toBeGreaterThan(1);

    // Verify each chunk is within maxChars (code blocks may exceed as atomic units)
    for (const chunk of chunks) {
      // Chunks should be self-contained. Code blocks may be atomic and slightly oversized
      // but non-code chunks must be within limit
      if (!chunk.includes("```")) {
        expect(chunk.length).toBeLessThanOrEqual(500);
      }
    }
  });

  it("no chunk contains broken formatting (unbalanced bold markers)", () => {
    const ir = parseMarkdownToIR(LONG_LLM_RESPONSE);
    const chunks = chunkIR(ir, {
      maxChars: 500,
      platform: "discord",
      tableMode: "off",
    });

    for (const chunk of chunks) {
      // Count ** pairs -- should be even
      const boldMarkers = (chunk.match(/\*\*/g) ?? []).length;
      expect(boldMarkers % 2).toBe(0);

      // Count backtick pairs for code (excluding code fences)
      // Strip code fences first
      const withoutFences = chunk.replace(/```[\s\S]*?```/g, "");
      const inlineCode = (withoutFences.match(/`/g) ?? []).length;
      expect(inlineCode % 2).toBe(0);
    }
  });

  it("each chunk is self-contained valid formatted message", () => {
    const ir = parseMarkdownToIR(LONG_LLM_RESPONSE);
    const platforms = ["discord", "slack", "telegram", "whatsapp"] as const;

    for (const platform of platforms) {
      const chunks = chunkIR(ir, {
        maxChars: 500,
        platform,
        tableMode: "off",
      });

      for (const chunk of chunks) {
        // Non-empty
        expect(chunk.length).toBeGreaterThan(0);

        // Platform-specific validation
        if (platform === "telegram") {
          // Every opening HTML tag should have a closing tag
          const openTags = chunk.match(/<(b|i|s|code|pre|a|blockquote)[^>]*>/g) ?? [];
          for (const tag of openTags) {
            const tagName = tag.match(/<(\w+)/)?.[1];
            if (tagName) {
              expect(chunk).toContain(`</${tagName}>`);
            }
          }
        }
      }
    }
  });

  it("chunk count is reasonable for given maxChars", () => {
    const ir = parseMarkdownToIR(LONG_LLM_RESPONSE);
    const fullRendered = renderIR(ir, "discord");
    const chunks = chunkIR(ir, {
      maxChars: 500,
      platform: "discord",
      tableMode: "off",
    });

    // Expected minimum chunks: full text length / maxChars (roughly)
    const minExpected = Math.ceil(fullRendered.length / 500);
    // Chunk count should be at least minExpected (usually more due to block boundaries)
    expect(chunks.length).toBeGreaterThanOrEqual(minExpected - 1);
    // But not excessively more
    expect(chunks.length).toBeLessThanOrEqual(minExpected * 3);
  });
});

// ---------------------------------------------------------------------------
// Table conversion per channel
// ---------------------------------------------------------------------------

describe("Table conversion per channel", () => {
  const TABLE_MD = `| Language | Year | Typed |
| --- | --- | --- |
| JavaScript | 1995 | No |
| TypeScript | 2012 | Yes |
| Rust | 2010 | Yes |`;

  it("code mode: produces fenced code block with aligned columns", () => {
    const ir = parseMarkdownToIR(TABLE_MD);
    const tableBlock = ir.blocks.find((b) => b.type === "table")!;
    const converted = convertTable(tableBlock, "code");

    expect(converted.type).toBe("code_block");
    const raw = converted.raw ?? "";
    const lines = raw.split("\n");

    // Header line with aligned columns
    expect(lines[0]).toContain("Language");
    expect(lines[0]).toContain("Year");
    expect(lines[0]).toContain("Typed");

    // Separator line with dashes
    expect(lines[1]).toMatch(/^-+\s+-+\s+-+$/);

    // Body rows
    expect(lines[2]).toContain("JavaScript");
    expect(lines[2]).toContain("1995");
    expect(lines[2]).toContain("No");
    expect(lines[4]).toContain("Rust");
  });

  it("bullets mode: produces bullet list with **Header:** value format", () => {
    const ir = parseMarkdownToIR(TABLE_MD);
    const tableBlock = ir.blocks.find((b) => b.type === "table")!;
    const converted = convertTable(tableBlock, "bullets");

    expect(converted.type).toBe("list");
    expect(converted.ordered).toBe(false);
    expect(converted.items).toHaveLength(3);

    // First item should have bold header spans
    const firstItem = converted.items![0];
    const boldSpans = firstItem.spans.filter((s) => s.type === "bold");
    expect(boldSpans.length).toBe(3);
    expect(boldSpans[0].text).toBe("Language:");
    expect(boldSpans[1].text).toBe("Year:");
    expect(boldSpans[2].text).toBe("Typed:");

    // Text spans should contain cell values
    const textSpans = firstItem.spans.filter((s) => s.type === "text");
    expect(textSpans.some((s) => s.text.includes("JavaScript"))).toBe(true);
    expect(textSpans.some((s) => s.text.includes("1995"))).toBe(true);
  });

  it("off mode: table passes through as-is (raw pipe syntax)", () => {
    const ir = parseMarkdownToIR(TABLE_MD);
    const tableBlock = ir.blocks.find((b) => b.type === "table")!;
    const converted = convertTable(tableBlock, "off");

    expect(converted).toBe(tableBlock); // Same reference
    expect(converted.type).toBe("table");
    expect(converted.headers).toEqual(["Language", "Year", "Typed"]);
  });

  it("multi-column table with varying cell widths", () => {
    const wideTableMd = `| ID | Name | Description |
| --- | --- | --- |
| 1 | A | Short |
| 100 | LongNameHere | This is a much longer description |`;

    const ir = parseMarkdownToIR(wideTableMd);
    const tableBlock = ir.blocks.find((b) => b.type === "table")!;
    const codeResult = convertTable(tableBlock, "code");

    const raw = codeResult.raw ?? "";
    const lines = raw.split("\n");

    // All lines should have same column alignment (widths consistent)
    // The column for "ID" should be at least 3 chars wide (for "100")
    // The column for "Name" should be at least 12 chars wide (for "LongNameHere")
    expect(lines[0]).toMatch(/^ID\s+/);
    expect(lines[2]).toMatch(/^1\s+/);
    expect(lines[3]).toMatch(/^100\s+/);
  });

  it("table with empty cells", () => {
    const emptyCellsMd = `| A | B | C |
| --- | --- | --- |
| 1 | | 3 |
| | 5 | |`;

    const ir = parseMarkdownToIR(emptyCellsMd);
    const tableBlock = ir.blocks.find((b) => b.type === "table")!;

    // Code mode: empty cells should be padded
    const codeResult = convertTable(tableBlock, "code");
    expect(codeResult.type).toBe("code_block");
    const lines = (codeResult.raw ?? "").split("\n");
    expect(lines.length).toBe(4); // header + sep + 2 body rows

    // Bullets mode: empty cells produce empty values after header
    const bulletResult = convertTable(tableBlock, "bullets");
    expect(bulletResult.items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Code fence preservation
// ---------------------------------------------------------------------------

describe("Code fence preservation", () => {
  it("code block in middle of content preserved intact", () => {
    const md = `Some text before.

\`\`\`python
def hello():
    print("world")
\`\`\`

Some text after.`;

    const ir = parseMarkdownToIR(md);
    const chunks = chunkIR(ir, {
      maxChars: 500,
      platform: "discord",
      tableMode: "off",
    });

    // All content fits in one chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("```python");
    expect(chunks[0]).toContain('print("world")');
    expect(chunks[0]).toContain("```");
  });

  it("code block stays intact when maxChars would split naively", () => {
    const md = `Introduction paragraph.

\`\`\`javascript
const a = 1;
const b = 2;
const c = 3;
const d = 4;
const e = 5;
\`\`\`

Conclusion paragraph.`;

    const ir = parseMarkdownToIR(md);
    // Set maxChars small enough that intro + code won't fit together
    // but code block itself fits in a single chunk
    const chunks = chunkIR(ir, {
      maxChars: 100,
      platform: "discord",
      tableMode: "off",
    });

    // Find the chunk containing the code block
    const codeChunk = chunks.find((c) => c.includes("```javascript"));
    expect(codeChunk).toBeDefined();
    // Verify complete code fence
    expect(codeChunk!).toContain("```javascript");
    expect(codeChunk!).toContain("const a = 1;");
    expect(codeChunk!).toContain("const e = 5;");
    // Must end with closing fence (the code block is kept whole)
    expect(codeChunk!).toMatch(/```$/);
  });

  it("large code block split at newline boundaries with fence wrapping", () => {
    // Create a code block exceeding 2x maxChars
    const lines = Array.from({ length: 40 }, (_, i) => `  const var${i} = ${i}; // some padding text`);
    const raw = lines.join("\n");
    const md = `\`\`\`typescript\n${raw}\n\`\`\``;

    const ir = parseMarkdownToIR(md);
    const chunks = chunkIR(ir, {
      maxChars: 200,
      platform: "discord",
      tableMode: "off",
    });

    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be wrapped in its own fence
    for (const chunk of chunks) {
      expect(chunk).toContain("```typescript");
      expect(chunk).toMatch(/```$/);
    }
  });

  it("code fence with backticks correctly parsed", () => {
    const md = "```js\nconsole.log('hi');\n```";
    const ir = parseMarkdownToIR(md);

    expect(ir.blocks).toHaveLength(1);
    expect(ir.blocks[0].type).toBe("code_block");
    expect(ir.blocks[0].language).toBe("js");
    expect(ir.blocks[0].raw).toBe("console.log('hi');");
  });

  it("code fence with tildes correctly parsed and preserved", () => {
    const md = "~~~python\nprint('hello')\n~~~";
    const ir = parseMarkdownToIR(md);

    expect(ir.blocks).toHaveLength(1);
    expect(ir.blocks[0].type).toBe("code_block");
    expect(ir.blocks[0].language).toBe("python");
    expect(ir.blocks[0].raw).toBe("print('hello')");
  });

  it("unclosed code fence extends to end of text", () => {
    const md = "```js\nconst x = 1;\nconst y = 2;";
    const ir = parseMarkdownToIR(md);

    expect(ir.blocks).toHaveLength(1);
    expect(ir.blocks[0].type).toBe("code_block");
    expect(ir.blocks[0].raw).toBe("const x = 1;\nconst y = 2;");
  });

  it("tilde fence not closed by backtick fence", () => {
    // ~~~ should only be closed by ~~~, not ```
    const md = "~~~python\ncode here\n```\nmore code\n~~~";
    const ir = parseMarkdownToIR(md);

    expect(ir.blocks).toHaveLength(1);
    expect(ir.blocks[0].type).toBe("code_block");
    // The ``` inside should be part of the content, not a closing fence
    expect(ir.blocks[0].raw).toContain("```");
    expect(ir.blocks[0].raw).toContain("code here");
    expect(ir.blocks[0].raw).toContain("more code");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("tilde fence (~~~) correctly parsed and preserved", () => {
    const md = `Some intro text.

~~~bash
echo "Hello"
ls -la
~~~

Some outro text.`;

    const ir = parseMarkdownToIR(md);
    const codeBlock = ir.blocks.find((b) => b.type === "code_block");
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.language).toBe("bash");
    expect(codeBlock!.raw).toContain('echo "Hello"');
    expect(codeBlock!.raw).toContain("ls -la");
  });

  it("Telegram rendering escapes <, >, & in text content", () => {
    const md = "Use `a < b && c > d` for comparison. Also <script>alert('xss')</script>";
    const ir = parseMarkdownToIR(md);
    const output = renderIR(ir, "telegram");

    // Text containing < > & should be HTML-escaped
    expect(output).toContain("&lt;");
    expect(output).toContain("&gt;");
    expect(output).toContain("&amp;");
    // Should NOT contain raw < or > in text context (outside tags)
    // The Telegram renderer wraps code in <code> tags, so those < > are safe
    expect(output).not.toContain("<script>");
    expect(output).not.toContain("</script>");
  });

  it("table-to-bullets preserves column header context", () => {
    const tableMd = `| Name | Role | Level |
| --- | --- | --- |
| Alice | Engineer | Senior |
| Bob | Designer | Junior |`;

    const ir = parseMarkdownToIR(tableMd);
    const tableBlock = ir.blocks.find((b) => b.type === "table")!;
    const bullets = convertTable(tableBlock, "bullets");

    expect(bullets.type).toBe("list");
    // Each item should preserve header context as bold prefixes
    const firstItem = bullets.items![0];
    const boldSpans = firstItem.spans.filter((s) => s.type === "bold");
    expect(boldSpans.map((s) => s.text)).toEqual(["Name:", "Role:", "Level:"]);

    const textSpans = firstItem.spans.filter((s) => s.type === "text");
    expect(textSpans.some((s) => s.text.includes("Alice"))).toBe(true);
    expect(textSpans.some((s) => s.text.includes("Engineer"))).toBe(true);
    expect(textSpans.some((s) => s.text.includes("Senior"))).toBe(true);
  });

  it("emoji at chunk boundary not split (surrogate pair safety)", () => {
    // Build text with emoji surrogate pairs near chunk boundaries
    const emoji = "\u{1F600}"; // Grinning face (U+1F600, encoded as surrogate pair)
    // Each instance is 2 UTF-16 code units. Create text where emoji falls near boundary.
    const padding = "A".repeat(95);
    const text = `${padding}${emoji}${padding}${emoji}${padding}${emoji}`;

    const ir: MarkdownIR = {
      blocks: [
        {
          type: "paragraph",
          spans: [{ type: "text", text, offset: 0, length: text.length }],
        },
      ],
      sourceLength: text.length,
    };

    const chunks = chunkIR(ir, {
      maxChars: 100,
      platform: "discord",
      tableMode: "off",
    });

    // Verify no chunk ends with an orphaned high surrogate
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const lastCharCode = chunk.charCodeAt(chunk.length - 1);
      // Last char should NOT be a high surrogate (0xD800-0xDBFF)
      const isHighSurrogate = lastCharCode >= 0xd800 && lastCharCode <= 0xdbff;
      expect(isHighSurrogate).toBe(false);
    }

    // Verify no chunk starts with an orphaned low surrogate
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const firstCharCode = chunk.charCodeAt(0);
      // First char should NOT be a low surrogate (0xDC00-0xDFFF)
      const isLowSurrogate = firstCharCode >= 0xdc00 && firstCharCode <= 0xdfff;
      expect(isLowSurrogate).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-platform consistency test
// ---------------------------------------------------------------------------

describe("Cross-platform rendering consistency", () => {
  const sampleMd = `# Summary

This is a **bold** statement with *italic* emphasis.

\`\`\`js
const x = 1;
\`\`\`

- Item one
- Item two

> A wise quote.`;

  const platforms = ["discord", "slack", "telegram", "whatsapp"] as const;

  it("all 4 platforms render the same block structure", () => {
    const ir = parseMarkdownToIR(sampleMd);

    const outputs = platforms.map((p) => renderIR(ir, p));

    // All outputs should have the same number of double-newline separated "sections"
    const sectionCounts = outputs.map((o) => o.split("\n\n").length);
    // All platforms should produce the same section count
    const unique = new Set(sectionCounts);
    expect(unique.size).toBe(1);
  });

  it("Discord output contains no unescaped HTML tags in text", () => {
    const ir = parseMarkdownToIR(sampleMd);
    const output = renderIR(ir, "discord");

    // Discord uses Markdown, not HTML -- should have no HTML tags
    expect(output).not.toMatch(/<\/?[bisu]>/);
    expect(output).not.toMatch(/<\/?code>/);
    expect(output).not.toMatch(/<\/?pre>/);
  });

  it("Telegram output has valid HTML (all tags closed)", () => {
    const ir = parseMarkdownToIR(sampleMd);
    const output = renderIR(ir, "telegram");

    // Count opening and closing tags for each type
    // Use word boundary or end-of-tag to avoid <b matching <blockquote
    const tagPairs: Array<{ open: RegExp; close: RegExp }> = [
      { open: /<b>/g, close: /<\/b>/g },
      { open: /<i>/g, close: /<\/i>/g },
      { open: /<code[^>]*>/g, close: /<\/code>/g },
      { open: /<blockquote>/g, close: /<\/blockquote>/g },
    ];
    for (const { open, close } of tagPairs) {
      const openCount = (output.match(open) ?? []).length;
      const closeCount = (output.match(close) ?? []).length;
      expect(openCount).toBe(closeCount);
    }
  });

  it("Slack output has no unescaped & or < in text spans", () => {
    const mdWithSpecials = "Text with A & B and x < y comparison.";
    const ir = parseMarkdownToIR(mdWithSpecials);
    const output = renderIR(ir, "slack");

    // & should be &amp;
    expect(output).toContain("&amp;");
    // < should be &lt;
    expect(output).toContain("&lt;");
    // Raw & (not followed by amp;/lt;/gt;) should not appear
    expect(output).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it("Telegram output has no unescaped & or < in text spans", () => {
    const mdWithSpecials = "Text with A & B and x < y comparison.";
    const ir = parseMarkdownToIR(mdWithSpecials);
    const output = renderIR(ir, "telegram");

    expect(output).toContain("&amp;");
    expect(output).toContain("&lt;");
    // Raw & should not appear
    expect(output).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it("all 4 outputs preserve the same semantic content", () => {
    const ir = parseMarkdownToIR(sampleMd);

    for (const platform of platforms) {
      const output = renderIR(ir, platform);

      // All platforms should contain the key content words
      expect(output).toContain("Summary");
      expect(output).toContain("bold");
      expect(output).toContain("italic");
      expect(output).toContain("const x = 1;");
      expect(output).toContain("Item one");
      expect(output).toContain("Item two");
      expect(output).toContain("wise quote");
    }
  });

  it("full pipeline: parse -> chunk -> each chunk is valid per platform", () => {
    const ir = parseMarkdownToIR(REALISTIC_LLM_RESPONSE);

    for (const platform of platforms) {
      const chunks = chunkIR(ir, {
        maxChars: 400,
        platform,
        tableMode: "code",
      });

      expect(chunks.length).toBeGreaterThan(0);

      // Reunite all chunks should cover all content
      const reunited = chunks.join("\n\n");
      expect(reunited).toContain("TypeScript");
      expect(reunited).toContain("greet");
    }
  });
});
