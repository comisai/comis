import { describe, it, expect, afterEach } from "vitest";
import { IcTag } from "./ic-tag.js";

// Import side-effect to register custom element
import "./ic-tag.js";

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
});

describe("IcTag", () => {
  it("renders a pill-shaped element", async () => {
    const el = await createElement<IcTag>("ic-tag");
    const tag = el.shadowRoot?.querySelector(".tag");
    expect(tag).toBeTruthy();
  });

  it("default variant uses muted color", async () => {
    const el = await createElement<IcTag>("ic-tag");
    const tag = el.shadowRoot?.querySelector(".tag") as HTMLElement;
    expect(tag?.style.color).toContain("var(--ic-text-muted)");
  });

  it("success variant uses success color", async () => {
    const el = await createElement<IcTag>("ic-tag", { variant: "success" });
    const tag = el.shadowRoot?.querySelector(".tag") as HTMLElement;
    expect(tag?.style.color).toContain("var(--ic-success)");
  });

  it("error variant uses error color", async () => {
    const el = await createElement<IcTag>("ic-tag", { variant: "error" });
    const tag = el.shadowRoot?.querySelector(".tag") as HTMLElement;
    expect(tag?.style.color).toContain("var(--ic-error)");
  });

  it("warning variant uses warning color", async () => {
    const el = await createElement<IcTag>("ic-tag", { variant: "warning" });
    const tag = el.shadowRoot?.querySelector(".tag") as HTMLElement;
    expect(tag?.style.color).toContain("var(--ic-warning)");
  });

  it("info variant uses info color", async () => {
    const el = await createElement<IcTag>("ic-tag", { variant: "info" });
    const tag = el.shadowRoot?.querySelector(".tag") as HTMLElement;
    expect(tag?.style.color).toContain("var(--ic-info)");
  });

  it("accent variant uses accent color", async () => {
    const el = await createElement<IcTag>("ic-tag", { variant: "accent" });
    const tag = el.shadowRoot?.querySelector(".tag") as HTMLElement;
    expect(tag?.style.color).toContain("var(--ic-accent)");
  });

  it("platform variant (telegram) uses platform color", async () => {
    const el = await createElement<IcTag>("ic-tag", { variant: "telegram" });
    const tag = el.shadowRoot?.querySelector(".tag") as HTMLElement;
    expect(tag?.style.color).toContain("var(--ic-telegram)");
  });

  it("content rendered via slot", async () => {
    const el = await createElement<IcTag>("ic-tag");
    el.textContent = "Active";
    await (el as any).updateComplete;
    const slot = el.shadowRoot?.querySelector("slot");
    expect(slot).toBeTruthy();
  });

  it("sm size applies correct class", async () => {
    const el = await createElement<IcTag>("ic-tag", { size: "sm" });
    const tag = el.shadowRoot?.querySelector(".tag");
    expect(tag?.classList.contains("tag--sm")).toBe(true);
  });

  it("md size applies correct class", async () => {
    const el = await createElement<IcTag>("ic-tag", { size: "md" });
    const tag = el.shadowRoot?.querySelector(".tag");
    expect(tag?.classList.contains("tag--md")).toBe(true);
  });
});
