import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  IcCronEditor,
  computeNextCronRuns,
  computeNextEveryRuns,
  computeNextAtRun,
} from "./ic-cron-editor.js";

// Import side-effect to register custom element
import "./ic-cron-editor.js";

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("IcCronEditor", () => {
  it("renders form fields in create mode", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor", {
      agents: ["default"],
    });
    const root = el.shadowRoot!;
    expect(root.querySelector("#cron-id")).toBeTruthy();
    expect(root.querySelector("#cron-name")).toBeTruthy();
    expect(root.querySelector('input[name="schedule-kind"]')).toBeTruthy();
    expect(root.querySelector("#cron-tz")).toBeTruthy();
    expect(root.querySelector("#cron-enabled")).toBeTruthy();
    expect(root.querySelector("#cron-agent")).toBeTruthy();
    expect(root.querySelector("#cron-message")).toBeTruthy();
    expect(root.querySelector("#cron-max")).toBeTruthy();
    expect(root.querySelector("#cron-session")).toBeTruthy();
  });

  it("shows 'New Cron Job' title in create mode", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor");
    const h2 = el.shadowRoot!.querySelector("h2");
    expect(h2?.textContent?.trim()).toBe("New Cron Job");
  });

  it("ID field is editable in create mode", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor");
    const idInput = el.shadowRoot!.querySelector("#cron-id") as HTMLInputElement;
    expect(idInput.disabled).toBe(false);
  });

  it("ID field is disabled in edit mode", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor", {
      mode: "edit",
    });
    const idInput = el.shadowRoot!.querySelector("#cron-id") as HTMLInputElement;
    expect(idInput.disabled).toBe(true);
  });

  it("shows 'Edit Cron Job' title in edit mode", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor", {
      mode: "edit",
    });
    const h2 = el.shadowRoot!.querySelector("h2");
    expect(h2?.textContent?.trim()).toBe("Edit Cron Job");
  });

  it("pre-fills form from job property", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor", {
      agents: ["default", "assistant"],
      job: {
        id: "daily-report",
        name: "Daily Report",
        agentId: "assistant",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" },
        message: "Generate the report",
        enabled: true,
        maxConcurrent: 2,
        sessionTarget: "isolated",
      },
    });

    expect((el as any)._id).toBe("daily-report");
    expect((el as any)._name).toBe("Daily Report");
    expect((el as any)._agentId).toBe("assistant");
    expect((el as any)._cronExpr).toBe("0 9 * * *");
    expect((el as any)._timezone).toBe("America/New_York");
    expect((el as any)._message).toBe("Generate the report");
    expect((el as any)._enabled).toBe(true);
    expect((el as any)._maxConcurrent).toBe(2);
    expect((el as any)._sessionTarget).toBe("isolated");
  });

  it("schedule kind selector switches visible fields", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor");
    const root = el.shadowRoot!;

    // Default is cron - should show cron fields
    expect(root.querySelector("#cron-expr")).toBeTruthy();
    expect(root.querySelector("#cron-tz")).toBeTruthy();
    expect(root.querySelector("#cron-interval")).toBeFalsy();
    expect(root.querySelector("#cron-at")).toBeFalsy();

    // Switch to "every"
    (el as any)._scheduleKind = "every";
    await el.updateComplete;

    expect(root.querySelector("#cron-expr")).toBeFalsy();
    expect(root.querySelector("#cron-tz")).toBeFalsy();
    expect(root.querySelector("#cron-interval")).toBeTruthy();
    expect(root.querySelector("#cron-at")).toBeFalsy();

    // Switch to "at"
    (el as any)._scheduleKind = "at";
    await el.updateComplete;

    expect(root.querySelector("#cron-expr")).toBeFalsy();
    expect(root.querySelector("#cron-interval")).toBeFalsy();
    expect(root.querySelector("#cron-at")).toBeTruthy();
  });

  it("next-5-runs preview shows runs for cron expression", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor");
    (el as any)._scheduleKind = "cron";
    (el as any)._cronExpr = "0 9 * * *";
    (el as any)._timezone = "UTC";
    await el.updateComplete;

    // Advance past 500ms debounce
    vi.advanceTimersByTime(500);
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll(".next-runs li");
    expect(items.length).toBe(5);
  });

  it("next-5-runs preview shows runs for every interval", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor");
    (el as any)._scheduleKind = "every";
    (el as any)._everyMs = 300_000; // 5 minutes
    await el.updateComplete;

    vi.advanceTimersByTime(500);
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll(".next-runs li");
    expect(items.length).toBe(5);
  });

  it("next-5-runs preview shows single run for at schedule", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor");
    (el as any)._scheduleKind = "at";
    (el as any)._atDateTime = "2026-03-02T10:00:00";
    await el.updateComplete;

    vi.advanceTimersByTime(500);
    await el.updateComplete;

    const items = el.shadowRoot!.querySelectorAll(".next-runs li");
    expect(items.length).toBe(1);
  });

  it("save button fires save event with form data", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor", {
      agents: ["default"],
    });

    // Fill form via internal state
    (el as any)._id = "test-job";
    (el as any)._name = "Test Job";
    (el as any)._scheduleKind = "cron";
    (el as any)._cronExpr = "0 9 * * *";
    (el as any)._timezone = "UTC";
    (el as any)._agentId = "default";
    (el as any)._message = "Hello";
    (el as any)._enabled = true;
    (el as any)._maxConcurrent = 1;
    (el as any)._sessionTarget = "main";
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener("save", handler);

    const saveBtn = el.shadowRoot!.querySelector(".btn-save") as HTMLButtonElement;
    saveBtn.click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.id).toBe("test-job");
    expect(detail.name).toBe("Test Job");
    expect(detail.schedule.kind).toBe("cron");
    expect(detail.schedule.expr).toBe("0 9 * * *");
    expect(detail.schedule.tz).toBe("UTC");
    expect(detail.agentId).toBe("default");
    expect(detail.message).toBe("Hello");
    expect(detail.enabled).toBe(true);
    expect(detail.maxConcurrent).toBe(1);
    expect(detail.sessionTarget).toBe("main");
  });

  it("cancel button fires cancel event", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor");
    const handler = vi.fn();
    el.addEventListener("cancel", handler);

    const cancelBtn = el.shadowRoot!.querySelector(".btn-cancel") as HTMLButtonElement;
    cancelBtn.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("shows empty message when no valid schedule is entered", async () => {
    const el = await createElement<IcCronEditor>("ic-cron-editor");
    // Default state has no cron expression entered
    vi.advanceTimersByTime(500);
    await el.updateComplete;

    const emptyMsg = el.shadowRoot!.querySelector(".empty-msg");
    expect(emptyMsg).toBeTruthy();
    expect(emptyMsg?.textContent).toBe("Enter a valid schedule");
  });
});

