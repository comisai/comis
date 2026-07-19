// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC authority parsing is caught by rpc-dispatch.
/** Explicit conversation authority parsing and display-key projection. */

import {
  ConversationRefSchema,
  conversationScopeToSessionKey,
  formatSessionKey,
  type SessionData,
} from "@comis/core";

export type CallerContextMismatchField =
  | "request context" | "resolved principal"
  | "session" | "session identity" | "agent"
  | "delivery origin tenant" | "delivery origin user"
  | "delivery origin channel type" | "delivery origin channel id"
  | "announcement route";

export type SessionSendAuthorizationFailure =
  | "request context is required for an agent-origin call"
  | "caller session is required for an agent-origin call"
  | "caller agent does not match the request principal"
  | "caller session does not match the request principal"
  | "caller session identity does not match the request principal"
  | "target session key is invalid"
  | "target tenant does not match the request principal"
  | "target user does not match the request principal"
  | "target session metadata is required"
  | "target agent ownership is required"
  | "target agent ownership is inconsistent"
  | "target delegation is inconsistent"
  | "target agent hint does not match session ownership"
  | "target agent does not match the request principal";

export function parseSessionAuthority(params: {
  tenant_id: string;
  agent_id: string;
  conversation_ref: string;
}) {
  const reference = ConversationRefSchema.safeParse(params.conversation_ref);
  if (!reference.success) throw new Error("Invalid conversation reference");
  return {
    scope: { tenantId: params.tenant_id, agentId: params.agent_id },
    conversationRef: reference.data,
  };
}

export function displaySessionKey(data: SessionData): string {
  const projected = conversationScopeToSessionKey(data.conversationScope);
  if (!projected.ok) throw projected.error;
  return formatSessionKey(projected.value);
}
