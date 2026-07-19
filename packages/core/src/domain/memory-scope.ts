// SPDX-License-Identifier: Apache-2.0
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import {
  ConversationRefSchema,
  createConversationRef,
  ResolvedTurnScopeSchema,
  type ResolvedTurnScope,
} from "./conversation-scope.js";
import type { TrustLevel } from "./memory-trust.js";

export const MemoryVisibilityRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("conversation") }),
  z.strictObject({ kind: z.literal("principal") }),
  z.strictObject({ kind: z.literal("agent-shared") }),
]);
export type MemoryVisibilityRequest = z.infer<typeof MemoryVisibilityRequestSchema>;

export const MemoryVisibilitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("conversation"), conversationRef: ConversationRefSchema }),
  z.strictObject({ kind: z.literal("principal"), principalId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("agent-shared") }),
]);
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;

export const MemoryVisibilityPermissionSchema = z.strictObject({
  kind: z.literal("operator-memory-visibility"),
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
});
export type MemoryVisibilityPermission = z.infer<typeof MemoryVisibilityPermissionSchema>;

export const MemoryWriteScopeSchema = z.strictObject({
  turnScope: ResolvedTurnScopeSchema,
  visibility: MemoryVisibilityRequestSchema,
  operatorPermission: MemoryVisibilityPermissionSchema.optional(),
});
export type MemoryWriteScope = z.infer<typeof MemoryWriteScopeSchema>;

export const MemoryRecallScopeSchema = z.strictObject({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  conversationRef: ConversationRefSchema,
  principalId: z.string().min(1),
  includeAgentShared: z.boolean(),
});
export type MemoryRecallScope = z.infer<typeof MemoryRecallScopeSchema>;

export class MemoryScopeError extends Error {
  readonly errorKind = "precondition" as const;
}

export function createMemoryRecallScope(
  turnScope: ResolvedTurnScope,
  includeAgentShared: boolean,
): Result<MemoryRecallScope, MemoryScopeError> {
  const parsed = ResolvedTurnScopeSchema.safeParse(turnScope);
  if (!parsed.success) return err(new MemoryScopeError("Memory recall requires a resolved turn scope"));
  const conversationRef = createConversationRef(parsed.data.conversation);
  if (!conversationRef.ok) return err(new MemoryScopeError("Memory recall conversation authority is invalid"));
  return ok({
    tenantId: parsed.data.conversation.tenantId,
    agentId: parsed.data.conversation.agentId,
    conversationRef: conversationRef.value,
    principalId: parsed.data.principal.principalId,
    includeAgentShared,
  });
}

export function resolveMemoryVisibility(
  scope: MemoryWriteScope,
  trustLevel: TrustLevel,
): Result<MemoryVisibility, MemoryScopeError> {
  const parsed = MemoryWriteScopeSchema.safeParse(scope);
  if (!parsed.success) return err(new MemoryScopeError("Memory writes require an explicit resolved visibility"));
  const { turnScope, visibility, operatorPermission } = parsed.data;
  const permissionMatches = operatorPermission !== undefined
    && operatorPermission.tenantId === turnScope.conversation.tenantId
    && operatorPermission.agentId === turnScope.conversation.agentId;
  if (trustLevel === "external" && visibility.kind !== "conversation" && !permissionMatches) {
    return err(new MemoryScopeError("External provenance cannot exceed conversation visibility without operator permission"));
  }
  switch (visibility.kind) {
    case "conversation": {
      const reference = createConversationRef(turnScope.conversation);
      return reference.ok
        ? ok({ kind: "conversation", conversationRef: reference.value })
        : err(new MemoryScopeError("Memory conversation authority is invalid"));
    }
    case "principal":
      return ok({ kind: "principal", principalId: turnScope.principal.principalId });
    case "agent-shared":
      return ok({ kind: "agent-shared" });
    default: {
      const _exhaustive: never = visibility;
      return err(new MemoryScopeError(`Unsupported memory visibility: ${String(_exhaustive)}`));
    }
  }
}
