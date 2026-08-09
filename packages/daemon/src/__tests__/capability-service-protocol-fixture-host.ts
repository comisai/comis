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
  CapabilityReportResponseSchema,
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
  readonly bundleDigest: string;
}

export interface CapabilityServiceProtocolFixtureRejection {
  readonly kind: CapabilityServiceErrorKind;
}

export interface CapabilityServiceProtocolFixtureHost {
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
  "report-response": CapabilityReportResponseSchema,
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
  if (
    typeof summary === "string" &&
    Buffer.byteLength(summary, "utf8") > CAPABILITY_SERVICE_LIMITS.maxReportBytes
  ) {
    return reject("size_limit_exceeded");
  }
  const evidence = params["evidence"];
  if (Array.isArray(evidence)) {
    for (const descriptor of evidence) {
      const sizeBytes = asRecord(descriptor)?.["sizeBytes"];
      if (
        typeof sizeBytes === "number" &&
        sizeBytes > CAPABILITY_SERVICE_LIMITS.maxEvidenceBytes
      ) {
        return reject("size_limit_exceeded");
      }
    }
  }
  return ok(undefined);
}

function validateRequest(
  payload: unknown,
  bundleDigest: string,
  operations: Map<string, string>,
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
  return {
    validate(step) {
      const payload = materializeProtocolFixtureDigest(step.payload, options.bundleDigest);
      const size = validateWireSize(step.target, payload);
      if (!size.ok) return size;
      if (step.target === "request") {
        return validateRequest(payload, options.bundleDigest, operations);
      }
      const schema = RESPONSE_SCHEMAS[step.target];
      return schema.safeParse(payload).success ? ok(undefined) : reject("invalid_params");
    },
  };
}
