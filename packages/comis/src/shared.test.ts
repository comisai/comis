// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/shared.ts`.
 *
 * Asserts shape + identity parity with the `@comis/shared` barrel: the
 * mirror exports the same key set, the sentinel `ok` is a function
 * (Result `ok` constructor), and the mirror re-export is identity-equal
 * (`===`) to the direct import. Catches `prepack.js` bundling regressions
 * and silent re-export shadowing.
 *
 * Phase 40 / Phase C §6.3.5 / COV-09.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorShared from "./shared.js";
import * as directShared from "@comis/shared";

describe("comisai/shared mirror file — shape parity with @comis/shared barrel", () => {
  it("exports an identical key set as the @comis/shared direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorShared).sort();
    const directKeys = Object.keys(directShared).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes ok as a function (sentinel Result-constructor typeof check)", () => {
    expect(typeof (mirrorShared as Record<string, unknown>).ok).toBe("function");
  });

  it("preserves re-export identity: mirror.ok === @comis/shared.ok", () => {
    expect((mirrorShared as Record<string, unknown>).ok).toBe(
      (directShared as Record<string, unknown>).ok,
    );
  });
});
