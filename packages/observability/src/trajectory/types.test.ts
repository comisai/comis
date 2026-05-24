// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { TRAJECTORY_EVENT_TYPES, type TrajectoryEventSource, type TrajectoryEventType, type TrajectoryEvent } from "./types.js";

describe("TrajectoryEventSource union (TRACE-02)", () => {
  it("declares the 3-member union per design §6.2", () => {
    // RED: fails today because the union is single-member "runtime".
    // GREEN: after widening to "runtime" | "transcript" | "export", this passes.
    expectTypeOf<TrajectoryEventSource>().toEqualTypeOf<"runtime" | "transcript" | "export">();
  });

  it("runtime recorder literal is assignable to the widened union", () => {
    const v: TrajectoryEventSource = "runtime";
    expect(v).toBe("runtime");
  });
});

describe("TRAJECTORY_EVENT_TYPES contains lifecycle envelope types (LIFE-01/02)", () => {
  it("includes trace.metadata", () => {
    expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes("trace.metadata")).toBe(true);
  });

  it("includes trace.artifacts", () => {
    expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes("trace.artifacts")).toBe(true);
  });
});

describe("TrajectoryEvent forward-declared optional fields (design §6.1)", () => {
  it("carries optional sourceSeq?: number", () => {
    expectTypeOf<TrajectoryEvent["sourceSeq"]>().toEqualTypeOf<number | undefined>();
  });

  it("carries optional parentEntryId?: string | null", () => {
    // The existing parentEntryId field is typed as string | undefined; this test
    // requires it to be widened to string | null | undefined per design §6.1
    // (null distinguishes "explicit root" from "missing").
    expectTypeOf<TrajectoryEvent["parentEntryId"]>().toEqualTypeOf<string | null | undefined>();
  });
});
