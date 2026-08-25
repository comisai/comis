// SPDX-License-Identifier: Apache-2.0
/**
 * Managed-run groups: an operator roll-up over related external runs.
 *
 * The point of the group is what it deliberately cannot express. Comis stores
 * no component names, dependency edges, file overlap, integration order,
 * business milestones or acceptance rules — a service that needs those supplies
 * its own bounded display projection. Keeping them out is what lets unrelated
 * services share one substrate instead of turning the host into a workflow
 * engine.
 *
 * Two invariants carry the security weight. Membership is same-scope only, so a
 * group can never become a bridge between tenants, agents, principals,
 * conversations or service instances. And a group operation is never advertised
 * as atomic: its result names every member with its own outcome, so a caller
 * that reached half the members reports exactly that instead of one success.
 *
 * @module
 */
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import { ManagedRunStatusSchema, type ManagedRunRecord } from "./managed-run.js";
import { ConversationRefSchema } from "./conversation-scope.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const OpaqueIdSchema = z.string().min(1).max(256).regex(OPAQUE_ID_PATTERN);
const TimestampMsSchema = z.number().int().nonnegative();

/** Maximum members admitted in one prepared group. */
export const MANAGED_RUN_GROUP_MAX_MEMBERS = 16;

/**
 * Retention for a preparation that bound only some of its members. It is a
 * ceiling on how long an unresolved partial binding may occupy host records,
 * not a promise that anything is retried within it.
 */
export const MANAGED_RUN_GROUP_PARTIAL_RETENTION_MS = 24 * 60 * 60 * 1000;

const MemberIdsSchema = z
  .array(OpaqueIdSchema)
  .min(1)
  .max(MANAGED_RUN_GROUP_MAX_MEMBERS)
  .refine(
    (values) => values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0),
    "group members must be unique and sorted",
  );

/**
 * Sparse by construction: a status absent from the map has no members in it.
 * Storing an explicit zero for every status would invite a reader to treat the
 * map as a fixed shape and miss that the total, not any single entry, is the
 * invariant.
 */
const StateCountsSchema = z.partialRecord(ManagedRunStatusSchema, z.number().int().positive());

export const ManagedRunGroupMemberOutcomeSchema = z.enum([
  "completed",
  "rejected",
  "unknown",
  "not_attempted",
]);

export const ManagedRunGroupRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  managedRunGroupId: OpaqueIdSchema,
  serviceInstanceId: OpaqueIdSchema,
  tenantId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  principalId: z.string().min(1).max(256),
  conversationRef: ConversationRefSchema,
  rootRunId: OpaqueIdSchema,
  memberManagedRunIds: MemberIdsSchema,
  stateCounts: StateCountsSchema,
  attentionCount: z.number().int().nonnegative(),
  activeCustodyCount: z.number().int().nonnegative(),
  createdAtMs: TimestampMsSchema,
  updatedAtMs: TimestampMsSchema,
}).superRefine((record, context) => {
  const memberCount = record.memberManagedRunIds.length;
  const counted = Object.values(record.stateCounts).reduce<number>((total, value) => total + (value ?? 0), 0);
  if (counted !== memberCount) {
    context.addIssue({
      code: "custom",
      path: ["stateCounts"],
      message: "state counts must account for exactly the group's members",
    });
  }
  if (record.attentionCount > memberCount) {
    context.addIssue({
      code: "custom",
      path: ["attentionCount"],
      message: "attention count cannot exceed the group's membership",
    });
  }
  if (record.activeCustodyCount > memberCount) {
    context.addIssue({
      code: "custom",
      path: ["activeCustodyCount"],
      message: "active custody count cannot exceed the group's membership",
    });
  }
  if (record.updatedAtMs < record.createdAtMs) {
    context.addIssue({
      code: "custom",
      path: ["updatedAtMs"],
      message: "updated time cannot precede creation",
    });
  }
});

export const ManagedRunGroupOperationResultSchema = z.strictObject({
  operationId: OpaqueIdSchema,
  managedRunGroupId: OpaqueIdSchema,
  members: z
    .array(z.strictObject({
      managedRunId: OpaqueIdSchema,
      outcome: ManagedRunGroupMemberOutcomeSchema,
    }))
    .min(1)
    .max(MANAGED_RUN_GROUP_MAX_MEMBERS)
    .refine(
      (values) => values.every((value, index) =>
        index === 0 || values[index - 1]!.managedRunId.localeCompare(value.managedRunId) < 0),
      "member outcomes must name each member once, in sorted order",
    ),
});

