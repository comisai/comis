// SPDX-License-Identifier: Apache-2.0
import type { ClockPort, ContextStorePort, ConversationRef } from "@comis/core";
import type { ContextEngineDeps } from "./types.js";

export type CanonicalContextEngineDeps = ContextEngineDeps & {
  contextStore: ContextStorePort;
  conversationRef: ConversationRef;
  tenantId: string;
  agentId: string;
  sessionKey: string;
  clock: ClockPort;
};
