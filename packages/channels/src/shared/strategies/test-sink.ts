// SPDX-License-Identifier: Apache-2.0
/**
 * TestSink — the Echo terminus rendering strategy.
 *
 * Unlike the channel strategies, TestSink applies NO coalescing and performs NO
 * channel I/O: it records the canonical render stream verbatim so an in-memory
 * acceptance test can assert it received every `apply(frame)`
 * and the single `finalize(outcome)` with full payload. This is the Echo
 * channel's "TestSink" routing (`selectStrategy(cap, "echo")`).
 *
 * `canDelete` / `canEdit` are false (Echo has no edit/delete surface) and the
 * strategy identity is `"TestSink"`. Implements the core `ChannelActivityRenderer`
 * port (the `channels → core` edge is allowed; the port lives in `core/activity`).
 */
import { ok, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderFrame,
  ActivityRenderError,
  TurnOutcome,
} from "@comis/core";

export interface TestSinkRecorder extends ChannelActivityRenderer {
  readonly recorded: {
    frames: ActivityRenderFrame[];
    outcome?: TurnOutcome;
  };
}

/**
 * Create a TestSink recorder. Every `apply(frame)` pushes the frame (verbatim —
 * no coalescing) onto `recorded.frames`; `finalize(outcome)` stores the outcome
 * on `recorded.outcome`. Both always succeed.
 */
export function createTestSink(): TestSinkRecorder {
  const recorded: TestSinkRecorder["recorded"] = { frames: [] };

  return {
    strategy: "TestSink",
    canDelete: false,
    canEdit: false,
    recorded,

    async apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>> {
      recorded.frames.push(frame);
      return ok(undefined);
    },

    async finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>> {
      recorded.outcome = outcome;
      return ok(undefined);
    },
  };
}
