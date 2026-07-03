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

// The four image-generation lifecycle types are appended
// to the closed tuple so the daemon image RPC handler can `recordEvent(...)`
// them via the per-session recorder (recordEvent REJECTS a type absent from
// TRAJECTORY_EVENT_TYPES). Direct-emitted (no bus bridge in the
// daemon RPC context), but still declared here for type closure.
describe("TRAJECTORY_EVENT_TYPES contains the image-generation lifecycle", () => {
  it.each(["image.requested", "image.generated", "image.delivered", "image.failed"])(
    "includes %s",
    (literal) => {
      expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes(literal)).toBe(true);
    },
  );
});

// The three vision lifecycle types are APPENDED to the
// closed tuple so the daemon vision RPC handler can `recordEvent(...)` them via
// the per-session recorder (recordEvent REJECTS a type absent from
// TRAJECTORY_EVENT_TYPES). Append-only — the image.* tuple is SemVer-frozen and
// must stay intact (a rename trips the bridge-count guard + codegen).
describe("TRAJECTORY_EVENT_TYPES contains the vision lifecycle (append-only)", () => {
  it.each(["media.vision.requested", "media.vision.completed", "media.vision.failed"])(
    "includes %s",
    (literal) => {
      expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes(literal)).toBe(true);
    },
  );

  it("the SemVer-frozen image.* tuple is STILL present (not renamed/deleted)", () => {
    for (const frozen of ["image.requested", "image.generated", "image.delivered", "image.failed"]) {
      expect((TRAJECTORY_EVENT_TYPES as readonly string[]).includes(frozen)).toBe(true);
    }
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
