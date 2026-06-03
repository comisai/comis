// SPDX-License-Identifier: Apache-2.0
/**
 * ChannelActivityRenderer port contract tests.
 *
 * The port consumes render frames (not raw events). These tests pin the frame
 * shape, the Result-returning apply/finalize signatures, and the closed
 * 5-variant ActivityRenderError union (exhaustive switch compiles).
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import { ok, type Result } from "@comis/shared";
import type {
  ActivityRenderFrame,
  ActivityRenderError,
  ChannelActivityRenderer,
  PlanSnapshot,
} from "./channel-activity-renderer.js";
import type { TurnOutcome } from "./turn-outcome.js";

// An exhaustive switch over the closed union must compile with a never-default.
function describeRenderError(e: ActivityRenderError): string {
  switch (e.kind) {
    case "rate_limited": return `retry in ${e.retryAfterMs}ms`;
    case "transient_network": return "network";
    case "permission": return e.detail;
    case "not_supported": return e.capability;
    case "internal": return "internal";
    default: {
      const _exhaustive: never = e;
      void _exhaustive;
      return "unreachable";
    }
  }
}

// Hand-built renderer proving the port type-checks.
const recordingRenderer: ChannelActivityRenderer = {
  canDelete: true,
  canEdit: true,
  strategy: "EditPlace",
  async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
    void frame.frameSeq;
    void frame.visibleEvents;
    void frame.groupedActivityIds;
    void frame.planSnapshot;
    void frame.changeSet;
    return ok(undefined);
  },
  async finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>> {
    void outcome.kind;
    return ok(undefined);
  },
};

describe("ChannelActivityRenderer port consumes frames and returns Results", () => {
  it("type-checks a hand-built renderer with apply(frame)/finalize(outcome)", () => {
    expectTypeOf(recordingRenderer.apply).parameter(0).toEqualTypeOf<ActivityRenderFrame>();
    expectTypeOf(recordingRenderer.apply).returns.resolves.toEqualTypeOf<Result<void, ActivityRenderError>>();
    expectTypeOf(recordingRenderer.finalize).parameter(0).toEqualTypeOf<TurnOutcome>();
    expectTypeOf(recordingRenderer.canDelete).toEqualTypeOf<boolean>();
    expectTypeOf(recordingRenderer.canEdit).toEqualTypeOf<boolean>();
  });

  it("carries frameSeq/visibleEvents/groupedActivityIds/planSnapshot/changeSet on the frame", () => {
    const snapshot: PlanSnapshot = {
      entries: [{ id: "s1", label: "Fetch logs", status: "in_progress" }],
    };
    const frame: ActivityRenderFrame = {
      frameSeq: 0,
      visibleEvents: [],
      groupedActivityIds: { "group-1": ["a", "b"] },
      planSnapshot: snapshot,
      changeSet: { added: ["a"], edited: [], removed: [] },
    };
    expect(frame.frameSeq).toBe(0);
    expect(frame.groupedActivityIds["group-1"]).toEqual(["a", "b"]);
    expect(frame.planSnapshot?.entries[0]?.status).toBe("in_progress");
    expect(frame.changeSet.added).toEqual(["a"]);
  });

  it("allows planSnapshot to be undefined when SEP is inactive", () => {
    const frame: ActivityRenderFrame = {
      frameSeq: 1,
      visibleEvents: [],
      groupedActivityIds: {},
      planSnapshot: undefined,
      changeSet: { added: [], edited: [], removed: [] },
    };
    expect(frame.planSnapshot).toBeUndefined();
  });

  it("exhaustively describes every ActivityRenderError variant", () => {
    expect(describeRenderError({ kind: "rate_limited", retryAfterMs: 500 })).toBe("retry in 500ms");
    expect(describeRenderError({ kind: "transient_network", cause: new Error("x") })).toBe("network");
    expect(describeRenderError({ kind: "permission", detail: "no edit scope" })).toBe("no edit scope");
    expect(describeRenderError({ kind: "not_supported", capability: "editMessages" })).toBe("editMessages");
    expect(describeRenderError({ kind: "internal", cause: "boom" })).toBe("internal");
  });
});
