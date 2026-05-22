// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/observability.ts`.
 *
 * Asserts shape + identity parity with the `@comis/observability` barrel:
 * the mirror exports the same key set, the sentinel `sanitizeForPersistence`
 * is a function, and the mirror re-export is identity-equal (`===`) to
 * the direct import. Catches `prepack.js` bundling regressions and
 * silent re-export shadowing.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorObservability from "./observability.js";
import * as directObservability from "@comis/observability";

describe("comisai/observability mirror file — shape parity with @comis/observability barrel", () => {
  it("exports an identical key set as the @comis/observability direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorObservability).sort();
    const directKeys = Object.keys(directObservability).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes sanitizeForPersistence as a function (sentinel value-export typeof check)", () => {
    expect(
      typeof (mirrorObservability as Record<string, unknown>).sanitizeForPersistence,
    ).toBe("function");
  });

  it("preserves re-export identity: mirror.sanitizeForPersistence === @comis/observability.sanitizeForPersistence", () => {
    expect((mirrorObservability as Record<string, unknown>).sanitizeForPersistence).toBe(
      (directObservability as Record<string, unknown>).sanitizeForPersistence,
    );
  });
});
