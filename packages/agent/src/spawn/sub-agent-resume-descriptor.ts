// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentCapabilitySchema,
  ChannelEndpointSchema,
  ConversationLocatorSchema,
  DeliveryOriginSchema,
  type DurableRunRecord,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";

const boundedString = z.string().max(65_536);
const boundedStringArray = z.array(z.string().max(8_192)).max(128);

export const SubAgentResumeDescriptorSchema = z.strictObject({
  kind: z.literal("subagent_resume"),
  task: boundedString,
  agentId: z.string().min(1).max(256),
  callerSessionKey: z.string().max(2_048).optional(),
  callerConversation: ConversationLocatorSchema.optional(),
  callerEndpoint: ChannelEndpointSchema.optional(),
  callerAgentId: z.string().max(256).optional(),
  announceChannelType: z.string().max(256).optional(),
  announceChannelId: z.string().max(2_048).optional(),
  model: z.string().max(512).optional(),
  maxSteps: z.number().int().positive().max(10_000).optional(),
  tokenBudget: z.number().int().positive().optional(),
  expectedOutputs: boundedStringArray.optional(),
  requesterOrigin: DeliveryOriginSchema.optional(),
  depth: z.number().int().nonnegative().max(10),
  maxDepth: z.number().int().positive().max(10),
  rootRunId: z.string().min(1).max(512),
  capabilityCeiling: z.array(AgentCapabilitySchema).max(128),
  isCronAgentTurn: z.boolean().optional(),
  jobId: z.string().max(512).optional(),
  jobName: z.string().max(512).optional(),
  artifactRefs: boundedStringArray.optional(),
  objective: boundedString.optional(),
  domainKnowledge: boundedStringArray.optional(),
  toolGroups: boundedStringArray.optional(),
  resolvedLanguage: z.string().max(256).optional(),
  requiredTools: boundedStringArray.optional(),
  includeParentHistory: z.enum(["none", "summary"]).optional(),
  discoveredDeferredTools: boundedStringArray.optional(),
  graphToolNames: boundedStringArray.optional(),
  worktree: z.boolean().optional(),
  workspacePolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type SubAgentResumeDescriptor = z.infer<typeof SubAgentResumeDescriptorSchema>;

function canonicalDescriptor(descriptor: SubAgentResumeDescriptor): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(descriptor)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function hashSubAgentResumeDescriptor(
  descriptor: SubAgentResumeDescriptor,
): string {
  return createHash("sha256").update(canonicalDescriptor(descriptor), "utf8").digest("hex");
}

export function parseSubAgentResumeDescriptor(
  value: unknown,
): Result<SubAgentResumeDescriptor, Error> {
  const parsed = SubAgentResumeDescriptorSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(new Error("Protected sub-agent resume descriptor failed validation"));
}

export function validateSubAgentResumeAuthority(
  descriptor: SubAgentResumeDescriptor,
  record: DurableRunRecord,
): Result<void, Error> {
  if (
    descriptor.agentId !== record.agentId
    || descriptor.rootRunId !== record.rootRunId
    || hashSubAgentResumeDescriptor(descriptor) !== record.resumeDescriptorHash
  ) {
    return err(new Error("Protected sub-agent resume descriptor identity mismatch"));
  }
  const ceiling = new Set(descriptor.capabilityCeiling);
  if (record.caps.some((capability) => !ceiling.has(capability))) {
    return err(new Error("Protected sub-agent resume descriptor capability ceiling mismatch"));
  }
  return ok(undefined);
}
