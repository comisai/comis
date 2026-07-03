// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Event bus (typed inter-module communication)

export { TypedEventBus } from "../event-bus/index.js";
export type {
  EventHandler,
  EventMap,
  MessagingEvents,
  AgentEvents,
  // ModelEvents (model:*/provider:* lifecycle) lives in its own domain file but
  // is NOT re-exported here — like OrchestrationEvents /
  // TrajectoryEvents, it stays internal and reaches consumers via EventMap.
  ChannelEvents,
  InfraEvents,
  // SpendScopeKind — the closed wire enum (agent|tenant|global) for the spend
  // kill-switch events. Consumed by the @comis/agent spend-accumulator.
  SpendScopeKind,
  // ReflectAdmissionOutcome — the closed content-free verdict enum on
  // reflect:funnel.admissionOutcome. Canonical in core; the
  // @comis/agent reflection-job re-exports it so the emit + this event contract
  // share one closed union.
  ReflectAdmissionOutcome,
} from "../event-bus/index.js";
