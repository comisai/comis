// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for VIDEO_MODELS + listVideoModelCaps + supportedModes + snapDuration
 * (CAP-02 — the per-model video-capability matrix that is the single source of
 * truth the IN-02 validator (Plan 02) and the IN-03 dynamic description (Plan
 * 03) both read). Mirrors the sibling `image-models.test.ts` closed-map-miss +
 * listing structure (a backend absent from the map → `undefined` on lookup,
 * never a crash) and the `video-pricing.ts` SEC-04 guarded-index discipline.
 *
 * The live FAL/Veo/Grok values are pinned here as the contract the impl must
 * satisfy (re-verified 2026-06-15; they drift ~monthly — see the impl's @module
 * caveat). The snapDuration round-half-up tie-break is pinned explicitly
 * (5→6, 7→8) so the rounding DIRECTION is part of the contract, not an
 * accident of the reduce seed.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  listVideoModelCaps,
  supportedModes,
  snapDuration,
} from "./video-models.js";

describe("listVideoModelCaps — CAP-02 (a) duration shape per backend", () => {
  it("FAL t2v durations are an enum [4,6,8]", () => {
    expect(listVideoModelCaps("fal", "t2v")?.durations).toEqual({
      kind: "enum",
      values: [4, 6, 8],
    });
  });

  it("Veo t2v durations are an enum [4,6,8]", () => {
    expect(listVideoModelCaps("veo", "t2v")?.durations).toEqual({
      kind: "enum",
      values: [4, 6, 8],
    });
  });

  it("Grok t2v durations are a range {min:1,max:15}", () => {
    expect(listVideoModelCaps("grok", "t2v")?.durations).toEqual({
      kind: "range",
      min: 1,
      max: 15,
    });
  });
});

describe("listVideoModelCaps — CAP-02 (b) a missing mode key yields undefined", () => {
  it("v2v (the RESERVED, never-populated mode) is undefined for every backend", () => {
    // v2v is RESERVED but wired to no backend (deferred). An omitted mode key →
    // undefined → the handler rejects with the supported-modes list.
    expect(listVideoModelCaps("fal", "v2v")).toBeUndefined();
    expect(listVideoModelCaps("veo", "v2v")).toBeUndefined();
    expect(listVideoModelCaps("grok", "v2v")).toBeUndefined();
  });

  it("an unknown backend yields undefined (closed-map miss, never a crash)", () => {
    expect(listVideoModelCaps("nope", "t2v")).toBeUndefined();
  });
});

describe("listVideoModelCaps — CAP-02 (c) a per-model override wins over the backend default", () => {
  it("the Veo backend default supports 4k", () => {
    expect(listVideoModelCaps("veo", "t2v")?.resolutions).toContain("4k");
  });

  it("the veo-2.0-generate-001 byModel override is 720p-only", () => {
    expect(
      listVideoModelCaps("veo", "t2v", "veo-2.0-generate-001")?.resolutions,
    ).toEqual(["720p"]);
  });

  it("the veo-2.0-generate-001 byModel override has no audio (Veo 2)", () => {
    expect(
      listVideoModelCaps("veo", "t2v", "veo-2.0-generate-001")?.audio,
    ).toBe(false);
  });

  it("the veo-2.0-generate-001 override also wins on i2v", () => {
    expect(
      listVideoModelCaps("veo", "i2v", "veo-2.0-generate-001")?.resolutions,
    ).toEqual(["720p"]);
  });

  it("an unknown model falls through to the backend default (no override)", () => {
    expect(
      listVideoModelCaps("veo", "t2v", "veo-99.0-imaginary")?.resolutions,
    ).toContain("4k");
  });
});

describe("listVideoModelCaps — SEC-04 proto-pollution guard precedes every index", () => {
  it("a poisoned backend key returns undefined (never touches the prototype)", () => {
    expect(listVideoModelCaps("__proto__", "t2v")).toBeUndefined();
    expect(listVideoModelCaps("constructor", "t2v")).toBeUndefined();
    expect(listVideoModelCaps("prototype", "t2v")).toBeUndefined();
  });

  it("a poisoned MODEL key is ignored — falls through to the mode default", () => {
    // The poisoned byModel key is never indexed; the default caps are returned.
    expect(listVideoModelCaps("veo", "t2v", "__proto__")?.resolutions).toContain(
      "4k",
    );
  });
});

describe("supportedModes", () => {
  it("FAL supports t2v + i2v (the present mode keys)", () => {
    expect(supportedModes("fal")).toEqual(["t2v", "i2v"]);
  });

  it("Grok supports t2v + i2v", () => {
    expect(supportedModes("grok")).toEqual(["t2v", "i2v"]);
  });

  it("an unknown backend returns []", () => {
    expect(supportedModes("nope")).toEqual([]);
  });

  it("a blocked backend key returns [] (SEC-04, never indexes)", () => {
    expect(supportedModes("__proto__")).toEqual([]);
  });
});

describe("snapDuration — enum snaps to the nearest member, ties round HALF-UP", () => {
  const falT2v = listVideoModelCaps("fal", "t2v")!;

  it("an exact midpoint rounds UP to the higher member (5 → 6)", () => {
    // 5 is equidistant from 4 and 6 → round-half-up picks 6 (the safer default:
    // a clip slightly longer than requested over slightly shorter).
    expect(snapDuration(falT2v, 5)).toBe(6);
  });

  it("an exact midpoint rounds UP to the higher member (7 → 8)", () => {
    // 7 is equidistant from 6 and 8 → round-half-up picks 8.
    expect(snapDuration(falT2v, 7)).toBe(8);
  });

  it("an exact enum value passes through (8 → 8)", () => {
    expect(snapDuration(falT2v, 8)).toBe(8);
  });

  it("a clear-nearest below the midpoint snaps down (4.4 → 4)", () => {
    // |4.4-4|=0.4 < |6-4.4|=1.6 — no tie, the nearest is 4.
    expect(snapDuration(falT2v, 4.4)).toBe(4);
  });
});

describe("snapDuration — range clamps to [min, max]", () => {
  const grokT2v = listVideoModelCaps("grok", "t2v")!;

  it("clamps above max (20 → 15)", () => {
    expect(snapDuration(grokT2v, 20)).toBe(15);
  });

  it("clamps below min (0 → 1)", () => {
    expect(snapDuration(grokT2v, 0)).toBe(1);
  });

  it("passes an in-range value through (6 → 6)", () => {
    expect(snapDuration(grokT2v, 6)).toBe(6);
  });
});
