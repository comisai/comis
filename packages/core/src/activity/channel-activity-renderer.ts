// SPDX-License-Identifier: Apache-2.0
/**
 * ChannelActivityRenderer — the renderer port.
 *
 * CRITICAL boundary: this port lives in `core/activity`, NOT `channels/shared/`.
 * Placing it channel-side would force `core`/`observability` to depend on
 * `channels`, collapsing the hexagonal boundary — a
 * `channels/shared/activity-renderer.ts` home is deliberately ruled out.
 *
 * The port consumes **render frames**, not raw `ActivityEvent`s. Frames are
 * produced by the projections and carry the materialised view a
 * renderer paints: which events are visible, which are grouped, what plan-state
 * to show, what changed since the previous frame. Without frames, every
 * renderer would reimplement projection state.
 *
 * Pure type-only file: no I/O, no logger, no channel import. The concrete
 * strategy bodies live in `channels/src/shared/strategies/` and implement this
 * port (`channels → core` is the allowed direction).
 */
import type { Result } from "@comis/shared";
import type { ActivityEvent } from "./activity-event.js";
import type { TurnOutcome } from "./turn-outcome.js";
import type { ActivityStrategy } from "./activity-strategy.js";

/**
 * The materialised render-state for one render tick. Produced by the
 * projection. Renderers are stateless w.r.t. coalescing — they paint
 * whatever the latest frame says is visible.
 */
export interface ActivityRenderFrame {
  /** Monotonic frame index within this turn (0 = initial). */
  frameSeq: number;
  /** Events visible in the rendered surface, in display order, post-coalescing. */
  visibleEvents: readonly ActivityEvent[];
  /**
   * Map from a coalesced-group surrogate `activityId` to the constituent
   * underlying `activityId`s. Renderers expose this via "expand" affordances
   * (Discord thread, Slack actions, ACP `tool_call`s).
   */
  groupedActivityIds: Readonly<Record<string, readonly string[]>>;
  /** Current plan snapshot, if SEP is active for this turn. */
  planSnapshot: PlanSnapshot | undefined;
  /** Diff vs previous frame — lets renderers minimize API calls. */
  changeSet: {
    /** activityIds first visible in this frame. */
    added: readonly string[];
    /** activityIds whose status/durationMs changed. */
    edited: readonly string[];
    /** activityIds dropped (e.g. coalesced away). */
    removed: readonly string[];
  };
}

export interface PlanSnapshot {
  /** From SEP `ExecutionPlan.steps`; mapped to canonical PlanEntry shape. */
  entries: readonly {
    id: string;
    label: string;
    status: "pending" | "in_progress" | "done" | "skipped";
  }[];
}

export interface ChannelActivityRenderer {
  readonly canDelete: boolean;
  readonly canEdit: boolean;
  readonly strategy: ActivityStrategy;

  /**
   * Paint a frame. Idempotent: applying the same frame twice is a no-op — the
   * coordinator may re-apply the latest frame after a transient failure without
   * duplicating channel output.
   */
  apply(frame: ActivityRenderFrame): Promise<Result<void, ActivityRenderError>>;

  /**
   * End-of-turn finalisation. Owns the delete-on-success / keep-on-failure
   * policy: on a successful turn the scaffolding is removed once the
   * assistant message has landed; on a failed turn the activity log is kept so
   * the user can diagnose. Called by the coordinator after it receives the
   * `FinalDeliveryReceipt` (so deletion never races ahead of the answer).
   */
  finalize(outcome: TurnOutcome): Promise<Result<void, ActivityRenderError>>;
}

export type ActivityRenderError =
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "transient_network"; cause: unknown }
  | { kind: "permission"; detail: string }
  | { kind: "not_supported"; capability: string }
  | { kind: "internal"; cause: unknown };
