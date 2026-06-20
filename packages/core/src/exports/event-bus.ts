// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Event bus (typed inter-module communication)

export { TypedEventBus } from "../event-bus/index.js";
export type {
  EventHandler,
  EventMap,
  MessagingEvents,
  AgentEvents,
  // ModelEvents — model-failover (model:*) + provider-health (provider:*) lifecycle,
  // extracted from AgentEvents for the file-size cap (composed into EventMap).
  ModelEvents,
  ChannelEvents,
  InfraEvents,
  // SpendScopeKind — the closed wire enum (agent|tenant|global) for the spend
  // kill-switch events. Consumed by the @comis/agent spend-accumulator (177-02).
  SpendScopeKind,
} from "../event-bus/index.js";
