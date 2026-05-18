// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/observability.ts`.
 *
 * Asserts shape + identity parity with the `@comis/observability` barrel:
 * the mirror exports the same key set, the sentinel
 * `OBSERVABILITY_PACKAGE_NAME` is the placeholder string, and the mirror
 * re-export is identity-equal (`===`) to the direct import. Catches
 * `prepack.js` bundling regressions and silent re-export shadowing.
 *
 * Plan 45-01 Task 10 will swap the placeholder for the substrate barrel;
 * the sentinel assertion is rewritten at that point. Today's assertion
 * verifies the package boundary works end-to-end (build → bundle → mirror).
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

  it("exposes OBSERVABILITY_PACKAGE_NAME as the placeholder string sentinel", () => {
    expect(
      (mirrorObservability as Record<string, unknown>).OBSERVABILITY_PACKAGE_NAME,
    ).toBe("@comis/observability");
  });

  it("preserves re-export identity: mirror.OBSERVABILITY_PACKAGE_NAME === @comis/observability.OBSERVABILITY_PACKAGE_NAME", () => {
    expect(
      (mirrorObservability as Record<string, unknown>).OBSERVABILITY_PACKAGE_NAME,
    ).toBe(
      (directObservability as Record<string, unknown>).OBSERVABILITY_PACKAGE_NAME,
    );
  });
});
