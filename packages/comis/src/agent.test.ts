// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/agent.ts`.
 *
 * Asserts shape + identity parity with the `@comis/agent` barrel: the mirror
 * exports the same key set, the sentinel `createCircuitBreaker` is a function,
 * and the mirror re-export is identity-equal (`===`) to the direct import.
 * Catches `prepack.js` bundling regressions and silent re-export shadowing
 * (e.g., a future PR replacing `export *` with a hand-rolled wrapper).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorAgent from "./agent.js";
import * as directAgent from "@comis/agent";

describe("comisai/agent mirror file — shape parity with @comis/agent barrel", () => {
  it("exports an identical key set as the @comis/agent direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorAgent).sort();
    const directKeys = Object.keys(directAgent).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes createCircuitBreaker as a function (sentinel value-export typeof check)", () => {
    expect(typeof (mirrorAgent as Record<string, unknown>).createCircuitBreaker).toBe(
      "function",
    );
  });

  it("preserves re-export identity: mirror.createCircuitBreaker === @comis/agent.createCircuitBreaker", () => {
    expect((mirrorAgent as Record<string, unknown>).createCircuitBreaker).toBe(
      (directAgent as Record<string, unknown>).createCircuitBreaker,
    );
  });
});
