// SPDX-License-Identifier: Apache-2.0
/**
 * Mirror file smoke test for `packages/comis/src/observability-otel.ts`.
 *
 * Asserts shape + identity parity with the `@comis/observability-otel` barrel:
 * the mirror exports the same key set, the sentinel `METRIC_CATALOG` is the
 * frozen catalog array, and the mirror re-export is identity-equal (`===`) to
 * the direct import. Catches `prepack.js` bundling regressions and silent
 * re-export shadowing for the FIRST opt-in extension package now that it is
 * bundled into the `comisai` umbrella (decision A1).
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import * as mirrorObservabilityOtel from "./observability-otel.js";
import * as directObservabilityOtel from "@comis/observability-otel";

describe("comisai/observability-otel mirror file — shape parity with @comis/observability-otel barrel", () => {
  it("exports an identical key set as the @comis/observability-otel direct import (no silent drift)", () => {
    const mirrorKeys = Object.keys(mirrorObservabilityOtel).sort();
    const directKeys = Object.keys(directObservabilityOtel).sort();
    expect(mirrorKeys).toEqual(directKeys);
  });

  it("exposes METRIC_CATALOG as a non-empty array (sentinel value-export check)", () => {
    const catalog = (mirrorObservabilityOtel as Record<string, unknown>).METRIC_CATALOG;
    expect(Array.isArray(catalog)).toBe(true);
    expect((catalog as readonly unknown[]).length).toBeGreaterThan(0);
  });

  it("preserves re-export identity: mirror.METRIC_CATALOG === @comis/observability-otel.METRIC_CATALOG", () => {
    expect((mirrorObservabilityOtel as Record<string, unknown>).METRIC_CATALOG).toBe(
      (directObservabilityOtel as Record<string, unknown>).METRIC_CATALOG,
    );
  });
});
