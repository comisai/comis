// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, expectTypeOf } from "vitest";
import { TRAJECTORY_EVENT_TYPES, type TrajectoryEventSource, type TrajectoryEventType, type TrajectoryEvent } from "./types.js";

describe("TrajectoryEventSource union", () => {
  it("declares the 3-member union", () => {
    expectTypeOf<TrajectoryEventSource>().toEqualTypeOf<"runtime" | "transcript" | "export">();
  });

  it("runtime recorder literal is assignable to the widened union", () => {
    const v: TrajectoryEventSource = "runtime";
    expect(v).toBe("runtime");
  });
});

describe("TRAJECTORY_EVENT_TYPES contains lifecycle envelope types", () => {
  it("includes trace.metadata", () => {
    expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes("trace.metadata")).toBe(true);
  });

  it("includes trace.artifacts", () => {
    expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes("trace.artifacts")).toBe(true);
  });
});

describe("TrajectoryEvent forward-declared optional fields", () => {
  it("carries optional sourceSeq?: number", () => {
    expectTypeOf<TrajectoryEvent["sourceSeq"]>().toEqualTypeOf<number | undefined>();
  });

  it("carries optional parentEntryId?: string | null", () => {
    // parentEntryId is widened to string | null | undefined
    // (null distinguishes "explicit root" from "missing").
    expectTypeOf<TrajectoryEvent["parentEntryId"]>().toEqualTypeOf<string | null | undefined>();
  });
});
