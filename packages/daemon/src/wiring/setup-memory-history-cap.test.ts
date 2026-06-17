// SPDX-License-Identifier: Apache-2.0
/**
 * REVISE-02 (Phase 203 Plan 05): unit coverage for the user-representation
 * historyCap resolver (extracted from setup-memory.ts to keep that leaf under the
 * 800-line cap). Pure — no I/O, no globals; same agents config ⇒ same result.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  resolveUserRepresentationHistoryCap,
  resolveUserRepresentationHistoryCapOption,
} from "./setup-memory-history-cap.js";

describe("resolveUserRepresentationHistoryCap (REVISE-02, Phase 203)", () => {
  it("returns undefined when there are no agents", () => {
    expect(resolveUserRepresentationHistoryCap(undefined)).toBeUndefined();
    expect(resolveUserRepresentationHistoryCap({})).toBeUndefined();
  });

  it("returns the MAX historyCap across ENABLED agents", () => {
    const caps = resolveUserRepresentationHistoryCap({
      a: { memoryUserRepresentation: { enabled: true, historyCap: 7 } },
      b: { memoryUserRepresentation: { enabled: true, historyCap: 25 } },
      c: { memoryUserRepresentation: { enabled: true, historyCap: 12 } },
    });
    expect(caps).toBe(25);
  });

  it("ignores a DISABLED agent's historyCap even when it is the largest", () => {
    const caps = resolveUserRepresentationHistoryCap({
      off: { memoryUserRepresentation: { enabled: false, historyCap: 99 } },
      on: { memoryUserRepresentation: { enabled: true, historyCap: 8 } },
    });
    expect(caps).toBe(8);
  });

  it("returns undefined when no ENABLED agent configures a numeric historyCap (store keeps its default)", () => {
    expect(
      resolveUserRepresentationHistoryCap({
        a: { memoryUserRepresentation: { enabled: true } },
        b: { memoryUserRepresentation: { enabled: false, historyCap: 50 } },
      }),
    ).toBeUndefined();
  });

  it("tolerates an undefined agent entry in the map", () => {
    expect(
      resolveUserRepresentationHistoryCap({
        a: undefined,
        b: { memoryUserRepresentation: { enabled: true, historyCap: 4 } },
      }),
    ).toBe(4);
  });
});

describe("resolveUserRepresentationHistoryCapOption (spread-ready, exactOptionalPropertyTypes-safe)", () => {
  it("yields { historyCap } when a cap is resolved", () => {
    expect(
      resolveUserRepresentationHistoryCapOption({
        a: { memoryUserRepresentation: { enabled: true, historyCap: 15 } },
      }),
    ).toEqual({ historyCap: 15 });
  });

  it("yields {} (never an explicit historyCap: undefined) when none is resolved", () => {
    const opt = resolveUserRepresentationHistoryCapOption({});
    expect(opt).toEqual({});
    expect("historyCap" in opt).toBe(false);
  });
});
