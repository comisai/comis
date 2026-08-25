// SPDX-License-Identifier: Apache-2.0
import {
  CAPABILITY_SERVICE_ERROR_DEFINITIONS,
  type CapabilityServiceErrorKind,
} from "@comis/capability-service-sdk";
import type { CapabilityServiceControlFailure } from "@comis/core";

const ERROR_TEXT = {
  bundle_digest_mismatch: ["Bundle digest does not match", "Use the exact configured protocol bundle"],
  deadline_exceeded: ["Request deadline elapsed", "Reconcile with the same operation identity before retrying"],
  internal_error: ["Capability-service request failed", "Inspect the managed-run store and capability-service health"],
  invalid_params: ["Request parameters are invalid", "Validate the request against the pinned schema"],
  invalid_request: ["Request envelope is invalid", "Send one strict authenticated JSON-RPC request line"],
  method_not_found: ["Method is not callable in this direction", "Use a service-to-Comis method from the pinned catalog"],
  precondition_failed: ["Request precondition is not satisfied", "Complete the exact instance handshake before retrying"],
  protocol_mismatch: ["Protocol identifier does not match", "Use the exact configured protocol identifier"],
  rate_limited: ["In-flight request limit reached", "Retry after an active request completes"],
  replay_conflict: ["Operation identity was reused with altered input", "Reuse the original input or mint a new operation identity"],
  size_limit_exceeded: ["Request exceeds a protocol size limit", "Reduce the request to the pinned manifest limit"],
  unauthorized_instance: ["Capability-service authentication failed", "Use the configured instance credential"],
} as const satisfies Readonly<Record<CapabilityServiceErrorKind, readonly [string, string]>>;

export function classifyCapabilityServiceWireFailure(
  kind: CapabilityServiceErrorKind,
): CapabilityServiceControlFailure["kind"] {
  switch (kind) {
    case "deadline_exceeded":
    case "internal_error":
      return "uncertain";
    case "rate_limited":
      return "unavailable";
    case "bundle_digest_mismatch":
    case "invalid_params":
    case "invalid_request":
    case "method_not_found":
    case "precondition_failed":
    case "protocol_mismatch":
    case "replay_conflict":
    case "size_limit_exceeded":
    case "unauthorized_instance":
      return "rejected";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function capabilityServiceErrorResponse(
  kind: CapabilityServiceErrorKind,
  id: string | null,
): unknown {
  const definition = CAPABILITY_SERVICE_ERROR_DEFINITIONS.find((candidate) => candidate.kind === kind);
  // eslint-disable-next-line security/detect-object-injection -- kind is the SDK's closed error discriminator
  const [message, hint] = ERROR_TEXT[kind];
  if (definition === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32_603,
        kind: "internal_error",
        retryable: true,
        message: ERROR_TEXT.internal_error[0],
        hint: ERROR_TEXT.internal_error[1],
      },
    };
  }
  return { jsonrpc: "2.0", id, error: { ...definition, message, hint } };
}
