// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { renderMarkdownToMatrixHtml, sanitizeInboundHtml } from "../format-matrix.js";

describe("renderMarkdownToMatrixHtml", () => {
  it("renders bold markdown to a strong element while keeping the plaintext fallback body", () => {
    const { body, formattedBody } = renderMarkdownToMatrixHtml("**bold**");
    expect(formattedBody).toMatch(/<(strong|b)>bold<\/(strong|b)>/);
    // The Matrix `body` is the plaintext fallback for clients that ignore HTML.
    expect(body).toBe("**bold**");
  });

  it("renders italic markdown to an em element", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("*italic*");
    expect(formattedBody).toMatch(/<(em|i)>italic<\/(em|i)>/);
  });

  it("renders inline code to a code element", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("`snippet`");
    expect(formattedBody).toContain("<code>snippet</code>");
  });

  it("renders a fenced code block to a pre/code element", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("```\nline one\n```");
    expect(formattedBody).toContain("<pre><code>");
    expect(formattedBody).toContain("line one");
    expect(formattedBody).toContain("</code></pre>");
  });

  it("renders a safe https link to an anchor with the http(s) href preserved", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("[x](https://h)");
    expect(formattedBody).toContain('<a href="https://h">x</a>');
  });

  it("renders an unordered list to a ul with one li per item", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("- a\n- b");
    expect(formattedBody).toContain("<ul>");
    expect(formattedBody).toContain("<li>a</li>");
    expect(formattedBody).toContain("<li>b</li>");
    expect(formattedBody).toContain("</ul>");
  });

  it("renders an ordered list to an ol with one li per item", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("1. a\n2. b");
    expect(formattedBody).toContain("<ol>");
    expect(formattedBody).toContain("<li>a</li>");
    expect(formattedBody).toContain("<li>b</li>");
    expect(formattedBody).toContain("</ol>");
  });

  it("renders a blockquote line to a blockquote element", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("> q");
    expect(formattedBody).toMatch(/<blockquote>[\s\S]*q[\s\S]*<\/blockquote>/);
  });

  it("renders a heading to the matching hN element", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("# Title");
    expect(formattedBody).toContain("<h1>Title</h1>");
  });

  it("passes plain text through as escaped text with no injected tags and an identical body", () => {
    const { body, formattedBody } = renderMarkdownToMatrixHtml("hello");
    expect(formattedBody).toBe("hello");
    expect(body).toBe("hello");
  });

  it("escapes raw HTML in outbound text so a script tag can never be injected into formatted_body", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("<script>alert(1)</script>");
    expect(formattedBody).not.toContain("<script>");
    expect(formattedBody).toContain("&lt;script&gt;");
  });

  it("neutralizes a dangerous-scheme link in outbound markdown rather than emitting a javascript href", () => {
    const { formattedBody } = renderMarkdownToMatrixHtml("[click](javascript:alert(1))");
    expect(formattedBody).not.toContain("javascript:");
    expect(formattedBody).not.toMatch(/<a\s+href="javascript/i);
  });
});

describe("sanitizeInboundHtml", () => {
  it("removes a script element together with its contents while keeping surrounding text", () => {
    const out = sanitizeInboundHtml("<script>alert(1)</script>hi");
    expect(out).toContain("hi");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert");
  });

  it("removes a style element together with its contents while keeping a safe bold element", () => {
    const out = sanitizeInboundHtml("<style>.x{color:red}</style><b>x</b>");
    expect(out).not.toContain("<style>");
    expect(out).toContain("<b>x</b>");
  });

  it("removes an iframe element together with its contents while keeping surrounding text", () => {
    const out = sanitizeInboundHtml('<iframe src="http://evil"></iframe>ok');
    expect(out).not.toContain("<iframe");
    expect(out).toContain("ok");
  });

  it("strips a javascript: scheme from an anchor href", () => {
    const out = sanitizeInboundHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain("x");
  });

  it("strips a data: scheme from an anchor href", () => {
    const out = sanitizeInboundHtml('<a href="data:text/html,evil">x</a>');
    expect(out).not.toContain("data:");
    expect(out).toContain("x");
  });

  it("strips a double-quoted on* event-handler attribute", () => {
    const out = sanitizeInboundHtml('<b onclick="x()">y</b>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("y");
  });

  it("strips a single-quoted on* event-handler attribute", () => {
    const out = sanitizeInboundHtml("<b onerror='y()'>z</b>");
    expect(out).not.toContain("onerror");
    expect(out).toContain("z");
  });

  it("preserves a safe anchor with an https href", () => {
    const out = sanitizeInboundHtml('<a href="https://h">link</a>');
    expect(out).toContain('href="https://h"');
    expect(out).toContain("link");
    expect(out).toMatch(/<a[\s>]/);
  });

  it("strips markup for a tag outside the safe subset while keeping its text content", () => {
    const out = sanitizeInboundHtml('<form action="x"><button>text</button></form>');
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<button");
    expect(out).toContain("text");
  });
});
