// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcCommandPalette } from "./ic-command-palette.js";

// Import side-effect to register the command palette. As an eagerly-loaded
// shell component it must ALSO transitively register <ic-icon> (rendered for
// every result row). We deliberately do NOT stub ic-icon here so the
// "renders a real icon" regression test exercises the real registration path.
import "./ic-command-palette.js";

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

describe("IcCommandPalette", () => {
  it("renders when open=true", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });
    const backdrop = el.shadowRoot?.querySelector(".backdrop");
    expect(backdrop).toBeTruthy();
  });

  it("registers the real ic-icon element and renders a non-blank icon for every result", async () => {
    // Regression: the palette is loaded eagerly by the shell but historically
    // never imported ic-icon, and its item icon names (lucide-style: "home",
    // "dollar-sign", "git-branch", ...) did not exist in ic-icon's ICON_MAP.
    // Every result-row icon was therefore blank until some lazy view happened
    // to register ic-icon. Both halves must hold: ic-icon is registered purely
    // by importing the palette, AND every rendered icon resolves to a real <svg>.
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });
    // updated() populates _results on open; await the follow-up render.
    await (el as any).updateComplete;

    expect(
      customElements.get("ic-icon"),
      "importing the command palette must register ic-icon",
    ).toBeTruthy();

    const icons = Array.from(
      el.shadowRoot?.querySelectorAll("ic-icon") ?? [],
    ) as HTMLElement[];
    expect(icons.length).toBeGreaterThan(0);

    for (const icon of icons) {
      await (icon as any).updateComplete;
      const name = icon.getAttribute("name");
      const svg = icon.shadowRoot?.querySelector("svg");
      expect(
        svg,
        `palette icon "${name}" must resolve to a real SVG path in ICON_MAP`,
      ).toBeTruthy();
    }
  });

  it("renders non-blank icons for dynamic agent and session results", async () => {
    // The dynamic agent/session items also used names absent from ICON_MAP
    // ("user", "message-circle"). Surface those categories via search and
    // assert each resolves to a real SVG.
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
      agents: [{ id: "default", name: "default" }],
      sessions: [{ key: "agent:default:web:1", agentId: "default" }],
    });
    await (el as any).updateComplete;

    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
    if (input) {
      input.value = "default";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    await (el as any).updateComplete;

    const icons = Array.from(
      el.shadowRoot?.querySelectorAll("ic-icon") ?? [],
    ) as HTMLElement[];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      await (icon as any).updateComplete;
      const svg = icon.shadowRoot?.querySelector("svg");
      expect(
        svg,
        `dynamic palette icon "${icon.getAttribute("name")}" must resolve to a real SVG`,
      ).toBeTruthy();
    }
  });

  it("does not render when open=false", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: false,
    });
    const backdrop = el.shadowRoot?.querySelector(".backdrop");
    expect(backdrop).toBeNull();
  });

  it("has role=combobox on the search input", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });
    const input = el.shadowRoot?.querySelector('[role="combobox"]');
    expect(input).toBeTruthy();
  });

  it("sets modal dialog semantics on the command palette", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", { open: true });
    const dialog = el.shadowRoot?.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
  });

  it("has role=listbox on the results container", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });
    const listbox = el.shadowRoot?.querySelector('[role="listbox"]');
    expect(listbox).toBeTruthy();
  });

  it("filters results based on input", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });

    // Type in search
    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
    if (input) {
      input.value = "Dashboard";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    await (el as any).updateComplete;

    const options = el.shadowRoot?.querySelectorAll('[role="option"]');
    // Should have at least the Dashboard result
    expect(options?.length).toBeGreaterThan(0);
    const labels = Array.from(options!).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Dashboard"))).toBe(true);
  });

  it("does not offer the unsupported setup wizard as a command", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });
    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
    expect(input).toBeTruthy();
    input!.value = "Setup Wizard";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await (el as any).updateComplete;

    expect(el.shadowRoot?.querySelectorAll('[role="option"]').length).toBe(0);
  });

  it("arrow keys change activeIndex", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });

    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");

    // Press ArrowDown
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await (el as any).updateComplete;

    // Check that first result is selected
    const firstOption = el.shadowRoot?.querySelector("#result-0");
    expect(firstOption?.getAttribute("aria-selected")).toBe("true");
  });

  it("Enter dispatches navigate event for view items", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });

    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");

    // Move to first result
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await (el as any).updateComplete;

    // Press Enter
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await (el as any).updateComplete;

    expect(handler).toHaveBeenCalled();
  });

  it("Escape dispatches close event", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });

    const handler = vi.fn();
    el.addEventListener("close", handler);

    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await (el as any).updateComplete;

    expect(handler).toHaveBeenCalled();
  });

  it("shows agent items when agents are provided", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
      agents: [{ id: "test-agent", name: "Test Agent" }],
    });

    // Search for the agent
    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
    if (input) {
      input.value = "Test Agent";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    await (el as any).updateComplete;

    const options = el.shadowRoot?.querySelectorAll('[role="option"]');
    const labels = Array.from(options!).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Test Agent"))).toBe(true);
  });
});
