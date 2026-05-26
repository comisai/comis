// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Activity surface (domain envelope + pure logic + ports
// + projections). This per-surface file re-exports the SOLE `core/activity`
// barrel and the read-only `ExecutionPlanPort` (the execution-plan port rides
// on the activity surface — there is no separate `exports/ports.ts` edit in the
// owning plan). Downstream packages import all of this from "@comis/core"
// (ACT-12 — the barrel stays "."-only, no deep-import subpaths).

export {
  // 70-01 activity-event
  ActivityEventSchema,
  RedactedParamValueSchema,
  RedactedParamsSchema,
  parseActivityEvent,
  // 70-01 approval
  ApprovalChoiceSchema,
  ApprovalCorrelationSchema,
  // 70-01 turn-outcome
  isNonEmptyEvents,
  // 70-04 template-engine / semantic-classifier / label-spec
  applyTemplate,
  classifySemanticPhase,
  registerActivityLabelSpec,
  resolveLabelSpec,
  // 70-05 strategy + projections
  selectStrategy,
  chatProjection,
  acpProjection,
  coalesce,
  CHAT_COALESCE_RULES,
} from "../activity/index.js";

// ChatType narrowing (§4.6, TURN-02; created in 70-01). The activity milestone's
// 3-value chat classification + the 5→3 narrowing helper. Surfaced here so the
// orchestrator composition (70-10, WIRE-03) can build `TurnActivityContext.chatType`
// from a `NormalizedMessage.chatType` via the canonical `narrowChatType` instead
// of re-hand-rolling the fold. Rides on the activity surface (§4.6 lives with the
// activity domain).
export { narrowChatType, ChatTypeSchema } from "../domain/chat-type.js";

export type {
  // 70-01
  ActivityEvent,
  ActivityParseError,
  ApprovalCorrelation,
  ApprovalChoice,
  FinalDeliveryReceipt,
  DeliveryFailureReceipt,
  DeliveryStageResult,
  TurnOutcome,
  // 70-04
  TemplateOutput,
  TemplateError,
  SemanticPhase,
  LabelSpec,
  ActionLabelSpec,
  RegisteredLabelSpec,
  ActivityTheme,
  ResolveLabelOptions,
  // 70-05
  TurnActivityContext,
  ActivityStrategy,
  ActivityRenderFrame,
  PlanSnapshot,
  ChannelActivityRenderer,
  ActivityRenderError,
  ActivitySubscription,
  ActivityStreamPort,
  ProjectionConfig,
  CoalesceResult,
  ActivityVerbosity,
} from "../activity/index.js";

export type {
  ChatType,
  NormalizedChatType,
} from "../domain/chat-type.js";

// ExecutionPlanPort — read-only SEP accessor (rides on the activity surface).
export type {
  ExecutionPlanPort,
  ReadonlyExecutionPlan,
  ReadonlyPlanStep,
} from "../ports/execution-plan-port.js";
