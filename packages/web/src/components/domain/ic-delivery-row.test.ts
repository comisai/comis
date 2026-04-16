import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcDeliveryRow } from "./ic-delivery-row.js";
import type { DeliveryTrace } from "../../api/types/index.js";

// Side-effect import to register custom element
import "./ic-delivery-row.js";

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */

const MOCK_TRACE: DeliveryTrace = {
  traceId: "trace-001",
  timestamp: Date.now() - 60_000,
  channelType: "telegram",
  messagePreview: "Hello, how can I help you today?",
  status: "success",
  latencyMs: 187,
  stepCount: 3,
};

const MOCK_FAILED_TRACE: DeliveryTrace = {
  traceId: "trace-002",
  timestamp: Date.now() - 120_000,
  channelType: "discord",
  messagePreview: "Failed message that did not arrive",
  status: "failed",
  latencyMs: null,
  stepCount: 1,
};

const MOCK_TIMEOUT_TRACE: DeliveryTrace = {
  traceId: "trace-003",
  timestamp: Date.now() - 300_000,
  channelType: "slack",
  messagePreview: "This is a really long message that should be truncated to fit nicely in the table row cell",
  status: "timeout",
  latencyMs: 30000,
  stepCount: 2,
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcDeliveryRow> {
  const el = document.createElement("ic-delivery-row") as IcDeliveryRow;
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

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("IcDeliveryRow", () => {
  it("1 - renders all 6 cells when trace is provided", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const cells = el.shadowRoot?.querySelectorAll('[role="cell"]');
    expect(cells?.length).toBe(6);
  });

  it("2 - shows relative time for timestamp", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const relTime = el.shadowRoot?.querySelector("ic-relative-time");
    expect(relTime).toBeTruthy();
    expect((relTime as any).timestamp).toBe(MOCK_TRACE.timestamp);
  });

  it("3 - shows channel type as tag", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag).toBeTruthy();
    expect(tag?.textContent?.trim()).toBe("telegram");
  });

  it("4 - shows truncated message preview", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const messageCell = el.shadowRoot?.querySelector(".cell-message");
    expect(messageCell).toBeTruthy();
    expect(messageCell?.textContent?.trim()).toBe(MOCK_TRACE.messagePreview);
  });

  it("5 - shows success status indicator", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const statusIcon = el.shadowRoot?.querySelector('svg[aria-label="Success"]');
    expect(statusIcon).toBeTruthy();
  });

  it("6 - shows failed status indicator", async () => {
    const el = await createElement({ trace: MOCK_FAILED_TRACE });
    const statusIcon = el.shadowRoot?.querySelector('svg[aria-label="Failed"]');
    expect(statusIcon).toBeTruthy();
  });

  it("7 - shows timeout status indicator", async () => {
    const el = await createElement({ trace: MOCK_TIMEOUT_TRACE });
    const statusIcon = el.shadowRoot?.querySelector('svg[aria-label="Timeout"]');
    expect(statusIcon).toBeTruthy();
  });

  it("8 - shows latency in milliseconds", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const latencyCell = el.shadowRoot?.querySelector(".cell-latency");
    expect(latencyCell?.textContent?.trim()).toBe("187ms");
  });

  it("9 - shows '--' for null latency", async () => {
    const el = await createElement({ trace: MOCK_FAILED_TRACE });
    const latencyCell = el.shadowRoot?.querySelector(".cell-latency");
    expect(latencyCell?.textContent?.trim()).toBe("--");
  });

  it("10 - shows step count", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const cells = el.shadowRoot?.querySelectorAll('[role="cell"]');
    const lastCell = cells?.[5];
    expect(lastCell?.textContent?.trim()).toBe("3");
  });

  it("11 - dispatches trace-click on click", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const handler = vi.fn();
    el.addEventListener("trace-click", handler);

    const row = el.shadowRoot?.querySelector('[role="row"]') as HTMLElement;
    row.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("trace-001");
  });

  it("12 - dispatches trace-click on Enter keydown", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const handler = vi.fn();
    el.addEventListener("trace-click", handler);

    const row = el.shadowRoot?.querySelector('[role="row"]') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("trace-001");
  });

  it("13 - dispatches trace-click on Space keydown", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const handler = vi.fn();
    el.addEventListener("trace-click", handler);

    const row = el.shadowRoot?.querySelector('[role="row"]') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("14 - renders nothing when trace is null", async () => {
    const el = await createElement({ trace: null });
    const cells = el.shadowRoot?.querySelectorAll('[role="cell"]');
    expect(cells?.length ?? 0).toBe(0);
  });

  it("15 - truncates long message preview at 40 chars", async () => {
    const el = await createElement({ trace: MOCK_TIMEOUT_TRACE });
    const messageCell = el.shadowRoot?.querySelector(".cell-message");
    const text = messageCell?.textContent?.trim() ?? "";
    // 40 chars + "..."
    expect(text.length).toBeLessThanOrEqual(43);
    expect(text).toContain("...");
  });

  it("16 - row has tabindex and role attributes", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const row = el.shadowRoot?.querySelector('[role="row"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.getAttribute("role")).toBe("row");
  });
});
