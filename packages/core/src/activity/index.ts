// SPDX-License-Identifier: Apache-2.0
/**
 * Activity barrel — the SOLE owner of the `core/activity` public surface.
 *
 * Re-exports the FULL activity surface across THREE foundation plans:
 *   - 70-01: activity-event / approval / turn-outcome (domain envelope)
 *   - 70-04: template-engine / semantic-classifier / label-spec (pure logic)
 *   - 70-05: turn-activity-context / activity-strategy / channel-activity-renderer
 *            / activity-stream-port / projections (ports + projections)
 *
 * 70-04 deliberately created NO barrel — this file is the single writer, so
 * there is no cross-plan write race on `activity/index.ts`. The build is green
 * because this plan depends on (and runs after) 70-04, so its source modules
 * already exist. The public `@comis/core` barrel re-exports this file via
 * `exports/activity.ts` (ACT-12 — no deep-import subpaths).
 */

// --- 70-01: activity-event ---------------------------------------------------
export {
  ActivityEventSchema,
  RedactedParamValueSchema,
  RedactedParamsSchema,
  parseActivityEvent,
} from "./activity-event.js";
export type { ActivityEvent, ActivityParseError } from "./activity-event.js";

// --- 70-01: approval ---------------------------------------------------------
export { ApprovalChoiceSchema, ApprovalCorrelationSchema } from "./approval.js";
export type { ApprovalCorrelation, ApprovalChoice } from "./approval.js";

// --- 70-01: turn-outcome -----------------------------------------------------
export { isNonEmptyEvents } from "./turn-outcome.js";
export type {
  FinalDeliveryReceipt,
  DeliveryFailureReceipt,
  DeliveryStageResult,
  TurnOutcome,
} from "./turn-outcome.js";

// --- 70-04: template-engine --------------------------------------------------
export { applyTemplate } from "./template-engine.js";
export type { TemplateOutput, TemplateError } from "./template-engine.js";

// --- 70-04: semantic-classifier ----------------------------------------------
export { classifySemanticPhase } from "./semantic-classifier.js";
export type { SemanticPhase } from "./semantic-classifier.js";

// --- 70-04: label-spec (test-only _clearActivityLabelSpecsForTest excluded) --
export { registerActivityLabelSpec, resolveLabelSpec } from "./label-spec.js";
export type {
  LabelSpec,
  ActionLabelSpec,
  RegisteredLabelSpec,
  ActivityTheme,
  ResolveLabelOptions,
} from "./label-spec.js";

// --- 70-05: turn-activity-context --------------------------------------------
export type { TurnActivityContext } from "./turn-activity-context.js";

// --- 70-05: activity-strategy ------------------------------------------------
export { selectStrategy } from "./activity-strategy.js";
export type { ActivityStrategy } from "./activity-strategy.js";

// --- 70-05: channel-activity-renderer ----------------------------------------
export type {
  ActivityRenderFrame,
  PlanSnapshot,
  ChannelActivityRenderer,
  ActivityRenderError,
} from "./channel-activity-renderer.js";

// --- 70-05: activity-stream-port ---------------------------------------------
export type { ActivitySubscription, ActivityStreamPort } from "./activity-stream-port.js";

// --- 70-05: projections ------------------------------------------------------
export { chatProjection, acpProjection, coalesce, CHAT_COALESCE_RULES } from "./projections/index.js";
export type {
  ProjectionConfig,
  CoalesceResult,
  ActivityVerbosity,
} from "./projections/index.js";
