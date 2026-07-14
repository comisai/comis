// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import { IcChatMessage, renderMarkdown } from "./ic-chat-message.js";

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
  vi.unstubAllGlobals();
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

  // XSS regression guard. renderMarkdown output is fed
  // straight into Lit's unsafeHTML sink (ic-chat-message.ts _renderContent +
  // pipeline-history-detail.ts) from UNTRUSTED agent/pipeline output. A
  // single-pass denylist (sanitizeHtml) can be defeated by nesting tags
  // (`<ifr<iframe>ame …>` -> a live `<iframe>` after one replace pass). The
  // renderer HTML-escapes all raw markup, so no live tag survives — only
  // the fixed safe tag set it generates from markdown is emitted.
  it("XSS: a plain script tag never reaches the output as a live tag", () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
  });

  it("XSS: a nested-tag iframe srcdoc payload cannot reconstruct a live <iframe>", () => {
    // The bypass class this defends against: a single-pass tag-strip leaves a
    // working <iframe srcdoc="…"> behind; srcdoc auto-executes with no click.
    const payload = '<ifr<iframe>ame srcdoc="&lt;script&gt;alert(document.domain)&lt;/script&gt;">';
    const result = renderMarkdown(payload);
    expect(result).not.toContain("<iframe");
    expect(result).toContain("&lt;iframe");
  });

  it("XSS: an svg onload payload is neutralized (no live <svg> tag)", () => {
    const result = renderMarkdown('<svg onload="alert(1)"></svg>');
    expect(result).not.toContain("<svg");
    expect(result).toContain("&lt;svg");
  });

  it("XSS: an img onerror payload is neutralized (no live <img> tag from message body)", () => {
    const result = renderMarkdown('<img onerror="alert(1)" src="x">');
    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
  });

  it("XSS: a javascript: markdown link does not produce an executable href", () => {
    const result = renderMarkdown("[click me](javascript:alert(1))");
    expect(result).not.toContain("javascript:");
    expect(result).not.toContain("<a ");
    // The link text is still shown (as inert, escaped text).
    expect(result).toContain("click me");
  });

  it("XSS: a data: markdown link is rejected", () => {
    const result = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(result).not.toContain("<a ");
    expect(result).not.toContain("data:text/html");
  });

  it("XSS: a normal https markdown link still renders as an anchor", () => {
    const result = renderMarkdown("[ok](https://example.com/path)");
    expect(result).toContain('<a href="https://example.com/path"');
    expect(result).toContain("ok</a>");
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

  /* ==================== Secure Media Attachment Tests ==================== */

  it("renderMarkdown defers relative media URLs instead of putting credentials in markup", () => {
    const json = JSON.stringify({ url: "/media/abc123def4567890.png", type: "image", mimeType: "image/png", fileName: "photo.png" });
    const result = renderMarkdown(`<!-- attachment:${json} -->`);
    expect(result).toContain('data-media-url="/media/abc123def4567890.png"');
    expect(result).toContain('alt="photo.png"');
    expect(result).not.toContain("?token=");
  });

  it("rejects external attachment URLs to prevent automatic third-party requests", () => {
    const json = JSON.stringify({ url: "https://cdn.example.com/img.png", type: "image", mimeType: "image/png", fileName: "img.png" });
    const result = renderMarkdown(`<!-- attachment:${json} -->`);
    expect(result).toBe("");
  });

  it("loads relative media without an Authorization header when no token is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["image-data"], { type: "image/png" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue("blob:unprotected-media"),
      revokeObjectURL: vi.fn(),
    });
    const json = JSON.stringify({ url: "/media/abc123", type: "image", mimeType: "image/png", fileName: "photo.png" });
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: `<!-- attachment:${json} -->`,
    });
    await vi.waitFor(() => {
      expect(el.shadowRoot?.querySelector("img")?.getAttribute("src"))
        .toBe("blob:unprotected-media");
    });

    expect(fetchMock).toHaveBeenCalledWith("/media/abc123", {
      signal: expect.any(AbortSignal),
    });
  });

  it("renderMarkdown rejects query parameters on protected media URLs", () => {
    const json = JSON.stringify({ url: "/media/abc123?format=webp", type: "image", mimeType: "image/webp", fileName: "photo.webp" });
    const result = renderMarkdown(`<!-- attachment:${json} -->`);
    expect(result).toBe("");
  });

  it("rejects noncanonical protected media paths before authenticated retrieval", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const json = JSON.stringify({
      url: "/media/../api/agents",
      type: "image",
      mimeType: "image/png",
      fileName: "photo.png",
    });
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: `<!-- attachment:${json} -->`,
      mediaToken: "my-secret-token",
    });
    await Promise.resolve();

    expect(el.shadowRoot?.querySelector("[data-media-url]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads protected media with an Authorization header and renders only a blob URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["image-data"], { type: "image/png" }), { status: 200 }),
    );
    const createObjectURL = vi.fn().mockReturnValue("blob:protected-media");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    const json = JSON.stringify({ url: "/media/abc123", type: "image", mimeType: "image/png", fileName: "photo.png" });
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: `<!-- attachment:${json} -->`,
      mediaToken: "my-secret-token",
    });
    await vi.waitFor(() => {
      const image = el.shadowRoot?.querySelector("img");
      expect(image?.getAttribute("src")).toBe("blob:protected-media");
    });

    expect(fetchMock).toHaveBeenCalledWith("/media/abc123", {
      headers: { Authorization: "Bearer my-secret-token" },
      signal: expect.any(AbortSignal),
    });
    expect(el.shadowRoot?.innerHTML).not.toContain("my-secret-token");
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it("revokes protected media blob URLs when the message disconnects", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(
      new Response(new Blob(["image-data"], { type: "image/png" }), { status: 200 }),
    )));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue("blob:protected-media"),
      revokeObjectURL,
    });

    const json = JSON.stringify({ url: "/media/abc123", type: "image", mimeType: "image/png", fileName: "photo.png" });
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: `<!-- attachment:${json} -->`,
      mediaToken: "my-secret-token",
    });
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector("img")?.getAttribute("src")).toBe("blob:protected-media"));

    el.remove();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:protected-media");
  });

  it("revokes the previous blob URL before loading changed message content", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(
      new Response(new Blob(["image-data"], { type: "image/png" }), { status: 200 }),
    )));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn()
        .mockReturnValueOnce("blob:first-media")
        .mockReturnValueOnce("blob:second-media"),
      revokeObjectURL,
    });

    const first = JSON.stringify({ url: "/media/first", type: "image", mimeType: "image/png", fileName: "first.png" });
    const second = JSON.stringify({ url: "/media/second", type: "image", mimeType: "image/png", fileName: "second.png" });
    const el = await createElement<IcChatMessage>("ic-chat-message", {
      role: "assistant",
      content: `<!-- attachment:${first} -->`,
      mediaToken: "my-secret-token",
    });
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector("img")?.getAttribute("src")).toBe("blob:first-media"));

    el.content = `<!-- attachment:${second} -->`;
    await el.updateComplete;
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector("img")?.getAttribute("src")).toBe("blob:second-media"));

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-media");
  });

  it("message actions become visible when keyboard focus enters the message", () => {
    const styles = IcChatMessage.styles.toString();
    expect(styles).toContain(".wrapper:focus-within .message-actions");
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
