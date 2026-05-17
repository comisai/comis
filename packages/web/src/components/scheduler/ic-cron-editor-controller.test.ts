// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactiveControllerHost } from "lit";
import {
  createIcCronEditorController,
  PREVIEW_DEBOUNCE_MS,
  type IcCronSchedulePreviewInput,
} from "./ic-cron-editor-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IcCronEditorController", () => {
  it("computeNextRuns: cron variant dispatches to computeNextCronRuns + returns ≤5 dates", () => {
    const host = makeHost();
    const controller = createIcCronEditorController(host);
    const schedule: IcCronSchedulePreviewInput = {
      scheduleKind: "cron",
      cronExpr: "0 9 * * *",
      timezone: "UTC",
      everyMs: 60000,
      atDateTime: "",
    };
    const runs = controller.computeNextRuns(schedule);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThanOrEqual(5);
    runs.forEach((d) => expect(d instanceof Date).toBe(true));
  });

  it("computeNextRuns: every variant dispatches to computeNextEveryRuns + emits 5 future dates", () => {
    const host = makeHost();
    const controller = createIcCronEditorController(host);
    const schedule: IcCronSchedulePreviewInput = {
      scheduleKind: "every",
      cronExpr: "",
      timezone: "UTC",
      everyMs: 5 * 60 * 1000,
      atDateTime: "",
    };
    const runs = controller.computeNextRuns(schedule);
    expect(runs.length).toBe(5);
    const now = new Date("2026-03-01T12:00:00Z").getTime();
    runs.forEach((d) => expect(d.getTime()).toBeGreaterThan(now));
  });

  it("computeNextRuns: at variant returns single future date when input is future", () => {
    const host = makeHost();
    const controller = createIcCronEditorController(host);
    const schedule: IcCronSchedulePreviewInput = {
      scheduleKind: "at",
      cronExpr: "",
      timezone: "UTC",
      everyMs: 60000,
      atDateTime: "2026-04-01T09:00:00Z",
    };
    const runs = controller.computeNextRuns(schedule);
    expect(runs.length).toBe(1);
    expect(runs[0].toISOString()).toBe("2026-04-01T09:00:00.000Z");
  });

  it("schedulePreview: callback fires after PREVIEW_DEBOUNCE_MS quiescence; isPreviewPending tracks state", () => {
    const host = makeHost();
    const controller = createIcCronEditorController(host);
    const cb = vi.fn();
    expect(controller.isPreviewPending()).toBe(false);
    controller.schedulePreview(cb);
    expect(controller.isPreviewPending()).toBe(true);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(controller.isPreviewPending()).toBe(false);
  });

  it("schedulePreview: rapid successive calls coalesce — last callback wins", () => {
    const host = makeHost();
    const controller = createIcCronEditorController(host);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    controller.schedulePreview(cb1);
    vi.advanceTimersByTime(100);
    controller.schedulePreview(cb2);
    vi.advanceTimersByTime(100);
    controller.schedulePreview(cb3);
    // Only cb3 should fire after PREVIEW_DEBOUNCE_MS from the last schedule
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
    expect(cb3).toHaveBeenCalledTimes(1);
  });

  it("cancelPreview: drops pending timer; callback never fires", () => {
    const host = makeHost();
    const controller = createIcCronEditorController(host);
    const cb = vi.fn();
    controller.schedulePreview(cb);
    expect(controller.isPreviewPending()).toBe(true);
    controller.cancelPreview();
    expect(controller.isPreviewPending()).toBe(false);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 2);
    expect(cb).not.toHaveBeenCalled();
  });

  it("hostDisconnected: cancels pending timer so callback never fires after detach", () => {
    const host = makeHost();
    const controller = createIcCronEditorController(host);
    const cb = vi.fn();
    controller.schedulePreview(cb);
    expect(controller.isPreviewPending()).toBe(true);
    controller.hostDisconnected();
    expect(controller.isPreviewPending()).toBe(false);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 2);
    expect(cb).not.toHaveBeenCalled();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    createIcCronEditorController(host);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });
});