export type ManagedRunGroupMemberOutcome = z.infer<typeof ManagedRunGroupMemberOutcomeSchema>;
export type ManagedRunGroupRecord = z.infer<typeof ManagedRunGroupRecordSchema>;
export type ManagedRunGroupOperationResult = z.infer<typeof ManagedRunGroupOperationResultSchema>;

export function parseManagedRunGroupRecord(raw: unknown): Result<ManagedRunGroupRecord, z.ZodError> {
  const parsed = ManagedRunGroupRecordSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}

export function parseManagedRunGroupOperationResult(
  raw: unknown,
): Result<ManagedRunGroupOperationResult, z.ZodError> {
  const parsed = ManagedRunGroupOperationResultSchema.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(parsed.error);
}

export interface ManagedRunGroupRollupInput {
  readonly managedRunGroupId: string;
  readonly serviceInstanceId: string;
  readonly rootRunId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly members: readonly ManagedRunRecord[];
}

export type ManagedRunGroupRollupErrorKind =
  | "empty_membership"
  | "membership_exceeds_ceiling"
  | "scope_mismatch"
  | "group_mismatch"
  | "invalid_rollup";

export interface ManagedRunGroupRollupError {
  readonly kind: ManagedRunGroupRollupErrorKind;
  readonly managedRunId?: string;
  readonly hint: string;
}

/**
 * Builds the group record from member run facts and nothing else.
 *
 * The host never asks the service what a group means; it counts what its own
 * records already say. `attentionCount` is the number of MEMBERS awaiting a
 * human, not the sum of their open requests — a roll-up that summed requests
 * could exceed the membership and stop being a roll-up.
 */
export function deriveManagedRunGroupRollup(
  input: ManagedRunGroupRollupInput,
): Result<ManagedRunGroupRecord, ManagedRunGroupRollupError> {
  const { members } = input;
  if (members.length === 0) {
    return err({
      kind: "empty_membership",
      hint: "a managed-run group needs at least one member; membership is explicit, never implied",
    });
  }
  if (members.length > MANAGED_RUN_GROUP_MAX_MEMBERS) {
    return err({
      kind: "membership_exceeds_ceiling",
      hint: `a prepared group holds at most ${String(MANAGED_RUN_GROUP_MAX_MEMBERS)} members`,
    });
  }

  const [anchor] = members as readonly [ManagedRunRecord, ...ManagedRunRecord[]];
  for (const member of members) {
    if (member.managedRunGroupId !== input.managedRunGroupId) {
      return err({
        kind: "group_mismatch",
        managedRunId: member.managedRunId,
        hint: "every member must already carry this group id; the host does not adopt a run into a group it never joined",
      });
    }
    if (
      member.serviceInstanceId !== input.serviceInstanceId
      || member.tenantId !== anchor.tenantId
      || member.agentId !== anchor.agentId
      || member.principalId !== anchor.principalId
      || member.conversationRef !== anchor.conversationRef
      || member.rootRunId !== input.rootRunId
    ) {
      return err({
        kind: "scope_mismatch",
        managedRunId: member.managedRunId,
        hint: "group membership is same-scope only: one service instance, tenant, agent, principal, conversation and root run",
      });
    }
  }

  const stateCounts: Record<string, number> = {};
  let attentionCount = 0;
  for (const member of members) {
    stateCounts[member.status] = (stateCounts[member.status] ?? 0) + 1;
    if (member.openAttentionCount > 0) attentionCount += 1;
  }

  return toRollupResult({
    schemaVersion: 1,
    managedRunGroupId: input.managedRunGroupId,
    serviceInstanceId: input.serviceInstanceId,
    tenantId: anchor.tenantId,
    agentId: anchor.agentId,
    principalId: anchor.principalId,
    conversationRef: anchor.conversationRef,
    rootRunId: input.rootRunId,
    memberManagedRunIds: [...members.map((member) => member.managedRunId)].sort((left, right) =>
      left.localeCompare(right)),
    stateCounts,
    attentionCount,
    // Custody is an E2 surface. Until it exists the host can honestly report
    // zero, and must not infer a count it has no records for.
    activeCustodyCount: 0,
    createdAtMs: input.createdAtMs,
    updatedAtMs: input.updatedAtMs,
  });
}

function toRollupResult(candidate: unknown): Result<ManagedRunGroupRecord, ManagedRunGroupRollupError> {
  const parsed = parseManagedRunGroupRecord(candidate);
  if (parsed.ok) return parsed;
  return err({
    kind: "invalid_rollup",
    hint: `derived group roll-up failed host validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
  });
}
