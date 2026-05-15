// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/core.ts`.
 *
 * Asserts shape + identity parity with the `@comis/core` barrel: the mirror
 * exports the same key set, the sentinel `safePath` is a function, and the
 * mirror re-export is identity-equal (`===`) to the direct import. Catches
 * `prepack.js` bundling regressions and silent re-export shadowing.
 *
 * Phase 40 / Phase C §6.3.5 / COV-09.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorCore from "./core.js";
import * as directCore from "@comis/core";

describe("comisai/core mirror file — shape parity with @comis/core barrel", () => {
  it("exports an identical key set as the @comis/core direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorCore).sort();
    const directKeys = Object.keys(directCore).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes safePath as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorCore as Record<string, unknown>).safePath).toBe("function");
  });

  it("preserves re-export identity: mirror.safePath === @comis/core.safePath", () => {
    expect((mirrorCore as Record<string, unknown>).safePath).toBe(
      (directCore as Record<string, unknown>).safePath,
    );
  });
});
