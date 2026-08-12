// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import {
  CAPABILITY_SERVICE_LIMITS,
  CAPABILITY_SERVICE_METHODS,
  CAPABILITY_SERVICE_PROTOCOL_ID,
  CapabilityAbandonResponseSchema,
  CapabilityActivateResponseSchema,
  CapabilityHandshakeResponseSchema,
  CapabilityHealthResponseSchema,
  CapabilityPutEvidenceResponseSchema,
  CapabilityReceiveAttentionResponseResponseSchema,
  CapabilityReleaseResponseSchema,
  CapabilityReportResponseSchema,
  CapabilityTerminalEventResponseSchema,
  CapabilityServiceErrorResponseSchema,
  CapabilityServiceRequestSchema,
  McpCapabilityCallContextSchema,
  McpManagedRunResultSchema,
  materializeProtocolFixtureDigest,
  type CapabilityServiceErrorKind,
  type ProtocolFixtureStep,
} from "@comis/capability-service-sdk";
import type { ZodType } from "zod";

export interface CapabilityServiceProtocolFixtureHostOptions {
  readonly activeScopes?: readonly string[];
  readonly bundleDigest: string;
}

export interface CapabilityServiceProtocolFixtureRejection {
  readonly kind: CapabilityServiceErrorKind;
}

export interface CapabilityServiceProtocolFixtureHost {
  validateRequest(
    payload: unknown,
  ): Result<void, CapabilityServiceProtocolFixtureRejection>;
  validate(
    step: ProtocolFixtureStep,
  ): Result<void, CapabilityServiceProtocolFixtureRejection>;
}

const RESPONSE_SCHEMAS = {
  "abandon-response": CapabilityAbandonResponseSchema,
  "activate-response": CapabilityActivateResponseSchema,
  "error-response": CapabilityServiceErrorResponseSchema,
  "handshake-response": CapabilityHandshakeResponseSchema,
  "health-response": CapabilityHealthResponseSchema,
  "put-evidence-response": CapabilityPutEvidenceResponseSchema,
  "receive-attention-response": CapabilityReceiveAttentionResponseResponseSchema,
  "release-response": CapabilityReleaseResponseSchema,
  "report-response": CapabilityReportResponseSchema,
  "terminal-event-response": CapabilityTerminalEventResponseSchema,
  "mcp-call-context": McpCapabilityCallContextSchema,
  "mcp-managed-run-result": McpManagedRunResultSchema,
} as const satisfies Readonly<Record<Exclude<ProtocolFixtureStep["target"], "request">, ZodType>>;

