// SPDX-License-Identifier: Apache-2.0
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
  sourceChannelType: "discord",
  targetChannelType: "telegram",
  status: "success",
  latencyMs: 187,
  error: null,
  failureStage: null,
  errorKind: null,
  stepCount: 3,
};

const MOCK_ERROR_TRACE: DeliveryTrace = {
  traceId: "trace-002",
  timestamp: Date.now() - 120_000,
  sourceChannelType: "telegram",
  targetChannelType: "discord",
  status: "error",
  latencyMs: null,
  error: "delivery_failed",
  failureStage: "delivery",
  errorKind: "platform",
  stepCount: 1,
};

const MOCK_TIMEOUT_TRACE: DeliveryTrace = {
  traceId: "trace-003",
  timestamp: Date.now() - 300_000,
  sourceChannelType: "telegram",
  targetChannelType: "slack",
  status: "timeout",
  latencyMs: 30000,
  error: "prompt_timeout",
  failureStage: "execution",
  errorKind: "timeout",
  stepCount: 2,
};

const MOCK_FILTERED_TRACE: DeliveryTrace = {
  ...MOCK_TRACE,
  traceId: "trace-004",
  status: "filtered",
};

const MOCK_ABORTED_TRACE: DeliveryTrace = {
  ...MOCK_TRACE,
  traceId: "trace-005",
  status: "aborted",
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

  it("shows the delivery destination rather than the source as the channel tag", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag).toBeTruthy();
    expect(tag?.textContent?.trim()).toBe("telegram");
  });

  it("renders the content-free trace identifier in the third column", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const messageCell = el.shadowRoot?.querySelector(".cell-trace");
    expect(messageCell).toBeTruthy();
    expect(messageCell?.textContent?.trim()).toBe(MOCK_TRACE.traceId);
  });

  it("5 - shows success status indicator", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const statusIcon = el.shadowRoot?.querySelector('svg[aria-label="Success"]');
    expect(statusIcon).toBeTruthy();
  });

  it("6 - shows error status indicator", async () => {
    const el = await createElement({ trace: MOCK_ERROR_TRACE });
    const statusIcon = el.shadowRoot?.querySelector('svg[aria-label="Error"]');
    expect(statusIcon).toBeTruthy();
  });

  it("7 - shows timeout status indicator", async () => {
    const el = await createElement({ trace: MOCK_TIMEOUT_TRACE });
    const statusIcon = el.shadowRoot?.querySelector('svg[aria-label="Timeout"]');
    expect(statusIcon).toBeTruthy();
  });

  it("shows filtered status indicator with an accessible label", async () => {
    const el = await createElement({ trace: MOCK_FILTERED_TRACE });
    const statusIcon = el.shadowRoot?.querySelector('svg[aria-label="Filtered"]');
    expect(statusIcon).toBeTruthy();
  });

  it("shows aborted status indicator with an accessible label", async () => {
    const el = await createElement({ trace: MOCK_ABORTED_TRACE });
    const statusIcon = el.shadowRoot?.querySelector('svg[aria-label="Aborted"]');
    expect(statusIcon).toBeTruthy();
  });

  it("8 - shows latency in milliseconds", async () => {
    const el = await createElement({ trace: MOCK_TRACE });
    const latencyCell = el.shadowRoot?.querySelector(".cell-latency");
    expect(latencyCell?.textContent?.trim()).toBe("187ms");
  });

  it("9 - shows '--' for null latency", async () => {
    const el = await createElement({ trace: MOCK_ERROR_TRACE });
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

  it("truncates a long trace identifier at 40 characters", async () => {
    const longTrace = {
      ...MOCK_TIMEOUT_TRACE,
      traceId: "trace-identifier-that-is-deliberately-longer-than-forty-characters",
    };
    const el = await createElement({ trace: longTrace });
    const messageCell = el.shadowRoot?.querySelector(".cell-trace");
    const text = messageCell?.textContent?.trim() ?? "";
    // 40 chars + "..."
    expect(text.length).toBeLessThanOrEqual(43);
    expect(text).toContain("trace-identifier");
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
