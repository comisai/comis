// SPDX-License-Identifier: Apache-2.0
/**
 * Activity barrel — the SOLE owner of the `core/activity` public surface.
 *
 * Re-exports the FULL activity surface across three layers:
 *   - domain envelope: activity-event / approval / turn-outcome
 *   - pure logic: template-engine / semantic-classifier / label-spec
 *   - ports + projections: turn-activity-context / activity-strategy /
 *     channel-activity-renderer / activity-stream-port / projections
 *
 * This file is the single writer for the barrel, so there is no cross-module
 * write race on `activity/index.ts`. The public `@comis/core` barrel re-exports
 * this file via `exports/activity.ts` (no deep-import subpaths).
 */

// --- activity-event ----------------------------------------------------------
export {
  ActivityEventSchema,
  RedactedParamValueSchema,
  RedactedParamsSchema,
  parseActivityEvent,
} from "./activity-event.js";
export type { ActivityEvent, ActivityParseError } from "./activity-event.js";

// --- approval -----------------------------------------------------------------
export { ApprovalChoiceSchema, ApprovalCorrelationSchema } from "./approval.js";
export type { ApprovalCorrelation, ApprovalChoice } from "./approval.js";

// --- turn-outcome --------------------------------------------------------------
export { isNonEmptyEvents } from "./turn-outcome.js";
export type {
  FinalDeliveryReceipt,
  DeliveryFailureReceipt,
  DeliveryStageResult,
  TurnOutcome,
} from "./turn-outcome.js";

// --- template-engine -----------------------------------------------------------
export { applyTemplate } from "./template-engine.js";
export type { TemplateOutput, TemplateError } from "./template-engine.js";

// --- semantic-classifier -------------------------------------------------------
export { classifySemanticPhase } from "./semantic-classifier.js";
export type { SemanticPhase } from "./semantic-classifier.js";

// --- label-spec (test-only _clearActivityLabelSpecsForTest excluded) ----------
export {
  registerActivityLabelSpec,
  resolveLabelSpec,
  hasRegisteredLabelSpec,
} from "./label-spec.js";
export type {
  LabelSpec,
  ActionLabelSpec,
  RegisteredLabelSpec,
  ActivityTheme,
  ResolveLabelOptions,
} from "./label-spec.js";

// --- turn-activity-context -----------------------------------------------------
export type { TurnActivityContext } from "./turn-activity-context.js";

// --- activity-strategy ---------------------------------------------------------
export { selectStrategy } from "./activity-strategy.js";
export type { ActivityStrategy } from "./activity-strategy.js";

// --- channel-activity-renderer -------------------------------------------------
export type {
  ActivityRenderFrame,
  PlanSnapshot,
  ChannelActivityRenderer,
  ActivityRenderError,
} from "./channel-activity-renderer.js";

// --- activity-stream-port ------------------------------------------------------
export type { ActivitySubscription, ActivityStreamPort } from "./activity-stream-port.js";

// --- projections ---------------------------------------------------------------
export { chatProjection, acpProjection, coalesce, CHAT_COALESCE_RULES } from "./projections/index.js";
export type {
  ProjectionConfig,
  CoalesceResult,
  ActivityVerbosity,
} from "./projections/index.js";

// --- themes --------------------------------------------------------------------
// The four bundled themes + their name→bundle registry. The label-baking step
// consumes `themeForName` + `ActivityTheme.markers` to bake the resolved marker
// into `ActivityEvent.defaultLabel` upstream of the channel painter.
export { themeForName } from "./themes/index.js";
export type { ThemeName } from "./themes/index.js";
export type { ActivityStatusMarkers } from "./label-spec.js";
