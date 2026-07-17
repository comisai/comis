// SPDX-License-Identifier: Apache-2.0
export { TypedEventBus } from "./bus.js";
export type { EventHandler } from "./bus.js";
export { emitObservationalEventSafely } from "./observational-emission.js";
export type { ObservationalEmissionDeps } from "./observational-emission.js";
export type { EventMap } from "./events.js";
export type { MessagingEvents } from "./events-messaging.js";
export type { AgentEvents } from "./events-agent.js";
// SpendScopeKind — the closed wire enum for the spend kill-switch (agent|tenant|global).
// Defined in events-agent.ts (the source of truth for the events that carry it) and
// re-exported here so the @comis/core top-level barrel surfaces it. Its in-repo
// consumer is the @comis/agent spend-accumulator.
export type { SpendScopeKind } from "./events-agent.js";
// ModelEvents — model-failover (model:*) + provider-health (provider:*) lifecycle,
// declared in its own domain file; composed into EventMap (events.ts).
export type { ModelEvents } from "./events-model.js";
export type { OrchestrationEvents } from "./events-orchestration.js";
export type { ChannelEvents } from "./events-channel.js";
export type { InfraEvents, WebhookFailureReason } from "./events-infra.js";
// ReflectAdmissionOutcome — the closed content-free verdict enum on
// reflect:funnel.admissionOutcome. Canonical in events-learning.ts
// (the event that carries it) since core cannot import @comis/agent; re-exported
// here so @comis/agent's reflection-job can import + re-export it and share the one
// closed union with this event contract.
export type { ReflectAdmissionOutcome } from "./events-learning.js";
