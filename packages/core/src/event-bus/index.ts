// SPDX-License-Identifier: Apache-2.0
export { TypedEventBus } from "./bus.js";
export type { EventHandler } from "./bus.js";
export type { EventMap } from "./events.js";
export type { MessagingEvents } from "./events-messaging.js";
export type { AgentEvents } from "./events-agent.js";
// SpendScopeKind — the closed wire enum for the spend kill-switch (agent|tenant|global).
// Defined in events-agent.ts (the source of truth for the events that carry it) and
// re-exported here so the @comis/core top-level barrel surfaces it. Its in-repo
// consumer is the @comis/agent spend-accumulator (Phase 177-02).
export type { SpendScopeKind } from "./events-agent.js";
export type { OrchestrationEvents } from "./events-orchestration.js";
export type { ChannelEvents } from "./events-channel.js";
export type { InfraEvents } from "./events-infra.js";
