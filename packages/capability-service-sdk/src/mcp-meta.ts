// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  ExternalRunRefSchema,
  ManagedRunIdSchema,
  OperationIdSchema,
  RegistrationNonceSchema,
  ServiceInstanceIdSchema,
} from "./common.js";

/** Private MCP request metadata supplied after model-authored arguments are fixed. */
export const McpCapabilityCallContextSchema = z.strictObject({
  operationId: OperationIdSchema,
  serviceInstanceId: ServiceInstanceIdSchema,
  agentId: z.string().min(1).max(256),
  conversationRef: z.string().min(1).max(512),
  workspacePolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
  rootRunId: ManagedRunIdSchema,
  traceId: z.string().min(1).max(128),
  managedRunGroupId: ManagedRunIdSchema.optional(),
  managedRunId: ManagedRunIdSchema.optional(),
});

/** Private MCP result metadata describing a prepared external run. */
export const McpManagedRunResultSchema = z.strictObject({
  state: z.literal("prepared"),
  externalRunRef: ExternalRunRefSchema,
  registrationNonce: RegistrationNonceSchema,
  expiresAt: z.iso.datetime(),
  displayLabel: z.string().min(1).max(256).optional(),
  requestedWorkspace: z
    .strictObject({
      rootHint: z.string().min(1).max(512),
    })
    .optional(),
  requestedAttachment: z
    .strictObject({
      kind: z.enum(["unix_socket", "inherited_descriptor"]),
      sourcePath: z.string().min(1).max(4_096),
    })
    .optional(),
});

export type McpCapabilityCallContext = z.infer<typeof McpCapabilityCallContextSchema>;
export type McpManagedRunResult = z.infer<typeof McpManagedRunResultSchema>;