describe("computeNextCronRuns", () => {
  it("parses standard cron (0 9 * * *) and returns 5 dates at 09:00", () => {
    const from = new Date("2026-03-01T12:00:00Z");
    const runs = computeNextCronRuns("0 9 * * *", undefined, 5, from);
    expect(runs).toHaveLength(5);
    for (const d of runs) {
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(0);
    }
  });

  it("handles step expressions (*/15 * * * *) with 15-minute intervals", () => {
    const from = new Date("2026-03-01T12:00:00Z");
    const runs = computeNextCronRuns("*/15 * * * *", undefined, 4, from);
    expect(runs).toHaveLength(4);
    // Should fire at :15, :30, :45, :00 of the next hour
    expect(runs[0].getMinutes()).toBe(15);
    expect(runs[1].getMinutes()).toBe(30);
    expect(runs[2].getMinutes()).toBe(45);
    expect(runs[3].getMinutes()).toBe(0);
  });

  it("handles range expressions (0 9-17 * * 1-5) for weekday working hours", () => {
    const from = new Date("2026-03-01T12:00:00Z"); // Sunday
    const runs = computeNextCronRuns("0 9-17 * * 1-5", undefined, 9, from);
    expect(runs.length).toBe(9);
    for (const d of runs) {
      const dow = d.getDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
      const hour = d.getHours();
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThanOrEqual(17);
      expect(d.getMinutes()).toBe(0);
    }
  });

  it("returns empty array for invalid expression", () => {
    const from = new Date("2026-03-01T12:00:00Z");
    expect(computeNextCronRuns("invalid", undefined, 5, from)).toEqual([]);
  });

  it("returns empty array for expression with wrong number of fields", () => {
    const from = new Date("2026-03-01T12:00:00Z");
    expect(computeNextCronRuns("* * *", undefined, 5, from)).toEqual([]);
  });

  it("handles list expressions (0,30 * * * *)", () => {
    const from = new Date("2026-03-01T12:00:00Z");
    const runs = computeNextCronRuns("0,30 * * * *", undefined, 4, from);
    expect(runs).toHaveLength(4);
    const minutes = runs.map((d) => d.getMinutes());
    expect(minutes).toEqual([30, 0, 30, 0]);
  });
});

describe("computeNextEveryRuns", () => {
  it("returns correct number of intervals", () => {
    const from = new Date("2026-03-01T12:00:00Z");
    const runs = computeNextEveryRuns(300_000, 5, from); // 5 minutes
    expect(runs).toHaveLength(5);
    // Each run should be 5 minutes apart
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].getTime() - runs[i - 1].getTime()).toBe(300_000);
    }
  });

  it("returns empty for zero or negative interval", () => {
    const from = new Date("2026-03-01T12:00:00Z");
    expect(computeNextEveryRuns(0, 5, from)).toEqual([]);
    expect(computeNextEveryRuns(-1000, 5, from)).toEqual([]);
  });
});

describe("computeNextAtRun", () => {
  it("returns single date for future datetime", () => {
    const runs = computeNextAtRun("2026-03-02T10:00:00Z");
    expect(runs).toHaveLength(1);
    expect(runs[0].toISOString()).toBe("2026-03-02T10:00:00.000Z");
  });

  it("returns empty for past datetime", () => {
    const runs = computeNextAtRun("2026-02-28T10:00:00Z");
    expect(runs).toHaveLength(0);
  });

  it("returns empty for invalid datetime", () => {
    const runs = computeNextAtRun("not-a-date");
    expect(runs).toHaveLength(0);
  });
});
