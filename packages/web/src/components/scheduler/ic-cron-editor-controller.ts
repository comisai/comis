// SPDX-License-Identifier: Apache-2.0
/**
 * Cron editor controller.
 *
 * NO-RPC variant — the ic-cron-editor component is a graph form
 * component with zero direct daemon-RPC invocations. The controller
 * factory signature omits the `rpcClient` parameter and the
 * controller owns pure UI orchestration (debounce timer + next-runs
 * computation). The view retains @state because its property
 * bindings to the parent scheduler view are the cross-component API
 * contract — `<ic-cron-editor .job=${...} .agents=${...}
 * .mode=${...} @save=${...} @cancel=${...}>` must stay verbatim.
 *
 * The next-runs calculators (computeNextCronRuns / computeNextEveryRuns
 * / computeNextAtRun) remain exported from ic-cron-editor.ts because
 * the existing test suite imports them directly. The controller
 * orchestrates dispatch to those calculators behind a debounce.
 *
 * @module
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { systemClearTimeout, systemNowDate, systemSetTimeout } from "@comis/core";
import {
  computeNextCronRuns,
  computeNextEveryRuns,
  computeNextAtRun,
} from "./ic-cron-editor.js";

/* ------------------------------------------------------------------ */
/*  Controller types                                                    */
/* ------------------------------------------------------------------ */

/** Schedule parameters used by the preview calculator. */
export interface IcCronSchedulePreviewInput {
  scheduleKind: "cron" | "every" | "at";
  cronExpr: string;
  timezone: string;
  everyMs: number;
  atDateTime: string;
}

/** Debounce delay for preview recompute (ms). Kept in sync with the
 *  cron editor so the next-runs preview does not recompute on every
 *  keystroke. */
export const PREVIEW_DEBOUNCE_MS = 500;

/** Number of runs the preview surfaces. */
export const PREVIEW_COUNT = 5;

export interface IcCronEditorController extends ReactiveController {
  hostConnected(): void;
  hostDisconnected(): void;
  /** Compute the next N fire times for the given schedule input.
   *  Dispatches to the appropriate calculator based on
   *  schedule.scheduleKind. Synchronous + pure. */
  computeNextRuns(schedule: IcCronSchedulePreviewInput): Date[];
  /** Schedule a debounced preview-recompute callback. The callback
   *  fires once after PREVIEW_DEBOUNCE_MS ms of quiescence. Any
   *  pending timer is cancelled and replaced. */
  schedulePreview(callback: () => void): void;
  /** Cancel any pending preview-recompute timer. Idempotent. */
  cancelPreview(): void;
  /** Whether a preview timer is currently scheduled.
   *  Exposed for test introspection. */
  isPreviewPending(): boolean;
}

/* ------------------------------------------------------------------ */
/*  Controller factory                                                  */
/* ------------------------------------------------------------------ */

export function createIcCronEditorController(
  host: ReactiveControllerHost,
): IcCronEditorController {
  let previewTimer: ReturnType<typeof setTimeout> | null = null;

  const controller: IcCronEditorController = {
    hostConnected(): void {
      /* no-op; the view drives lifecycle */
    },
    hostDisconnected(): void {
      // Cancel any pending preview timer to avoid firing
      // after the element is detached.
      if (previewTimer !== null) {
        systemClearTimeout(previewTimer);
        previewTimer = null;
      }
    },

    computeNextRuns(schedule: IcCronSchedulePreviewInput): Date[] {
      const now = systemNowDate();
      switch (schedule.scheduleKind) {
        case "cron":
          return computeNextCronRuns(
            schedule.cronExpr,
            schedule.timezone,
            PREVIEW_COUNT,
            now,
          );
        case "every":
          return computeNextEveryRuns(schedule.everyMs, PREVIEW_COUNT, now);
        case "at":
          return computeNextAtRun(schedule.atDateTime, now);
      }
    },

    schedulePreview(callback: () => void): void {
      if (previewTimer !== null) {
        systemClearTimeout(previewTimer);
      }
      previewTimer = systemSetTimeout(() => {
        previewTimer = null;
        callback();
      }, PREVIEW_DEBOUNCE_MS);
    },

    cancelPreview(): void {
      if (previewTimer !== null) {
        systemClearTimeout(previewTimer);
        previewTimer = null;
      }
    },

    isPreviewPending(): boolean {
      return previewTimer !== null;
    },
  };

  host.addController(controller);
  return controller;
}
