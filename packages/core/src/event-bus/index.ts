// SPDX-License-Identifier: Apache-2.0
export { TypedEventBus } from "./bus.js";
export type { EventHandler } from "./bus.js";
export type { EventMap } from "./events.js";
export type { MessagingEvents } from "./events-messaging.js";
export type { AgentEvents } from "./events-agent.js";
// SpendScopeKind is intentionally NOT re-exported at the @comis/core barrel until
// Plan 02 adds its in-repo consumer (the public-export-consumers gate). It is
// reachable from "@comis/core/event-bus/events-agent" meanwhile (the source of truth).
export type { OrchestrationEvents } from "./events-orchestration.js";
export type { ChannelEvents } from "./events-channel.js";
export type { InfraEvents } from "./events-infra.js";
