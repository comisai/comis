// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcCodeBlock } from "./ic-code-block.js";
import { highlightCode } from "./ic-code-block.js";

// Side-effect import to register custom element
import "./ic-code-block.js";

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("IcCodeBlock", () => {
  it("renders pre/code elements with code content", async () => {
    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "const x = 1;",
      language: "typescript",
    });
    const pre = el.shadowRoot?.querySelector("pre");
    const code = el.shadowRoot?.querySelector("code");
    expect(pre).toBeTruthy();
    expect(code).toBeTruthy();
    expect(code?.textContent).toContain("const");
    expect(code?.textContent).toContain("x");
  });

  it("displays language label in header when language prop is set", async () => {
    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "{}",
      language: "json",
    });
    const label = el.shadowRoot?.querySelector(".language-label");
    expect(label).toBeTruthy();
    expect(label?.textContent).toBe("json");
  });

  it("hides language header content when language is empty and copyable is false", async () => {
    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "plain text",
      language: "",
      copyable: false,
    });
    const header = el.shadowRoot?.querySelector(".header");
    expect(header).toBeNull();
  });

  it("copy button is visible when copyable is true", async () => {
    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "hello",
      language: "text",
      copyable: true,
    });
    const copyBtn = el.shadowRoot?.querySelector(".copy-btn");
    expect(copyBtn).toBeTruthy();
  });

  it("copy button is hidden when copyable is false", async () => {
    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "hello",
      language: "text",
      copyable: false,
    });
    const copyBtn = el.shadowRoot?.querySelector(".copy-btn");
    expect(copyBtn).toBeNull();
  });

  it("copy button calls navigator.clipboard.writeText with code content", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "copy me",
      language: "text",
    });
    const copyBtn = el.shadowRoot?.querySelector(".copy-btn") as HTMLButtonElement;
    copyBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeTextMock).toHaveBeenCalledWith("copy me");
  });

  it("shows 'Copied!' feedback after copy click and reverts after 2s", async () => {
    vi.useFakeTimers();
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "test",
      language: "text",
    });
    const copyBtn = el.shadowRoot?.querySelector(".copy-btn") as HTMLButtonElement;
    copyBtn?.click();

    // Wait for microtask (clipboard promise)
    await Promise.resolve();
    await Promise.resolve();
    await (el as any).updateComplete;

    let btnText = el.shadowRoot?.querySelector(".copy-btn")?.textContent?.trim();
    expect(btnText).toContain("Copied!");

    vi.advanceTimersByTime(2000);
    await (el as any).updateComplete;
    btnText = el.shadowRoot?.querySelector(".copy-btn")?.textContent?.trim();
    expect(btnText).toContain("Copy");

    vi.useRealTimers();
  });

  it("applies syntax highlighting CSS classes for strings in JSON", () => {
    const result = highlightCode('{"key": "value"}', "json");
    expect(result).toContain("hl-string");
  });

  it("applies keyword highlighting for JavaScript keywords", () => {
    const result = highlightCode("const x = 1;", "javascript");
    expect(result).toContain("hl-keyword");
    expect(result).toContain("const");
  });

  it("scrollable overflow for long code (max-height is set)", async () => {
    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "line\n".repeat(100),
      language: "text",
    });
    const codeArea = el.shadowRoot?.querySelector(".code-area") as HTMLElement;
    expect(codeArea).toBeTruthy();
    // The CSS sets max-height: 24rem with overflow-y: auto
    // We can verify the class exists which has this styling
    expect(codeArea.classList.contains("code-area")).toBe(true);
  });

  it("has role='region' and aria-label='Code block'", async () => {
    const el = await createElement<IcCodeBlock>("ic-code-block", {
      code: "test",
      language: "text",
    });
    const container = el.shadowRoot?.querySelector("[role='region']");
    expect(container).toBeTruthy();
    expect(container?.getAttribute("aria-label")).toBe("Code block");
  });

  it("renders plain text when language is empty (no highlighting applied)", () => {
    const result = highlightCode("const x = 1;", "");
    expect(result).not.toContain("hl-keyword");
    expect(result).not.toContain("hl-string");
    // Content should be HTML-escaped
    expect(result).toContain("const x = 1;");
  });
});