function reject(
  kind: CapabilityServiceErrorKind,
): Result<void, CapabilityServiceProtocolFixtureRejection> {
  return err({ kind });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateWireSize(
  target: ProtocolFixtureStep["target"],
  payload: unknown,
): Result<void, CapabilityServiceProtocolFixtureRejection> {
  if (target === "mcp-call-context" || target === "mcp-managed-run-result") return ok(undefined);
  const bytes = serializedBytes(payload);
  const directionLimit =
    target === "request"
      ? CAPABILITY_SERVICE_LIMITS.maxRequestBytes
      : CAPABILITY_SERVICE_LIMITS.maxResponseBytes;
  if (bytes > directionLimit || bytes + 1 > CAPABILITY_SERVICE_LIMITS.maxLineBytes) {
    return reject("size_limit_exceeded");
  }
  return ok(undefined);
}

function validateProtocolIdentity(
  params: Readonly<Record<string, unknown>>,
  bundleDigest: string,
): Result<void, CapabilityServiceProtocolFixtureRejection> {
  if (
    "protocolId" in params &&
    params["protocolId"] !== CAPABILITY_SERVICE_PROTOCOL_ID
  ) {
    return reject("protocol_mismatch");
  }
  if ("bundleDigest" in params && params["bundleDigest"] !== bundleDigest) {
    return reject("bundle_digest_mismatch");
  }
  return ok(undefined);
}

function validateReportSizes(
  method: unknown,
  params: Readonly<Record<string, unknown>>,
): Result<void, CapabilityServiceProtocolFixtureRejection> {
  if (method !== "managedRuns.report") return ok(undefined);
  const summary = params["summary"];
  const details = params["details"];
  const contentBytes =
    (typeof summary === "string" ? Buffer.byteLength(summary, "utf8") : 0) +
    (typeof details === "string" ? Buffer.byteLength(details, "utf8") : 0);
  if (
    contentBytes > CAPABILITY_SERVICE_LIMITS.maxReportBytes
  ) {
    return reject("size_limit_exceeded");
  }
  return ok(undefined);
}

function validateRequest(
  payload: unknown,
  bundleDigest: string,
  operations: Map<string, string>,
  preparationWorkspaceRequests: ReadonlyMap<string, boolean>,
  preparationAttachmentRequests: ReadonlyMap<string, boolean>,
): Result<void, CapabilityServiceProtocolFixtureRejection> {
  const envelope = asRecord(payload);
  const params = asRecord(envelope?.["params"]);
  if (!envelope || !params) return reject("invalid_request");
  const method = envelope["method"];
  if (
    typeof method !== "string" ||
    !CAPABILITY_SERVICE_METHODS.includes(method as (typeof CAPABILITY_SERVICE_METHODS)[number])
  ) {
    return reject("method_not_found");
  }

  const identity = validateProtocolIdentity(params, bundleDigest);
  if (!identity.ok) return identity;
  const sizes = validateReportSizes(method, params);
  if (!sizes.ok) return sizes;

  const parsed = CapabilityServiceRequestSchema.safeParse(payload);
  if (!parsed.success) return reject("invalid_params");
  if (parsed.data.id !== parsed.data.params.operationId) return reject("invalid_request");
  if (parsed.data.method === "managedRuns.activate") {
    const requestedWorkspace = preparationWorkspaceRequests.get(
      parsed.data.params.externalRunRef,
    );
    if (
      requestedWorkspace !== undefined
      && requestedWorkspace !== (parsed.data.params.workspaceLeaseId !== undefined)
    ) {
      return reject("invalid_params");
    }
    const requestedAttachment = preparationAttachmentRequests.get(
      parsed.data.params.externalRunRef,
    );
    const hasAttachment = parsed.data.params.executionAttachmentId !== undefined
      && parsed.data.params.attachmentTargetName !== undefined;
    if (requestedAttachment !== undefined && requestedAttachment !== hasAttachment) {
      return reject("invalid_params");
    }
  }

  const canonical = JSON.stringify(parsed.data);
  const previous = operations.get(parsed.data.params.operationId);
  if (previous !== undefined && previous !== canonical) return reject("replay_conflict");
  operations.set(parsed.data.params.operationId, canonical);
  return ok(undefined);
}

export function createCapabilityServiceProtocolFixtureHost(
  options: CapabilityServiceProtocolFixtureHostOptions,
): CapabilityServiceProtocolFixtureHost {
  const operations = new Map<string, string>();
  const preparationWorkspaceRequests = new Map<string, boolean>();
  const preparationAttachmentRequests = new Map<string, boolean>();
  const validatePayload = (
    payload: unknown,
  ): Result<void, CapabilityServiceProtocolFixtureRejection> => {
    const size = validateWireSize("request", payload);
    if (!size.ok) return size;
    return validateRequest(
      payload,
      options.bundleDigest,
      operations,
      preparationWorkspaceRequests,
      preparationAttachmentRequests,
    );
  };
  return {
    validateRequest: validatePayload,
    validate(step) {
      const payload = materializeProtocolFixtureDigest(step.payload, options.bundleDigest);
      if (step.target === "request") {
        return validatePayload(payload);
      }
      const size = validateWireSize(step.target, payload);
      if (!size.ok) return size;
      const schema = RESPONSE_SCHEMAS[step.target];
      const parsed = schema.safeParse(payload);
      if (!parsed.success) return reject("invalid_params");
      if (step.target === "mcp-managed-run-result") {
        const preparation = McpManagedRunResultSchema.safeParse(payload);
        if (!preparation.success) return reject("invalid_params");
        preparationWorkspaceRequests.set(
          preparation.data.externalRunRef,
          preparation.data.requestedWorkspace !== undefined,
        );
        if (
          preparation.data.requestedAttachment !== undefined
          && !(options.activeScopes ?? ["execution_attachment"]).includes("execution_attachment")
        ) {
          return reject("precondition_failed");
        }
        preparationAttachmentRequests.set(
          preparation.data.externalRunRef,
          preparation.data.requestedAttachment !== undefined,
        );
      }
      return ok(undefined);
    },
  };
}
