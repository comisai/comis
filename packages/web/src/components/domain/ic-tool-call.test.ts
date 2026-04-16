import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcToolCall } from "./ic-tool-call.js";

// Side-effect import to register custom element
import "./ic-tool-call.js";

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

describe("IcToolCall", () => {
  it("renders tool name in header", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "memory_search",
    });
    const toolName = el.shadowRoot?.querySelector(".tool-name");
    expect(toolName).toBeTruthy();
    expect(toolName?.textContent).toBe("memory_search");
  });

  it("shows success icon when status is 'success'", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      status: "success",
    });
    const status = el.shadowRoot?.querySelector(".status");
    expect(status).toBeTruthy();
    const icon = status?.querySelector("ic-icon");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("name")).toBe("check");
  });

  it("shows error icon when status is 'error'", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      status: "error",
    });
    const status = el.shadowRoot?.querySelector(".status");
    const icon = status?.querySelector("ic-icon");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("name")).toBe("x");
  });

  it("shows loading indicator when status is 'running'", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      status: "running",
    });
    const status = el.shadowRoot?.querySelector(".status");
    const loader = status?.querySelector("ic-loading");
    expect(loader).toBeTruthy();
  });

  it("collapsed by default (expanded is false)", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
    });
    expect(el.expanded).toBe(false);
    const body = el.shadowRoot?.querySelector(".body");
    expect(body).toBeNull();
  });

  it("click header toggles expanded state", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      input: { query: "hello" },
    });
    expect(el.expanded).toBe(false);

    const header = el.shadowRoot?.querySelector(".header") as HTMLButtonElement;
    header?.click();
    await (el as any).updateComplete;

    expect(el.expanded).toBe(true);
    const body = el.shadowRoot?.querySelector(".body");
    expect(body).toBeTruthy();
  });

  it("Enter key on header toggles expanded", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      input: { query: "hello" },
    });
    const header = el.shadowRoot?.querySelector(".header") as HTMLButtonElement;
    header?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await (el as any).updateComplete;
    expect(el.expanded).toBe(true);
  });

  it("Space key on header toggles expanded", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      input: { query: "hello" },
    });
    const header = el.shadowRoot?.querySelector(".header") as HTMLButtonElement;
    header?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await (el as any).updateComplete;
    expect(el.expanded).toBe(true);
  });

  it("expanded body shows input section with ic-code-block", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      expanded: true,
      input: { query: "hello" },
    });
    const body = el.shadowRoot?.querySelector(".body");
    expect(body).toBeTruthy();
    const codeBlock = body?.querySelector("ic-code-block");
    expect(codeBlock).toBeTruthy();
  });

  it("expanded body shows output section with ic-code-block", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      expanded: true,
      output: { result: "found" },
    });
    const sections = el.shadowRoot?.querySelectorAll(".section");
    // Should have output section
    expect(sections?.length).toBeGreaterThan(0);
    const codeBlock = el.shadowRoot?.querySelector(".body ic-code-block");
    expect(codeBlock).toBeTruthy();
  });

  it("input renders as formatted JSON", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      expanded: true,
      input: { query: "hello", limit: 10 },
    });
    const codeBlock = el.shadowRoot?.querySelector(".body ic-code-block") as any;
    expect(codeBlock).toBeTruthy();
    const code = codeBlock?.code ?? "";
    expect(code).toContain('"query"');
    expect(code).toContain('"hello"');
    expect(code).toContain("10");
  });

  it("hides input section when input is null", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      expanded: true,
      input: null,
      output: { result: "ok" },
    });
    const labels = el.shadowRoot?.querySelectorAll(".section-label");
    const inputLabel = Array.from(labels ?? []).find((l) => l.textContent === "Input");
    expect(inputLabel).toBeUndefined();
  });

  it("hides output section when output is null", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
      expanded: true,
      input: { query: "hello" },
      output: null,
    });
    const labels = el.shadowRoot?.querySelectorAll(".section-label");
    const outputLabel = Array.from(labels ?? []).find((l) => l.textContent === "Output");
    expect(outputLabel).toBeUndefined();
  });

  it("has aria-expanded attribute that reflects state", async () => {
    const el = await createElement<IcToolCall>("ic-tool-call", {
      toolName: "test",
    });
    const header = el.shadowRoot?.querySelector(".header");
    expect(header?.getAttribute("aria-expanded")).toBe("false");

    el.expanded = true;
    await (el as any).updateComplete;
    expect(header?.getAttribute("aria-expanded")).toBe("true");
  });
});
