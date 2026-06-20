// SPDX-License-Identifier: Apache-2.0
// @comis/core exports — Event bus (typed inter-module communication)

export { TypedEventBus } from "../event-bus/index.js";
export type {
  EventHandler,
  EventMap,
  MessagingEvents,
  AgentEvents,
  ChannelEvents,
  InfraEvents,
} from "../event-bus/index.js";
// NOTE (Phase 177-01): SpendScopeKind is exported from events-agent.ts but NOT
// re-exported at the @comis/core top-level barrel YET — the public-export-consumers
// arch gate requires an in-repo consumer, which Plan 02's spend-accumulator adds.
// Plan 02 adds the barrel re-export here in the same change that imports it.
