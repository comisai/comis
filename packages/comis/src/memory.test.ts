// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/memory.ts`.
 *
 * Asserts shape + identity parity with the `@comis/memory` barrel: the
 * mirror exports the same key set, the sentinel `createSessionStore` is
 * a function, and the mirror re-export is identity-equal (`===`) to the
 * direct import. Catches `prepack.js` bundling regressions and silent
 * re-export shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorMemory from "./memory.js";
import * as directMemory from "@comis/memory";

describe("comisai/memory mirror file — shape parity with @comis/memory barrel", () => {
  it("exports an identical key set as the @comis/memory direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorMemory).sort();
    const directKeys = Object.keys(directMemory).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes createSessionStore as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorMemory as Record<string, unknown>).createSessionStore).toBe(
      "function",
    );
  });

  it("preserves re-export identity: mirror.createSessionStore === @comis/memory.createSessionStore", () => {
    expect((mirrorMemory as Record<string, unknown>).createSessionStore).toBe(
      (directMemory as Record<string, unknown>).createSessionStore,
    );
  });
});
