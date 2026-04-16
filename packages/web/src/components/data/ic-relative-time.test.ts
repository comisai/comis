import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { IcRelativeTime, formatRelative } from "./ic-relative-time.js";

// Import side-effect to register custom element
import "./ic-relative-time.js";

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
  vi.useRealTimers();
});

describe("IcRelativeTime", () => {
  it("renders a <time> element", async () => {
    const el = await createElement<IcRelativeTime>("ic-relative-time", {
      timestamp: Date.now() - 120000,
    });
    const time = el.shadowRoot?.querySelector("time");
    expect(time).toBeTruthy();
  });

  it('shows "just now" for timestamp within last 60 seconds', () => {
    const now = Date.now();
    expect(formatRelative(now - 30000, now)).toBe("just now");
  });

  it('shows "Xm ago" for timestamp within last hour', () => {
    const now = Date.now();
    expect(formatRelative(now - 5 * 60 * 1000, now)).toBe("5m ago");
    expect(formatRelative(now - 45 * 60 * 1000, now)).toBe("45m ago");
  });

  it('shows "Xh ago" for timestamp within last 24 hours', () => {
    const now = Date.now();
    expect(formatRelative(now - 3 * 60 * 60 * 1000, now)).toBe("3h ago");
    expect(formatRelative(now - 23 * 60 * 60 * 1000, now)).toBe("23h ago");
  });

  it('shows "Xd ago" for timestamp within last 30 days', () => {
    const now = Date.now();
    expect(formatRelative(now - 5 * 24 * 60 * 60 * 1000, now)).toBe("5d ago");
  });

  it("shows ISO date string for timestamps older than 30 days", () => {
    const now = Date.now();
    const old = now - 60 * 24 * 60 * 60 * 1000;
    const result = formatRelative(old, now);
    // Should be YYYY-MM-DD format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("<time> element has datetime attribute with ISO string", async () => {
    const ts = Date.now() - 120000;
    const el = await createElement<IcRelativeTime>("ic-relative-time", {
      timestamp: ts,
    });
    const time = el.shadowRoot?.querySelector("time");
    const expected = new Date(ts).toISOString();
    expect(time?.getAttribute("datetime")).toBe(expected);
  });

  it("<time> element has title attribute with full date", async () => {
    const ts = Date.now() - 120000;
    const el = await createElement<IcRelativeTime>("ic-relative-time", {
      timestamp: ts,
    });
    const time = el.shadowRoot?.querySelector("time");
    expect(time?.getAttribute("title")).toBeTruthy();
    // Title should contain some date string
    expect(time?.getAttribute("title")!.length).toBeGreaterThan(0);
  });

  it("sets up interval timer in connectedCallback", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setInterval");

    const el = await createElement<IcRelativeTime>("ic-relative-time", {
      timestamp: Date.now() - 120000,
    });

    // setInterval should have been called (at least once by our component)
    const calls = spy.mock.calls.filter((c) => c[1] === 60000);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    spy.mockRestore();
  });

  it("clears interval timer in disconnectedCallback", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");

    const el = await createElement<IcRelativeTime>("ic-relative-time", {
      timestamp: Date.now() - 120000,
    });

    // Remove from DOM to trigger disconnectedCallback
    el.remove();

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
