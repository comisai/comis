// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/scheduler.ts`.
 *
 * Asserts shape + identity parity with the `@comis/scheduler` barrel: the
 * mirror exports the same key set, the sentinel `computeNextRunAtMs` is a
 * function (cron next-run calculator), and the mirror re-export is
 * identity-equal (`===`) to the direct import. Catches `prepack.js`
 * bundling regressions and silent re-export shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorScheduler from "./scheduler.js";
import * as directScheduler from "@comis/scheduler";

describe("comisai/scheduler mirror file — shape parity with @comis/scheduler barrel", () => {
  it("exports an identical key set as the @comis/scheduler direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorScheduler).sort();
    const directKeys = Object.keys(directScheduler).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes computeNextRunAtMs as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorScheduler as Record<string, unknown>).computeNextRunAtMs).toBe(
      "function",
    );
  });

  it("preserves re-export identity: mirror.computeNextRunAtMs === @comis/scheduler.computeNextRunAtMs", () => {
    expect((mirrorScheduler as Record<string, unknown>).computeNextRunAtMs).toBe(
      (directScheduler as Record<string, unknown>).computeNextRunAtMs,
    );
  });
});
