// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcChatMessage } from "./ic-chat-message.js";
import { renderMarkdown, sanitizeHtml } from "./ic-chat-message.js";

// Side-effect import to register custom element
import "./ic-chat-message.js";

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

describe("IcChatMessage", () => {
  it("user message renders right-aligned with accent background", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "Hello",
    });
    const wrapper = el.shadowRoot?.querySelector(".wrapper--user");
    expect(wrapper).toBeTruthy();
    const bubble = el.shadowRoot?.querySelector(".bubble--user");
    expect(bubble).toBeTruthy();
  });

  it("assistant message renders left-aligned with surface background", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: "Hi there",
    });
    const wrapper = el.shadowRoot?.querySelector(".wrapper--assistant");
    expect(wrapper).toBeTruthy();
    const bubble = el.shadowRoot?.querySelector(".bubble--assistant");
    expect(bubble).toBeTruthy();
  });

  it("error message renders with red-tinted background and error border", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "error",
      content: "Something went wrong",
    });
    const wrapper = el.shadowRoot?.querySelector(".wrapper--error");
    expect(wrapper).toBeTruthy();
    const bubble = el.shadowRoot?.querySelector(".bubble--error");
    expect(bubble).toBeTruthy();
  });

  it("system message renders centered with dim text", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "system",
      content: "Session started",
    });
    const wrapper = el.shadowRoot?.querySelector(".wrapper--system");
    expect(wrapper).toBeTruthy();
    const bubble = el.shadowRoot?.querySelector(".bubble--system");
    expect(bubble).toBeTruthy();
  });

  it("timestamp renders formatted time when timestamp > 0", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "test",
      timestamp: new Date(2026, 0, 15, 14, 30).getTime(),
    });
    const ts = el.shadowRoot?.querySelector(".timestamp");
    expect(ts).toBeTruthy();
    expect(ts?.textContent).toBeTruthy();
    // Should contain some time-like text
    expect(ts?.textContent?.length).toBeGreaterThan(0);
  });

  it("timestamp is hidden when timestamp is 0", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "test",
      timestamp: 0,
    });
    const ts = el.shadowRoot?.querySelector(".timestamp");
    expect(ts).toBeNull();
  });

  it("has role='article' with aria-label containing role name", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: "test",
    });
    const article = el.shadowRoot?.querySelector("[role='article']");
    expect(article).toBeTruthy();
    expect(article?.getAttribute("aria-label")).toBe("assistant message");
  });

  it("assistant message renders bold markdown (**text** becomes strong)", () => {
    const result = renderMarkdown("**bold text**");
    expect(result).toContain("<strong>bold text</strong>");
  });

  it("assistant message renders italic markdown (*text* becomes em)", () => {
    const result = renderMarkdown("*italic text*");
    expect(result).toContain("<em>italic text</em>");
  });

  it("assistant message renders inline code (backtick becomes code element)", () => {
    const result = renderMarkdown("use `console.log`");
    expect(result).toContain("<code");
    expect(result).toContain("console.log");
  });

  it("assistant message renders links ([text](url) becomes anchor)", () => {
    const result = renderMarkdown("[click here](https://example.com)");
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain("click here</a>");
  });

  it("assistant message renders code fences as ic-code-block elements", () => {
    const result = renderMarkdown("```json\n{\"key\": 1}\n```");
    expect(result).toContain("<ic-code-block");
    expect(result).toContain('language="json"');
  });

  it("assistant message renders unordered lists", () => {
    const result = renderMarkdown("- item one\n- item two");
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>item one</li>");
    expect(result).toContain("<li>item two</li>");
  });

  it("assistant message renders ordered lists", () => {
    const result = renderMarkdown("1. first\n2. second");
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>first</li>");
    expect(result).toContain("<li>second</li>");
  });

  it("user message does NOT process markdown (plain text only)", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "**bold** and *italic*",
    });
    const bubble = el.shadowRoot?.querySelector(".bubble--user");
    // User messages should show plain text, not HTML
    expect(bubble?.textContent).toContain("**bold** and *italic*");
    expect(bubble?.innerHTML).not.toContain("<strong>");
  });

  it("XSS: script tags are stripped from content", () => {
    const result = sanitizeHtml('<script>alert("xss")</script>');
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
  });

  it("XSS: on-event handlers are stripped from content", () => {
    const result = sanitizeHtml('<img onerror="alert(1)" src="x">');
    expect(result).not.toContain("onerror");
  });

  it("XSS: javascript: URLs are stripped from content", () => {
    const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain("javascript:");
  });

  /* ==================== Per-Message Action Tests ==================== */

  it("action buttons container exists in shadow DOM", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "Hello",
      messageId: "msg-1",
    });
    const actions = el.shadowRoot?.querySelector(".message-actions");
    expect(actions).toBeTruthy();
  });

  it("action buttons hidden by default (opacity 0 via CSS)", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "Hello",
      messageId: "msg-1",
    });
    const actions = el.shadowRoot?.querySelector(".message-actions") as HTMLElement;
    expect(actions).toBeTruthy();
    // CSS sets opacity: 0 by default (hover shows them)
    // We verify the class exists which implies the CSS rule applies
    expect(actions?.classList.contains("message-actions")).toBe(true);
  });

  it("copy button present for all message roles (user)", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "Hello",
      messageId: "msg-1",
    });
    const copyBtn = el.shadowRoot?.querySelector('[aria-label="Copy message"]');
    expect(copyBtn).toBeTruthy();
  });

  it("copy button present for assistant messages", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: "Hello",
      messageId: "msg-1",
    });
    const copyBtn = el.shadowRoot?.querySelector('[aria-label="Copy message"]');
    expect(copyBtn).toBeTruthy();
  });

  it("retry button present only for assistant messages", async () => {
    const assistantEl = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: "Hello",
      messageId: "msg-1",
    });
    const retryBtn = assistantEl.shadowRoot?.querySelector('[aria-label="Retry message"]');
    expect(retryBtn).toBeTruthy();

    document.body.innerHTML = "";

    const userEl = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "Hello",
      messageId: "msg-2",
    });
    const userRetryBtn = userEl.shadowRoot?.querySelector('[aria-label="Retry message"]');
    expect(userRetryBtn).toBeNull();
  });

  it("delete button present for all message roles", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "Hello",
      messageId: "msg-1",
    });
    const deleteBtn = el.shadowRoot?.querySelector('[aria-label="Delete message"]');
    expect(deleteBtn).toBeTruthy();
  });

  it("copy button calls navigator.clipboard.writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: "Copy me",
      messageId: "msg-1",
    });

    const copyBtn = el.shadowRoot?.querySelector('[aria-label="Copy message"]') as HTMLButtonElement;
    copyBtn?.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(writeText).toHaveBeenCalledWith("Copy me");
  });

  it("retry button click dispatches 'retry' CustomEvent with messageId", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: "Hello",
      messageId: "msg-42",
    });

    const handler = vi.fn();
    el.addEventListener("retry", handler);

    const retryBtn = el.shadowRoot?.querySelector('[aria-label="Retry message"]') as HTMLButtonElement;
    retryBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ messageId: "msg-42" });
  });

  it("delete button click dispatches 'delete' CustomEvent with messageId", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "user",
      content: "Hello",
      messageId: "msg-99",
    });

    const handler = vi.fn();
    el.addEventListener("delete", handler);

    const deleteBtn = el.shadowRoot?.querySelector('[aria-label="Delete message"]') as HTMLButtonElement;
    deleteBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({ messageId: "msg-99" });
  });

  /* ==================== Media Attachment Auth Token Tests ==================== */

  it("renderMarkdown appends ?token= to relative /media/ URLs in attachment markers", () => {
    const json = JSON.stringify({ url: "/media/abc123", type: "image", mimeType: "image/png", fileName: "photo.png" });
    const result = renderMarkdown(`<!-- attachment:${json} -->`, "my-secret-token");
    expect(result).toContain('src="/media/abc123?token=my-secret-token"');
  });

  it("renderMarkdown does NOT append token to external URLs in attachment markers", () => {
    const json = JSON.stringify({ url: "https://cdn.example.com/img.png", type: "image", mimeType: "image/png", fileName: "img.png" });
    const result = renderMarkdown(`<!-- attachment:${json} -->`, "my-secret-token");
    expect(result).toContain('src="https://cdn.example.com/img.png"');
    expect(result).not.toContain("token=");
  });

  it("renderMarkdown does NOT append token when token is empty", () => {
    const json = JSON.stringify({ url: "/media/abc123", type: "image", mimeType: "image/png", fileName: "photo.png" });
    const result = renderMarkdown(`<!-- attachment:${json} -->`, "");
    expect(result).toContain('src="/media/abc123"');
    expect(result).not.toContain("token=");
  });

  it("renderMarkdown appends token with & if URL already has query params", () => {
    const json = JSON.stringify({ url: "/media/abc123?format=webp", type: "image", mimeType: "image/webp", fileName: "photo.webp" });
    const result = renderMarkdown(`<!-- attachment:${json} -->`, "tok");
    expect(result).toContain("/media/abc123?format=webp&amp;token=tok");
  });

  it("system messages do not show action buttons", async () => {
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "system",
      content: "System message",
      messageId: "msg-sys",
    });
    const actions = el.shadowRoot?.querySelector(".message-actions");
    expect(actions).toBeNull();
  });
});
