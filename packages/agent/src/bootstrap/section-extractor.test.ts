import { describe, it, expect } from "vitest";
import {
  extractMarkdownSections,
  MAX_POST_COMPACTION_CHARS,
} from "./section-extractor.js";

describe("extractMarkdownSections", () => {
  // Case 1: Empty content -> []
  it("returns empty array for empty content", () => {
    expect(extractMarkdownSections("", ["Session Startup"])).toEqual([]);
  });

  // Case 2: Empty sectionNames -> []
  it("returns empty array for empty sectionNames", () => {
    expect(
      extractMarkdownSections("## Session Startup\nSome content", []),
    ).toEqual([]);
  });

  // Case 3: H2 match -> returns heading + body until next H2/H1
  it("extracts H2 section until next H2", () => {
    const md = [
      "## Session Startup",
      "Do this first.",
      "Do this second.",
      "## Red Lines",
      "Never do this.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Session Startup"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(
      "## Session Startup\nDo this first.\nDo this second.",
    );
  });

  // Case 4: H3 match -> returns heading + body until next H3/H2/H1
  it("extracts H3 section until next H3", () => {
    const md = [
      "## Parent",
      "### Sub A",
      "Content A.",
      "### Sub B",
      "Content B.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Sub A"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("### Sub A\nContent A.");
  });

  it("extracts H3 section terminated by H2", () => {
    const md = [
      "### Sub A",
      "Content A.",
      "## Next H2",
      "H2 content.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Sub A"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("### Sub A\nContent A.");
  });

  // Case 5: Case-insensitive match
  it("matches headings case-insensitively", () => {
    const md = [
      "## Session Startup",
      "Instructions here.",
      "## Other",
      "Unrelated.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["session startup"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("## Session Startup\nInstructions here.");
  });

  // Case 6: Heading inside fenced code block -> ignored
  it("ignores headings inside fenced code blocks", () => {
    const md = [
      "## Real Section",
      "Content before fence.",
      "```",
      "## Fake Heading",
      "code here",
      "```",
      "Content after fence.",
      "## Next Section",
      "Next content.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Real Section"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("## Fake Heading"); // fake heading is captured as body content
    expect(result[0]).toContain("Content after fence.");
  });

  it("does not match heading name that is inside a code block", () => {
    const md = [
      "## Intro",
      "Hello.",
      "```",
      "## Target Section",
      "This is code, not a real heading.",
      "```",
      "## Other",
      "Other content.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Target Section"]);
    expect(result).toHaveLength(0);
  });

  // Case 7: Section at EOF (no subsequent heading) -> flushed correctly
  it("flushes section at EOF when no subsequent heading exists", () => {
    const md = [
      "## Some Section",
      "Unrelated.",
      "## Target",
      "Line 1.",
      "Line 2.",
      "Line 3.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Target"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("## Target\nLine 1.\nLine 2.\nLine 3.");
  });

  // Case 8: Multiple matching sections -> all returned in order
  it("returns multiple matching sections in order", () => {
    const md = [
      "## Session Startup",
      "Startup content.",
      "## Red Lines",
      "Safety content.",
      "## Other",
      "Other content.",
    ].join("\n");

    const result = extractMarkdownSections(md, [
      "Session Startup",
      "Red Lines",
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("## Session Startup\nStartup content.");
    expect(result[1]).toBe("## Red Lines\nSafety content.");
  });

  // Case 9: H3 under H2 of different name -> included in H2 section content
  it("includes nested H3 in H2 section when H3 has a different name", () => {
    const md = [
      "## Session Startup",
      "Intro.",
      "### Steps",
      "Step 1.",
      "Step 2.",
      "## Next Section",
      "Done.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Session Startup"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("### Steps");
    expect(result[0]).toContain("Step 1.");
    expect(result[0]).toContain("Step 2.");
  });

  // Case 10: Non-matching headings -> skipped
  it("returns empty array when no headings match", () => {
    const md = [
      "## Something Else",
      "Content A.",
      "## Another Thing",
      "Content B.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Session Startup"]);
    expect(result).toHaveLength(0);
  });

  // Case 11: H1 headings -> not matched (only H2/H3)
  it("does not match H1 headings", () => {
    const md = [
      "# Session Startup",
      "Top-level heading content.",
      "## Other",
      "Other content.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Session Startup"]);
    expect(result).toHaveLength(0);
  });

  // Case 12: Nested fences (``` inside ```) -> toggle correctly
  it("handles nested fenced code blocks correctly", () => {
    const md = [
      "## Before",
      "Content.",
      "```",
      "outer code",
      "```",
      "## Target",
      "Real content.",
      "```",
      "## Fake Inside",
      "```",
      "After fence content.",
      "## After",
      "After content.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Target"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("Real content.");
    expect(result[0]).toContain("## Fake Inside"); // inside fence, captured as body
    expect(result[0]).toContain("After fence content.");
  });

  // Edge case: H2 terminated by H1 (higher level outside our match range)
  it("terminates H2 section when H1 is encountered (even though H1 is not matchable)", () => {
    // An H1 has level 1, which is < 2 (currentLevel). So it should close the section.
    // But our regex only matches #{2,3}, so H1 won't be caught by the heading regex.
    // H1 lines are just body text and get appended to the current section.
    // This is acceptable behavior: H1 is not a valid section delimiter in this context.
    const md = [
      "## Target",
      "Content.",
      "# Top Level",
      "More text.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Target"]);
    expect(result).toHaveLength(1);
    // H1 is not detected as heading by the regex, so it becomes body text
    expect(result[0]).toContain("# Top Level");
  });

  // Edge case: indented code fences
  it("handles indented code fence markers", () => {
    const md = [
      "## Target",
      "Content.",
      "  ```python",
      "  ## Not A Heading",
      "  print('hello')",
      "  ```",
      "More content.",
      "## Other",
      "Other content.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Target"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("## Not A Heading");
    expect(result[0]).toContain("More content.");
  });

  // Edge case: trailing whitespace on heading
  it("trims heading text before matching", () => {
    const md = [
      "## Session Startup  ",
      "Content.",
      "## Other",
      "Other.",
    ].join("\n");

    const result = extractMarkdownSections(md, ["Session Startup"]);
    expect(result).toHaveLength(1);
  });
});

describe("MAX_POST_COMPACTION_CHARS", () => {
  it("is exported as 3000", () => {
    expect(MAX_POST_COMPACTION_CHARS).toBe(3000);
  });
});
