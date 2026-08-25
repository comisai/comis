// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  ApprovalRequestIdSchema,
  AttachmentRelayIdentitySchema,
  ExternalRunRefSchema,
  ManagedRunIdSchema,
  OperationIdSchema,
  RegistrationNonceSchema,
  ServiceInstanceIdSchema,
} from "./common.js";
import { CAPABILITY_SERVICE_LIMITS } from "./constants.js";

/** Private MCP request metadata supplied after model-authored arguments are fixed. */
export const McpCapabilityCallContextSchema = z.strictObject({
  operationId: OperationIdSchema,
  serviceInstanceId: ServiceInstanceIdSchema,
  agentId: z.string().min(1).max(256),
  conversationRef: z.string().min(1).max(512),
  workspacePolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
  rootRunId: ManagedRunIdSchema,
  traceId: z.string().min(1).max(128),
  approvalRequestId: ApprovalRequestIdSchema.optional(),
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
      relayIdentity: AttachmentRelayIdentitySchema,
    })
    .optional(),
});

/** Private MCP result metadata describing one same-scope prepared run group. */
export const McpManagedRunGroupResultSchema = z.strictObject({
  state: z.literal("prepared"),
  registrationNonce: RegistrationNonceSchema,
  expiresAt: z.iso.datetime(),
  displayLabel: z.string().min(1).max(256).optional(),
  members: z.array(McpManagedRunResultSchema)
    .min(1)
    .max(CAPABILITY_SERVICE_LIMITS.maxGroupMembers),
}).superRefine((group, context) => {
  const externalRunRefs = new Set<string>();
  const registrationNonces = new Set<string>([group.registrationNonce]);
  for (let index = 0; index < group.members.length; index += 1) {
    const member = group.members[index];
    if (member === undefined) continue;
    if (member.expiresAt !== group.expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "expiresAt"],
        message: "group members must share the group expiry",
      });
    }
    if (externalRunRefs.has(member.externalRunRef)) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "externalRunRef"],
        message: "group member external references must be unique",
      });
    }
    externalRunRefs.add(member.externalRunRef);
    if (registrationNonces.has(member.registrationNonce)) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "registrationNonce"],
        message: "group and member registration nonces must be unique",
      });
    }
    registrationNonces.add(member.registrationNonce);
  }
});

export type McpCapabilityCallContext = z.infer<typeof McpCapabilityCallContextSchema>;
export type McpManagedRunResult = z.infer<typeof McpManagedRunResultSchema>;
export type McpManagedRunGroupResult = z.infer<typeof McpManagedRunGroupResultSchema>;
