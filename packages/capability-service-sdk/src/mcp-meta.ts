// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { CAPABILITY_SERVICE_PROTOCOL_ID } from "./constants.js";
import {
  BundleDigestSchema,
  ExternalRunRefSchema,
  OperationIdSchema,
  RegistrationNonceSchema,
  ServiceInstanceRefSchema,
  TimestampMsSchema,
} from "./common.js";

/** Private MCP request metadata supplied after model-authored arguments are fixed. */
export const McpCapabilityCallContextSchema = z.strictObject({
  protocolId: z.literal(CAPABILITY_SERVICE_PROTOCOL_ID),
  bundleDigest: BundleDigestSchema,
  operationId: OperationIdSchema,
  serviceInstanceRef: ServiceInstanceRefSchema,
});

/** Private MCP result metadata describing a prepared external run. */
export const McpManagedRunResultSchema = z.strictObject({
  state: z.literal("prepared"),
  serviceInstanceRef: ServiceInstanceRefSchema,
  externalRunRef: ExternalRunRefSchema,
  registrationNonce: RegistrationNonceSchema,
  expiresAtMs: TimestampMsSchema,
});

export type McpCapabilityCallContext = z.infer<typeof McpCapabilityCallContextSchema>;
export type McpManagedRunResult = z.infer<typeof McpManagedRunResultSchema>;
