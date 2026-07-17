// SPDX-License-Identifier: Apache-2.0
// @allow-throw: Session lifecycle RPC helper — callers run inside rpc-dispatch's JSON-RPC error boundary.
/** Session-lifecycle clearing for prompt-injected delivery-mirror state. */

import type { SessionHandlerDeps } from "./session-helpers.js";

type SessionLifecycleMethod =
  | "session.delete"
  | "session.reset"
  | "session.reset_conversation";

/**
 * Clear one session's mirror before destructive transcript mutations.
 * A disabled mirror is represented by a no-op adapter, so an absent port or
 * adapter failure means the lifecycle operation cannot honestly report success.
 */
export async function clearSessionDeliveryMirror(
  deps: Pick<SessionHandlerDeps, "deliveryMirror" | "logger">,
  sessionKey: string,
  method: SessionLifecycleMethod,
): Promise<number> {
  if (!deps.deliveryMirror) {
    deps.logger.error(
      {
        method,
        conversationId: sessionKey,
        sessionKey,
        submodule: "session-delivery-mirror",
        errorKind: "precondition" as const,
        hint: "Complete daemon startup so the delivery-mirror adapter is wired, then retry the session lifecycle operation",
      },
      "Session lifecycle failed because delivery mirror is unavailable",
    );
    throw new Error("Delivery mirror not available — daemon not fully initialized");
  }

  const result = await deps.deliveryMirror.clearSession(sessionKey);
  if (!result.ok) {
    deps.logger.error(
      {
        method,
        conversationId: sessionKey,
        sessionKey,
        submodule: "session-delivery-mirror",
        errorKind: "dependency" as const,
        hint: "Delivery mirror entries were not cleared; repair the mirror store and retry the session lifecycle operation before sending another message",
        err: result.error,
      },
      "Session lifecycle failed while clearing delivery mirror",
    );
    throw new Error("Delivery mirror clear failed; no transcript layers were deleted");
  }

  return result.value;
}
