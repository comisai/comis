// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC authority validation is caught and converted by rpc-dispatch.
/** Exact-conversation authority for model-facing sub-agent session operations. */

import {
  ConversationScopeSchema,
  createConversationRef,
  type ConversationRef,
} from "@comis/core";
import { AuthorizationError } from "../errors.js";

/**
 * Return the exact conversation reference owned by a sub-agent caller.
 * Control-plane callers and non-sub-agent agent turns keep their existing scope.
 */
export function subagentCallerConversationRef(
  rawParams: Record<string, unknown>,
): ConversationRef | undefined {
  const rawScope = rawParams._callerConversationScope;
  if (rawScope === undefined) return undefined;

  const parsed = ConversationScopeSchema.safeParse(rawScope);
  if (!parsed.success) {
    throw new AuthorizationError("Sub-agent session access denied");
  }
  const partition = parsed.data.partition;
  if (
    partition.kind !== "endpoint-conversation"
    && partition.kind !== "endpoint-conversation-principal"
  ) {
    return undefined;
  }
  if (partition.endpoint.channelType !== "sub-agent") return undefined;

  const reference = createConversationRef(parsed.data);
  if (!reference.ok) {
    throw new AuthorizationError("Sub-agent session access denied");
  }
  return reference.value;
}

/** Refuse a sub-agent target outside its exact caller conversation. */
export function requireSubagentConversationAccess(
  rawParams: Record<string, unknown>,
  targetRef: ConversationRef,
): void {
  const callerRef = subagentCallerConversationRef(rawParams);
  if (callerRef !== undefined && callerRef !== targetRef) {
    throw new AuthorizationError("Sub-agent session access denied");
  }
}
