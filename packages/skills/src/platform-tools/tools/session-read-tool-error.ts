// SPDX-License-Identifier: Apache-2.0
// @allow-throw: platform-tool boundary rethrows errors for the AgentTool wrapper.
/** Preserve session-read authorization failures across the RPC SDK boundary. */

import { throwToolError } from "../tool-helpers.js";

const SESSION_READ_AUTHORIZATION_HINT =
  "Use tenant_id and agent_id from the authenticated caller conversation; read an unrelated conversation through an operator-scoped route";

/** Convert an RPC authorization error into the platform tool error taxonomy. */
export function rethrowSessionReadRpcError(error: unknown): never {
  if (error instanceof Error && error.message.startsWith("[")) throw error;
  if (error instanceof Error && error.name === "AuthorizationError") {
    throwToolError("permission_denied", error.message, {
      hint: SESSION_READ_AUTHORIZATION_HINT,
    });
  }
  throw error instanceof Error ? error : new Error(String(error));
}
