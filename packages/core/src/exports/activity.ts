// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Activity surface (domain envelope + pure logic + ports
// + projections). This per-surface file re-exports the SOLE `core/activity`
// barrel and the read-only `ExecutionPlanPort` (the execution-plan port rides
// on the activity surface — there is no separate `exports/ports.ts` edit in the
// owning plan). Downstream packages import all of this from "@comis/core" —
// the barrel stays "."-only, no deep-import subpaths.

export {
  // activity-event
  ActivityEventSchema,
  RedactedParamValueSchema,
  RedactedParamsSchema,
  parseActivityEvent,
  // approval
  ApprovalChoiceSchema,
  ApprovalCorrelationSchema,
  // turn-outcome
  isNonEmptyEvents,
  // template-engine / semantic-classifier / label-spec
  applyTemplate,
  classifySemanticPhase,
  registerActivityLabelSpec,
  resolveLabelSpec,
  hasRegisteredLabelSpec,
  // strategy + projections
  selectStrategy,
  chatProjection,
  acpProjection,
  coalesce,
  CHAT_COALESCE_RULES,
  // themes — the name→bundle registry. The daemon composition root resolves
  // `themeForName(<default-agent theme>)` and bakes the resolved marker set
  // into `ActivityEvent.defaultLabel`.
  themeForName,
} from "../activity/index.js";

// ChatType narrowing. Surfaced here so the
// orchestrator composition can build `TurnActivityContext.chatType`
// from a `NormalizedMessage.chatType` via the canonical `narrowChatType` instead
// of re-hand-rolling the 5→3 fold. Only the `narrowChatType` value is re-exported:
// the `ChatType` type already reaches consumers transitively through
// `TurnActivityContext.chatType`, and `ChatTypeSchema`/`NormalizedChatType` have no
// in-repo by-name consumer yet (re-export them when one lands — dead-export guard).
export { narrowChatType } from "../domain/chat-type.js";

export type {
  // activity-event / approval / turn-outcome
  ActivityEvent,
  ActivityParseError,
  ApprovalCorrelation,
  ApprovalChoice,
  DeliveryFailureReceipt,
  DeliveryStageResult,
  TurnOutcome,
  // template-engine / semantic-classifier / label-spec
  TemplateOutput,
  TemplateError,
  SemanticPhase,
  LabelSpec,
  ActionLabelSpec,
  RegisteredLabelSpec,
  ActivityTheme,
  ResolveLabelOptions,
  // themes
  ThemeName,
  ActivityStatusMarkers,
  // strategy + projections
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

// ExecutionPlanPort — read-only SEP accessor (rides on the activity surface).
export type {
  ExecutionPlanPort,
  ReadonlyExecutionPlan,
  ReadonlyPlanStep,
} from "../ports/execution-plan-port.js";
