// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/infra.ts`.
 *
 * Asserts shape + identity parity with the `@comis/infra` barrel: the mirror
 * exports the same key set, the sentinel `createSystemClock` is a function
 * (Phase 39 PORTS-06 clock factory), and the mirror re-export is
 * identity-equal (`===`) to the direct import. Catches `prepack.js`
 * bundling regressions and silent re-export shadowing.
 *
 * Phase 40 / Phase C §6.3.5 / COV-09.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorInfra from "./infra.js";
import * as directInfra from "@comis/infra";

describe("comisai/infra mirror file — shape parity with @comis/infra barrel", () => {
  it("exports an identical key set as the @comis/infra direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorInfra).sort();
    const directKeys = Object.keys(directInfra).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes createSystemClock as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorInfra as Record<string, unknown>).createSystemClock).toBe(
      "function",
    );
  });

  it("preserves re-export identity: mirror.createSystemClock === @comis/infra.createSystemClock", () => {
    expect((mirrorInfra as Record<string, unknown>).createSystemClock).toBe(
      (directInfra as Record<string, unknown>).createSystemClock,
    );
  });
});
